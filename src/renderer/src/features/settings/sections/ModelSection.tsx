import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CONTEXT_WINDOW_RANGE,
  DEFAULT_CONTEXT_WINDOW,
  TEMPERATURE_RANGE,
  VENDOR_PRESETS,
  isProviderId,
  providerMeta,
  vendorPreset
} from '@shared/constants'
import type { DiscoveredModel, ModelProfileDraft, ProviderId } from '@shared/types'
import { draftFromProfile, useModelProfiles } from '../useModelProfiles'
import {
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSave,
  IconSpark,
  IconTrash
} from '../icons'
import { ModelDiscovery } from './ModelDiscovery'

type Status = { kind: 'success' | 'error' | 'info'; text: string }

function emptyDraft(presetId = 'openai'): ModelProfileDraft {
  const preset = vendorPreset(presetId)
  const models = preset.models.length > 0 ? [preset.models[0]] : []
  return {
    name: preset.label,
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    apiKey: '',
    models,
    defaultModel: models[0] ?? '',
    temperature: 0.7,
    modelOptions: Object.fromEntries(
      models.map((model) => [model, { contextWindowTokens: DEFAULT_CONTEXT_WINDOW, multimodal: false }])
    )
  }
}

/** 用草稿内容做脏检查签名：只有真正改动才提示未保存。 */
function signatureOf(draft: ModelProfileDraft): string {
  return JSON.stringify({
    name: draft.name,
    provider: draft.provider,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    models: draft.models,
    defaultModel: draft.defaultModel,
    temperature: draft.temperature,
    modelOptions: draft.models.map((model) => draft.modelOptions[model] ?? null)
  })
}

function presetFor(provider: ProviderId, baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  const hit = VENDOR_PRESETS.find(
    (item) => item.provider === provider && item.baseUrl && item.baseUrl.replace(/\/+$/, '').toLowerCase() === normalized
  )
  return hit ? hit.id : provider === 'mock' ? 'mock' : 'custom'
}

interface ModelSectionProps {
  /** 档案变化后通知外层刷新全局配置（例如聊天页的模型角标） */
  onChanged?: () => void
}

