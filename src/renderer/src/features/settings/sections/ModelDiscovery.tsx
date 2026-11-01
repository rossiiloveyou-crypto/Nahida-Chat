import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiscoveredModel, ModelProfileDraft } from '@shared/types'

interface ModelDiscoveryProps {
  draft: ModelProfileDraft
  onCancel: () => void
  onConfirm: (models: DiscoveredModel[]) => void
}

/**
 * 「获取可用模型」的选择器。
 *
 * 拿到清单后不直接写进档案：服务商经常一次返回几十上百个模型，
 * 里面混着 embedding、语音、审核模型，直接全塞进去只会把用户的下拉框搞废。
 * 所以这里先让用户看着勾，只写勾中的。
 */
export function ModelDiscovery({ draft, onCancel, onConfirm }: ModelDiscoveryProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<DiscoveredModel[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  const fetchList = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.nahida.modelProfiles.discover({
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey
      })
      if (!result.ok) {
        setError(result.error ?? '拉取失败')
        setModels([])
        return
      }
      setModels(result.models)
      // 已在本档案里的模型默认勾上，方便用户看出"哪些还没加"
      const existing = new Set(draft.models)
      setPicked(new Set(result.models.filter((m) => existing.has(m.id)).map((m) => m.id)))
      if (result.models.length === 0) setError('服务商返回了空清单')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setModels([])
    } finally {
      setLoading(false)
    }
  }

  // 进面板就拉一次：用户点「获取」的意图已经足够明确，不需要再点第二次。
  // 用 ref 兜住 StrictMode 的重复挂载，避免开发者模式下发两次请求。
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void fetchList()
  }, [])

  const filtered = useMemo(() => {
    if (!models) return []
    const keyword = query.trim().toLowerCase()
    if (!keyword) return models
    return models.filter(
      (item) =>
        item.id.toLowerCase().includes(keyword) ||
        (item.name ? item.name.toLowerCase().includes(keyword) : false)
    )
  }, [models, query])

  const toggle = (id: string): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllVisible = (): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      for (const item of filtered) next.add(item.id)
      return next
    })
  }

  const clearAll = (): void => setPicked(new Set())

  const confirm = (): void => {
    if (!models) return
    const chosen = models.filter((item) => picked.has(item.id))
    onConfirm(chosen)
  }

  return (
    <div className="discovery" data-ui-target="获取可用模型">
      <div className="discovery__head">
        <strong>获取可用模型</strong>
        <span className="hint-text">
          向 {draft.baseUrl || '当前地址'} 请求模型清单，勾选后并入上面的模型清单。
        </span>
      </div>

      {loading && <p className="hint-text">正在请求模型清单…</p>}

      {error && !loading && (
        <div className="discovery__error">
          <p className="hint-text hint-text--error">{error}</p>
          <p className="hint-text">
            有些中转站不实现 /models 接口。这时候只能退回上面的手动输入，模型 ID 以服务商文档为准。
          </p>
        </div>
      )}

      {models && models.length > 0 && !loading && (
        <>
          <div className="discovery__tools">
            <input
              className="field__control field__control--sm"
              type="text"
              placeholder="搜索模型 ID 或名称"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="button" className="btn-ghost btn-ghost--sm" onClick={selectAllVisible}>
              全选可见
            </button>
            <button type="button" className="btn-ghost btn-ghost--sm" onClick={clearAll}>
              清空勾选
            </button>
            <span className="hint-text">
              已选 {picked.size} / {models.length}
            </span>
          </div>

          <div className="discovery__list">
            {filtered.length === 0 && <p className="hint-text">没有匹配的模型。</p>}
            {filtered.map((item) => (
              <label className="discovery__item" key={item.id}>
                <input type="checkbox" checked={picked.has(item.id)} onChange={() => toggle(item.id)} />
                <code className="discovery__id">{item.id}</code>
                {item.name && item.name !== item.id && (
                  <span className="discovery__name">{item.name}</span>
                )}
                {item.contextWindowTokens && (
                  <span className="discovery__meta">
                    {Math.round(item.contextWindowTokens / 1024)}k
                  </span>
                )}
                {item.multimodal && <span className="discovery__meta">多模态</span>}
              </label>
            ))}
          </div>

          <div className="discovery__actions">
            <button type="button" className="btn-ghost" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="btn-ghost" onClick={() => void fetchList()} disabled={loading}>
              重新拉取
            </button>
            <button type="button" className="btn-primary" disabled={picked.size === 0} onClick={confirm}>
              添加所选（{picked.size}）
            </button>
          </div>
        </>
      )}

      {models && models.length === 0 && !loading && (
        <div className="discovery__actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            关闭
          </button>
          <button type="button" className="btn-ghost" onClick={() => void fetchList()}>
            重试
          </button>
        </div>
      )}
    </div>
  )
}
