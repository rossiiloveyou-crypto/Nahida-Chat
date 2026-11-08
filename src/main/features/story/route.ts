import { sessionPolicy } from '../chat/sessionPolicy'
import type { MemoryScopeId } from '@shared/zones'
import { isStoryId } from './paths'

/**
 * 这条会话的记忆该怎么走（P4 / T6）—— 全仓**唯一**的「故事记忆 vs 普通记忆」判定点。
 *
 * 两种完全不同的隔离机制，必须由一个函数分流，不许在两处各判一次（B2）：
 *   ① 故事区：**物理**隔离 —— 自己的库 + 自己的域 story:<storyId>
 *   ② 其余：  **逻辑**隔离 —— P5 的 sessionPolicy（zone:root / zone:<zoneId> / solo:<key>）
 *
 * 🔴 域 id 用 story:<storyId>，与 zone: / solo: 前缀并列，互相不可能撞。
 * 🔴 fail-closed：storyId 形状非法 → 当「不属于故事区」，而不是「随便给个库」。
 */
export interface MemoryRoute {
  /** 写到哪个库；null = 主库（userData/memory.db） */
  storyId: string | null
  /** 写到哪个域 */
  scope: MemoryScopeId
}

export function storyScope(storyId: string): MemoryScopeId {
  return 'story:' + storyId
}

export function memoryRouteOf(session: { id: string; storyId?: string | null }): MemoryRoute {
  const storyId = session.storyId ?? ''
  if (storyId && isStoryId(storyId)) return { storyId, scope: storyScope(storyId) }
  // 非故事会话：原样沿用 P5 的判定（chatService 原来就是这一行）。
  //
  // 🔴 偏离蓝图 §4.9 的一处：那里写的是 `primary || rootScope()` 兜底。
  //    实测它会破坏 P5 的 fail-closed —— `qq-session-policy` 有一条既有守卫
  //    「scopes = [] 的会话：抽取 0 次」当场变红，因为空串被兜成了 zone:root，
  //    于是「不该写记忆的会话」又开始往 root 域写。真实代码/既有守卫优先（总蓝图 · 执行者须知）。
  //    故事区不受影响：上面的分支一定返回非空 scope。
  const primary = sessionPolicy().primaryScope(session.id)
  return { storyId: null, scope: primary }
}