export function ModelSection({ onChanged }: ModelSectionProps) {
  const { catalog, loading, error, save, remove, setDefault, test } = useModelProfiles()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ModelProfileDraft>(() => emptyDraft())
  const [creating, setCreating] = useState(false)
  const [baseline, setBaseline] = useState<string>(() => signatureOf(emptyDraft()))
  const [status, setStatus] = useState<Status | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [newModel, setNewModel] = useState('')
  const [discovering, setDiscovering] = useState(false)

  // 只在首次拿到档案列表时自动选中默认档案；之后用户的新建/选中不再被重置
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    if (catalog.profiles.length === 0) return
    bootstrapped.current = true
    const selected =
      catalog.profiles.find((item) => item.id === catalog.defaultProfileId) ?? catalog.profiles[0]
    setActiveId(selected.id)
    const next = draftFromProfile(selected)
    setDraft(next)
    setBaseline(signatureOf(next))
  }, [catalog])

  const dirty = signatureOf(draft) !== baseline
  const presetId = presetFor(draft.provider, draft.baseUrl)
  const preset = vendorPreset(presetId)
  const suggestions = useMemo(
    () => [...new Set([...preset.models, ...draft.models])],
    [preset, draft.models]
  )

  const selectProfile = (id: string): void => {
    const profile = catalog.profiles.find((item) => item.id === id)
    if (!profile) return
    setCreating(false)
    setActiveId(id)
    const next = draftFromProfile(profile)
    setDraft(next)
    setBaseline(signatureOf(next))
    setStatus(null)
    setNewModel('')
  }

  const startNew = (): void => {
    const next = emptyDraft()
    setCreating(true)
    setActiveId(null)
    setDraft(next)
    setBaseline(signatureOf(next))
    setStatus(null)
    setNewModel('')
  }

  const patch = (next: Partial<ModelProfileDraft>): void => {
    setDraft((prev) => ({ ...prev, ...next }))
    setStatus(null)
  }

  const changePreset = (id: string): void => {
    const target = vendorPreset(id)
    const models = target.models.length > 0 ? [target.models[0]] : []
    // 档案名还是上一个预设的默认名（= 用户没自己改过）时跟着换，改过就尊重用户输入
    const previousLabel = vendorPreset(presetFor(draft.provider, draft.baseUrl)).label
    const nameUntouched = !draft.name.trim() || draft.name.trim() === previousLabel
    patch({
      name: nameUntouched ? target.label : draft.name,
      provider: target.provider,
      baseUrl: target.baseUrl,
      apiKey: target.provider === 'mock' ? '' : draft.apiKey,
      models,
      defaultModel: models[0] ?? '',
      modelOptions: Object.fromEntries(
        models.map((model) => [model, { contextWindowTokens: DEFAULT_CONTEXT_WINDOW, multimodal: false }])
      )
    })
  }

  const addModel = (): void => {
    const value = newModel.trim()
    if (!value) return
    if (draft.models.includes(value)) {
      setStatus({ kind: 'error', text: '模型已在清单里' })
      return
    }
    patch({
      models: [...draft.models, value],
      defaultModel: draft.defaultModel || value,
      modelOptions: {
        ...draft.modelOptions,
        [value]: { contextWindowTokens: DEFAULT_CONTEXT_WINDOW, multimodal: false }
      }
    })
    setNewModel('')
  }

  /** 把「获取可用模型」勾选的条目并入清单；已有的保留用户调过的上下文窗口。 */
  const addDiscovered = (picked: DiscoveredModel[]): void => {
    if (picked.length === 0) return
    const models = [...draft.models]
    const modelOptions = { ...draft.modelOptions }
    for (const item of picked) {
      if (models.includes(item.id)) continue
      models.push(item.id)
      modelOptions[item.id] = {
        contextWindowTokens: item.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW,
        multimodal: item.multimodal ?? false
      }
    }
    const skipped = picked.length - (models.length - draft.models.length)
    patch({ models, modelOptions, defaultModel: draft.defaultModel || models[0] })
    setDiscovering(false)
    setStatus({
      kind: 'success',
      text: skipped > 0 ? '已添加 ' + (picked.length - skipped) + ' 个模型，' + skipped + ' 个已存在' : '已添加 ' + picked.length + ' 个模型'
    })
  }

  const removeModel = (model: string): void => {
    if (draft.models.length <= 1) {
      setStatus({ kind: 'error', text: '至少要保留一个模型' })
      return
    }
    const models = draft.models.filter((item) => item !== model)
    const modelOptions = { ...draft.modelOptions }
    delete modelOptions[model]
    patch({
      models,
      modelOptions,
      defaultModel: draft.defaultModel === model ? models[0] : draft.defaultModel
    })
  }

  const patchOption = (
    model: string,
    next: Partial<{ contextWindowTokens: number; multimodal: boolean }>
  ): void => {
    setDraft((prev) => ({
      ...prev,
      modelOptions: {
        ...prev.modelOptions,
        [model]: { ...prev.modelOptions[model], ...next }
      }
    }))
  }

  const validate = (): string | null => {
    if (draft.models.length === 0) return '至少添加一个模型'
    if (!draft.models.includes(draft.defaultModel)) return '默认模型必须在清单里'
    if (draft.provider !== 'mock') {
      if (!draft.baseUrl.trim()) return '请填写 baseUrl'
      try {
        const parsed = new URL(draft.baseUrl.trim())
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
          return 'baseUrl 必须是 http(s) 地址'
        }
      } catch {
        return 'baseUrl 格式不正确'
      }
      const isLocalHost = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i.test(draft.baseUrl.trim())
      if (draft.provider !== 'ollama' && !isLocalHost && !draft.apiKey.trim()) return '请填写 API Key'
    }
    for (const model of draft.models) {
      const tokens = draft.modelOptions[model]?.contextWindowTokens
      if (!Number.isFinite(tokens) || tokens < CONTEXT_WINDOW_RANGE.min) return '上下文窗口不能小于 4096'
    }
    return null
  }

  const handleSave = async (): Promise<void> => {
    const invalid = validate()
    if (invalid) {
      setStatus({ kind: 'error', text: invalid })
      return
    }
    setSaving(true)
    setStatus({ kind: 'info', text: '保存中…' })
    try {
      const next = await save({ ...draft, id: activeId ?? undefined })
      const saved =
        (activeId ? next.profiles.find((item) => item.id === activeId) : undefined) ??
        [...next.profiles].reverse().find((item) => item.baseUrl === draft.baseUrl && item.defaultModel === draft.defaultModel)
      if (saved) {
        setCreating(false)
        setActiveId(saved.id)
        const clean = draftFromProfile(saved)
        setDraft(clean)
        setBaseline(signatureOf(clean))
      }
      setStatus({ kind: 'success', text: '档案已保存' })
      onChanged?.()
    } catch (cause) {
      setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    const invalid = validate()
    if (invalid) {
      setStatus({ kind: 'error', text: invalid })
      return
    }
    setTesting(true)
    setStatus({ kind: 'info', text: '正在测试连接…' })
    try {
      const result = await test({
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        model: draft.defaultModel
      })
      setStatus(
        result.ok
          ? { kind: 'success', text: '连接成功 · ' + result.latencyMs + 'ms' + (result.sample ? ' · ' + result.sample : '') }
          : { kind: 'error', text: '连接失败：' + (result.error ?? '未知错误') }
      )
    } catch (cause) {
      setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setTesting(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!activeId) return
    setDeleting(true)
    try {
      const next = await remove(activeId)
      const fallback = next.profiles.find((item) => item.id === next.defaultProfileId) ?? next.profiles[0]
      if (fallback) {
        setActiveId(fallback.id)
        const clean = draftFromProfile(fallback)
        setDraft(clean)
        setBaseline(signatureOf(clean))
      } else {
        startNew()
      }
      setStatus({ kind: 'success', text: '档案已删除' })
      onChanged?.()
    } catch (cause) {
      setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setDeleting(false)
    }
  }

  const handleSetDefault = async (): Promise<void> => {
    if (!activeId) return
    try {
      await setDefault(activeId)
      setStatus({ kind: 'success', text: '已设为默认档案，新对话将使用它' })
      onChanged?.()
    } catch (cause) {
      setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  return (
    <div className="model-settings" data-ui-region="B 模型配置">
      <header className="model-settings__header" data-ui-target="标题与新建">
        <div>
          <h1>模型配置</h1>
          <p className="model-settings__intro">
            每一份档案 = 一个服务商 + 一组模型。对话永远使用「默认档案」的默认模型；档案只存在本机。
          </p>
        </div>
        <button className="btn-primary btn-primary--icon" onClick={startNew}>
          <IconPlus size={16} />
          新建档案
        </button>
      </header>

      <div className="model-layout">
        <aside className="model-list" data-ui-target="档案列表" aria-label="模型档案列表">
          <div className="model-list__heading">
            <strong>档案</strong>
            <span>{catalog.profiles.length}</span>
          </div>
          <div className="model-list__items">
            {catalog.profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={profile.id === activeId && !creating ? 'model-card is-active' : 'model-card'}
                onClick={() => selectProfile(profile.id)}
              >
                <span className="model-card__badge">{providerMeta(profile.provider).label.slice(0, 2)}</span>
                <span className="model-card__copy">
                  <strong>{profile.name}</strong>
                  <small>{profile.defaultModel || '未设置模型'}</small>
                </span>
                {profile.id === catalog.defaultProfileId && <span className="tag-default">默认</span>}
              </button>
            ))}
            {catalog.profiles.length === 0 && !loading && (
              <p className="hint-text model-list__empty">还没有档案，点右上角新建。</p>
            )}
            <button
              type="button"
              className={creating ? 'model-card model-card--draft is-active' : 'model-card model-card--draft'}
              onClick={startNew}
            >
              <span className="model-card__badge">
                <IconPlus size={15} />
              </span>
              <span className="model-card__copy">
                <strong>新建档案</strong>
                <small>从预设或自定义开始</small>
              </span>
            </button>
          </div>
          <p className="model-list__footnote">档案信息以明文保存在本机 userData 目录。</p>
          {error && <p className="hint-text hint-text--error">{error}</p>}
        </aside>

        <main className="model-editor" data-ui-target="档案编辑区">
          <div className="model-editor__heading">
            <div>
              <h2>{creating ? '新建档案' : draft.name || '未命名档案'}</h2>
              <p>
                {providerMeta(draft.provider).label} · {draft.defaultModel || '未选择模型'}
              </p>
            </div>
            {activeId && !creating && (
              activeId === catalog.defaultProfileId ? (
                <span className="tag-default">默认档案</span>
              ) : (
                <button className="btn-ghost btn-ghost--sm" onClick={() => void handleSetDefault()}>
                  设为默认
                </button>
              )
            )}
          </div>

          {dirty && (
            <div className="model-unsaved" role="status">
              有未保存的改动
            </div>
          )}

          <section className="setting-group">
            <h3 className="setting-group__title">服务商</h3>
            <p className="setting-group__desc">先选预设快速填好地址与常用模型，也可以选「自定义」自己填。</p>
            <div className="field">
              <span className="field__label">预设</span>
              <select
                className="field__control"
                value={presetId}
                onChange={(event) => changePreset(event.target.value)}
              >
                {VENDOR_PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field__row">
              <label className="field">
                <span className="field__label">档案名</span>
                <input
                  className="field__control"
                  value={draft.name}
                  maxLength={60}
                  placeholder="例如：主力模型"
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label">传输适配器</span>
                <select
                  className="field__control"
                  value={draft.provider}
                  onChange={(event) =>
                    patch({ provider: isProviderId(event.target.value) ? event.target.value : 'openai-compatible' })
                  }
                >
                  <option value="openai-compatible">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                  <option value="ollama">Ollama</option>
                  <option value="mock">演示模式（离线）</option>
                </select>
              </label>
            </div>
            {preset.websiteUrl && (
              <p className="hint-text">
                申请密钥：
                <a className="model-link" href={preset.websiteUrl} target="_blank" rel="noreferrer">
                  {preset.websiteUrl}
                </a>
              </p>
            )}
          </section>

          <section className="setting-group">
            <h3 className="setting-group__title">连接</h3>
            <p className="setting-group__desc">地址与凭据。测试连接会用默认模型发一次最小请求。</p>
            {draft.provider === 'mock' && (
              <p className="hint-text">
                演示模式完全离线：不发任何网络请求，回复由本地生成，用来验证界面与工具审批链路。
              </p>
            )}
            {draft.provider !== 'mock' && (
            <>
            <label className="field">
              <span className="field__label">baseUrl</span>
              <div className="model-inline">
                <input
                  className="field__control"
                  value={draft.baseUrl}
                  placeholder={providerMeta(draft.provider).defaultBaseUrl || 'https://api.example.com/v1'}
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                />
                <button
                  className="btn-ghost btn-ghost--sm"
                  title="重置为预设地址"
                  onClick={() => patch({ baseUrl: vendorPreset(presetId).baseUrl || providerMeta(draft.provider).defaultBaseUrl })}
                >
                  <IconRefresh size={14} />
                </button>
              </div>
            </label>
            <label className="field">
                <span className="field__label">
                  apiKey{draft.provider === 'ollama' ? '（本地服务可留空）' : ''}
                </span>
                <input
                  className="field__control"
                  type="password"
                  value={draft.apiKey}
                  placeholder={draft.provider === 'ollama' ? '通常不需要' : 'sk-…'}
                  autoComplete="new-password"
                  onChange={(event) => patch({ apiKey: event.target.value })}
                />
              </label>
            </>
            )}
            <div className="field">
              <span className="field__label">
                温度 · {draft.temperature.toFixed(1)}
              </span>
              <input
                type="range"
                min={TEMPERATURE_RANGE.min}
                max={TEMPERATURE_RANGE.max}
                step={TEMPERATURE_RANGE.step}
                value={draft.temperature}
                onChange={(event) => patch({ temperature: Number(event.target.value) })}
              />
            </div>
          </section>

          <section className="setting-group">
            <h3 className="setting-group__title">模型清单</h3>
            <p className="setting-group__desc">勾选左侧圆点即默认模型；上下文窗口与多模态只影响界面提示。</p>
            <div className="model-rows">
              {draft.models.map((model) => {
                const option = draft.modelOptions[model] ?? {
                  contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
                  multimodal: false
                }
                return (
                  <div className={model === draft.defaultModel ? 'model-row is-default' : 'model-row'} key={model}>
                    <label className="model-row__pick">
                      <input
                        type="radio"
                        name="default-model"
                        checked={model === draft.defaultModel}
                        onChange={() => patch({ defaultModel: model })}
                      />
                      <code>{model}</code>
                    </label>
                    <label className="model-row__field" title="上下文窗口（token）">
                      <input
                        className="field__control field__control--sm"
                        type="number"
                        min={CONTEXT_WINDOW_RANGE.min}
                        max={CONTEXT_WINDOW_RANGE.max}
                        step={1024}
                        value={option.contextWindowTokens}
                        onChange={(event) =>
                          patchOption(model, { contextWindowTokens: Number(event.target.value) })
                        }
                      />
                      <span>token</span>
                    </label>
                    <label className="model-row__check" title="支持图片输入">
                      <input
                        type="checkbox"
                        checked={option.multimodal}
                        onChange={(event) => patchOption(model, { multimodal: event.target.checked })}
                      />
                      多模态
                    </label>
                    <button
                      className="model-row__remove"
                      title="移除模型"
                      disabled={draft.models.length <= 1}
                      onClick={() => removeModel(model)}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
            {/* 手动输入永远在：服务商不实现清单接口时，这是唯一的路 */}
            <div className="model-inline model-add">
              <input
                className="field__control"
                list="model-suggestions"
                value={newModel}
                placeholder="填模型 ID，回车添加"
                onChange={(event) => setNewModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addModel()
                  }
                }}
              />
              <datalist id="model-suggestions">
                {suggestions.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
              <button className="btn-ghost btn-ghost--sm" onClick={addModel}>
                <IconPlus size={14} />
                添加
              </button>
              {draft.provider !== 'mock' && !discovering && (
                <button
                  className="btn-ghost btn-ghost--sm"
                  title="向服务商请求可用模型列表"
                  onClick={() => setDiscovering(true)}
                >
                  获取可用模型
                </button>
              )}
            </div>
            {discovering && (
              <ModelDiscovery
                draft={draft}
                onCancel={() => setDiscovering(false)}
                onConfirm={addDiscovered}
              />
            )}
          </section>

          {status && (
            <p
              className={
                status.kind === 'error'
                  ? 'model-status hint-text hint-text--error'
                  : status.kind === 'success'
                    ? 'model-status hint-text model-status--ok'
                    : 'model-status hint-text'
              }
              role="status"
            >
              {status.text}
            </p>
          )}

          <div className="model-actions" data-ui-target="档案操作按钮">
            {activeId && !creating && (
              <button className="btn-ghost btn-ghost--danger" disabled={deleting} onClick={() => void handleDelete()}>
                <IconTrash size={15} />
                {deleting ? '删除中…' : '删除档案'}
              </button>
            )}
            <button className="btn-ghost" disabled={testing} onClick={() => void handleTest()}>
              <IconSpark size={15} />
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button className="btn-primary btn-primary--icon" disabled={saving} onClick={() => void handleSave()}>
              <IconSave size={15} />
              {saving ? '保存中…' : '保存档案'}
            </button>
          </div>

          <p className="hint-text model-footnote">
            <IconPencil size={13} /> 修改默认档案后，聊天页右上角的模型角标会在下次进入时同步。
          </p>
        </main>
      </div>
    </div>
  )
}
