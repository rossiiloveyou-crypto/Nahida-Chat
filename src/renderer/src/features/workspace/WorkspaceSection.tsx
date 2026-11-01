import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../chat/store'
import { useWorkspaces } from './useWorkspaces'

/**
 * 侧栏的「工作区」段（参照 dsh：工作区是一份清单，点一下就切换）。
 *
 * 三个动作都在这里闭环，不用跳设置页：
 * - 点条目 → 设为活动工作区（新会话默认绑定它）
 * - 悬停出现「…」→ 改名 / 在文件管理器里打开 / 删除
 * - 段标题右侧「+」→ 弹系统目录选择框，选一个文件夹就成为一个工作区
 *
 * P5：菜单改 `position: fixed` + 打开时写入实时坐标。
 * 原因是 `.workspace-list` 是 `overflow-y: auto` 的滚动容器，它会把 `position: absolute`
 * 的子菜单按列表边界裁掉 —— 那时 `z-index` 一点用都没有（裁剪与层叠是两件事）。
 * fixed 的包含块是视口，祖先 overflow 不再参与裁剪；代价是「列表一滚动坐标就过期」，
 * 所以下面在 scroll（capture）/ resize 时直接关掉菜单，不留悬空浮层。
 */

/** 菜单尺寸常量：必须与 `global.css` 里 `.workspace-menu` 的 min-width / 实际高度同步（A48）。
 *  高度 = 3 项 × 32 + 上下 padding 8 + 边框 2 = 106（2026-10-31 实测，不是估的）。 */
const MENU_W = 160
const MENU_H = 106
/** 菜单与条目之间的呼吸位 */
const MENU_GAP = 4
/** 贴边时至少留出的视口边距 */
const VIEWPORT_PAD = 8

export function WorkspaceSection() {
  const { catalog, save, remove, setActive, pickDirectory, open, error, ready } = useWorkspaces()
  const resyncSessions = useChatStore((s) => s.resync)
  const [busy, setBusy] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // 点空白处收起「…」菜单；滚动 / 改窗口尺寸后坐标失效，直接关掉
  useEffect(() => {
    if (!menuId) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      // 菜单是 fixed 定位、可能被 portal 化到别处：两处都判，
      // 否则「点菜单项」会先被当成「点外面」而关掉，菜单看得见却点不动。
      if (sectionRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setMenuId(null)
    }
    // fixed 的坐标是打开那一刻算的：一滚动就过期，跟过去比直接关闭更不容易出错
    const closeMenu = (): void => setMenuId(null)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', closeMenu)
    // scroll 不冒泡，必须 capture，否则收不到 .workspace-list 的内部滚动
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [menuId])

  // 新建工作区：先弹目录，取消就什么都不做
  const handleAdd = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const dir = await pickDirectory()
      if (!dir) return
      await save({ name: '', dir })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 打开「…」菜单：按锚点条目的实时位置算 fixed 坐标。
   *
   * 边界规则：默认贴条目下方弹；底部放不下就上翻；上翻也放不下就贴底。
   * 左右同理夹在视口内 —— 宁可压住条目，也不要出画。
   */
  const openMenu = (workspaceId: string, anchor: HTMLElement): void => {
    if (menuId === workspaceId) {
      setMenuId(null)
      return
    }
    const rect = anchor.getBoundingClientRect()
    let left = rect.right - MENU_W
    let top = rect.bottom + MENU_GAP
    if (top + MENU_H > window.innerHeight - VIEWPORT_PAD) {
      const flipped = rect.top - MENU_H - MENU_GAP
      top = flipped >= VIEWPORT_PAD ? flipped : Math.max(VIEWPORT_PAD, window.innerHeight - MENU_H - VIEWPORT_PAD)
    }
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - MENU_W - VIEWPORT_PAD))
    setMenuPos({ left: Math.round(left), top: Math.round(top) })
    setMenuId(workspaceId)
  }

  const startRename = (id: string, current: string): void => {
    setMenuId(null)
    setRenamingId(id)
    setRenameDraft(current)
  }

  const commitRename = async (id: string, dir: string): Promise<void> => {
    const name = renameDraft.trim()
    setRenamingId(null)
    if (!name) return
    await save({ id, name, dir })
  }

  return (
    <div className="workspace-section" ref={sectionRef} data-ui-region="A2 工作区列表">
      <div className="workspace-section__head">
        <span className="sidebar__section-title">工作区</span>
        <button
          type="button"
          className="workspace-section__add"
          title="新建工作区（选一个文件夹）"
          aria-label="新建工作区"
          disabled={busy}
          onClick={() => void handleAdd()}
          data-ui-target="新建工作区"
        >
          +
        </button>
      </div>

      <div className="workspace-list" data-ui-target="工作区条目">
        {!ready && <p className="workspace-list__empty">正在载入…</p>}
        {ready && catalog.workspaces.length === 0 && (
          <p className="workspace-list__empty">还没有工作区</p>
        )}
        {catalog.workspaces.map((workspace) => {
          const active = workspace.id === catalog.activeWorkspaceId
          return (
            <div
              key={workspace.id}
              className={'workspace-item sel-frame--stitch' + (active ? ' is-active' : '')}
              title={workspace.dir}
            >
              {renamingId === workspace.id ? (
                <input
                  className="workspace-item__rename"
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => void commitRename(workspace.id, workspace.dir)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitRename(workspace.id, workspace.dir)
                    if (event.key === 'Escape') setRenamingId(null)
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="workspace-item__main"
                  onClick={() => void setActive(workspace.id)}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="workspace-item__dot" />
                  <span className="workspace-item__name">{workspace.name}</span>
                </button>
              )}
              <button
                type="button"
                className="workspace-item__more"
                aria-label="工作区操作"
                aria-haspopup="menu"
                aria-expanded={menuId === workspace.id}
                onClick={(event) => openMenu(workspace.id, event.currentTarget)}
              >
                …
              </button>
              {menuId === workspace.id && menuPos && (
                <div
                  className="workspace-menu"
                  role="menu"
                  ref={menuRef}
                  style={{ left: menuPos.left, top: menuPos.top }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => startRename(workspace.id, workspace.name)}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuId(null)
                      void open(workspace.id)
                    }}
                  >
                    在文件夹中打开
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="workspace-menu__danger"
                    onClick={() => {
                      setMenuId(null)
                      // 主进程删完会把绑在上面的会话改绑并落盘。渲染层不能自己推算改绑目标
                      // —— 那等于把顺位规则实现两遍，且此刻的 catalog 已经过期（刚删掉一条），
                      // 算错就会把会话的 workspaceId 写成 null，侧栏过滤后"对话凭空消失"。
                      // 直接问主进程要权威结果。
                      void remove(workspace.id).then((ok) => {
                        if (ok) void resyncSessions()
                      })
                    }}
                  >
                    移出列表
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {error && <p className="workspace-list__error">{error}</p>}
    </div>
  )
}
