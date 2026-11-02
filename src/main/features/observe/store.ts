import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import type { ObserveConversation, ObserveRecord, ObserveStatus } from '@shared/observe'
import {
  OBSERVE_DIR_NAME,
  OBSERVE_SEGMENT_BYTES,
  OBSERVE_TAIL_BYTES,
  OBSERVE_WARN_BYTES,
  isSafeSegment
} from '@shared/observe'

/**
 * 旁听库（P8 G2）。真源：userData/observe/qq/<uin>/<chatType>/<chatId>[.N].jsonl
 *
 * 🔴 两条铁律（改动前先读 PHASE-8 §4.0 裁决）：
 *  1. **只增不清**：本类**没有** remove / truncate / archive / rewrite 方法。
 *     唯一会写已有文件的方式是 open('a') —— 每次 append 都是纯追加。
 *  2. **不做 mtime 缓存**（与 channels/store.ts 同理由，见 P6 §4.2 / 总蓝图 J-23）。
 *     外部（用户、编辑器、别的实例）随时可能动这些文件，缓存会把外部写入覆盖掉。
 *
 * 🔴 采集资格**不在这里判定**。本类是哑存储：「给我一条记录我就追加」。
 *    谁有资格被记录由 bridge + 白名单决定（见 bridge.ts 的 shouldObserve / PHASE-8 §4.3）。
 *
 * 🔴 与 cyrene-agent 的 history-log 的分歧（原话抄自用户「只增不清」裁决）：
 *    cyrene: 超 200 行截断 + 按月归档搬家  ⇒ 旧数据从原文件消失
 *    这里  : 超 OBSERVE_SEGMENT_BYTES 开新分片 ⇒ 任何一行都永远留在它当初写入的那个文件里
 */

/** 构造函数可选项。测试用它把分片阈值调到 200 字节，生产用默认值。 */
export interface ObserveStoreOptions {
  /** 库根目录，默认 userData/observe */
  root?: string
  /** 单片上限，默认 OBSERVE_SEGMENT_BYTES（32 MiB） */
  segmentBytes?: number
  /** 读尾部的默认字节窗口，默认 OBSERVE_TAIL_BYTES（256 KiB） */
  tailBytes?: number
}

/** 一次 append 的实测耗时（ms）。bridge 用它判断是否要改成队列（§九 K2）。 */
export interface ObserveAppendTiming {
  file: string
  bytes: number
  ms: number
}

export class ObserveStore {
  private readonly rootPath: string
  private readonly segmentBytes: number
  private readonly tailBytes: number
  /** 最近一次 append 的耗时，供 §十二 12.3「同步写实测耗时」取证 */
  private lastAppend: ObserveAppendTiming | null = null

  constructor(options: ObserveStoreOptions | string = {}) {
    const opts: ObserveStoreOptions = typeof options === 'string' ? { root: options } : options
    this.rootPath = opts.root ?? join(app.getPath('userData'), OBSERVE_DIR_NAME)
    this.segmentBytes = opts.segmentBytes ?? OBSERVE_SEGMENT_BYTES
    this.tailBytes = opts.tailBytes ?? OBSERVE_TAIL_BYTES
  }

  get root(): string {
    return this.rootPath
  }

  /** 最近一次 append 的实测（毫秒 / 字节 / 落地文件）。null = 还没写过。 */
  lastAppendTiming(): ObserveAppendTiming | null {
    return this.lastAppend ? { ...this.lastAppend } : null
  }

  /** 会话目录：root/qq/<uin>/<chatType> */
  private dirOf(uin: string, chatType: 'private' | 'group'): string {
    if (!isSafeSegment(uin)) throw new Error('非法 uin')
    if (chatType !== 'private' && chatType !== 'group') throw new Error('非法 chatType')
    return join(this.rootPath, 'qq', uin, chatType)
  }

