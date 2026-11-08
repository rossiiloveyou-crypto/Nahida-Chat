import type {
  DuplicateKeyword,
  WorldbookEntry,
  WorldbookEntryDraft
} from '@shared/worldbook'
import {
  WORLDBOOK_DEFAULT_PRIORITY,
  WORLDBOOK_DEFAULT_VALUE,
  WORLDBOOK_PRIORITY_MAX,
  WORLDBOOK_PRIORITY_MIN,
  WORLDBOOK_VALUE_MAX,
  WORLDBOOK_VALUE_MIN
} from '@shared/worldbook'

/**
 * 世界书条目的**解析与序列化**（P9 / T2）。纯函数，零 IO，可单测。
 *
 * 🔴 B2：条目格式在这里**只定义一次** —— 解析（读）与序列化（写）共用同一组常量，
 *    UI 永远不拼模板。改格式只改这个文件。
 *
 * 条目形状（照抄 `Prompt/characters/nahida/worldbook/README.md`，不猜）：
 *
 * ```markdown
 * ## 条目名
 * - id: 07ffdbb426b68adb6e3426559e0ad813
 * - 触发词: 被抹去的神, 历史被改写
 * - 常驻: 是
 * - 优先级: 10
 * - 内在价值: 95
 * - 连带触发词: 无
 *
 * 正文……
 * ---
 * ```
 */

/** 六个元数据键。顺序就是写盘顺序（P9 §4.2「顺序固定」）。 */
const META_KEY_ID = 'id'
const META_KEY_KEYWORDS = '触发词'
const META_KEY_ALWAYS = '常驻'
const META_KEY_PRIORITY = '优先级'
const META_KEY_VALUE = '内在价值'
const META_KEY_CHAINED = '连带触发词'

/** 合规判定除「触发词」外还要命中的键 */
const SECONDARY_KEYS = [META_KEY_ID, META_KEY_ALWAYS, META_KEY_PRIORITY, META_KEY_VALUE, META_KEY_CHAINED]

/** 表示「没有」的占位写法（真实文件里 `- 连带触发词: 无` 出现 26 次） */
const NONE_WORDS = new Set(['', '无', '無', 'none', 'null', '-', '—', '——'])

/** 元数据行：`- key: value`，中英文冒号都认 */
const META_LINE = /^-\s*([^:：]+?)\s*[:：]\s*(.*)$/

/**
 * 按逗号切触发词：中文逗号、英文逗号、顿号都认（A-12）。
 * trim + 去空 + 去重（保留首次出现的顺序）。
 */
export function splitKeywords(text: string): string[] {
  const raw = typeof text === 'string' ? text : ''
  const parts = raw.split(/[,，、]/)
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of parts) {
    const word = part.trim()
    if (!word || NONE_WORDS.has(word)) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(word)
  }
  return result
}

/** 数组 → 元数据行里的文本。空数组写成「无」（与真实文件一致） */
export function joinKeywords(words: string[]): string {
  const list = Array.isArray(words) ? words.map((item) => String(item).trim()).filter(Boolean) : []
  return list.length > 0 ? list.join(', ') : '无'
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 数字字段：parseInt + 越界截断（P9 §4.2） */
function readNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, min, max)
}

function readAlways(raw: string | undefined): boolean {
  const text = String(raw ?? '').trim().toLowerCase()
  return text === '是' || text === 'true' || text === 'yes' || text === 'y' || text === '1'
}

interface RawBlock {
  title: string
  /** 在原文里的字符偏移（行首） */
  startOffset: number
  /** 到**下一条目**行首（或文末）为止的字符偏移 */
  endOffset: number
  lines: string[]
}

interface ScanResult {
  blocks: RawBlock[]
  lines: string[]
}

/**
 * 扫描候选边界：**行首 `## `** 且**不在围栏代码块内**。
 *
 * 🔴 两条都不能省（P9 §2.4b）：
 *   ① 只认行首 `## `：`### 小标题`、正文里的行内反引号 `## ` 都不是条目；
 *   ② 跳过围栏：`README.md` 用 ```markdown 展示了条目模板，朴素切分会把示例当条目（A-16）。
 */
