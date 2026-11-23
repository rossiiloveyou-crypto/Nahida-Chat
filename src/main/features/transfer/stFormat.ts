import { randomUUID } from 'node:crypto'
import { MAX_TRANSFER_MESSAGES, type ParsedTransfer, type TransferFormat } from '../../../shared/transfer'
import type { Message } from '../../../shared/types'
import { assertTransferByteLimit, assertTransferMessageLimit, isRecord, NC_FORMAT, parseNc, readJson } from './ncFormat'

const ST_HEADER_KEYS = ['chat_metadata', 'user_name', 'character_name']
const ST_DROPPED_KEYS = [
  'extra', 'chat_metadata', 'swipes', 'swipe_id', 'swipe_info', 'name',
  'force_avatar', 'title', 'gen_started', 'gen_finished',
]
const MAX_DATE = 8.64e15
const UNKNOWN_FORMAT = '未识别对话格式：缺少酒馆头行的 chat_metadata / user_name / character_name，或 NC 的 format: nc-sessions'

export interface ParseTransferOptions {
  mtimeMs?: number
  fallbackTitle?: string
}

/** 迭代物理行而不为整个文件分配行数组。空行和 UTF-8 BOM 不算坏行。 */
function* nonBlankLines(text: string): Generator<string> {
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (start < text.length) {
    const end = text.indexOf('\n', start)
    const line = text.slice(start, end < 0 ? text.length : end).trim()
    if (line) yield line
    if (end < 0) break
    start = end + 1
  }
}

function isStHeader(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ST_HEADER_KEYS.some(key => Object.hasOwn(value, key))
}

export function sniffTransferFormat(text: string): TransferFormat {
  assertTransferByteLimit(text)
  const first = nonBlankLines(text).next().value
  if (typeof first === 'string' && first.startsWith('{')) {
    const header = readJson(first)
    if (isRecord(header) && header.format === NC_FORMAT) return 'nc'
    if (isStHeader(header)) return 'st'
    // NC 可以是 pretty-printed JSON，所以检查整个根对象，仅看结构化字段。
    const pack = readJson(text.replace(/^\uFEFF/, ''))
    if (isRecord(pack) && pack.format === NC_FORMAT) return 'nc'
  }
  throw new Error(UNKNOWN_FORMAT)
}

export function parseTransfer(text: string, options?: ParseTransferOptions): ParsedTransfer {
  return sniffTransferFormat(text) === 'st' ? parseSt(text, options) : parseNc(text)
}

function validDate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_DATE
}

function parseSendDate(value: unknown): number | undefined {
  let time: number
  if (typeof value === 'string') {
    time = Date.parse(value)
    if (validDate(time)) return time
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return undefined
    value = Number(value)
  }
  if (typeof value !== 'number') return undefined
  time = value < 1e12 ? value * 1000 : value
  return validDate(time) ? Math.trunc(time) : undefined
}

function countDropped(row: Record<string, unknown>, counts: Record<string, number>): void {
  for (const key of ST_DROPPED_KEYS) {
    if (Object.hasOwn(row, key)) counts[key] = (counts[key] ?? 0) + 1
  }
}

function readName(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
}

const PLACEHOLDER_NAMES = new Set([
  'unused', 'unknown', 'null', 'undefined', 'n/a', 'na', 'none', '-', '—', 'character', '角色', 'assistant',
])

/** 展示标题和角色候选共用；原始头行名保留在解析结果中供诊断。 */
export function resolveStName(characterName: unknown, fallbackTitle?: string): string | null {
  const usable = (value: unknown): string | null => {
    const name = readName(value)
    return name && !PLACEHOLDER_NAMES.has(name.toLowerCase()) ? name : null
  }
  return usable(characterName)
    ?? usable(readName(fallbackTitle)?.replace(/(?:^| )- (?:\d{4}-\d{2}-\d{2}@.*|[^@]+@\d{1,2}(?:h|:).*)$/, ''))
}

export function parseSt(text: string, options: ParseTransferOptions = {}): ParsedTransfer {
  assertTransferByteLimit(text)
  const lines = nonBlankLines(text)
  const first = lines.next().value
  const header = typeof first === 'string' ? readJson(first) : undefined
  if (!isStHeader(header)) throw new Error(UNKNOWN_FORMAT)

  const characterName = readName(header.character_name)
  const userName = readName(header.user_name)
  const title = resolveStName(characterName, options.fallbackTitle) ?? '导入的对话'
  const discardedFields: Record<string, number> = {}
  countDropped(header, discardedFields)

  const fallback = options.mtimeMs ?? 0
  let previous: number | undefined
  let count = 0
  let skippedLines = 0
  const messages: Message[] = []
  for (const line of lines) {
    const row = readJson(line)
    if (!isRecord(row) || !['mes', 'is_user', 'is_system'].some(key => Object.hasOwn(row, key))
      || (row.mes != null && !['string', 'number', 'boolean'].includes(typeof row.mes))) {
      skippedLines++
      continue
    }
    count++
    // 超限之后只统计实际条数，不再分配消息，也不返回部分结果。
    if (count > MAX_TRANSFER_MESSAGES) continue
    countDropped(row, discardedFields)
    const createdAt = parseSendDate(row.send_date) ?? (previous === undefined
      ? (validDate(fallback) ? Math.trunc(fallback) : 0)
      : Math.min(previous + 1000, MAX_DATE))
    previous = createdAt
    messages.push({
      id: randomUUID(),
      role: row.is_user === true ? 'user' : row.is_system === true ? 'system' : 'assistant',
      content: String(row.mes ?? ''),
      createdAt,
      status: 'done',
    })
  }
  assertTransferMessageLimit(count)

  for (let i = 1; i < messages.length; i++) {
    messages[i].createdAt = Math.max(messages[i].createdAt, messages[i - 1].createdAt)
  }
  return {
    format: 'st', title, characterName, userName, sessions: [{ title, messages }],
    skippedLines, discardedFields,
  }
}

export function serializeSt(
  messages: readonly Message[],
  { userName, characterName }: { userName: string; characterName: string },
): { text: string; narrationCount: number } {
  const lines = [JSON.stringify({ chat_metadata: {}, user_name: userName, character_name: characterName })]
  let narrationCount = 0
  for (const message of messages) {
    const isUser = message.role === 'user'
    if (message.role === 'narration') narrationCount++
    if (!validDate(message.createdAt)) throw new Error('消息时间无效，无法生成酒馆 ISO 日期')
    lines.push(JSON.stringify({
      name: isUser ? userName : characterName,
      is_user: isUser,
      is_system: message.role === 'system',
      send_date: new Date(message.createdAt).toISOString(),
      mes: message.content,
      extra: {},
    }))
  }
  return { text: lines.join('\n') + '\n', narrationCount }
}
