import { NavLink, useNavigate } from 'react-router-dom'
import type { ConversationMode } from '@shared/types'
import { useChatStore } from '../features/chat/store'
import { WorkspaceSection } from '../features/workspace/WorkspaceSection'
import { useWorkspaces } from '../features/workspace/useWorkspaces'

export function Sidebar() {
  const navigate = useNavigate()
  const sessions = useChatStore((s) => s.sessions)
  const activeId = useChatStore((s) => s.activeId)
  const select = useChatStore((s) => s.select)
  const createSession = useChatStore((s) => s.createSession)
  const removeSession = useChatStore((s) => s.removeSession)
  const { catalog } = useWorkspaces()

  /**
   * P6 G2：当前上下文模式 —— 有活动会话看会话，否则看草稿（草稿模式的真源在 store）。
   *
   * 侧栏据此决定工不工作区段：Chat 模式不碰文件，工作区与它无关，
   * 留一块空白段只会让人以为加载失败，所以直接不渲染。
   */
  const activeMode: ConversationMode = useChatStore(
    (s) => (s.activeId ? s.sessions.find((x) => x.id === s.activeId)?.mode : null) ?? s.draftMode
  )

  // 活动工作区决定新会话落在哪；侧栏显示它，用户才知道「新建对话」会去哪
  const activeWorkspace =
    catalog.workspaces.find((item) => item.id === catalog.activeWorkspaceId) ?? null

  /** 「最近」列表按当前活动工作区过滤：工作区之间的会话不互相串台。 */
  const visibleSessions = activeWorkspace
    ? sessions.filter((session) => (session.workspaceId ?? null) === activeWorkspace.id)
    : sessions

  const handleSelect = (id: string): void => {
    select(id)
    navigate('/chat')
  }

  const handleCreate = (): void => {
    void createSession({ workspaceId: activeWorkspace?.id ?? null })
    navigate('/chat')
  }

  return (
    <aside className="sidebar" data-ui-region="A 会话侧栏">
      {/* 侧栏顶部不再放品牌头像（用户 2026-11-02 指令：删掉）。
          头像只用消息列表里的那一处，避免同一枚素材在窄侧栏里被压成 34px 糊成色块。 */}
      <div className="sidebar__brand">
        <div className="brand-text">
          <strong>Nahida Chat</strong>
          <span>本地优先的 AI 对话</span>
        </div>
      </div>

      <button className="sidebar__new" data-ui-target="新建对话" onClick={handleCreate}>
        新建对话
      </button>

      {/* 工作区是 Agent 模式的专属概念（P6 G2）：Chat 模式下整段不渲染 */}
      {activeMode === 'agent' && <WorkspaceSection />}

      <div className="sidebar__section-title sidebar__section-title--inset">
        最近
        {activeMode === 'agent' && activeWorkspace && (
          <span className="sidebar__section-scope">{activeWorkspace.name}</span>
        )}
      </div>
      <nav className="session-list" data-ui-target="会话列表">
        {visibleSessions.length === 0 && <p className="session-list__empty">还没有对话</p>}
        {visibleSessions.map((session) => (
          <div
            key={session.id}
            className={'session-item sel-frame--stitch' + (session.id === activeId ? ' is-active' : '')}
          >
            <button className="session-item__main" onClick={() => handleSelect(session.id)} title={session.title}>
              <span className="session-item__title">{session.title}</span>
              <span className="session-item__meta">{session.messages.length} 条</span>
            </button>
            <button
              className="session-item__delete"
              aria-label="删除对话"
              onClick={() => void removeSession(session.id)}
            >
              ×
            </button>
          </div>
        ))}
      </nav>

      {/* 纯装饰：日间浅色叶纹、夜间星尘，靠主题选择器换图（P2 §4.7） */}
      <div className="sidebar__ornament" aria-hidden="true" />

      <div className="sidebar__footer" data-ui-target="设置入口">
        <NavLink
          to="/settings/models"
          className={({ isActive }) =>
            'settings-entry sel-frame--stitch' + (isActive ? ' is-active' : '')
          }
        >
          <span className="settings-entry__icon">⚙</span>
          <span>设置</span>
        </NavLink>
      </div>
    </aside>
  )
}
