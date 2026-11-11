import { useCallback, useEffect, useState } from 'react'
import {
  MEMORY_BUDGET_RANGE,
  MEMORY_TOP_K_RANGE,
  SUMMARY_CHARS_RANGE,
  SUMMARY_TRIGGER_RANGE,
  SUMMARY_WINDOW_RANGE
} from '@shared/constants'
import type {
  MemoryEntry,
  MemoryRecallHit,
  MemoryStatus,
  SummarySettings,
  SummaryStatus
} from '@shared/types'
import { useChatStore } from '../../chat/store'
import { useSettings } from '../useSettings'

/**
 * 长期记忆设置分区。
 *
 * 这个页面不只是开关集合，它同时是「记忆的可审计界面」：
 * 用户必须能看到、能改、能删掉每一条记住了什么，
 * 否则记忆就是个黑箱——出了「她为什么说这个」的问题根本没法排查。
 *
 * 页面有两个**互不相干**的记忆层，别把它们混成一件事：
 * - 对话摘要（第一段）：把窗口外的对话压成四段文本，**无条件**注入；
 * - 事实记忆（其余各段）：从你的发言里抽事实，**按 query 检索**，命中才注入。
 * 前者管「刚才聊到哪」，后者管「你是谁」。存储也是两个文件。
 */
