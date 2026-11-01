import { useCallback, useEffect, useState } from 'react'
import type { ConversationMode, PromptLibrary, Settings } from '@shared/types'
import { useSettings } from '../useSettings'

/**
 * 提示词库设置。
 * 原则：设置页不显示、不编辑提示词正文——这里只告诉用户「改哪个文件」，并提供打开目录的按钮。
 * 正文一律在编辑器里改，避免把长文塞进设置页、也避免两处真源。
 *
 * 版式约束：整页必须能在一屏（1280x860 内容区）内看完，否则可定位截图抓不到下半页，
 * 用户就没法按编号反馈位置。所以「注入顺序」与「改哪个文件」合成一张表——
 * 顺序本身就是文件顺序，拆成两张表只是重复；打开按钮并进页头，也不单独占一节。
 */

/** 与 promptStore.compose() 一一对应；改一处必须同步另一处。 */
const INJECTION_ORDER: Array<{
  step: string
  source: string
  mode: string
  /** shared/ 下的全局文件，用这个 id 去查是否存在 */
  sharedId?: string
  scope?: 'both' | 'agent'
}> = [
  { step: '全局底线', source: 'shared/base.md', mode: '两种模式', sharedId: 'shared/base.md', scope: 'both' },
  { step: '语气与句式', source: 'shared/tone.md', mode: '两种模式', sharedId: 'shared/tone.md', scope: 'both' },
  { step: '人格核心', source: 'characters/<角色>/soul.md', mode: '两种模式' },
  { step: '原作台词', source: 'characters/<角色>/canon/*.md', mode: '两种模式' },
  { step: '背景设定', source: 'characters/<角色>/worldbook/*.md', mode: '两种模式' },
  { step: '模式规则', source: 'characters/<角色>/modes/<mode>.md', mode: '按模式' },
  { step: '表达风格', source: 'characters/<角色>/styles/<mode>.md', mode: '按模式' },
  { step: '工具规范', source: 'shared/tool_usage.md', mode: '仅 Agent', sharedId: 'shared/tool_usage.md', scope: 'agent' }
]

export function PromptsSection() {
  const { settings, loading, error, save } = useSettings()
  const [library, setLibrary] = useState<PromptLibrary | null>(null)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadLibrary = useCallback(async (): Promise<void> => {
    try {
      const next = await window.nahida.prompts.library()
      setLibrary(next)
      setLibraryError(null)
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void loadLibrary()
  }, [loadLibrary])

  const open = async (target?: string): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const failure = target
        ? await window.nahida.prompts.openCharacter(target)
        : await window.nahida.prompts.openLibrary()
      setStatus(failure ? '打开失败：' + failure : null)
    } catch (cause) {
      setStatus('打开失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }

  const chooseCharacter = async (id: string): Promise<void> => {
    const ok = await save({ defaultCharacterId: id })
    if (ok) setStatus('已切换默认角色，新建对话会使用它')
  }

  /** 全局文件是否缺失：角色文件的存在性在下面的角色卡片里逐条标。 */
  const sharedMissing = (sharedId?: string): boolean => {
    if (!sharedId || !library) return false
    const file = library.sharedFiles.find((item) => item.id === sharedId)
    return file ? !file.exists : false
  }

  return (
    <>
      <div className="settings-page__head prompt-head" data-ui-target="页头">
        <div className="prompt-head__text">
          <h1>提示词库</h1>
          <p>
            提示词是文件资产，直接改文件。每次发消息现场按顺序读，缺哪段跳过哪段。
            Chat / Agent 在新建对话时用首页滑块选，整个会话生命周期不变。
          </p>
        </div>
        <div className="prompt-actions" data-ui-target="打开按钮组">
          <button className="btn-primary" disabled={busy} onClick={() => void open()}>
            打开目录
          </button>
          <button className="btn-ghost" onClick={() => void loadLibrary()}>
            刷新
          </button>
        </div>
      </div>

      <section className="setting-group">
        <h3 className="setting-group__title">注入顺序 = 改哪个文件</h3>
        <p className="setting-group__desc">
          越靠后离这次回答越近。模式规则管「该做什么」，表达风格管「怎么说话」，分开写才不会互相牵制。
        </p>
        <ol className="prompt-order" data-ui-target="注入顺序">
          {INJECTION_ORDER.map((item, index) => (
            <li className="prompt-order__row" key={item.source}>
              <span className="prompt-order__index">{index + 1}</span>
              <span className="prompt-order__what">{item.step}</span>
              <code className="prompt-order__file">{item.source}</code>
              <span className={item.scope === 'agent' ? 'prompt-scope is-agent' : 'prompt-scope'}>
                {item.mode}
              </span>
              {sharedMissing(item.sharedId) && <span className="prompt-character__missing">缺失</span>}
            </li>
          ))}
        </ol>
        {library && <p className="prompt-path">{library.root}</p>}
        {library && !library.exists && (
          <p className="hint-text hint-text--error">提示词目录不存在，检查安装是否完整。</p>
        )}
        {libraryError && <p className="hint-text hint-text--error">{libraryError}</p>}
        {status && <p className="hint-text">{status}</p>}
      </section>

      <section className="setting-group">
        <h3 className="setting-group__title">角色</h3>
        <p className="setting-group__desc">
          新增角色 = 在 characters/ 下新建一个文件夹，这里会自动出现。
        </p>
        <div className="prompt-characters" data-ui-target="角色列表">
          {(library?.characters ?? []).map((character) => {
            const isDefault = settings?.defaultCharacterId === character.id
            return (
              <div className={isDefault ? 'prompt-character is-default' : 'prompt-character'} key={character.id}>
                <div className="prompt-character__head">
                  <strong>{character.name}</strong>
                  <code>{character.id}</code>
                  {isDefault && <span className="tag-default">默认</span>}
                  <div className="prompt-character__actions">
                    <button className="btn-ghost btn-ghost--sm" disabled={busy} onClick={() => void open(character.id)}>
                      打开目录
                    </button>
                    {!isDefault && (
                      <button
                        className="btn-ghost btn-ghost--sm"
                        disabled={loading}
                        onClick={() => void chooseCharacter(character.id)}
                      >
                        设为新对话默认
                      </button>
                    )}
                  </div>
                </div>
                <ul className="prompt-character__files">
                  {character.files.map((file) => (
                    <li key={file.id} className={file.exists ? '' : 'is-missing'}>
                      <span>{file.label}</span>
                      <code>{file.relativePath}</code>
                      {!file.exists && <span className="prompt-character__missing">缺失</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
          {(library?.characters ?? []).length === 0 && (
            <p className="hint-text">characters/ 下还没有角色文件夹。</p>
          )}
        </div>
        {error && <p className="hint-text hint-text--error">{error}</p>}
      </section>
    </>
  )
}

export type { ConversationMode }
