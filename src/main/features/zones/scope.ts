import type { MemoryScopeId, Zone } from '@shared/zones'
import { ROOT_ZONE_ID, rootScope, soloScope, zoneIdFromScope, zoneScope } from '@shared/zones'
import { isChannelSessionId } from '@shared/channels'
import { zoneStore } from './store'

/**
 * 域解析（P5 G3 → P6 G6）——**全仓唯一的「这条会话属于哪个域」判定点**。
 *
 * P6 起判定次序是纯解析，不再查任何表：
 *  1. 这个 sessionId 不是渠道会话（isChannelSessionId = false）？→ ['zone:root']
 *  2. 它的外部键在某个区块里？                                → ['zone:<该区块>']
 *  3. 否则                                                    → ['solo:<外部键>']
 *
 * ⚠️ P5 在这里查绑定表（按 sessionId 反向查一条绑定），因为那时 QQ 会话 id 是 UUID，
 *    无法从 id 形态区分。P6 把会话 id 定义成外部键本身，这一跳就没有了。
 *
 * 🔴 `resolveRecallScopes` 返回**空数组 = 不召回**（fail-closed）。
 *    实现成「空数组退回全库」会把一次配置错误变成隐私泄漏。
 *    本实现永远只返回 1 个元素；数组是为了给 P7 留扩展位。
 */
export interface ScopeResolver {
  /** 一次运行的主域：记忆写到哪 */
  resolvePrimaryScope(sessionId: string): MemoryScopeId
  /** 这次召回允许读哪些域 */
  resolveRecallScopes(sessionId: string): MemoryScopeId[]
  /** 是否注入 owner 画像（用户资料 / 关系日志） */
  shouldInjectOwnerProfile(scopeId: MemoryScopeId): boolean
  /** 本域是否旁听群消息（P8 用；P6 只提供判定，不实现行为） */
  shouldObserveGroupMessages(externalKey: string): boolean
}

export interface ScopeSources {
  /** 区块来源。缺省用全局 zoneStore */
  zones?: Pick<typeof zoneStore, 'findZoneByExternalKey' | 'getZone'>
}

function primaryScope(
  sessionId: string,
  zones: Pick<typeof zoneStore, 'findZoneByExternalKey'>
): MemoryScopeId {
  if (!isChannelSessionId(sessionId)) return rootScope()
  const zone = zones.findZoneByExternalKey(sessionId)
  return zone ? zoneScope(zone.zoneId) : soloScope(sessionId)
}

function injectOwnerProfile(
  scopeId: MemoryScopeId,
  zones: Pick<typeof zoneStore, 'getZone'>
): boolean {
  const zoneId = zoneIdFromScope(scopeId)
  // solo 域（未归区的外部会话）读不到 owner 画像：它的语义就是「只读自己」
  if (!zoneId) return false
  if (zoneId === ROOT_ZONE_ID) {
    const root = zones.getZone(ROOT_ZONE_ID)
    return root ? root.config.injectOwnerProfile : true
  }
  const zone = zones.getZone(zoneId)
  return zone ? zone.config.injectOwnerProfile : false
}

export function createScopeResolver(sources: ScopeSources = {}): ScopeResolver {
  const zones = sources.zones ?? zoneStore
  return {
    resolvePrimaryScope: (sessionId: string) => primaryScope(sessionId, zones),
    resolveRecallScopes: (sessionId: string) => [primaryScope(sessionId, zones)],
    shouldInjectOwnerProfile: (scopeId: MemoryScopeId) => injectOwnerProfile(scopeId, zones),
    shouldObserveGroupMessages: (externalKey: string) => {
      const zone: Zone | null = zones.findZoneByExternalKey(externalKey)
      return zone ? zone.config.observeGroupMessages : false
    }
  }
}

/** 主进程默认解析器（区块表 = userData/zones.json） */
export const scopeResolver: ScopeResolver = createScopeResolver()

export function resolvePrimaryScope(sessionId: string): MemoryScopeId {
  return scopeResolver.resolvePrimaryScope(sessionId)
}

export function resolveRecallScopes(sessionId: string): MemoryScopeId[] {
  return scopeResolver.resolveRecallScopes(sessionId)
}

export function shouldInjectOwnerProfile(scopeId: MemoryScopeId): boolean {
  return scopeResolver.shouldInjectOwnerProfile(scopeId)
}

export function shouldObserveGroupMessages(externalKey: string): boolean {
  return scopeResolver.shouldObserveGroupMessages(externalKey)
}
