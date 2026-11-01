/**
 * 会话记忆策略的旁挂注册表（P4 G8，P5 区块升级）。
 *
 * 为什么不做成 Session 上的字段：Session 是三端契约（总蓝图 §七），
 * 加字段会同时打穿主进程 / preload / 渲染层，而且老会话要迁移。
 * chatService 只需要问一句「这条会话能读哪些域、写到哪个域」，实现由谁提供它不关心。
 *
 * P5 起真值来自 `main/features/zones/scope.ts`（绑定表 + zones.json），
 * 由 `qq/bridge.ts` 在启动时注册进来。
 */
export interface SessionPolicy {
  /**
   * P4 的二元隔离判定。
   * ⚠️ P5 起**生产路径不再使用**（chatService 改按域召回/抽取），保留它是为了让
   * `qq-bridge` 的既有断言继续成立；P6 之后可以删。
   */
  isMemoryIsolated(sessionId: string): boolean
  /**
   * 这次召回允许读哪些域。
   * 🔴 返回空数组 = 不召回（fail-closed）。别实现成「空数组退回全库」。
   */
  recallScopes(sessionId: string): string[]
  /** 一次运行的主域：记忆写到哪 */
  primaryScope(sessionId: string): string
  /** 是否注入 owner 画像（用户资料 / 关系日志） */
  injectOwnerProfile(sessionId: string): boolean
}

export const ROOT_SCOPE = 'zone:root'

function rootPolicy(): SessionPolicy {
  return {
    isMemoryIsolated: () => false,
    recallScopes: () => [ROOT_SCOPE],
    primaryScope: () => ROOT_SCOPE,
    injectOwnerProfile: () => true
  }
}

let current: SessionPolicy = rootPolicy()

export function setSessionPolicy(policy: SessionPolicy): void {
  current = policy
}

export function sessionPolicy(): SessionPolicy {
  return current
}

/** 测试用：把注册表恢复成「所有会话都用 root 域」（避免用例互相污染） */
export function resetSessionPolicy(): void {
  current = rootPolicy()
}
