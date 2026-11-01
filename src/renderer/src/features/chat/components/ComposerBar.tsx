import { useEffect, useRef, useState } from 'react'
import { providerMeta } from '@shared/constants'
import type { ModelProfileCatalog, PermissionMode } from '@shared/types'
import { useSettings } from '../../settings/useSettings'
import { useWorkspaces } from '../../workspace/useWorkspaces'

interface ComposerBarProps {
  disabled: boolean
  streaming: boolean
  /** 没有会话时由外层暂存的选择；有会话时为空，显示的就是会话自己的值 */
  draftProfileId: string | null
  draftModelId: string | null
  onPickModel: (profileId: string, modelId: string) => void
  /** 当前生效的工作区 id（会话的 > 草稿的 > 活动工作区），由 ChatPage 解析 */
  workspaceId: string | null
  onPickWorkspace: (workspaceId: string) => void
}

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  readonly: '只读',
  approve: '审批',
  full: '完全访问'
}

const PERMISSION_HINT: Record<PermissionMode, string> = {
  readonly: '只能读取，不能改动任何文件',
  approve: '要改动东西前会先问你',
  full: '全部直接执行，不再逐次确认'
}

/** 下拉指示箭头。用 SVG 而不是 ▾ 字符：中文字体里这个字形常常缺失或过小。 */
function Caret() {
  return (
    <svg className="composer-pick__caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * 输入框下方的三个选择器：模型 / 工作区 / 权限。
 *
 * 放在这里而不是只放在设置页，是因为它们都是「这一句话要用的东西」：
 * 用户不该为了换个模型、换个目录或临时放宽权限而离开对话。
 *
 * 数据来源是分开的：
 * - 模型写进会话（每个会话可以不一样）
 * - 工作区写进会话（每个会话绑定一个目录，见 Session.workspaceId）
 * - 权限写进设置（全局一份，和设置页共享）
 */
export function ComposerBar({
  disabled,
  streaming,
  draftProfileId,
  draftModelId,
  onPickModel,
  workspaceId,
  onPickWorkspace
}: ComposerBarProps) {
  const { settings, save } = useSettings()
  const { catalog: workspaceCatalog, save: saveWorkspace } = useWorkspaces()
  const [catalog, setCatalog] = useState<ModelProfileCatalog>({ profiles: [], defaultProfileId: null })
  const [openMenu, setOpenMenu] = useState<'model' | 'workspace' | 'permission' | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    window.nahida.modelProfiles
      .list()
      .then((next) => {
        if (alive) setCatalog(next)
      })
      .catch(() => {
        if (alive) setCatalog({ profiles: [], defaultProfileId: null })
      })
    return () => {
      alive = false
    }
  }, [])

  // 点空白处收起菜单：比给每个菜单加一层遮罩轻
  useEffect(() => {
    if (!openMenu) return
    const onDown = (event: MouseEvent): void => {
      if (!barRef.current) return
      if (!barRef.current.contains(event.target as Node)) setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openMenu])

  const profile =
    catalog.profiles.find((item) => item.id === draftProfileId) ??
    catalog.profiles.find((item) => item.id === catalog.defaultProfileId) ??
    catalog.profiles[0] ??
    null
  const model =
    draftModelId && profile?.models.includes(draftModelId) ? draftModelId : profile?.defaultModel ?? ''
  const mode: PermissionMode = settings?.permission.mode ?? 'approve'
  const workspace =
    workspaceCatalog.workspaces.find((item) => item.id === workspaceId) ??
    workspaceCatalog.workspaces.find((item) => item.id === workspaceCatalog.activeWorkspaceId) ??
    workspaceCatalog.workspaces[0] ??
    null

  // 菜单是往上弹的（输入框在页面底部），所以这里只需要处理横向越界
  const modelLabel = profile ? (profile.defaultModel === model ? profile.name : model) : '未配置模型'
  const locked = disabled || streaming

  return (
    <div className="composer-bar" ref={barRef} data-ui-region="C1 输入区工具条">
      <div className="composer-bar__group">
        <button
          type="button"
          className={openMenu === 'model' ? 'composer-pick is-open' : 'composer-pick'}
          onClick={() => setOpenMenu(openMenu === 'model' ? null : 'model')}
          disabled={locked || catalog.profiles.length === 0}
          title="选择本次对话使用的模型"
          data-ui-target="模型选择"
        >
          <span className="composer-pick__dot" />
          <span className="composer-pick__text">{modelLabel}</span>
          <Caret />
        </button>

        {openMenu === 'model' && (
          <div className="composer-menu" role="listbox" aria-label="模型列表">
            {catalog.profiles.map((item) => (
              <div className="composer-menu__group" key={item.id}>
                <div className="composer-menu__heading">
                  {item.name}
                  <span>{providerMeta(item.provider).label}</span>
                </div>
                {item.models.map((id) => {
                  const selected = item.id === profile?.id && id === model
                  return (
                    <button
                      key={item.id + ':' + id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={selected ? 'composer-menu__item is-active' : 'composer-menu__item'}
                      onClick={() => {
                        setOpenMenu(null)
                        onPickModel(item.id, id)
                      }}
                    >
                      <code>{id}</code>
                      {selected && <span className="composer-menu__check">✓</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="composer-bar__group">
        <button
          type="button"
          className={openMenu === 'workspace' ? 'composer-pick is-open' : 'composer-pick'}
          onClick={() => setOpenMenu(openMenu === 'workspace' ? null : 'workspace')}
          disabled={locked || workspaceCatalog.workspaces.length === 0}
          title={workspace ? '当前工作区：' + workspace.dir : '选择一个工作区目录'}
          data-ui-target="工作区选择"
        >
          <span className="composer-pick__folder" aria-hidden="true" />
          <span className="composer-pick__text">{workspace ? workspace.name : '未选工作区'}</span>
          <Caret />
        </button>

        {openMenu === 'workspace' && (
          <div className="composer-menu" role="listbox" aria-label="工作区列表">
            {workspaceCatalog.workspaces.map((item) => {
              const selected = item.id === workspace?.id
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={
                    selected
                      ? 'composer-menu__item composer-menu__item--stack is-active'
                      : 'composer-menu__item composer-menu__item--stack'
                  }
                  onClick={() => {
                    setOpenMenu(null)
                    onPickWorkspace(item.id)
                  }}
                >
                  <span className="composer-menu__row">
                    <strong>{item.name}</strong>
                    {selected && <span className="composer-menu__check">✓</span>}
                  </span>
                  <span className="composer-menu__hint composer-menu__hint--path">{item.dir}</span>
                </button>
              )
            })}
            <button
              type="button"
              className="composer-menu__item composer-menu__item--action"
              onClick={() => {
                setOpenMenu(null)
                void window.nahida.workspaces.pickDirectory().then((dir) => {
                  if (!dir) return
                  void saveWorkspace({ name: '', dir }).then((ok) => {
                    if (!ok) return
                    // 新建成功后直接切过去：用户的意图就是"在这个目录里干活"
                    void window.nahida.workspaces
                      .list()
                      .then((next) => {
                        const created = next.workspaces.find((item) => item.dir === dir)
                        if (created) onPickWorkspace(created.id)
                      })
                  })
                })
              }}
            >
              + 新建工作区…
            </button>
          </div>
        )}
      </div>

      <div className="composer-bar__group">
        <button
          type="button"
          className={[
            'composer-pick',
            mode === 'full' ? 'composer-pick--warn' : '',
            openMenu === 'permission' ? 'is-open' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => setOpenMenu(openMenu === 'permission' ? null : 'permission')}
          disabled={locked || !settings}
          title="切换工具权限模式（和设置页同一份配置）"
          data-ui-target="权限模式"
        >
          <span className="composer-pick__text">{PERMISSION_LABEL[mode]}</span>
          <Caret />
        </button>

        {openMenu === 'permission' && (
          <div className="composer-menu composer-menu--right" role="listbox" aria-label="权限模式">
            {(['readonly', 'approve', 'full'] as PermissionMode[]).map((item) => {
              const selected = item === mode
              return (
                <button
                  key={item}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={
                    selected
                      ? 'composer-menu__item composer-menu__item--stack is-active'
                      : 'composer-menu__item composer-menu__item--stack'
                  }
                  onClick={() => {
                    setOpenMenu(null)
                    if (!settings || selected) return
                    void save({ permission: { ...settings.permission, mode: item } })
                  }}
                >
                  <span className="composer-menu__row">
                    <strong>{PERMISSION_LABEL[item]}</strong>
                    {selected && <span className="composer-menu__check">✓</span>}
                  </span>
                  <span className="composer-menu__hint">{PERMISSION_HINT[item]}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
