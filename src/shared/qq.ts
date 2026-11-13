import { COMMAND_DEFAULT_THRESHOLDS } from './persona'
import type { CommandThresholds } from './persona'
import type { QqHostStatus } from './qqHost'

/**
 * QQ 侧的纯数据契约（主进程 / preload / 渲染进程共用）。
 *
 * 只放类型与常量，不放实现：绑定与设置的**落盘与校验**在
 * `src/main/features/qq/store.ts`，渲染层只读这里的形状。
 */

/** 外部会话类型。群临时会话（sub_type=group）按私聊处理，见 inbound.ts */
export type QqChatType = 'private' | 'group'

// P6：「外部会话 → 本机会话」的绑定类型已删除。
// 「哪条会话能响应」的唯一真源是 channels/access.json（见 shared/channels.ts），
// 会话 id 由外部键直接算出 —— 不再有「外部会话 → 本机会话」这层手工映射。

/** 出站切段与行为开关。默认值见 DEFAULT_QQ_SETTINGS。 */
export interface QqSettings {
  /** typing 模式（M12）：text = 发一条极短文本；status = set_input_status；off = 不做 */
  typingMode: 'text' | 'status' | 'off'
  /** typingMode='text' 时发什么 */
  typingText: string
  /** typingMode='status' 时的 event_type（未真机验证，做成设置项便于现场调，E4） */
  typingEventType: number
  /** 群聊是否必须 @ 才回应 */
  groupRequireMention: boolean
  /** 群聊回复时是否 @ 回发送者 */
  atOnGroupReply: boolean
  /** 段间延迟（ms），E12 */
  segmentDelayMs: number
  /** 单句段数上限，E10 */
  maxSegments: number
  /** 单段码点上限，E11 */
  maxCharsPerSegment: number
  /** 60 s 窗口内每用户上限 */
  rateLimitPerUser: number
  /** 60 s 窗口内每渠道上限 */
  rateLimitPerChannel: number
  /** 出错时回给对端的一句话（空串 = 不回） */
  errorReplyText: string
  /** P4：每条指令的门槛。缺字段 = 出厂值（见 COMMAND_DEFAULT_THRESHOLDS） */
  commandThresholds: CommandThresholds
}

export const DEFAULT_QQ_SETTINGS: QqSettings = {
  typingMode: 'text',
  typingText: '正在看…',
  typingEventType: 1,
  groupRequireMention: true,
  atOnGroupReply: true,
  segmentDelayMs: 500,
  maxSegments: 10,
  maxCharsPerSegment: 1500,
  rateLimitPerUser: 20,
  rateLimitPerChannel: 60,
  errorReplyText: '（这边卡住了，稍后再试）',
  commandThresholds: { ...COMMAND_DEFAULT_THRESHOLDS }
}

/** 数字字段的合法区间。越界一律钳制，不抛错（一个坏配置不该让 QQ 功能整体瘫痪）。 */
export const QQ_SETTINGS_LIMITS = {
  segmentDelayMs: { min: 0, max: 5000 },
  maxSegments: { min: 1, max: 20 },
  maxCharsPerSegment: { min: 200, max: 4000 },
  rateLimitPerUser: { min: 1, max: 1000 },
  rateLimitPerChannel: { min: 1, max: 1000 },
  typingEventType: { min: 0, max: 10 },
  typingText: { maxLength: 40 }
} as const

/** 入站归一化之后的一条消息 */
export interface QqInbound {
  uin: string
  chatType: QqChatType
  chatId: string
  /** OneBot message_id 的字符串形式；事件缺 id 时为空串（此时不做去重） */
  messageId: string
  senderId: string
  senderName: string
  /** 拼好的纯文本（只取 text 段；at 段记成 @名字；其他段记成 [类型]） */
  text: string
  /** 原始段数组，审计用 */
  segments: unknown[]
  /** 是否 @ 了机器人自己 */
  mentioned: boolean
  at: number
}

/** 这条事件为什么没进管线。UI 的「最近事件」按它显示。 */
export type QqDropReason =
  | 'not-message'
  | 'self-echo'
  | 'bad-chat'
  | 'non-text'
  | 'unbound'
  | 'no-permission'
  /** P9-R3：发言人不被允许（私聊不在账号白名单 / 群成员鉴权不通过） */
  | 'not-authorized-member'
  | 'not-mentioned'
  | 'duplicate'
  | 'rate-limited'
  | 'queue-full'

/** 「最近事件」里一条记录的判定结果 */
export type QqEventOutcome =
  | 'responded'
  | 'empty-reply'
  | 'failed'
  | 'error-reply'
  | `dropped-${QqDropReason}`

/** 渲染层「最近事件」列表的一项（只读，最后 N 条） */
export interface QqEventFeedItem {
  id: string
  at: number
  uin: string
  chatType: QqChatType | 'unknown'
  chatId: string
  senderName: string
  /** 文本预览（最多 60 字） */
  preview: string
  outcome: QqEventOutcome
  /** 附加说明（如错误原文、失败段数），可为空 */
  detail?: string
}

/** 计数统计。字段名与 QqDropReason 一一对应，便于排查「为什么不回我」。 */
export interface QqStats {
  received: number
  responded: number
  sent: number
  failed: number
  droppedNotMessage: number
  droppedSelfEcho: number
  droppedBadChat: number
  droppedNonText: number
  droppedUnbound: number
  /** 历史字段：v1 的「在白名单但 respond=false」。P9-R3 起群聊不再有这一位，保留只为兼容旧回执 */
  droppedNoPermission: number
  /** P9-R3：发言人不在白名单 / 未授予该场景权限（按**人**判） */
  droppedNotAuthorizedMember: number
  droppedNotMentioned: number
  droppedDuplicate: number
  droppedRateLimited: number
  droppedQueueFull: number
  /**
   * P4：成功执行的指令条数。
   *
   * 🔴 指令**不是**「回复」也不是「丢弃」：它没进模型，so 不占 responded / failed，
   *    也不属于任何一个 dropped-*（那些是「为什么没回」）。单独一位才好排查
   *    「为什么 //switch 没反应」——commands 与 commandsFailed 分开，才看得出是
   *    没被接住（两者都不动）还是接住但执行失败。
   */
  commands: number
  /** P4：接住但执行失败（人设不存在 / 越权 / 缺参数）的指令条数 */
  commandsFailed: number
  lastError: string | null
  lastEventAt: number | null
}

/**
 * 面板一次拉取的状态。
 *
 * 这里引用 QqHostStatus 是**纯类型 import**（编译期擦除），不破坏
 * shared 层的"零运行时依赖"约束；宿主侧根本不 import 本文件。
 */
export interface QqStatusPayload {
  host: QqHostStatus
  stats: QqStats
  /** userData/qq —— QQ 设置文件所在目录（绑定表已废弃，白名单在 userData/channels） */
  dataDir: string
}
