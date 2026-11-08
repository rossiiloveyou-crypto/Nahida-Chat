import type { Session } from '@shared/types'

/**
 * 侧栏「对话」段应该显示的会话：先排除 story 会话，再按活动工作区过滤。
 *
 * 🔴 必须显式排除 story（J-09 / A-12）：故事会话会被并入 useChatStore.sessions
 *    （流式打字机要靠 ownedByWindow），而 activeWorkspace 为 null 时旧过滤会放全部会话进来，
 *    所以不能只靠 workspace 过滤。
 *
 * 这个文件不 import react / zustand / electron —— 纯数据，测试可直接 bundle。
 */
export function visibleDesktopSessions(sessions: Session[], activeWorkspaceId: string | null): Session[] {
  return sessions
    .filter((session) => !session.storyId)
    .filter((session) => (activeWorkspaceId ? (session.workspaceId ?? null) === activeWorkspaceId : true))
}
