/**
 * 渠道授权（P6）——外部聊天对象 ↔ 本机权限的**唯一真源**。
 *
 * 与 P4 绑定表的区别（这是本 Phase 的核心变更）：
 *   绑定表             : 外部会话 → **手工绑一条 NC 会话**（sessionId 是外来 UUID）
 *   ChannelAccessEntry : 外部会话 → **权限位**；会话 id 由外部键直接算出来
 *
 * 「有条目」= 在白名单里；「respond=false」= 在白名单里但不自动回复（P8 的旁听就用它）。
 * 没有任何条目 = 完全不响应、不旁听、不落库。
 *
 * 本文件**零运行时依赖**（只 export 类型与纯函数），主进程 / preload / 渲染层都能直接引。
 * host 侧不 import 它。
 */

export type ChannelId = 'qq'
export type ChannelChatType = 'private' | 'group'

/** 会话 id 前缀（渠道会话 id = 外部键本身，见 channelSessionIdOf） */
const CHANNEL_SESSION_PREFIX = 'qq:'

/** 权限位。P6 只存，P9 才按 tool 拦截；respond 在 P6 就生效（bridge 闸门） */
export interface ChannelPermissions {
  /** 允许自动回复（触达模型） */
  respond: boolean
  /** 允许工具调用（P9 生效；P6 仅存值） */
  tool: boolean
}

export const DEFAULT_CHANNEL_PERMISSIONS: ChannelPermissions = {
  respond: true,
  tool: false
}

/**
 * 一条白名单条目。
 * key 与 P4 的 bindingKey 完全同构（qq:<uin>:<chatType>:<chatId>），
 * 目的：zones.json 里已存在的成员 key **一个字节都不用改**（P6 §4.7 断言 A6）。
 */
export interface ChannelAccessEntry {
  key: string
  channel: ChannelId
  uin: string
  chatType: ChannelChatType
  chatId: string
  /** 群名 / 昵称。空串表示用户没填；UI 显示时回落 chatId */
  label: string
  permissions: ChannelPermissions
  /** 最近一次命中白名单的时间（0 = 从未）。P7 面板按它排序 */
  lastAt: number
  createdAt: number
  updatedAt: number
}

/** `userData/channels/access.json` 的整体形状 */
export interface ChannelAccessFile {
  version: 1
  entries: ChannelAccessEntry[]
}

/** 新建 / 修改白名单时提交的草稿 */
export interface ChannelAccessDraft {
  channel?: ChannelId
  uin: string
  chatType: ChannelChatType
  chatId: string
  label?: string
  permissions?: Partial<ChannelPermissions>
}

/** `channels:status` 的回执：让用户知道文件在哪（和 QqStatusPayload.dataDir 同一思路） */
export interface ChannelStatusPayload {
  dataDir: string
  file: string
  count: number
}

/**
 * 「还没归区」的候选会话（P6 G8，P7 面板要用）。
 *
 * 只有白名单条目才会出现在这里：加了白名单就能在区块面板里看到它，
 * 与「有没有说过话」彻底解耦（用户明确要求的行为，M20）。
 */
export interface UnzonedChannelItem {
  key: string
  uin: string
  chatType: ChannelChatType
  chatId: string
  /** 白名单 label（群名/昵称），空串表示没填 */
  label: string
  /** 已经在某个区块里？是的话 zoneId 给出 */
  inZone: boolean
  zoneId: string | null
  /** 权限位（P7 面板显示用；P6 只是带出去） */
  permissions: ChannelPermissions
  lastAt: number
}

/** key 的构造。与 P4 `qq/store.ts` 里那份键拼接逻辑必须产生同一字符串。 */
export function channelKeyOf(
  uin: string,
  chatType: ChannelChatType,
  chatId: string,
  channel: ChannelId = 'qq'
): string {
  return channel + ':' + uin + ':' + chatType + ':' + chatId
}

/** key 的反解。任何不合形状的串一律 null（不抛错） */
export function parseChannelKey(
  key: string
): { channel: ChannelId; uin: string; chatType: ChannelChatType; chatId: string } | null {
  if (typeof key !== 'string') return null
  const parts = key.split(':')
  if (parts.length !== 4) return null
  const [channel, uin, chatType, chatId] = parts
  if (channel !== 'qq') return null
  if (chatType !== 'private' && chatType !== 'group') return null
  if (!uin || !chatId) return null
  return { channel, uin, chatType, chatId }
}

/**
 * 这条会话 id 是不是渠道会话？
 *
 * ⚠️ 只用前缀 + `parseChannelKey` 两道判定，**不靠 UUID 形态反推**
 * （桌面会话现在是 UUID，但没有契约保证以后还是）。
 */
export function isChannelSessionId(sessionId: string): boolean {
  if (typeof sessionId !== 'string') return false
  if (!sessionId.startsWith(CHANNEL_SESSION_PREFIX)) return false
  return parseChannelKey(sessionId) !== null
}

/** 渠道会话 id 就是外部键（P6 的核心简化） */
export function channelSessionIdOf(key: string): string {
  return key
}
