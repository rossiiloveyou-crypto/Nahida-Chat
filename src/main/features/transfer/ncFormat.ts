import { MAX_TRANSFER_BYTES, MAX_TRANSFER_MESSAGES, type ParsedTransfer } from '../../../shared/transfer'
import type { Message, Session } from '../../../shared/types'

export const NC_FORMAT = 'nc-sessions'
const NC_VERSION = 1
const roles = new Set<unknown>(['system', 'user', 'assistant', 'narration'])
const statuses = new Set<unknown>(['streaming', 'done', 'error'])
const modes = new Set<unknown>(['chat', 'agent', 'story'])
const callStatuses = new Set<unknown>(['awaiting', 'running', 'ok', 'error', 'denied'])

export function assertTransferByteLimit(text: string): void {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_TRANSFER_BYTES) {
    throw new Error(`对话文件大小为 ${bytes} 字节，超过 64 MiB（${MAX_TRANSFER_BYTES} 字节）上限`)
  }
}

export function assertTransferMessageLimit(count: number): void {
  if (count > MAX_TRANSFER_MESSAGES) {
    throw new Error(`对话文件有 ${count} 条消息，超过 ${MAX_TRANSFER_MESSAGES} 条上限`)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // JSON.parse 的异常可能包含源会话片段。
    return undefined
  }
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function validToolCall(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && typeof value.title === 'string' && typeof value.readOnly === 'boolean'
    && typeof value.arguments === 'string' && callStatuses.has(value.status)
    && nullableString(value.result) && nullableString(value.error)
    && Number.isFinite(value.startedAt) && (value.durationMs === null || Number.isFinite(value.durationMs))
}

function validMessage(value: unknown): value is Message {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && roles.has(value.role) && typeof value.content === 'string' && Number.isFinite(value.createdAt)
    && statuses.has(value.status)
    && ['reasoning', 'error', 'copiedFromMessageId'].every(key => !Object.hasOwn(value, key) || typeof value[key] === 'string')
    && (value.warnings === undefined || (Array.isArray(value.warnings) && value.warnings.every(item => typeof item === 'string')))
    && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(validToolCall)))
}

export function parseNc(text: string): ParsedTransfer {
  assertTransferByteLimit(text)
  const pack = readJson(text.replace(/^﻿/, ''))
  if (!isRecord(pack) || pack.format !== NC_FORMAT) throw new Error('缺少 NC 备份标记 format: nc-sessions')
  if (pack.version !== NC_VERSION) throw new Error('仅支持 NC 备份版本 1')
  if (!Array.isArray(pack.sessions) || !pack.sessions.length) throw new Error('NC 备份缺少会话')

  let count = 0
  for (const [i, session] of pack.sessions.entries()) {
    if (!isRecord(session) || typeof session.title !== 'string' || !Array.isArray(session.messages)) {
      throw new Error(`NC 备份的第 ${i + 1} 个会话格式无效`)
    }
    count += session.messages.length
  }
  assertTransferMessageLimit(count)

  const sessions: ParsedTransfer['sessions'] = pack.sessions.map((session, i) => {
    const messages = (session.messages as unknown[]).map((message, j) => {
      if (!validMessage(message)) throw new Error(`NC 备份第 ${i + 1} 个会话的第 ${j + 1} 条消息格式无效`)
      return message
    })
    return {
      title: session.title,
      messages,
      characterId: typeof session.characterId === 'string' ? session.characterId : undefined,
      mode: modes.has(session.mode) ? session.mode : undefined,
      createdAt: Number.isFinite(session.createdAt) ? session.createdAt : undefined,
      updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : undefined,
    }
  })

  return {
    format: 'nc', title: sessions[0].title, characterName: null, userName: null,
    sessions, skippedLines: 0, discardedFields: {},
  }
}

export function serializeNc(sessions: readonly Session[], exportedAt = Date.now()): string {
  return JSON.stringify({ format: NC_FORMAT, version: NC_VERSION, exportedAt, sessions }, null, 2) + '\n'
}
