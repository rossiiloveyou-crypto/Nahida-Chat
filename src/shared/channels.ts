/**
 * 渠道授权的**共享契约**（P6 → P9-R3）。
 *
 * 🔴 v1 的「会话级白名单」已经**不是授权主体**了（用户 2026-11-02：
 *    「不是按照会话给权限，粒度太粗了」）。授权模型搬到了
 *    `shared/channelAccess.ts`：一个 QQ 号一条账号记录 + 一个群号一条群记录。
 *
 * 本文件保留的**只有会话身份的工具**（key 的拼装 / 反解 / 认不认得出是渠道会话）
 * 与两处仍需「会话维度」投影的展示类型：
 *
 *   ChannelAccessEntry  —— v1 条目的形状。**只剩迁移与兼容读**（store 的 normalizeConfig 读它）。
 *   UnzonedChannelItem  —— 区块面板的候选行（会话维度，由白名单投影而来）。
 *   ChannelPermissions  —— v1 权限位。同样只剩迁移用途。
 *
 * 「有条目」这套 v1 语义已由 `boundOf()`（bridge.ts）取代：
 *   群聊 = 群号在 groups[] 里；私聊 = 该号在 accounts[] 里。
 *
 * 本文件**零运行时依赖**（只 export 类型与纯函数），主进程 / preload / 渲染层都能直接引。
 * host 侧不 import 它。
 */

export type ChannelId = 'qq'
export type ChannelChatType = 'private' | 'group'

/** 会话 id 前缀（渠道会话 id = 外部键本身，见 channelSessionIdOf） */
const CHANNEL_SESSION_PREFIX = 'qq:'

/**
 * v1 的会话级权限位。
 *
 * 🔴 **P9-R3 起不再是授权判定的依据**（判定改按「人」，见 shared/channelAccess.ts）。
 *    它只剩两个用途：
 *      ① 迁移：v1 条目 → v2 账号/群时逐条读它（chatType='private' 的 respond → private 位）；
 *      ② 兼容：手改的老文件仍能被读进来，不必先跑迁移。
 */
export interface ChannelPermissions {
  /** 允许自动回复（触达模型） */
  respond: boolean
  /** 允许工具调用 */
  tool: boolean
}

export const DEFAULT_CHANNEL_PERMISSIONS: ChannelPermissions = {
  respond: true,
  tool: false
}

/**
 * v1 的一条白名单条目（**只剩迁移读它**）。
 * key 与 P4 的 bindingKey 完全同构（qq:<uin>:<chatType>:<chatId>）。
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
  /** 最近一次命中白名单的时间（0 = 从未） */
  lastAt: number
  createdAt: number
  updatedAt: number
}

/** v1 文件的整体形状。**只用于迁移读取**；v2 见 shared/channelAccess.ts */
export interface ChannelAccessFile {
  version: 1
  entries: ChannelAccessEntry[]
}

/** `channels:status` 的回执：让用户知道文件在哪 */
export interface ChannelStatusPayload {
  dataDir: string
  file: string
  /** 账号数 + 群数 */
  count: number
  accounts: number
  groups: number
}

/**
 * 「还没归区」的候选会话（P6 G8，P7 面板要用）—— **会话维度**的投影。
 *
 * 来源是白名单（v2 的 accounts + groups × 已知 uin），与「有没有说过话」彻底解耦。
 */
export interface UnzonedChannelItem {
  key: string
  uin: string
  chatType: ChannelChatType
  chatId: string
  /** 备注（群名 / 昵称），空串表示没填 */
  label: string
  /** 已经在某个区块里？是的话 zoneId 给出 */
  inZone: boolean
  zoneId: string | null
  /** 权限位（区块面板显示用，**判定不信它**） */
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
