import { useEffect, useState } from 'react'
import { DEFAULT_STORY_RECALL } from '@shared/constants'
import type { Settings, StoryRecallConfig, StoryRecallStatus } from '@shared/types'
import { NumberField } from '../../../components/NumberField'

interface Props {
  settings: Settings
  saving: boolean
  save: (patch: Partial<Settings>) => Promise<boolean>
}

/** Own draft and explicit save keep the cross-field invariant editable in either order. */
export function StoryRecallPanel({ settings, saving, save }: Props) {
  const [draft, setDraft] = useState<StoryRecallConfig>({ ...DEFAULT_STORY_RECALL, ...settings.storyRecall })
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<StoryRecallStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!dirty) setDraft({ ...DEFAULT_STORY_RECALL, ...settings.storyRecall })
  }, [settings.storyRecall, dirty])

  async function refresh(): Promise<void> {
    try {
      setStatus(await window.nahida.story.recallStatus())
      setStatusError(null)
    } catch (cause) {
      setStatus(null)
      setStatusError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  useEffect(() => {
    void refresh()
    return window.nahida.story.onEmbeddingProgress?.(next => {
      setStatus(current => current ? { ...current, ...next } : current)
      if (!next.backfilling) void refresh()
    })
  }, [])

  async function backfill(cancel = false): Promise<void> {
    try {
      const result = await window.nahida.story.backfillEmbeddings(cancel)
      setStatusError(result.started ? null : result.reason ?? null)
      await refresh()
    } catch (cause) { setStatusError(cause instanceof Error ? cause.message : String(cause)) }
  }

  function change(patch: Partial<StoryRecallConfig>): void {
    setDraft(current => ({ ...current, ...patch }))
    setDirty(true)
    setSaved(false)
    setSaveError(null)
  }
  const invalid = draft.keywordWeight <= draft.minScore
  const busy = saving || pending

  async function persist(): Promise<void> {
    if (invalid || busy) return
    setPending(true)
    setSaveError(null)
    setSaved(false)
    try {
      const next = await save({ storyRecall: { ...draft } })
      if (!next) throw new Error('保存故事召回设置失败，请重试')
      setDirty(false)
      setSaved(true)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="setting-group" data-ui-region="R 故事召回" data-ui-target="故事区RAG召回">
      <h3 className="setting-group__title">故事区 RAG 召回</h3>
      <p className="setting-group__desc">按轮找回故事原文；独立开关，不受普通聊天事实记忆设置影响。</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className="memory-check" data-ui-target="故事召回开关">
          <input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />
          <span>启用故事召回</span>
        </label>
        <label className="memory-num" data-ui-target="故事召回轮数">
          <span className="memory-num__label">最多召回轮数 N</span>
          <NumberField className="field__control field__control--sm" value={draft.n} min={1} max={20} onCommit={n => change({ n })} />
          <span className="memory-num__unit">轮</span>
        </label>
        <label className="memory-num" data-ui-target="故事召回预算">
          <span className="memory-num__label">token 预算</span>
          <NumberField className="field__control field__control--sm" value={draft.budgetTokens} min={1000} max={32000} step={1000} onCommit={budgetTokens => change({ budgetTokens })} />
        </label>
        <label className="memory-num" data-ui-target="故事召回阈值">
          <span className="memory-num__label">相似度阈值</span>
          <NumberField className="field__control field__control--sm" value={draft.minScore} min={0} max={1} step={0.05} onCommit={minScore => change({ minScore })} />
        </label>
        <label className="memory-num" data-ui-target="故事关键词权重">
          <span className="memory-num__label">关键词权重</span>
          <NumberField className="field__control field__control--sm" value={draft.keywordWeight} min={0} max={1} step={0.05} onCommit={keywordWeight => change({ keywordWeight })} />
        </label>
        <label className="memory-num" data-ui-target="故事补查深度">
          <span className="memory-num__label">补查较新状态深度</span>
          <NumberField className="field__control field__control--sm" value={draft.recheckDepth} min={0} max={64} onCommit={recheckDepth => change({ recheckDepth })} />
          <span className="memory-num__unit">0 关闭补查</span>
        </label>
      </fieldset>
      {invalid && <p className="hint-text hint-text--error" role="alert" data-ui-target="故事召回校验">关键词权重必须大于相似度阈值，否则模型未安装 / 向量不可用时，纯关键词召回会全部被过滤掉</p>}
      <div className="settings-actions">
        <button type="button" className="btn-primary" disabled={invalid || busy} onClick={() => void persist()} data-ui-target="保存故事召回设置">{pending ? '保存中…' : '保存故事召回设置'}</button>
        <button type="button" className="btn-ghost" onClick={() => void refresh()} data-ui-target="刷新故事召回状态">刷新状态</button>
      </div>
      <div className="settings-actions">
        <button type="button" className="btn-ghost" disabled={!!status?.backfilling} onClick={() => void backfill()} data-ui-target="补算故事向量">补算向量</button>
        {status?.backfilling && <button type="button" className="btn-ghost" onClick={() => void backfill(true)} data-ui-target="停止故事向量补算">停止补算</button>}
      </div>
      {saveError && <p className="hint-text hint-text--error" role="alert">{saveError}</p>}
      {saved && <p className="hint-text" role="status">故事召回设置已保存</p>}
      <div data-ui-target="故事召回状态" aria-live="polite">
        <dl className="info-grid">
          <dt>已归档轮数</dt><dd>{status?.archivedRounds ?? '—'}</dd>
          <dt>已有向量轮数</dt><dd>{status?.vectorRounds ?? '—'}</dd>
          <dt>向量可用性</dt><dd>{status?.vectorReady ? '可用' : '不可用（仅关键词召回，可能漏细节）'}</dd>
          <dt>最近一次召回</dt><dd className="story-recall-last">{status?.lastRecall ? status.lastRecall.hitRounds + ' 轮' +
            ((status.lastRecall.dropped ?? 0) > 0 ? '（另有 ' + status.lastRecall.dropped + ' 轮因预算未注入）' : '') : '暂无记录'}</dd>
          <dt>本次命中分量</dt><dd className="story-recall-components">{status?.lastRecall?.top?.length
            ? status.lastRecall.top.slice(0, 3).map((hit, index) => <div key={index}>第 {hit.roundIndex + 1} 轮 向量 {hit.vectorScore?.toFixed(2) ?? '—'} / 关键词 {hit.keywordScore?.toFixed(2) ?? '—'}</div>)
            : '暂无记录'}</dd>
          <dt>待补向量轮数</dt><dd>{status?.pendingRounds ?? '—'}（{status?.pendingChunks ?? '—'} 个分片）</dd>
          <dt>补算进度</dt><dd>{status?.backfilling ? `${status.backfilling.done} / ${status.backfilling.total}` : '未在补算'}</dd>
        </dl>
        {status && <div className="story-recall-stories">
          <h4>按故事区</h4>
          {status.stories?.length ? <ul>
            {status.stories.map(story => <li key={story.storyId}>
              <span>{story.title}{story.branchLabel ? '（' + story.branchLabel + '）' : ''}</span>
              {' · '}归档 {story.archivedRounds} · 向量 {story.vectorRounds} · 待补 {story.pendingRounds}
              {'（'}{story.pendingChunks} 个分片）
            </li>)}
          </ul> : <p className="hint-text">还没有故事区</p>}
        </div>}
        {!status?.vectorReady && <p className="hint-text hint-text--error" role="status" data-ui-target="故事向量降级提示"><strong>不可用（仅关键词召回，可能漏细节）</strong>{status?.lastError ? '：' + status.lastError : status?.modelInstalled ? ' · 模型已安装，等待下次检索加载' : ' · 模型未安装或尚未就绪'}</p>}
        {status?.pendingError && <p className="hint-text hint-text--error" role="alert">向量待补原因：{status.pendingError}</p>}
        {statusError && <p className="hint-text hint-text--error" role="alert">状态读取失败：{statusError}</p>}
        {status?.databaseErrors.map(message => <p className="hint-text hint-text--error" role="alert" key={message}>故事库统计失败：{message}</p>)}
      </div>
    </section>
  )
}
