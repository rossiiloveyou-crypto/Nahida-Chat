/**
 * 出站切分（P4 G1 / M11）：围栏代码块保护 → 单句切 → 码点硬上限。
 *
 * 语义来源（逐字对齐，不要"优化"）：
 *  - 单句切：`Cyrene-Agent-1.3.4/src/shared/message-segmentation.ts:13-31`
 *    断句符 `[。！？!?；;]`、段首空白丢弃、段数上限（超出部分并入最后一段）。
 *  - 硬上限：`.../napcat-adapter.ts:40-61` 的 splitQqText，1500 码点、
 *    在窗口末尾往回找断点且位置必须 ≥ 窗口 55%，否则硬断。
 *
 * 为什么要保护围栏块：断句符字符集里有 `;`，JS 代码几乎每行都有分号。
 * 不保护的话，一段代码会被劈成七八条消息，"代码完整在一个气泡里"直接不可能。
 */

export interface SplitOptions {
  /** 单句段的条数上限，超出部分并入最后一段（E10：Cyrene 是 10） */
  maxSegments?: number
  /** 单个发送单元的码点上限（E11：Cyrene 是 1500） */
  maxChars?: number
}

const FENCE = '```'
const SENTENCE_BREAK = /[。！？!?；;]/
const HARD_BREAK = /[。！？!?；;…\n]/u
/** 硬断点必须落在窗口的这个比例之后，否则宁可硬断（太靠前的断点会把段切得太碎） */
const HARD_BREAK_RATIO = 0.55

interface Piece {
  kind: 'text' | 'fence'
  value: string
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, raw))
}

/** 扫描成对的三个反引号；未闭合的围栏视为普通文本（用户写了一半也要能发出去）。 */
function scanFences(text: string): Piece[] {
  const pieces: Piece[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf(FENCE, cursor)
    if (start < 0) {
      pieces.push({ kind: 'text', value: text.slice(cursor) })
      break
    }
    const end = text.indexOf(FENCE, start + FENCE.length)
    if (end < 0) {
      // 未闭合：从这里到结尾都是普通文本
      pieces.push({ kind: 'text', value: text.slice(cursor) })
      break
    }
    if (start > cursor) pieces.push({ kind: 'text', value: text.slice(cursor, start) })
    pieces.push({ kind: 'fence', value: text.slice(start, end + FENCE.length) })
    cursor = end + FENCE.length
  }
  return pieces
}

/** 与 Cyrene splitTextBySentenceBreaks 逐字对齐（段首空白丢弃 / 末尾剩余并入最后一段）。 */
function splitSentences(text: string, maxParts: number): string[] {
  const clean = text.trim()
  if (!clean) return []
  const safeMax = Math.max(1, Math.floor(maxParts))
  const parts: string[] = []
  let buffer = ''
  for (const char of clean) {
    if (buffer.length === 0 && /^\s$/.test(char)) continue
    buffer += char
    if (parts.length < safeMax - 1 && SENTENCE_BREAK.test(char)) {
      parts.push(buffer)
      buffer = ''
    }
  }
  if (buffer) parts.push(buffer)
  return parts
}

/** 按码点硬上限切（Array.from 用码点，不能用 .length：emoji 会被劈成两半）。 */
function hardSplit(text: string, maxChars: number): string[] {
  const result: string[] = []
  let rest = Array.from(text)
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let splitAt = -1
    const floor = Math.floor(maxChars * HARD_BREAK_RATIO)
    for (let i = window.length - 1; i >= floor; i -= 1) {
      if (HARD_BREAK.test(window[i])) {
        splitAt = i + 1
        break
      }
    }
    if (splitAt < 0) splitAt = maxChars
    result.push(window.slice(0, splitAt).join(''))
    rest = rest.slice(splitAt)
  }
  const tail = rest.join('')
  if (tail) result.push(tail)
  return result
}

/**
 * 围栏块超长时的专用切法（X-03）：按行累积，每段重新裹上围栏，
 * 保证每一段的围栏标记都成对——否则 QQ 客户端里会出现「半截代码块」。
 *
 * 为什么按行而不是按码点：代码块被从语句中间劈开比被多切几段糟得多；
 * 单行自己就超预算时才退回 hardSplit，且结果仍然重裹围栏。
 */
function splitFence(fence: string, maxChars: number): string[] {
  // 短围栏原样返回：走通用切法会多出空行，回归时与改动前不一致（A0b 第 6 条）
  if (Array.from(fence).length <= maxChars) return [fence]

  const firstBreak = fence.indexOf('\n')
  let header = FENCE
  let inner: string
  if (firstBreak < 0) {
    // 单行围栏（没有换行可切）：剥掉外层围栏按码点切，再逐段重裹 —— 不透传 hardSplit，
    // 否则首段缺尾围栏、末段缺首围栏，围栏计数变奇数（A0b 第 4 条）
    if (!fence.endsWith(FENCE) || fence.length < FENCE.length * 2) return hardSplit(fence, maxChars)
    inner = fence.slice(FENCE.length, fence.length - FENCE.length)
  } else {
    header = fence.slice(0, firstBreak).trim() // 形如 三反引号 + 语言名
    if (!header.startsWith(FENCE)) return hardSplit(fence, maxChars)
    const closeIndex = fence.lastIndexOf(FENCE)
    if (closeIndex <= firstBreak) return hardSplit(fence, maxChars)
    inner = fence.slice(firstBreak + 1, closeIndex)
  }
  // 给围栏自身开销留余量：header + 两个换行 + 尾围栏
  const budget = Math.max(80, maxChars - Array.from(header).length - 8)

  const lines = inner.split('\n')
  const chunks: string[] = []
  let buffer: string[] = []
  let used = 0
  const flush = (): void => {
    if (buffer.length === 0) return
    chunks.push(buffer.join('\n'))
    buffer = []
    used = 0
  }
  for (const line of lines) {
    const cost = Array.from(line).length + 1
    // 单行就超预算：该行自己走 hardSplit，结果也裹围栏
    if (cost > budget) {
      flush()
      for (const piece of hardSplit(line, budget)) chunks.push(piece)
      continue
    }
    if (used + cost > budget) flush()
    buffer.push(line)
    used += cost
  }
  flush()
  return chunks.map((chunk) => header + '\n' + chunk + '\n' + FENCE)
}

/** 顶层入口：任何输入都返回「可以直接发出去」的字符串数组，空输入返回 []（不是 ['']）。 */
export function splitForQq(text: string, options: SplitOptions = {}): string[] {
  const maxSegments = clampInt(options.maxSegments, 1, 20, 10)
  const maxChars = clampInt(options.maxChars, 200, 4000, 1500)
  const source = String(text ?? '').trim()
  if (!source) return []

  const parts: Piece[] = []
  let budget = maxSegments
  for (const piece of scanFences(source)) {
    if (piece.kind === 'fence') {
      // 围栏块自成一段，与它前后的文本段各自独立（不合并）
      parts.push(piece)
      continue
    }
    if (!piece.value.trim()) continue
    if (budget <= 0) {
      parts.push({ kind: 'text', value: piece.value })
      continue
    }
    const chunk = splitSentences(piece.value, budget)
    budget -= chunk.length
    for (const value of chunk) parts.push({ kind: 'text', value })
  }

  const out: string[] = []
  for (const part of parts) {
    // fence 与 text 走不同分支：fence 按行切并重裹围栏，text 走码点硬切
    const raws = part.kind === 'fence' ? splitFence(part.value, maxChars) : hardSplit(part.value, maxChars)
    for (const raw of raws) {
      const trimmed = raw.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}