  /**
   * 追加一行。**同步写**（理由见 PHASE-8 §九 K2 的取舍说明）。
   *
   * 分片选择：从 <chatId>.jsonl 开始，找到第一个 size < segmentBytes 的；都不行就新开一片。
   * 注意：只**新建**分片，**永不**改写旧分片。
   */
  append(record: ObserveRecord): void {
    if (!isSafeSegment(record.chatId)) throw new Error('非法 chatId')
    if (!isSafeSegment(record.uin)) throw new Error('非法 uin')
    if (record.chatType !== 'private' && record.chatType !== 'group') throw new Error('非法 chatType')
    const dir = this.dirOf(record.uin, record.chatType)
    mkdirSync(dir, { recursive: true })
    const file = this.pickSegment(dir, record.chatId)
    const line = JSON.stringify(record) + '\n'
    const startedAt = Date.now()
    // 'a' = 追加。即使另一个实例同时在写，O_APPEND 保证不会互相覆盖（最多交错，不会丢）
    const fd = openSync(file, 'a')
    try {
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
    this.lastAppend = { file, bytes: Buffer.byteLength(line, 'utf8'), ms: Date.now() - startedAt }
  }

  /**
   * 挑当前可写的分片。
   *
   * ⚠️ 实测成本（`scripts/probe-observe-latency.mjs`，500 条）：
   *   默认 32 MiB 分片 → **0.112 ms/条**（一次 stat，可忽略）
   *   人为压到 200 B（每行一片）→ **6.706 ms/条**（每片一行，每次都要从 1 数到 N，O(n²)）
   * 所以「分片阈值不要调小」不是洁癖：调小会让写入变成平方级。
   * 真要改小，改之前先跑那个探针，超过 2 ms/条就按 §九 K2 换「队列 + 批量刷」。
   */
  private pickSegment(dir: string, chatId: string): string {
    const first = join(dir, chatId + '.jsonl')
    if (!existsSync(first)) return first
    for (let n = 1; n < 10000; n += 1) {
      const file = n === 1 ? first : join(dir, chatId + '.' + n + '.jsonl')
      if (!existsSync(file)) return file // 上一片刚好满了被跳过，这里补空位
      const size = statSync(file).size
      if (size < this.segmentBytes) return file
    }
    // 10000 片还不行，说明单片上限被改小了或数据异常。宁可报错也不覆盖
    throw new Error('分片过多，拒绝写入')
  }

  /** 读某会话最近 limit 行（从文件尾往前读，不整文件读入） */
  readTail(
    uin: string,
    chatType: 'private' | 'group',
    chatId: string,
    limit: number
  ): ObserveRecord[] {
    if (!isSafeSegment(chatId)) return []
    if (!isSafeSegment(uin)) return []
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
    const dir = this.dirOf(uin, chatType)
    if (!existsSync(dir)) return []
    // 从**最新**分片往前凑，凑够 limit 就停（只读旧片尾部，不整片读）
    const files = this.segmentsOf(dir, chatId)
    const out: ObserveRecord[] = []
    for (let i = files.length - 1; i >= 0 && out.length < safeLimit; i -= 1) {
      const chunk = this.readTailBytes(files[i], this.tailBytes)
      const rows = chunk
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => parseLine(line))
        .filter((row): row is ObserveRecord => row !== null)
      out.unshift(...rows.slice(-(safeLimit - out.length)))
    }
    return out.slice(-safeLimit)
  }

  /** 所有会话的汇总（面板 D 区用）。目录遍历，数量级是「有几个群」，不是「有几行」 */
  listConversations(): ObserveConversation[] {
    const result: ObserveConversation[] = []
    const qqRoot = join(this.rootPath, 'qq')
    if (!existsSync(qqRoot)) return result
    for (const uin of safeReaddir(qqRoot)) {
      if (!isSafeSegment(uin)) continue
      for (const chatType of ['private', 'group'] as const) {
        const dir = join(qqRoot, uin, chatType)
        if (!existsSync(dir)) continue
        const byChat = new Map<string, string[]>()
        for (const name of safeReaddir(dir)) {
          // <chatId>.jsonl 或 <chatId>.<n>.jsonl
          const match = /^([0-9A-Za-z_-]+)(?:\.(\d+))?\.jsonl$/.exec(name)
          if (!match) continue
          const chatId = match[1]
          const list = byChat.get(chatId) ?? []
          list.push(join(dir, name))
          byChat.set(chatId, list)
        }
        for (const [chatId, files] of byChat) {
          const segments = files.sort((a, b) => segmentOrdinal(a) - segmentOrdinal(b))
          let bytes = 0
          let lines = 0
          for (const file of segments) {
            const size = statSync(file).size
            bytes += size
            lines += countLinesApprox(file)
          }
          const last = this.readTail(uin, chatType, chatId, 1)[0]
          result.push({
            key: channelKeyFor(uin, chatType, chatId),
            uin,
            chatType,
            chatId,
            label: last?.chatLabel || last?.entryLabel || '',
            segments: segments.length,
            bytes,
            lines,
            lastAt: last?.at ?? 0
          })
        }
      }
    }
    return result.sort((a, b) => b.lastAt - a.lastAt)
  }

