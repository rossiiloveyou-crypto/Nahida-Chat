import type { QqChatType, QqDropReason, QqInbound } from '@shared/qq'

/**
 * 入站归一化 + 过滤（P4 G4）。
 *
 * 🔴 过滤顺序不可换，每条都有理由（蓝图 §4.7）：
 *  1. post_type === 'message'  —— SL 把**自己发出去的回声**标成 message_sent（E9）；
 *     只判 message_type 会造成自问自答死循环（J-15）。
 *  2. user_id !== self_id —— 双保险。
 *  3. message_type ∈ private/group —— 群临时会话（sub_type=group）仍算私聊，允许。
 *  4. chatId 非空。
 *  5. 文本 trim 后非空 —— 纯图片/表情 P4 不回（媒体出站是非目标），但要计数。
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function idOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function toSegments(message: unknown): unknown[] {
  if (Array.isArray(message)) return message
  // 字符串格式（message_format:'string'）不解析 CQ 码：整串当一段 text
  if (typeof message === 'string' && message.trim()) {
    return [{ type: 'text', data: { text: message } }]
  }
  return []
}

const NON_TEXT_LABEL: Record<string, string> = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  face: '[表情]',
  mface: '[表情]',
  json: '[卡片]',
  xml: '[卡片]'
}

/** 段 → 纯文本。raw_message 不用（那是 CQ 码字符串，含转义，E8）。 */
export function textFromSegments(segments: unknown[]): string {
  const parts: string[] = []
  for (const item of segments) {
    const segment = asRecord(item)
    if (!segment) continue
    const type = typeof segment.type === 'string' ? segment.type : ''
    const data = asRecord(segment.data) ?? {}
    if (type === 'text') {
      if (typeof data.text === 'string') parts.push(data.text)
      continue
    }
    if (type === 'at') {
      const qq = idOf(data.qq)
      if (qq) parts.push(qq === 'all' ? '@全体成员' : '@' + qq)
      continue
    }
    if (type === 'reply') {
      // 引用段没有可读文本，不进正文（引用回复本身是非目标）
      continue
    }
    parts.push(NON_TEXT_LABEL[type] ?? '[未知:' + (type || '?') + ']')
  }
  return parts.join('').trim()
}

/** @ 判定：只认 qq === selfId。'all'（@全体成员）**不算**叫她，否则群里每句话都会回。 */
export function isMentionedSelf(segments: unknown[], selfId: string): boolean {
  if (!selfId) return false
  return segments.some((item) => {
    const segment = asRecord(item)
    return segment !== null && segment.type === 'at' && idOf(asRecord(segment.data)?.qq) === selfId
  })
}

export interface InboundRejection {
  ok: false
  reason: QqDropReason
  uin: string
  chatType: QqChatType | 'unknown'
  chatId: string
  senderName: string
  preview: string
}

export type InboundResult = { ok: true; inbound: QqInbound } | InboundRejection

/** 过滤 + 归一化的完整结果。桥需要 reason 才能计数，normalizeInbound 只是它的窄投影。 */
export function inboundOutcome(
  uin: string,
  event: unknown,
  selfId: string,
  now: number = Date.now()
): InboundResult {
  const raw = asRecord(event)
  const reject = (reason: QqDropReason, chatType: QqChatType | 'unknown', chatId: string): InboundRejection => {
    const sender = asRecord(raw?.sender) ?? {}
    return {
      ok: false,
      reason,
      uin,
      chatType,
      chatId,
      senderName: idOf(sender.card) || idOf(sender.nickname),
      preview: ''
    }
  }

  if (!raw) return reject('not-message', 'unknown', '')

  const postType = typeof raw.post_type === 'string' ? raw.post_type : ''
  if (postType !== 'message') {
    return reject(postType === 'message_sent' ? 'self-echo' : 'not-message', 'unknown', '')
  }

  const senderId = idOf(raw.user_id)
  if (selfId && senderId === selfId) return reject('self-echo', 'unknown', '')

  const messageType = typeof raw.message_type === 'string' ? raw.message_type : ''
  const groupId = idOf(raw.group_id)
  let chatType: QqChatType
  let chatId: string
  if (messageType === 'private') {
    chatType = 'private'
    chatId = senderId
  } else if (messageType === 'group') {
    chatType = 'group'
    chatId = groupId
  } else {
    return reject('bad-chat', 'unknown', '')
  }
  if (!chatId) return reject('bad-chat', chatType, '')

  const segments = toSegments(raw.message)
  const message = textFromSegments(segments)
  const sender = asRecord(raw.sender) ?? {}
  const senderName = idOf(sender.card) || idOf(sender.nickname) || senderId
  const messageId = idOf(raw.message_id) || idOf(raw.message_seq)

  // 🔴 「有没有人真的说了字」与「拼出来的文本」是两件事：纯图片消息拼出来是 '[图片]'，
  // 非空但不是可回答的内容。判据是「存在非空 text 段或 at 段」——
  // 否则群里每张图都会触发一次模型调用（P4 不做媒体出站）。
  const hasText = segments.some((item) => {
    const segment = asRecord(item)
    if (!segment) return false
    if (segment.type === 'at') return true
    if (segment.type !== 'text') return false
    const data = asRecord(segment.data) ?? {}
    return typeof data.text === 'string' && data.text.trim().length > 0
  })

  if (!hasText || !message) {
    return {
      ok: false,
      reason: 'non-text',
      uin,
      chatType,
      chatId,
      senderName,
      preview: ''
    }
  }

  return {
    ok: true,
    inbound: {
      uin,
      chatType,
      chatId,
      messageId,
      senderId,
      senderName,
      text: message,
      segments,
      mentioned: isMentionedSelf(segments, selfId),
      at: now
    }
  }
}

/** 蓝图约定的窄入口：只关心"进不进管线"。 */
export function normalizeInbound(
  uin: string,
  event: unknown,
  selfId: string,
  now: number = Date.now()
): QqInbound | null {
  const result = inboundOutcome(uin, event, selfId, now)
  return result.ok ? result.inbound : null
}
