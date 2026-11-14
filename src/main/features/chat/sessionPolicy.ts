/**
 * 会话记忆策略的旁挂注册表（P4 G8；P6 收编域解析）。
 *
 * 为什么不做成 Session 上的字段：Session 是三端契约（总蓝图 §七），
 * 加字段会同时打穿主进程 / preload / 渲染层，而且老会话要迁移。
 * chatService 只需要问一句「这条会话能读哪些域、写到哪个域」，实现由谁提供它不关心。
 *
 * 🔴 P6：域解析就住在本文件（`scopeOf`），**零查表**。
 *    P6 之前真值来自 `main/features/zones/scope.ts`（会话 id 解析 + zones.json），该文件与区块表
 *    已整体删除；全仓只剩这一个「这条会话属于哪个域」判定点（B2：同一语义只许一处）。
 *
 * P6 删掉的两个成员（`isMemoryIsolated` / `injectOwnerProfile`）：
 *   - `isMemoryIsolated`：P5 起 chatService 从不调用，只剩 qq-bridge 的自我断言。
 *   - `injectOwnerProfile`：从来没有消费者（「有开关但没行为」）。
 *   留着它们会让「域」这个概念多活一个 Phase，而隔离真值早已是 (user_id, persona_id)。
 */

/** 边界域。`route.scope` 的非空闸门取值，**不要改字符串**：既有断言与提示词按它写。 */
export const ROOT_SCOPE = 'zone:root'

/** 作用域 id。P6 之后只剩 `zone:root`（主库）与 `story:<storyId>`（故事区物理库）两种。 */
export type MemoryScopeId = string

export interface SessionPolicy {
  /**
   * 这次召回允许读哪些域。
   * 🔴 返回空数组 = 不召回（fail-closed）。别实现成「空数组退回全库」。
   */
  recallScopes(sessionId: string): string[]
  /** 一次运行的主域：记忆写到哪 */
  primaryScope(sessionId: string): string
}

/**
 * P6：这条会话写记忆时属于哪个域。**零查表**。
 *
 * 为什么还留这个函数：`story/route.ts` 用它填 `MemoryRoute.scope`，而那个字段是
 * `chatService` 的 **fail-closed 闸门**（空 = 不召回、不抽取）。闸门本身有价值
 * （「没有归属的会话不该写记忆」），只是 P6 之后它**永远非空**（故事区走另一支）。
 *
 * 🔴 参数故意保留但当前不用：将来若真要按会话区分，**只改这一处**（B2：判定只许一处）。
 * 🔴 不许在这里再引入第二种前缀来区分「档位」—— 那会制造第二套域语义，P6 就白删了。
 *    隔离的真值是 (user_id, persona_id) 租户，不是域。
 */
export function scopeOf(sessionId: string): MemoryScopeId {
  void sessionId
  return ROOT_SCOPE
}

function rootPolicy(): SessionPolicy {
  return {
    recallScopes: (sessionId: string) => [scopeOf(sessionId)],
    primaryScope: (sessionId: string) => scopeOf(sessionId)
  }
}

let current: SessionPolicy = rootPolicy()

export function setSessionPolicy(policy: SessionPolicy): void {
  current = policy
}

export function sessionPolicy(): SessionPolicy {
  return current
}

/** 测试用：把注册表恢复成「所有会话都用边界域」（避免用例互相污染） */
export function resetSessionPolicy(): void {
  current = rootPolicy()
}
