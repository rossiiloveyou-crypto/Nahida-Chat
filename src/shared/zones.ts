/**
 * 区块（Zones）的纯数据契约（P5 G1）。
 *
 * 与 `shared/qqHost.ts` 同规矩：**零 import**，主进程 / preload / 渲染层都要能打进去。
 * 这里只有类型与字符串拼接，落盘、校验、不变量全在 main/features/zones/。
 *
 * 心智模型（M16，来自 Cyrene zones/types.ts）：
 *  - root 唯一、不可删、不可改名，**隐式包含全部桌面对话**（不落成员表）
 *  - 一个外部会话同一时刻只属于一个区块
 *  - root 至多挂 1 个 QQ 私聊；其余外部会话（群 / 未归区私聊）各自成区块或 solo 域
 */

/** 成员类型：只有「外部会话」进存储，桌面会话由 root 隐式包含 */
export type ZoneMemberKind = 'external'

/** 一个外部会话成员。key 直接复用 P4 的绑定键 qq:<uin>:<chatType>:<chatId>。 */
export interface ZoneExternalMember {
  kind: ZoneMemberKind
  /** 外部会话标识：P4 的绑定键，P5 直接复用（solo 域也是它） */
  key: string
  channel: 'qq'
  chatType: 'private' | 'group'
  /** 平台会话 id（群号 / QQ 号），仅供展示 */
  chatId: string
  displayName?: string
}

/** 区块级行为开关。P5 只存字段，行为在 P6（旁听）/ P7（画像）里实现。 */
export interface ZoneConfig {
  /** 是否把 owner 的画像（用户资料 / 关系日志）注入本域。群默认 false */
  injectOwnerProfile: boolean
  /** 是否在本域累积群语料（P6 用；P5 只存字段，不实现行为） */
  observeGroupMessages: boolean
}

export interface Zone {
  /** root 或 zone_<base36 时间戳>_<rand6> */
  zoneId: string
  zoneName: string
  /** root 唯一、不可删、不可改名 */
  isRoot: boolean
  createdAt: number
  config: ZoneConfig
  members: ZoneExternalMember[]
}

export interface ZonesFile {
  version: 1
  zones: Zone[]
}

export const ROOT_ZONE_ID = 'root'
export const ZONES_FILE_VERSION = 1

/** 作用域 id：zone:root / zone:<zoneId> / solo:<externalKey> */
export type MemoryScopeId = string

export function zoneScope(zoneId: string): MemoryScopeId {
  return 'zone:' + zoneId
}

export function rootScope(): MemoryScopeId {
  return zoneScope(ROOT_ZONE_ID)
}

export function soloScope(externalKey: string): MemoryScopeId {
  return 'solo:' + externalKey
}

export function isZoneScope(scopeId: MemoryScopeId): boolean {
  return typeof scopeId === 'string' && scopeId.startsWith('zone:')
}

export function isSoloScope(scopeId: MemoryScopeId): boolean {
  return typeof scopeId === 'string' && scopeId.startsWith('solo:')
}

/** zone:<id> → <id>；不是 zone 作用域时返回 null（不猜）。 */
export function zoneIdFromScope(scopeId: MemoryScopeId): string | null {
  if (!isZoneScope(scopeId)) return null
  const zoneId = scopeId.slice('zone:'.length)
  return zoneId || null
}

export interface ZoneDraft {
  zoneId?: string
  zoneName: string
}

export interface ZoneMemberDraft {
  zoneId: string
  key: string
  chatType: 'private' | 'group'
  chatId: string
  displayName?: string
}

/** 面板上的统计行：一个区块有多少成员、多少条记忆 */
export interface ZoneStat {
  zoneId: string
  memoryCount: number
  memberCount: number
}

export interface ZoneAdoptResult {
  zones: Zone[]
  added: number
  errors: string[]
}