function scanBlocks(text: string): ScanResult {
  const lines = text.split('\n')
  const offsets: number[] = []
  let cursor = 0
  for (const line of lines) {
    offsets.push(cursor)
    cursor += line.length + 1 // +1 是换行符
  }

  const heads: number[] = []
  let fence = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(\`\`\`|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (/^##(?!#)\s*\S/.test(line)) heads.push(index)
  }

  const blocks: RawBlock[] = []
  for (let index = 0; index < heads.length; index += 1) {
    const startLine = heads[index]
    const endLine = index + 1 < heads.length ? heads[index + 1] : lines.length
    blocks.push({
      title: lines[startLine].replace(/^##\s*/, '').replace(/\s+$/, '').trim(),
      startOffset: offsets[startLine],
      endOffset: endLine < lines.length ? offsets[endLine] : text.length,
      lines: lines.slice(startLine, endLine)
    })
  }
  return { blocks, lines }
}

interface MetaSplit {
  meta: Record<string, string>
  bodyLines: string[]
}

/**
 * 把一个块切成「紧跟标题的连续 `- key: value` 行」与「其余正文」。
 *
 * 🔴 只认**六个已知键**：正文里的 `- 某个列表项: 说明` 不该被当成元数据吃掉。
 * 🔴 遇到重复键就停：重复意味着已经出了元数据区（真实文件不会有重复，但坏文件不该把正文吞掉）。
 */
function splitMeta(blockLines: string[]): MetaSplit {
  const meta: Record<string, string> = {}
  let index = 1
  while (index < blockLines.length && blockLines[index].trim() === '') index += 1
  while (index < blockLines.length) {
    const line = blockLines[index].replace(/\r$/, '')
    const match = META_LINE.exec(line)
    if (!match) break
    const key = match[1].trim()
    if (key !== META_KEY_ID && !SECONDARY_KEYS.includes(key) && key !== META_KEY_KEYWORDS) break
    if (Object.prototype.hasOwnProperty.call(meta, key)) break
    meta[key] = match[2].trim()
    index += 1
  }
  return { meta, bodyLines: blockLines.slice(index) }
}

/** 去掉正文首尾空行与结尾的 `---` 分隔线（分隔线属于「条目之间」的胶水，不是正文） */
function cleanBody(bodyLines: string[]): string {
  const lines = bodyLines.map((line) => line.replace(/\r$/, ''))
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length > 0 && lines[lines.length - 1].trim() === '---') {
    lines.pop()
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  }
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  return lines.join('\n').trim()
}

/**
 * 合规判定（A-13 / A-16 / M4）。
 *
 * 块内必须有 `- 触发词:`，且 `id / 常驻 / 优先级 / 内在价值 / 连带触发词` 中**至少再命中 2 个**。
 * 普通 md 的 `## 小节` 不含这些键 → 不合规 → **不列出**。
 */
export function isConformingEntry(blockText: string): boolean {
  const lines = (typeof blockText === 'string' ? blockText : '').split('\n')
  const { meta } = splitMeta(lines)
  if (!Object.prototype.hasOwnProperty.call(meta, META_KEY_KEYWORDS)) return false
  let hits = 0
  for (const key of SECONDARY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(meta, key)) hits += 1
  }
  return hits >= 2
}

/**
 * 解析一个文件里的**全部合规条目**。
 *
 * 🔴 不合规的 `## ` 段（普通小标题、README 的模板示例）直接跳过、不列出（G4 / T7）。
 * 🔴 缺 `id` 的合规条目**保留**并标 `missingId`（编辑时补），不静默丢弃。
 */
export function parseWorldbookFile(file: string, text: string): WorldbookEntry[] {
  const source = typeof text === 'string' ? text : ''
  const { blocks } = scanBlocks(source)
  const entries: WorldbookEntry[] = []
  for (const block of blocks) {
    if (!isConformingEntry(block.lines.join('\n'))) continue
    const { meta, bodyLines } = splitMeta(block.lines)
    const id = (meta[META_KEY_ID] ?? '').trim()
    entries.push({
      id,
      title: block.title,
      keywords: splitKeywords(meta[META_KEY_KEYWORDS] ?? ''),
      always: readAlways(meta[META_KEY_ALWAYS]),
      priority: readNumber(meta[META_KEY_PRIORITY], WORLDBOOK_DEFAULT_PRIORITY, WORLDBOOK_PRIORITY_MIN, WORLDBOOK_PRIORITY_MAX),
      value: readNumber(meta[META_KEY_VALUE], WORLDBOOK_DEFAULT_VALUE, WORLDBOOK_VALUE_MIN, WORLDBOOK_VALUE_MAX),
      chained: splitKeywords(meta[META_KEY_CHAINED] ?? ''),
      body: cleanBody(bodyLines),
      file,
      ...(id ? {} : { missingId: true })
    })
  }
  return entries
}

/** 一个条目序列化为 markdown 块（**不含**结尾的 `---`，由调用方加） */
export function serializeEntry(entry: WorldbookEntryDraft & { id: string }): string {
  const lines = [
    '## ' + String(entry.title ?? '').trim(),
    '- ' + META_KEY_ID + ': ' + String(entry.id ?? '').trim(),
    '- ' + META_KEY_KEYWORDS + ': ' + joinKeywords(entry.keywords),
    '- ' + META_KEY_ALWAYS + ': ' + (entry.always ? '是' : '否'),
    '- ' + META_KEY_PRIORITY + ': ' + String(readNumber(String(entry.priority), WORLDBOOK_DEFAULT_PRIORITY, WORLDBOOK_PRIORITY_MIN, WORLDBOOK_PRIORITY_MAX)),
    '- ' + META_KEY_VALUE + ': ' + String(readNumber(String(entry.value), WORLDBOOK_DEFAULT_VALUE, WORLDBOOK_VALUE_MIN, WORLDBOOK_VALUE_MAX)),
    '- ' + META_KEY_CHAINED + ': ' + joinKeywords(entry.chained)
  ]
  const body = String(entry.body ?? '').replace(/\r\n/g, '\n').trim()
  if (body) lines.push('', body)
  return lines.join('\n')
}

/**
 * 追加一条到文件末尾（A-02 / A-15）。
 *
 * 目标形态与真实文件一致：`…正文\n\n---\n`；新条目接在**最后一个分隔线之后**。
 * 空文件 / 零合规文件照样能写（A-15：不是「先有合规条目才能加」）。
 */
export function appendEntry(text: string, entry: WorldbookEntryDraft & { id: string }): string {
  const block = serializeEntry(entry)
  const head = String(text ?? '').replace(/\s+$/, '')
  if (!head) return block + '\n\n---\n'
  const endsWithSeparator = /(^|\n)---$/.test(head)
  const prefix = endsWithSeparator ? head + '\n\n' : head + '\n\n---\n\n'
  return prefix + block + '\n\n---\n'
}

export interface EntryBlockRange {
  /** 块起点（`## ` 行的行首） */
  start: number
  /** 块终点（下一条目 `## ` 行首，或文末） */
  end: number
  title: string
}

/** 按 id 找条目块在原文里的字符区间；找不到返回 null（**不猜位置**） */
export function findEntryBlock(text: string, id: string): EntryBlockRange | null {
  const wanted = String(id ?? '').trim()
  if (!wanted) return null
  const source = typeof text === 'string' ? text : ''
  const { blocks } = scanBlocks(source)
  for (const block of blocks) {
    if (!isConformingEntry(block.lines.join('\n'))) continue
    const { meta } = splitMeta(block.lines)
    if ((meta[META_KEY_ID] ?? '').trim() !== wanted) continue
    return { start: block.startOffset, end: block.endOffset, title: block.title }
  }
  return null
}

/**
 * 按**标题**找「缺 id」的条目块。
 *
 * 🔴 只服务一种场景：合规但**没有 `- id:` 行**的条目（P9 §4.2「保留并标缺 id，编辑时补」）。
 *    没有 id 就没有句柄，编辑 / 删除必须先能定位到它 —— 所以用标题当**临时句柄**。
 * 🔴 三条限制缺一不可（少一条就可能删错块）：
 *   ① 只匹配**没有 id** 的块（有 id 的一律走 id 路径，绝不按标题误伤）；
 *   ② 标题完全相等；
 *   ③ 命中必须**唯一**，同名缺 id 块有多个 → null（宁可报错也不猜）。
 */
export function findEntryBlockByTitle(text: string, title: string): EntryBlockRange | null {
  const wanted = String(title ?? '').trim()
  if (!wanted) return null
  const source = typeof text === 'string' ? text : ''
  const { blocks } = scanBlocks(source)
  const hits: EntryBlockRange[] = []
  for (const block of blocks) {
    if (!isConformingEntry(block.lines.join('\n'))) continue
    const { meta } = splitMeta(block.lines)
    if ((meta[META_KEY_ID] ?? '').trim()) continue
    if (block.title !== wanted) continue
    hits.push({ start: block.startOffset, end: block.endOffset, title: block.title })
  }
  return hits.length === 1 ? hits[0] : null
}

/**
 * 把块切成「条目文本」与「尾部分隔段」。
 *
 * 为什么要切：块区间包含**它自己的 `---` 分隔线**（到下一条目标题为止）。
 * 改写时要保住那一段，否则编辑 / 删除会把两个条目粘成一段（A-04 / A-05 守恒的前提）。
 */
function splitTail(raw: string): { block: string; tail: string } {
  const lines = raw.split('\n')
  let separatorAt = -1
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    if (lines[index].trim() === '---') {
      separatorAt = index
      break
    }
  }
  if (separatorAt < 0) return { block: raw.replace(/\s+$/, ''), tail: '' }
  return {
    block: lines.slice(0, separatorAt).join('\n').replace(/\s+$/, ''),
    tail: lines.slice(separatorAt).join('\n')
  }
}

