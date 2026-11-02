import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import type {
  QqChatType,
  QqInbound,
  QqDropReason,
  QqEventFeedItem,
  QqEventOutcome,
  QqSettings,
  QqStats
} from '@shared/qq'
import { channelKeyOf, channelSessionIdOf, isChannelSessionId } from '@shared/channels'
import type { ChannelAccessConfig } from '@shared/channelAccess'
import { findAccount, findGroup, resolveMessageAccess } from '@shared/channelAccess'
import type { ObserveOutcome, ObserveRecord } from '@shared/observe'
import { observeStore } from '../observe/store'
import type { QqActionResult, QqHostEventMessage } from '@shared/qqHost'
import type { ChatSink, ChatTurnOutcome } from '../chat/sink'
import { chatService } from '../chat/chatService'
import { setSessionPolicy } from '../chat/sessionPolicy'
import { createScopeResolver } from '../zones/scope'
import { channelStore } from '../channels/store'
import { qqHost } from './host'
import { inboundOutcome } from './inbound'
import { createKeyedQueue } from './queue'
import { splitForQq } from './segment'
import { qqStore } from './store'
import { QqSink } from './sink'

/**
 * 入站 → 模型 → 出站 的编排核心（P4 G2/G4/G5）。
 *
 * 流水线严格按序（蓝图 §4.9）：
 *  归一化（E9 自回环在这一层）→ 白名单 → @ 判定 → 去重 → 双键串行 →
 *  限速 → typing → await 整轮 → 切段 → 逐段发送（段间延迟）
 *
 * 所有依赖都可注入：A7 用纯假 deps 跑这条链路，不需要 QQ、不需要模型。
 */

const DEDUPE_TTL_MS = 10 * 60_000
const RATE_WINDOW_MS = 60_000
const FEED_MAX = 50
const DEDUPE_PRUNE_AT = 500