export function MemorySection() {
  const { settings, loading, saving, error, save } = useSettings()
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus | null>(null)
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryRecallHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextEntries] = await Promise.all([
        window.nahida.memory.status(),
        window.nahida.memory.list()
      ])
      setStatus(nextStatus)
      setEntries(nextEntries)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const memory = settings?.memory
  const summaryCfg = settings?.summary

  const patch = async (value: Partial<NonNullable<typeof memory>>): Promise<void> => {
    if (!memory) return
    await save({ memory: { ...memory, ...value } })
    await refresh()
  }

  // ── 对话摘要 ──────────────────────────────────────────────────────
  // 状态独立于 RAG 那份：它在 summaries.json，不是 memory.db。
  const activeSessionId = useChatStore((s) => s.activeId)

  const refreshSummary = useCallback(async (): Promise<void> => {
    try {
      setSummaryStatus(await window.nahida.summary.status())
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refreshSummary()
  }, [refreshSummary])

  const patchSummary = async (value: Partial<SummarySettings>): Promise<void> => {
    if (!summaryCfg) return
    await save({ summary: { ...summaryCfg, ...value } })
  }

  const forgetSummary = async (): Promise<void> => {
    if (!activeSessionId) return
    try {
      setSummaryStatus(await window.nahida.summary.forget(activeSessionId))
      setNotice('已忘掉当前会话的摘要；下一次请求会下发完整历史。')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const clearSummaries = async (): Promise<void> => {
    try {
      setSummaryStatus(await window.nahida.summary.clear())
      setNotice('已清空全部对话摘要（聊天记录与事实记忆未受影响）。')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const addEntry = async (): Promise<void> => {
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setNotice(null)
    try {
      const next = await window.nahida.memory.save({ content })
      setEntries(next)
      setDraft('')
      setNotice('已存入记忆，并已生成向量')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const removeEntry = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.nahida.memory.remove(id)
      setEntries(next)
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const clearAll = async (): Promise<void> => {
    if (!window.confirm('清空全部记忆？这一步不可撤销。')) return
    setBusy(true)
    try {
      const next = await window.nahida.memory.clear()
      setEntries(next)
      setNotice('已清空全部记忆')
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const runRecall = async (): Promise<void> => {
    const text = query.trim()
    if (!text) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.nahida.memory.recall(text)
      setHits(result)
      if (result.length === 0) setNotice('没有任何记忆命中——可能是库为空，或分数都低于下限')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="hint-text">读取中…</p>

  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>长期记忆</h1>
        <p>
          本页两件事：<strong>对话摘要</strong>把窗口外的对话压成摘要，让长对话接得上；
          <strong>事实记忆</strong>跨会话记住你说过的事实。检索与摘要在本地编排，
          对话内容不外发做 embedding。
        </p>
      </div>

      {error && <p className="hint-text hint-text--error">{error}</p>}
      {notice && <p className="hint-text">{notice}</p>}

      <section className="setting-group">
        <h3 className="setting-group__title">对话摘要（窗口外的对话）</h3>
        <p className="setting-group__desc">
          对话变长以后，早期内容会掉出上下文窗口。这里每攒够 N 条就把那一段压成四段摘要
          （近期话题 / 你的信息 / 重要约定 / 长期经历），之后每轮把摘要注入 system，
          历史只下发最近 W 条。于是上下文长度是常数，长对话不会失忆。
          与下面的「事实记忆」是两套：那个按问题检索事实，这个无条件注入对话。
        </p>

        <div data-ui-target="对话摘要参数">
          <label className="memory-check">
            <input
              type="checkbox"
              checked={Boolean(summaryCfg?.enabled)}
              disabled={saving}
              onChange={(event) => void patchSummary({ enabled: event.target.checked })}
            />
            <span>启用对话摘要（关闭后不压缩、不注入，历史全量下发）</span>
          </label>

          <div className="memory-num">
            <span className="memory-num__label">触发条数</span>
            <input
              className="field__control field__control--sm"
              type="number"
              min={SUMMARY_TRIGGER_RANGE.min}
              max={SUMMARY_TRIGGER_RANGE.max}
              value={summaryCfg?.triggerCount ?? 40}
              disabled={saving || !summaryCfg?.enabled}
              onChange={(event) => void patchSummary({ triggerCount: Number(event.target.value) })}
            />
            <span className="memory-num__unit">条未压缩消息压一次（越小越省上下文、越费调用）</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">保留窗口</span>
            <input
              className="field__control field__control--sm"
              type="number"
              min={SUMMARY_WINDOW_RANGE.min}
              max={SUMMARY_WINDOW_RANGE.max}
              value={summaryCfg?.windowCount ?? 12}
              disabled={saving || !summaryCfg?.enabled}
              onChange={(event) => void patchSummary({ windowCount: Number(event.target.value) })}
            />
            <span className="memory-num__unit">条最近原文保留（0 = 只靠摘要接话）</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">近期话题上限</span>
            <input
              className="field__control field__control--sm"
              type="number"
              min={SUMMARY_CHARS_RANGE.min}
              max={SUMMARY_CHARS_RANGE.max}
              value={summaryCfg?.shortTermMaxChars ?? 400}
              disabled={saving || !summaryCfg?.enabled}
              onChange={(event) => void patchSummary({ shortTermMaxChars: Number(event.target.value) })}
            />
            <span className="memory-num__unit">字符 · 0 不截断</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">你的信息上限</span>
            <input
              className="field__control field__control--sm"
              type="number"
              min={SUMMARY_CHARS_RANGE.min}
              max={SUMMARY_CHARS_RANGE.max}
              value={summaryCfg?.userInfoMaxChars ?? 600}
              disabled={saving || !summaryCfg?.enabled}
              onChange={(event) => void patchSummary({ userInfoMaxChars: Number(event.target.value) })}
            />
            <span className="memory-num__unit">字符 · 0 不截断</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">重要约定上限</span>
            <input
              className="field__control field__control--sm"
              type="number"
              min={SUMMARY_CHARS_RANGE.min}
              max={SUMMARY_CHARS_RANGE.max}
              value={summaryCfg?.promisesMaxChars ?? 400}
              disabled={saving || !summaryCfg?.enabled}
              onChange={(event) => void patchSummary({ promisesMaxChars: Number(event.target.value) })}
            />
            <span className="memory-num__unit">字符 · 0 不截断</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">长期经历上限</span>
            <input
              className="field__control field__control--sm"
              type="number"
              min={SUMMARY_CHARS_RANGE.min}
              max={SUMMARY_CHARS_RANGE.max}
              value={summaryCfg?.longTermMaxChars ?? 1200}
              disabled={saving || !summaryCfg?.enabled}
              onChange={(event) => void patchSummary({ longTermMaxChars: Number(event.target.value) })}
            />
            <span className="memory-num__unit">字符 · 0 不截断</span>
          </div>
        </div>

        <dl className="info-grid" data-ui-target="对话摘要状态">
          <dt>已摘要会话</dt>
          <dd>{summaryStatus ? summaryStatus.sessionCount + ' 条' : '读取中…'}</dd>
          <dt>已压缩消息</dt>
          <dd>{summaryStatus ? summaryStatus.coveredMessages + ' 条' : '—'}</dd>
          <dt>最近更新</dt>
          <dd>
            {summaryStatus && summaryStatus.lastUpdatedAt > 0
              ? new Date(summaryStatus.lastUpdatedAt).toLocaleString()
              : '还没有压缩过'}
          </dd>
          <dt>数据文件</dt>
          <dd>{summaryStatus?.file ?? '—'}</dd>
          {summaryStatus?.lastError && (
            <>
              <dt>最近错误</dt>
              <dd className="hint-text hint-text--error">{summaryStatus.lastError}</dd>
            </>
          )}
        </dl>
        {!summaryCfg?.enabled && (
          <p className="hint-text">
            已关闭：不压缩、不注入摘要，历史全量下发 —— 与没有这个功能时的行为一致。
          </p>
        )}

        <div className="settings-actions" data-ui-target="对话摘要操作">
          <button type="button" className="btn-ghost" onClick={() => void refreshSummary()}>
            刷新状态
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={!activeSessionId}
            onClick={() => void forgetSummary()}
          >
            忘掉当前会话的摘要
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={!summaryStatus || summaryStatus.sessionCount === 0}
            onClick={() => void clearSummaries()}
          >
            清空全部摘要
          </button>
        </div>
        <p className="hint-text">
          「忘掉」只删摘要，不动聊天记录；清空后模型会重新看到完整历史，直到再次攒够触发条数。
        </p>
      </section>

      <section className="setting-group">
        <h3 className="setting-group__title">运行状态</h3>
        <p className="setting-group__desc">
          记忆是增强能力：任何一环不可用时，对话会照常进行，只是没有记忆。
        </p>
        {status ? (
          <dl className="info-grid" data-ui-target="记忆状态">
            <dt>总开关</dt>
            <dd>{memory?.enabled ? '已启用' : '已关闭'}</dd>
            <dt>向量模型</dt>
            <dd>
              {status.modelReady ? (
                <span>{status.modelId} · {status.dimensions} 维 · 已加载</span>
              ) : (
                <span>未加载（首次检索时按需载入）</span>
              )}
            </dd>
            <dt>记忆条数</dt>
            <dd>{status.entryCount} 条</dd>
            <dt>数据库</dt>
            <dd>{status.dbPath}</dd>
            {status.lastError && (
              <>
                <dt>最近错误</dt>
                <dd className="hint-text hint-text--error">{status.lastError}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="hint-text">读取中…</p>
        )}
        <div className="settings-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void window.nahida.memory.openModelDir()}
          >
            打开模型目录
          </button>
          <button type="button" className="btn-ghost" onClick={() => void refresh()}>
            刷新状态
          </button>
        </div>
        {status && !status.modelReady && (
          <p className="hint-text">
            模型目录应放 <code>Xenova/bge-m3/</code>，包含 config.json、tokenizer.json 与
            onnx/model_quantized.onnx。缺文件时记忆会退化为纯关键词检索。
          </p>
        )}
      </section>

      <section className="setting-group">
        <h3 className="setting-group__title">检索参数</h3>
        <p className="setting-group__desc">
          预算决定每轮对话最多塞多少记忆进上下文。这里没有硬上限：填多少就按多少走，代价是你的模型上下文。
          调小更省 token，调大记性更好但更容易干扰当前话题。
        </p>
        <div data-ui-target="检索参数">
        <label className="memory-check">
          <input
            type="checkbox"
            checked={Boolean(memory?.enabled)}
            disabled={saving}
            onChange={(event) => void patch({ enabled: event.target.checked })}
          />
          <span>启用长期记忆（关闭后既不写入也不召回）</span>
        </label>
        <label className="memory-check">
          <input
            type="checkbox"
            checked={Boolean(memory?.autoExtract)}
            disabled={saving || !memory?.enabled}
            onChange={(event) => void patch({ autoExtract: event.target.checked })}
          />
          <span>对话结束后自动提炼记忆（只从你的发言里抽取）</span>
        </label>
        <div className="memory-num">
          <span className="memory-num__label">每次最多注入</span>
          <input
            className="field__control field__control--sm"
            type="number"
            min={MEMORY_TOP_K_RANGE.min}
            max={MEMORY_TOP_K_RANGE.max}
            value={memory?.topK ?? 5}
            disabled={saving || !memory?.enabled}
            onChange={(event) => void patch({ topK: Number(event.target.value) })}
          />
          <span className="memory-num__unit">条</span>
        </div>
        <div className="memory-num">
          <span className="memory-num__label">token 预算</span>
          <input
            className="field__control field__control--sm"
            type="number"
            min={MEMORY_BUDGET_RANGE.min}
            step={MEMORY_BUDGET_RANGE.step}
            value={memory?.budgetTokens ?? 1200}
            disabled={saving || !memory?.enabled}
            onChange={(event) => void patch({ budgetTokens: Number(event.target.value) })}
          />
          <span className="memory-num__unit">token · 不设上限</span>
        </div>
        <div className="memory-num">
          <span className="memory-num__label">分数下限</span>
          <input
            className="field__control field__control--sm"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={memory?.minScore ?? 0.55}
            disabled={saving || !memory?.enabled}
            onChange={(event) => void patch({ minScore: Number(event.target.value) })}
          />
          <span className="memory-num__unit">低于此分数宁可不注入</span>
        </div>
        </div>
      </section>

      <section className="setting-group">
        <h3 className="setting-group__title">检索调试</h3>
        <p className="setting-group__desc">
          输入一句话，看现在会召回哪些记忆、各条分数多少。用于判断分数下限设得合不合适。
        </p>
        <div className="memory-inline" data-ui-target="试召回输入">
          <input
            className="field__control"
            type="text"
            placeholder="例如：我住在哪"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runRecall()
            }}
          />
          <button type="button" className="btn-primary" disabled={busy || !query.trim()} onClick={() => void runRecall()}>
            试召回
          </button>
        </div>
        {hits && hits.length > 0 && (
          <ul className="memory-list" data-ui-target="召回结果">
            {hits.map((hit) => (
              <li key={hit.id} className="memory-list__item">
                <div className="memory-list__body">
                  <span className="memory-list__text">{hit.content}</span>
                  <span className="memory-list__meta">
                    综合 {hit.score.toFixed(3)} · 向量 {hit.vectorScore.toFixed(3)} · 关键词{' '}
                    {hit.keywordScore.toFixed(2)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="setting-group">
        <h3 className="setting-group__title">记忆内容（{entries.length} 条）</h3>
        <p className="setting-group__desc">
          每一条都能溯源到来源对话。手动添加的条目也会生成向量，可被语义检索命中。
        </p>
        <div className="memory-inline" data-ui-target="添加记忆">
          <input
            className="field__control"
            type="text"
            placeholder="手动添加一条事实，例如：用户是前端工程师"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void addEntry()
            }}
          />
          <button type="button" className="btn-primary" disabled={busy || !draft.trim()} onClick={() => void addEntry()}>
            添加
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || entries.length === 0}
            onClick={() => void clearAll()}
          >
            清空全部
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="hint-text">还没有记忆。开启自动提炼后，聊几句就会出现在这里。</p>
        ) : (
          <ul className="memory-list" data-ui-target="记忆列表">
            {entries.map((entry) => (
              <li key={entry.id} className="memory-list__item">
                <div className="memory-list__body">
                  <span className="memory-list__text">{entry.content}</span>
                  <span className="memory-list__meta">
                    {formatDate(entry.createdAt)} · 命中 {entry.hitCount} 次
                    {entry.sourceMessageId ? ' · 来自对话' : ' · 手动添加'}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-ghost--sm"
                  disabled={busy}
                  onClick={() => void removeEntry(entry.id)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}