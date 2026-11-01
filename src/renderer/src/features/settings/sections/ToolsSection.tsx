import { useEffect, useState } from 'react'
import { READ_ONLY_LABEL, WRITE_LABEL } from '@shared/tools'
import type { ToolDefinition } from '@shared/tools'
import type { PermissionMode, Settings } from '@shared/types'
import { useSettings } from '../useSettings'

interface ModeOption {
  id: PermissionMode
  label: string
  summary: string
  detail: string
}

/**
 * 三个模式的说明文案。
 * 刻意用「会发生什么」而不是「安全等级」来写：
 * 用户要判断的是"我放心让模型自己动手吗"，不是"这个模式打几分"。
 */
const MODE_OPTIONS: ModeOption[] = [
  {
    id: 'readonly',
    label: '只读',
    summary: '只能看，不能改',
    detail: '只读工具直接执行；任何会写文件或执行命令的调用一律拒绝。'
  },
  {
    id: 'approve',
    label: '审批',
    summary: '动手前先问你',
    detail: '只读工具直接执行；会改动东西的调用先弹确认卡，超时按拒绝处理。'
  },
  {
    id: 'full',
    label: '完全访问',
    summary: '全部直接执行',
    detail: '不再逐次确认，文件工具也不受工作区限制。只在你完全信任模型时使用。'
  }
]

/** 工具权限：权限模式 + 已注册工具清单。工作区不在这里 —— 它是多份清单，由侧栏管理。 */
export function ToolsSection() {
  const { settings, loading, saving, error, save } = useSettings()
  const [draft, setDraft] = useState<Settings | null>(null)
  const [toolList, setToolList] = useState<ToolDefinition[]>([])
  const [savedAt, setSavedAt] = useState(0)

  useEffect(() => {
    if (settings) setDraft(settings)
  }, [settings])

  useEffect(() => {
    let alive = true
    window.nahida.tools
      .list()
      .then((list) => {
        if (alive) setToolList(list)
      })
      .catch(() => {
        if (alive) setToolList([])
      })
    return () => {
      alive = false
    }
  }, [])

  const permission = draft?.permission
  const mode: PermissionMode = permission?.mode ?? 'approve'

  const patchMode = (next: PermissionMode): void => {
    setDraft((prev) =>
      prev ? { ...prev, permission: { ...prev.permission, mode: next } } : prev
    )
  }

  const handleSave = async (): Promise<void> => {
    if (!draft) return
    const ok = await save({ permission: draft.permission })
    if (ok) setSavedAt(Date.now())
  }

  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>工具权限</h1>
        <p>
          决定 Agent 模式下模型能做什么、要不要先问你。切换后下一次工具调用立即生效。
          文件边界由各个会话绑定的工作区决定，在侧栏「工作区」里管理。
        </p>
      </div>

      <section className="setting-group">
        <h3 className="setting-group__title">权限模式</h3>
        <p className="setting-group__desc">
          三种模式互斥。改的是一个行为问题：模型能不能自己动手。
          能碰哪个目录不在这里设 —— 每个会话在侧栏「工作区」里各绑一个。
        </p>
        <div className="permission-modes" data-ui-target="权限模式">
          {MODE_OPTIONS.map((option) => {
            const active = mode === option.id
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={'permission-mode sel-frame--stitch' + (active ? ' is-active' : '')}
                data-ui-target={'权限-' + option.label}
                onClick={() => patchMode(option.id)}
              >
                <span className="permission-mode__head">
                  <strong>{option.label}</strong>
                  {option.id === 'full' && <span className="permission-mode__warn">放开目录限制</span>}
                </span>
                <span className="permission-mode__summary">{option.summary}</span>
                <span className="permission-mode__detail">{option.detail}</span>
              </button>
            )
          })}
        </div>
        {mode === 'full' && (
          <p className="hint-text hint-text--error">
            完全访问意味着模型的每一次工具调用都会直接执行，包括写文件和执行命令。只在你清楚风险时使用。
          </p>
        )}
      </section>

      <section className="setting-group">
        <h3 className="setting-group__title">已注册工具（{toolList.length}）</h3>
        <p className="setting-group__desc">
          工具由主进程注册。标记「只读」的工具在只读与审批模式下都能直接跑。
        </p>
        <div className="tool-registry" data-ui-target="已注册工具">
          {toolList.length === 0 && <span className="hint-text">主进程还没有注册任何工具。</span>}
          {toolList.map((tool) => (
            <span className="tool-registry__item" key={tool.name}>
              <span className={tool.readOnly ? 'tool-registry__tag' : 'tool-registry__tag is-write'}>
                {tool.readOnly ? READ_ONLY_LABEL : WRITE_LABEL}
              </span>
              {tool.title}
              <code className="tool-registry__name">{tool.name}</code>
            </span>
          ))}
        </div>
      </section>

      <div className="settings-actions" data-ui-target="保存按钮组">
        <button className="btn-primary" onClick={() => void handleSave()} disabled={!draft || saving || loading}>
          {saving ? '保存中…' : '保存设置'}
        </button>
        <button className="btn-ghost" onClick={() => setDraft(settings)} disabled={!settings || saving}>
          还原
        </button>
        {savedAt > 0 && <span className="hint-text">已保存</span>}
        {error && <span className="hint-text hint-text--error">{error}</span>}
      </div>
    </>
  )
}