export interface QqBridgeDeps {
  host: {
    on(event: 'event', cb: (msg: QqHostEventMessage) => void): unknown
    invokeAction(uin: string, action: string, params?: Record<string, unknown>): Promise<QqActionResult>
  }
  chat: {
    sendAwait(input: { sessionId: string; content: string }, sink: ChatSink): Promise<ChatTurnOutcome>
  }
  store: {
    /**
     * P9-R3：授权配置来源（账号 + 群 + 两个总开关）。
     * 替换 P6 的 `access(): ChannelAccessEntry[]` —— 会话级条目已不再是授权主体。
     */
    access(): ChannelAccessConfig
    settings(): QqSettings
    /** 记一次命中（P7 面板的「最近活动」）。可选，测试里可以不给 */
    touchAccess?(key: string, at: number): void
    /**
     * 记下机器人自己的登录号（P9-R3）。可选。
     *
     * 为什么需要：群白名单存的是**群号**，区块 / 旁听要的是会话键 qq:<uin>:group:<群号>。
     * 没有 uin 就把群展不开成会话（区块面板会看不到它）。
     */
    rememberUin?(uin: string): void
  }
  /**
   * P8：旁听库。**可选** —— 不注入 = 不旁听（测试与将来的重放工具用）。
   * 生产接线在 startQqBridge() 里注入 observeStore。
   * 写盘失败**绝不能**影响回复，见 §4.4.3。
   */
  observe?: { append(record: ObserveRecord): void }
  /** P6：渠道会话的幂等创建。不注入时用全局 chatService */
  ensureSession?: (sessionId: string, title: string) => unknown
  broadcast: (channel: string, payload: unknown) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface QqBridge {
  /** 直接喂一条事件（测试与将来的重放工具用；宿主订阅也走它） */
  handleEvent(uin: string, event: unknown): Promise<void>
  stats(): QqStats
  /** 最后 N 条判定记录（面板的「最近事件」是实时推送的，这里供测试与排障） */
  feed(): QqEventFeedItem[]
  /** 解绑宿主监听（测试收尾；生产进程生命周期内不需要） */
  stop(): void
}

export function emptyStats(): QqStats {
  return {
    received: 0,
    responded: 0,
    sent: 0,
    failed: 0,
    droppedNotMessage: 0,
    droppedSelfEcho: 0,
    droppedBadChat: 0,
    droppedNonText: 0,
    droppedUnbound: 0,
    droppedNoPermission: 0,
    droppedNotAuthorizedMember: 0,
    droppedNotMentioned: 0,
    droppedDuplicate: 0,
    droppedRateLimited: 0,
    droppedQueueFull: 0,
    lastError: null,
    lastEventAt: null
  }
}

const DROP_COUNTER: Record<QqDropReason, keyof QqStats> = {
  'not-message': 'droppedNotMessage',
  'self-echo': 'droppedSelfEcho',
  'bad-chat': 'droppedBadChat',
  'non-text': 'droppedNonText',
  unbound: 'droppedUnbound',
  'no-permission': 'droppedNoPermission',
  'not-authorized-member': 'droppedNotAuthorizedMember',
  'not-mentioned': 'droppedNotMentioned',
  duplicate: 'droppedDuplicate',
  'rate-limited': 'droppedRateLimited',
  'queue-full': 'droppedQueueFull'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function oneBotId(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value
}

function previewOf(text: string): string {
  return Array.from(text.trim()).slice(0, 60).join('')
}

/* ── P8：旁听（§4.3 采集资格 / §4.4 单点写入 / §4.5 原始事件取群名） ───────── */

/** 环境变量应急开关。设了 NC_OBSERVE=0 / false / off / no 就停采（已有文件一个字节不动）。 */
function observeDisabled(): boolean {
  const raw = String(process.env.NC_OBSERVE ?? '').trim().toLowerCase()
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no'
}

function rawRecord(event: unknown): Record<string, unknown> | null {
  return typeof event === 'object' && event !== null ? (event as Record<string, unknown>) : null
}

/**
 * 这条消息要不要进旁听库（PHASE-8 §4.3，2026-11-01 按「P8 = 群语料」修订）。
 * 只做判定，不写盘 —— 写盘在 finally 里一次性完成（§4.4）。
 *
 *   R1 群聊：一律采，不管在不在白名单（「加白之前的历史已经在攒了」）
 *   R2 私聊：只在白名单里才采（私聊没有「旁观」语义）
 *   R3 有非空文本（纯图片/语音不算语料）
 *
 * ⚠️ 区块开关 observeGroupMessages 在这里**不读**（见 §4.3 末尾的说明）。
 */
export function shouldObserve(chatType: QqChatType, bound: boolean, text: string): boolean {
  if (observeDisabled()) return false
  if (!text.trim()) return false
  if (chatType === 'group') return true
  return bound
}

/**
 * 这条会话「在不在白名单」的 v2 判定（P9-R3）。
 *
 *  群聊：群号在 `groups[]` 里 → true（与「群里谁能触发她」是两个问题）
 *  私聊：这个号在 `accounts[]` 里 → true
 *
 * ⚠️ 它**不看** permissions 的任何一个位，只回答「名单里有没有」。
 *    这正是旁听库里 allowed 字段的语义（P8 §4.4）。
 */
export function boundOf(
  config: ChannelAccessConfig,
  chatType: QqChatType,
  chatId: string
): boolean {
  if (chatType === 'group') return findGroup(config.groups, chatId) !== null
  return findAccount(config.accounts, chatId) !== null
}

/** 白名单里的备注 / 群名（面板与旁听都用它，空串表示没填） */
export function labelOf(
  config: ChannelAccessConfig,
  chatType: QqChatType,
  chatId: string
): string {
  if (chatType === 'group') return findGroup(config.groups, chatId)?.label ?? ''
  return findAccount(config.accounts, chatId)?.label ?? ''
}

/** 从 OneBot 原始事件里读群名。只读不改：QqInbound 保持原样，三端契约不动。 */
function groupNameOf(event: unknown): string {
  const value = rawRecord(event)?.group_name
  return typeof value === 'string' ? value : ''
}

/** 群名片（sender.card）。空卡时由调用方回落昵称，这里只报事实。 */
function senderCardOf(event: unknown): string {
  const sender = rawRecord(rawRecord(event)?.sender)
  const card = sender?.card
  return typeof card === 'string' ? card : ''
}

/** 段的类型名列表，去重。**绝不**序列化 data（data 里可能有 base64 文件）。 */
export function segmentTypesOf(segments: unknown[]): string[] {
  const types: string[] = []
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = rawRecord(seg)?.type
    if (typeof type === 'string' && !types.includes(type)) types.push(type)
  }
  return types
}

/** 由 outcome 反推 triggered，**不单独维护一个布尔**（§4.4.3 第 3 条）。 */
const TRIGGERED_OUTCOMES: ReadonlySet<ObserveOutcome> = new Set<ObserveOutcome>([
  'responded',
  'empty-reply',
  'failed',
  'error-reply'
])

export function triggeredOf(outcome: ObserveOutcome): boolean {
  return TRIGGERED_OUTCOMES.has(outcome)
}

/**
 * 造一行旁听记录（纯函数，便于单测）。
 *
 * triggered / outcome 先给占位值，由调用方在 finally 里覆盖 ——
 * 这样即使某条出口忘了赋值，行也会被写下来（兜底值一眼就能看出问题，见 §九 K5）。
 */
export function buildRecord(
  uin: string,
  inbound: QqInbound,
  bound: boolean,
  entryLabel: string,
  rawEvent: unknown
): ObserveRecord {
  const key = channelKeyOf(inbound.uin, inbound.chatType, inbound.chatId)
  return {
    v: 1,
    id: 'ob-' + randomUUID(),
    at: inbound.at,
    sessionId: channelSessionIdOf(key),
    key,
    channel: 'qq',
    uin,
    chatType: inbound.chatType,
    chatId: inbound.chatId,
    chatLabel: groupNameOf(rawEvent),
    entryLabel,
    messageId: inbound.messageId,
    speakerId: inbound.senderId,
    speakerName: inbound.senderName,
    speakerCard: senderCardOf(rawEvent),
    isBot: inbound.senderId === uin,
    mentioned: inbound.mentioned,
    triggered: false,
    allowed: bound,
    outcome: 'dropped-queue-full',
    text: inbound.text,
    segmentTypes: segmentTypesOf(inbound.segments)
  }
}

export function createQqBridge(deps: QqBridgeDeps): QqBridge {
  const queue = createKeyedQueue({ maxPendingPerKey: 8 })
  const dedupe = new Map<string, number>()
  const userHits = new Map<string, number[]>()
  const channelHits = new Map<string, number[]>()
  const feedItems: QqEventFeedItem[] = []
  const stats = emptyStats()
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let seq = 0

  // 记忆域（G8 → P5 G5 → P6 G6）：域由「会话 id 解析 + zones.json」决定，不再查绑定表。
  // P6 的判定等价于「这个 id 是不是渠道会话」—— 绑定表已废，UUID 桌面会话不可能再变成 QQ 会话。
  const scopeResolver = createScopeResolver()
  const ensureSession =
    deps.ensureSession ??
    ((sessionId: string, title: string) => chatService.ensureChannelSession(sessionId, { title }))
  setSessionPolicy({
    // P6：等价于「是不是渠道会话」（绑定表已下线）
    isMemoryIsolated: (sessionId: string) => isChannelSessionId(sessionId),
    recallScopes: (sessionId: string) => scopeResolver.resolveRecallScopes(sessionId),
    primaryScope: (sessionId: string) => scopeResolver.resolvePrimaryScope(sessionId),
    injectOwnerProfile: (sessionId: string) =>
      scopeResolver.shouldInjectOwnerProfile(scopeResolver.resolvePrimaryScope(sessionId))
  })

  function record(
    fields: Omit<QqEventFeedItem, 'id' | 'at'> & { at?: number }
  ): void {
    seq += 1
    const item: QqEventFeedItem = {
      id: 'qqe-' + String(seq),
      at: fields.at ?? now(),
      uin: fields.uin,
      chatType: fields.chatType,
      chatId: fields.chatId,
      senderName: fields.senderName,
      preview: fields.preview,
      outcome: fields.outcome,
      ...(fields.detail ? { detail: fields.detail } : {})
    }
    feedItems.push(item)
    if (feedItems.length > FEED_MAX) feedItems.shift()
    deps.broadcast(IPC.qqEvent, item)
  }

  function countDrop(reason: QqDropReason, fields: {
    uin: string
    chatType: QqChatType | 'unknown'
    chatId: string
    senderName: string
    preview: string
    detail?: string
  }): void {
    const counter = DROP_COUNTER[reason]
    // 动态列名访问：值与 QqStats 的数值字段一一对应（见 DROP_COUNTER 的类型约束）
    ;(stats as unknown as Record<string, number>)[counter] += 1
    record({ ...fields, outcome: ('dropped-' + reason) as QqEventOutcome })
  }

  function allowHit(map: Map<string, number[]>, key: string, limit: number): boolean {
    const at = now()
    const hits = (map.get(key) ?? []).filter((time) => at - time < RATE_WINDOW_MS)
    if (hits.length >= limit) {
      map.set(key, hits)
      return false
    }
    hits.push(at)
    map.set(key, hits)
    return true
  }

  async function sendTyping(uin: string, chatId: string, settings: QqSettings): Promise<void> {
    if (settings.typingMode === 'off') return
    try {
      if (settings.typingMode === 'text') {
        if (!settings.typingText.trim()) return
        await deps.host.invokeAction(uin, 'send_private_msg', {
          user_id: oneBotId(chatId),
          message: [{ type: 'text', data: { text: settings.typingText } }]
        })
        return
      }
      await deps.host.invokeAction(uin, 'set_input_status', {
        user_id: oneBotId(chatId),
        event_type: settings.typingEventType
      })
    } catch (error) {
      // C6：typing 是锦上添花，绝不能阻断正文发送
      console.warn('[qq] typing 发送失败：' + errorMessage(error))
    }
  }

  async function sendText(uin: string, chatType: QqChatType, chatId: string, text: string): Promise<boolean> {
    if (!text.trim()) return false
    const action = chatType === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params: Record<string, unknown> = {
      message: [{ type: 'text', data: { text } }]
    }
    if (chatType === 'group') params.group_id = oneBotId(chatId)
    else params.user_id = oneBotId(chatId)
    try {
      const result = await deps.host.invokeAction(uin, action, params)
      if (!result.ok) {
        stats.lastError = result.error ?? 'send failed'
        console.warn('[qq] 发送失败：' + stats.lastError)
        return false
      }
      stats.sent += 1
      return true
    } catch (error) {
      stats.lastError = errorMessage(error)
      console.warn('[qq] 发送异常：' + stats.lastError)
      return false
    }
  }

  /** 逐段发送；单段失败不中断后续段（C4），全部失败才算整体失败。 */
  async function sendSegments(
    uin: string,
    chatType: QqChatType,
    chatId: string,
    parts: string[],
    options: { atFirst: boolean; atUserId: string; delayMs: number }
  ): Promise<number> {
    const action = chatType === 'group' ? 'send_group_msg' : 'send_private_msg'
    let okCount = 0
    for (let index = 0; index < parts.length; index += 1) {
      const segments: unknown[] = []
      if (chatType === 'group' && options.atFirst && index === 0) {
        segments.push({ type: 'at', data: { qq: oneBotId(options.atUserId) } })
      }
      segments.push({ type: 'text', data: { text: parts[index] } })
      const params: Record<string, unknown> = { message: segments }
      if (chatType === 'group') params.group_id = oneBotId(chatId)
      else params.user_id = oneBotId(chatId)

      try {
        const result = await deps.host.invokeAction(uin, action, params)
        if (result.ok) {
          okCount += 1
          stats.sent += 1
        } else {
          stats.lastError = result.error ?? 'send failed'
          console.warn('[qq] 第 ' + String(index + 1) + ' 段发送失败：' + stats.lastError)
        }
      } catch (error) {
        stats.lastError = errorMessage(error)
        console.warn('[qq] 第 ' + String(index + 1) + ' 段发送异常：' + stats.lastError)
      }

      if (index < parts.length - 1 && options.delayMs > 0) await sleep(options.delayMs)
    }
    return okCount
  }

  /**
   * 真正跑一轮。**返回真实 outcome**（P8 §4.4.4）：
   * finally 里要用它反推 triggered 并写进旁听行，绝不在外层再猜一次。
   */
  async function processInbound(
    sessionId: string,
    key: string,
    inbound: QqInbound,
    settings: QqSettings
  ): Promise<ObserveOutcome> {
    const base = {
      uin: inbound.uin,
      chatType: inbound.chatType,
      chatId: inbound.chatId,
      senderName: inbound.senderName,
      preview: previewOf(inbound.text)
    }

    // 10. 限速（在管道内：排队期间不计入，比较的是"真正开始处理"的时刻）
    if (!allowHit(userHits, key + ':' + inbound.senderId, settings.rateLimitPerUser)) {
      countDrop('rate-limited', { ...base, detail: '用户 ' + inbound.senderId + ' 超限' })
      return 'dropped-rate-limited'
    }
    if (!allowHit(channelHits, key, settings.rateLimitPerChannel)) {
      countDrop('rate-limited', { ...base, detail: '渠道超限' })
      return 'dropped-rate-limited'
    }

    // 11. typing：只在"正要送进模型"这一刻、且只在私聊（M12）
    if (inbound.chatType === 'private') {
      await sendTyping(inbound.uin, inbound.chatId, settings)
    }

    // C2：群聊正文前缀发言人，否则模型不知道是谁在说话
    const content =
      inbound.chatType === 'group'
        ? '[群聊 ' + inbound.senderName + '(' + inbound.senderId + ')]\n' + inbound.text
        : inbound.text

    // P9-R3：把发言人挂到 sink 上。工具闸门在 chatService.runTool 里按它判权限。
    const sink = new QqSink(deps.broadcast, inbound.senderId)
    let outcome: ChatTurnOutcome
    try {
      outcome = await deps.chat.sendAwait({ sessionId, content }, sink)
    } catch (error) {
      // C7：sendAwait 的 rejection 必须在这里收口，不能让队列变成 unhandledRejection
      stats.failed += 1
      stats.lastError = errorMessage(error)
      record({ ...base, outcome: 'failed', detail: stats.lastError })
      if (settings.errorReplyText.trim()) {
        await sendText(inbound.uin, inbound.chatType, inbound.chatId, settings.errorReplyText)
      }
      return 'failed'
    } finally {
      // typing 收尾：status 模式发 event_type 0（text 模式不用收尾，那是正文之一）
      if (inbound.chatType === 'private' && settings.typingMode === 'status') {
        try {
          await deps.host.invokeAction(inbound.uin, 'set_input_status', {
            user_id: oneBotId(inbound.chatId),
            event_type: 0
          })
        } catch (error) {
          console.warn('[qq] typing 收尾失败：' + errorMessage(error))
        }
      }
    }

    if (outcome.status === 'error') {
      stats.failed += 1
      stats.lastError = outcome.error ?? '生成失败'
      record({ ...base, outcome: 'error-reply', detail: stats.lastError })
      if (settings.errorReplyText.trim()) {
        await sendText(inbound.uin, inbound.chatType, inbound.chatId, settings.errorReplyText)
      }
      return 'error-reply'
    }

    // C1：正文用 outcome.content（done 的权威全文），不用 sink.content
    const parts = splitForQq(outcome.content, {
      maxSegments: settings.maxSegments,
      maxChars: settings.maxCharsPerSegment
    })
    if (parts.length === 0) {
      record({ ...base, outcome: 'empty-reply' })
      return 'empty-reply'
    }

    const okCount = await sendSegments(inbound.uin, inbound.chatType, inbound.chatId, parts, {
      atFirst: inbound.chatType === 'group' && settings.atOnGroupReply,
      atUserId: inbound.senderId,
      delayMs: settings.segmentDelayMs
    })

    if (okCount > 0) {
      stats.responded += 1
      // 「最近活动」在闸门处已经记过一次（命中白名单的时刻），这里不再重复写盘（K7）
      record({
        ...base,
        outcome: 'responded',
        detail: String(okCount) + '/' + String(parts.length) + ' 段'
      })
      return 'responded'
    }
    stats.failed += 1
    record({ ...base, outcome: 'failed', detail: '全部段发送失败' })
    return 'failed'
  }

  async function handleEvent(uin: string, event: unknown): Promise<void> {
    stats.received += 1
    stats.lastEventAt = now()

    const eventRecord =
      typeof event === 'object' && event !== null ? (event as Record<string, unknown>) : null
    const selfId = eventRecord && eventRecord.self_id !== undefined ? String(eventRecord.self_id) : uin

    // 1-2. 归一化（含 message_sent 自回环过滤）
    const result = inboundOutcome(uin, event, selfId, now())
    if (!result.ok) {
      countDrop(result.reason, {
        uin,
        chatType: result.chatType,
        chatId: result.chatId,
        senderName: result.senderName,
        preview: result.preview
      })
      return
    }
    const inbound = result.inbound

    const key = channelKeyOf(inbound.uin, inbound.chatType, inbound.chatId)
    const settings = deps.store.settings()
    // P9-R3：授权配置（按人 + 按群 + 两个总开关）。每条消息读一次盘（store 不做缓存，J-23）
    const access = deps.store.access()
    const bound = boundOf(access, inbound.chatType, inbound.chatId)
    // 机器人自己的登录号要记下来：群白名单存的是群号，区块 / 旁听要的是会话键 qq:<uin>:group:<群号>
    deps.store.rememberUin?.(inbound.uin)

    // ── P8：旁听（§4.3 采集资格 / §4.4 单点写入）───────────────────────────
    //
    // 入口在**归一化成功之后**（2026-11-01 修订）：群聊要全采，unbound 的群消息也得记。
    // 写入收敛到**一个** finally 里，不散落在各个 return 上 ——
    // 散着写必然出现「加一个出口就忘了加一次 append」。
    //
    // 三件不变量：
    //  1. 只判定一次：pending 为 null 就什么都不写。
    //  2. outcome 初值不是 'responded'：兜底成 dropped-queue-full，漏赋值时一眼看得出（K5）。
    //  3. triggered 由 outcome 反推，不单独维护布尔（§4.4.3-3）。
    // let 而非常量：去重分支是**唯一**一处「丢弃但不记录」的出口（§4.3），要把 pending 清空。
    /** 事件上下文（丢弃记录用），一次造好，各出口共用 —— 少写一份预览就少一处走样 */
    const base = {
      uin,
      chatType: inbound.chatType,
      chatId: inbound.chatId,
      senderName: inbound.senderName,
      preview: previewOf(inbound.text)
    }
    let pending: ObserveRecord | null = shouldObserve(inbound.chatType, bound, inbound.text)
      ? buildRecord(uin, inbound, bound, labelOf(access, inbound.chatType, inbound.chatId), event)
      : null
    /** 兜底值：走到没预料到的出口时行照样写下来，统计里 queue-full 会异常变大（K5） */
    let outcome: ObserveOutcome = 'dropped-queue-full'

    try {
      // ── 闸门顺序（P9-R3 §15.6.2）。**副作用一律排在所有判定之后**（J-56 / F-01）──
      //
      //   私聊：① 准入（按**发言人**判，始终校验）
      //   群聊：① 群是否加白 → ② 是否 @ 她 → ③ 成员鉴权（groupMemberGate，默认关闭）
      //   两者共同：④ ensureSession + touchAccess → ⑤ 去重 → ⑥ 队列
      //
      // 为什么 ④ 必须在 ① ② ③ 之后：
      //   F-01 实测过「未 @ 的消息也建会话、也全量写一次 access.json」——
      //   群里刷屏 = 每条都读一次写一次。J-56：挡住 ≠ 没副作用，副作用必须排在判定之后。
      if (inbound.chatType === 'private') {
        // ① 私聊准入：**按发言人判**（plus 的 classifyQqEvent 同款）。
        //    私聊没有「旁观」语义：陌生号发消息 → 直接丢，不进模型。
        const decision = resolveMessageAccess(access, {
          channel: 'qq',
          chatType: 'private',
          senderId: inbound.senderId
        })
        if (decision.blocked) {
          countDrop('not-authorized-member', { ...base, detail: decision.reason })
          outcome = 'dropped-not-authorized-member'
          return
        }
      } else {
        // ① 群白名单：这个群允不允许她说话。注意旁听在**这之前**就写完了 ——
        //    未加白的群照样攒语料（M32「P8 就是群语料」）。
        if (!bound) {
          countDrop('unbound', { ...base })
          outcome = 'dropped-unbound'
          return
        }
        // ② 必须 @（既有闸门，位置不变）
        if (settings.groupRequireMention && !inbound.mentioned) {
          countDrop('not-mentioned', { ...base })
          outcome = 'dropped-not-mentioned'
          return
        }
        // ③ 群成员鉴权（groupMemberGate，**默认关闭**）。
        //    关闭 = 群里谁 @ 她都回（现状）；打开 = 只有 QQ 号白名单里的人能触发。
        const memberDecision = resolveMessageAccess(access, {
          channel: 'qq',
          chatType: 'group',
          senderId: inbound.senderId
        })
        if (memberDecision.blocked) {
          countDrop('not-authorized-member', { ...base, detail: memberDecision.reason })
          outcome = 'dropped-not-authorized-member'
          return
        }
      }

      // ④ 会话 id = 外部键（P6 核心）。第一次收到消息时凭空建出来，之后一直复用。
      const sessionId = channelSessionIdOf(key)
      ensureSession(sessionId, labelOf(access, inbound.chatType, inbound.chatId) || inbound.chatId)
      deps.store.touchAccess?.(key, now())

      // 7. 去重（必须在队列之外：重放的同一事件不能排队两次）
      //
      //  🔴 去重键**必须带 chatType + chatId**（P8 附二 B / J-59）：
      //     message_id 只在单个会话内唯一，群 A 与群 B 完全可能撞同一个 id。
      //     旧的 uin:messageId 会让后到的那条被静默丢弃 ——「消息偶尔少了，但没有任何报错」。
      if (inbound.messageId) {
        const dedupeKey =
          inbound.uin + ':' + inbound.chatType + ':' + inbound.chatId + ':' + inbound.messageId
        const expiry = dedupe.get(dedupeKey)
        if (expiry !== undefined && expiry > now()) {
          countDrop('duplicate', { ...base })
          outcome = 'dropped-duplicate'
          // §4.3：duplicate 是唯一「丢弃但不记录」的 drop 原因 ——
          // 同一 message_id 的重放，原文已经记过一次，再记一行会让「这个群说过什么」出现复读。
          pending = null
          return
        }
        dedupe.set(dedupeKey, now() + DEDUPE_TTL_MS)
        if (dedupe.size > DEDUPE_PRUNE_AT) {
          const at = now()
          for (const [id, until] of dedupe) {
            if (until <= at) dedupe.delete(id)
          }
        }
      }

      // 8-9. 双键串行：同外部会话串行 + 同 NC 会话串行（P6 起两者其实同构，保留双键是零成本）
      const outer = queue.run('ext:' + key, () =>
        queue.run('session:' + sessionId, () => processInbound(sessionId, key, inbound, settings))
      )
      try {
        outcome = await outer
      } catch (error) {
        const message = errorMessage(error)
        if (message.startsWith('queue_full:')) {
          countDrop('queue-full', { ...base })
          outcome = 'dropped-queue-full'
        } else {
          stats.failed += 1
          stats.lastError = message
          record({ ...base, outcome: 'failed', detail: message })
          outcome = 'failed'
        }
      }
    } finally {
      // §4.4.3-1：写盘是**次生副作用**。失败少一行语料可接受，抛出去用户看不到回复不可接受。
      if (pending && deps.observe) {
        pending.outcome = outcome
        pending.triggered = triggeredOf(outcome)
        try {
          deps.observe.append(pending)
        } catch (error) {
          // 不重试：重试会写出重复行
          console.warn('[observe] 写入失败：' + errorMessage(error))
        }
      }
    }
  }

  const unsubscribe = deps.host.on('event', (msg) => {
    void handleEvent(msg.uin, msg.event)
  })

  return {
    handleEvent,
    stats: () => ({ ...stats }),
    feed: () => [...feedItems],
    stop: () => {
      if (typeof unsubscribe === 'function') (unsubscribe as () => void)()
    }
  }
}

/* ── 生产接线 ───────────────────────────────────────────────────────────── */

/** 广播到所有存活窗口。渲染层 store 对未知 sessionId 是空操作（E18），所以可以广广播。 */
export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(channel, payload)
  }
}

let activeBridge: QqBridge | null = null

/** 在 startQqHost() 之后调用一次。重复调用返回同一个实例。 */
export function startQqBridge(): QqBridge {
  if (activeBridge) return activeBridge
  activeBridge = createQqBridge({
    host: qqHost,
    chat: { sendAwait: (input, sink) => chatService.sendAwait(input, sink) },
    store: {
      access: () => channelStore.config(),
      settings: () => qqStore.settings(),
      touchAccess: (key, at) => channelStore.touch(key, at),
      rememberUin: (uin) => channelStore.addUin(uin)
    },
    // P8：旁听库。这是**生产环境唯一的写入注入点**（§6.1 I1 守卫盯着这句）。
    observe: observeStore,
    broadcast: broadcastToWindows
  })
  return activeBridge
}

export function qqBridge(): QqBridge | null {
  return activeBridge
}

export function qqStats(): QqStats {
  return activeBridge ? activeBridge.stats() : emptyStats()
}