/**
 * 原地替换一条（块级手术）：**只有目标块被重写，其余字节逐字不变**（A-05）。
 * 返回新全文；id 不存在 → null（调用方决定抛什么）。
 */
export function replaceEntryBlock(
  text: string,
  id: string,
  entry: WorldbookEntryDraft & { id: string },
  fallbackTitle?: string
): string | null {
  const source = typeof text === 'string' ? text : ''
  // id 为空（缺 id 的条目）时才用标题兜底 —— 见 findEntryBlockByTitle 的三条限制
  const range = findEntryBlock(source, id) ?? findEntryBlockByTitle(source, fallbackTitle ?? '')
  if (!range) return null
  const raw = source.slice(range.start, range.end)
  const { tail } = splitTail(raw)
  const rebuilt = serializeEntry(entry)
  const replacement = tail ? rebuilt + '\n\n' + tail : rebuilt + (raw.endsWith('\n') ? '\n' : '')
  return source.slice(0, range.start) + replacement + source.slice(range.end)
}

/**
 * 原地删除一条（块级手术）：**其余字节逐字不变**（A-04）。
 * 🔴 删除的是整段（`## ` 行到下一条目 `## ` 行之前），不是只删标题行（M2）。
 */
export function removeEntryBlock(text: string, id: string, fallbackTitle?: string): string | null {
  const source = typeof text === 'string' ? text : ''
  const range = findEntryBlock(source, id) ?? findEntryBlockByTitle(source, fallbackTitle ?? '')
  if (!range) return null
  return source.slice(0, range.start) + source.slice(range.end)
}

/**
 * 同文件内的重复触发词（A-17）—— **只用于 UI 标红，不阻断写入**（用户明确要求）。
 * 大小写不敏感；`excludeId` 是「正在编辑的这条」，它的词不算与别人重复。
 */
export function findDuplicateKeywords(
  entries: WorldbookEntry[],
  keywords: string[],
  excludeId?: string
): DuplicateKeyword[] {
  const wanted = new Map<string, string>()
  for (const word of Array.isArray(keywords) ? keywords : []) {
    const text = String(word ?? '').trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (!wanted.has(key)) wanted.set(key, text)
  }
  if (wanted.size === 0) return []
  const owners = new Map<string, string[]>()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (excludeId && entry.id === excludeId) continue
    for (const word of entry.keywords) {
      const key = String(word ?? '').trim().toLowerCase()
      if (!key || !wanted.has(key)) continue
      const list = owners.get(key) ?? []
      if (!list.includes(entry.title)) list.push(entry.title)
      owners.set(key, list)
    }
  }
  const result: DuplicateKeyword[] = []
  for (const [key, list] of owners) {
    result.push({ keyword: wanted.get(key) ?? key, owners: list })
  }
  return result
}