  /** 汇总状态。warnBytes 可选 —— 测试用它把阈值压到 1 字节。 */
  status(warnBytes: number = OBSERVE_WARN_BYTES): ObserveStatus {
    const conversations = this.listConversations()
    const totalBytes = conversations.reduce((sum, item) => sum + item.bytes, 0)
    const files = conversations.reduce((sum, item) => sum + item.segments, 0)
    return {
      root: this.rootPath,
      conversations: conversations.length,
      files,
      totalBytes,
      totalLines: conversations.reduce((sum, item) => sum + item.lines, 0),
      warnBytes,
      warn: totalBytes > warnBytes
    }
  }

  private segmentsOf(dir: string, chatId: string): string[] {
    return safeReaddir(dir)
      .filter((name) => {
        const match = /^([0-9A-Za-z_-]+)(?:\.(\d+))?\.jsonl$/.exec(name)
        return match !== null && match[1] === chatId
      })
      .map((name) => join(dir, name))
      .sort((a, b) => segmentOrdinal(a) - segmentOrdinal(b))
  }

  /** 只读文件尾部 bytes 字节（流式，不整文件读） */
  private readTailBytes(file: string, bytes: number): string {
    const size = statSync(file).size
    const length = Math.min(bytes, size)
    const start = size - length
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      let text = buffer.toString('utf8')
      // 起点可能落在半行中间：丢掉第一段不完整的行
      if (start > 0) {
        const nl = text.indexOf('\n')
        text = nl >= 0 ? text.slice(nl + 1) : ''
      }
      return text
    } finally {
      closeSync(fd)
    }
  }
}

/** 单行解析：坏行返回 null（**绝不**因为一行坏了就重写文件） */
export function parseLine(line: string): ObserveRecord | null {
  try {
    const raw = JSON.parse(line) as Partial<ObserveRecord>
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.at !== 'number' || typeof raw.chatId !== 'string') return null
    return raw as ObserveRecord
  } catch {
    return null
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function segmentOrdinal(file: string): number {
  const match = /\.(\d+)\.jsonl$/.exec(file)
  return match ? Number(match[1]) : 1
}

/** 大致行数：分块读整片数换行（只在 status 时调；不会一次分配 32 MiB） */
function countLinesApprox(file: string): number {
  const CHUNK = 1024 * 1024
  let fd: number | null = null
  try {
    const size = statSync(file).size
    let count = 0
    let offset = 0
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, size)))
    while (offset < size) {
      const read = readSync(fd, buffer, 0, buffer.length, offset)
      if (read <= 0) break
      for (let i = 0; i < read; i += 1) if (buffer[i] === 10) count += 1
      offset += read
    }
    return count
  } catch {
    return 0
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 关不掉也不影响已算出的行数 */
      }
    }
  }
}

function channelKeyFor(uin: string, chatType: 'private' | 'group', chatId: string): string {
  return 'qq:' + uin + ':' + chatType + ':' + chatId
}

/** 主进程默认实例 */
export const observeStore = new ObserveStore()

/** 造一条最小合法记录（测试与将来的重放工具用；生产走 bridge 的 buildRecord） */
export function makeRecord(patch: Partial<ObserveRecord> & Pick<ObserveRecord, 'uin' | 'chatType' | 'chatId'>): ObserveRecord {
  const base: ObserveRecord = {
    v: 1,
    id: 'ob-' + randomUUID(),
    at: Date.now(),
    sessionId: channelKeyFor(patch.uin, patch.chatType, patch.chatId),
    key: channelKeyFor(patch.uin, patch.chatType, patch.chatId),
    channel: 'qq',
    uin: patch.uin,
    chatType: patch.chatType,
    chatId: patch.chatId,
    chatLabel: '',
    entryLabel: '',
    messageId: '',
    speakerId: '',
    speakerName: '',
    speakerCard: '',
    isBot: false,
    mentioned: false,
    triggered: false,
    allowed: true,
    outcome: 'responded',
    text: '',
    segmentTypes: ['text']
  }
  return { ...base, ...patch }
}
