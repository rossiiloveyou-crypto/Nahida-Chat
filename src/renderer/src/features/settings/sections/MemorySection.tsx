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
  MemoryModelProgress,
  MemoryStatus,
  PersonaHistoryEntry,
  SummarySettings,
  SummaryStatus
} from '@shared/types'
import type { MemoryDeleteReport, MemoryPersonaRow, MemoryUserDetail, MemoryUserRow } from '@shared/api'
import { useChatStore } from '../../chat/store'
import { useSettings } from '../useSettings'
import { useModelProfiles } from '../useModelProfiles'
import { NumberField } from '../../../components/NumberField'
import { WipeDialog } from './WipeDialog'
import { StoryRecallPanel } from './StoryRecallPanel'

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
  const models = useModelProfiles()

  /**
   * 一键安装模型。
   * 失败原因原样显示（镜像/网络/磁盘），不吞成"未知错误"——用户要能据此判断
   * 是网络问题还是磁盘空间问题。装完刷新状态，模型即可用。
   */
  const startModelDownload = useCallback(async (): Promise<void> => {
    setDownloadError(null)
    setDownloading({ phase: 'downloading', file: '', ratio: 0, receivedBytes: 0, totalBytes: 0 })
    const unsubscribe = window.nahida.memory.onModelProgress((progress) => {
      setDownloading(progress.phase === 'done' || progress.phase === 'failed' ? null : progress)
    })
    try {
      const result = await window.nahida.memory.downloadModel()
      if (!result.ok) throw new Error(result.error ?? '下载失败')
      setStatus(result.status)
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      unsubscribe()
      setDownloading(null)
    }
  }, [])
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [downloading, setDownloading] = useState<MemoryModelProgress | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus | null>(null)
  const [users, setUsers] = useState<MemoryUserRow[]>([])
  const [selected, setSelected] = useState<MemoryUserDetail | null>(null)
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [history, setHistory] = useState<PersonaHistoryEntry[]>([])
  const [openPersona, setOpenPersona] = useState<string | null>(null)
  const [report, setReport] = useState<MemoryDeleteReport | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryRecallHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // P7：清空全部数据（本页唯一不可逆的入口，弹框自己管验证码状态）
  const [wipeOpen, setWipeOpen] = useState(false)
  // D-2：清空失败的提示必须渲染在**危险区**（用户点按钮时在页面最底，顶部那句在视口外）
  const [wipeNotice, setWipeNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextUsers] = await Promise.all([
        window.nahida.memory.status(),
        window.nahida.memory.users()
      ])
      setStatus(nextStatus)
      setUsers(nextUsers)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const memory = settings?.memory
  const summaryCfg = settings?.summary
  const summaryProfileId = summaryCfg?.profileId ?? ''
  const summaryProfile = models.catalog.profiles.find((profile) => profile.id === summaryProfileId)
  const summaryModel = summaryCfg?.model ?? ''
  const summaryProfileMissing = !models.loading && !models.error && Boolean(summaryProfileId && !summaryProfile)

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

  // ── 按人聚合（P5 / M19 / M23）─────────────────────────────────────
  // 列表态 → 详情态只有一个 selected 状态，故意不引入路由：设置页本身就是
  // active === 'memory' 的单页切换，加路由会动到 P7 的入口结构。
  const openUser = async (userId: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    setReport(null)
    try {
      setSelected(await window.nahida.memory.userDetail(userId))
      setEntries([])
      setHistory([])
      setOpenPersona(null)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const reloadDetail = async (userId: string): Promise<void> => {
    setSelected(await window.nahida.memory.userDetail(userId))
  }

  const viewPersona = async (personaId: string): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.nahida.memory.userEntries(selected.userId, personaId)
      setEntries(result.entries)
      setHistory(result.history)
      setOpenPersona(personaId)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  // H-B-03：手动添加一条事实的能力**保留**，但只能写进「当前这个人的这个人设」。
  // 不许再像旧代码那样只传 { content } —— 那会落到 root/default 头上，把事实记到别人账上。
  const addEntry = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || !selected || !openPersona) return
    setBusy(true)
    setNotice(null)
    try {
      await window.nahida.memory.save({ content, userId: selected.userId, personaId: openPersona })
      const result = await window.nahida.memory.userEntries(selected.userId, openPersona)
      setEntries(result.entries)
      setHistory(result.history)
      setDraft('')
      setNotice('已存入这个人设，并已生成向量')
      await reloadDetail(selected.userId)
      await refresh()
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeEntry = async (id: string): Promise<void> => {
    if (!selected || !openPersona) return
    setBusy(true)
    try {
      await window.nahida.memory.remove(id)
      const result = await window.nahida.memory.userEntries(selected.userId, openPersona)
      setEntries(result.entries)
      setHistory(result.history)
      await reloadDetail(selected.userId)
      await refresh()
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const runDeletePersona = async (persona: MemoryPersonaRow): Promise<void> => {
    if (!selected) return
    const ok = window.confirm(
      '删除人设「' +
        persona.personaId +
        '」？\n\n' +
        '会删掉它的 ' +
        persona.memoryCount +
        ' 条记忆与 ' +
        persona.historyCount +
        ' 条聊天历史，不可撤销。\n' +
        '这个人的其它人设不受影响。'
    )
    if (!ok) return
    setBusy(true)
    setNotice(null)
    try {
      const next = await window.nahida.memory.deletePersona(selected.userId, persona.personaId)
      setReport(next)
      setEntries([])
      setHistory([])
      setOpenPersona(null)
      await reloadDetail(selected.userId)
      await refresh()
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  // 🔴 M23 的全部可读承诺都在这段确认框里：删数据、留授权、不碰群聊、不碰故事区。
  // 少写任何一句，用户删完就会以为「她把我拉黑了」，或者以为「没删干净」。
  const runDeleteUser = async (): Promise<void> => {
    if (!selected) return
    const memoryTotal = selected.personas.reduce((sum, persona) => sum + persona.memoryCount, 0)
    const historyTotal = selected.personas.reduce((sum, persona) => sum + persona.historyCount, 0)
    const ok = window.confirm(
      '删除「' +
        (selected.label || selected.userId) +
        '」的全部记忆？\n\n' +
        '会删掉：\n' +
        '  · ' +
        memoryTotal +
        ' 条记忆（RAG 事实）\n' +
        '  · ' +
        historyTotal +
        ' 条聊天历史（所有人设）\n' +
        '  · ' +
        selected.personas.length +
        ' 个人设\n' +
        '  · 他的对话摘要\n' +
        '  · 他的私聊聊天记录\n\n' +
        '不会删掉：\n' +
        '  · 他的使用授权 —— 删完他仍然可以和我说的话，只是我完全不记得他了\n' +
        '  · 群聊里的记录（那里混着别人的发言）\n' +
        '  · 故事区的剧情（在各自的库里）\n\n' +
        '不可撤销。'
    )
    if (!ok) return
    setBusy(true)
    setNotice(null)
    try {
      const next = await window.nahida.memory.deleteUser(selected.userId)
      setReport(next)
      setSelected(null)
      setEntries([])
      setHistory([])
      setOpenPersona(null)
      await refresh()
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openUserDataDir = async (): Promise<void> => {
    try {
      const failed = await window.nahida.memory.openDir()
      setNotice(failed ? '打开目录失败：' + failed : null)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
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
        <p>
          记忆按「<strong>人 × 人设</strong>」分区存放，下面可以按人查看与清理；
          「对话摘要」是另一套，不受这里任何开关影响。
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
            <NumberField
              className="field__control field__control--sm"
              min={SUMMARY_TRIGGER_RANGE.min}
              max={SUMMARY_TRIGGER_RANGE.max}
              value={summaryCfg?.triggerCount ?? 40}
              disabled={!summaryCfg?.enabled}
              onCommit={(next) => void patchSummary({ triggerCount: next })}
            />
            <span className="memory-num__unit">条未压缩消息压一次（越小越省上下文、越费调用）</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">保留窗口</span>
            <NumberField
              className="field__control field__control--sm"
              min={SUMMARY_WINDOW_RANGE.min}
              max={SUMMARY_WINDOW_RANGE.max}
              value={summaryCfg?.windowCount ?? 12}
              disabled={!summaryCfg?.enabled}
              onCommit={(next) => void patchSummary({ windowCount: next })}
            />
            <span className="memory-num__unit">条最近原文保留（0 = 只靠摘要接话）</span>
          </div>

          <label className="field">
            <span className="field__label">总结模型档案</span>
            <select
              className="field__control"
              data-ui-target="总结模型档案"
              value={summaryProfileId}
              disabled={loading || saving || models.loading || Boolean(models.error) || !summaryCfg}
              onChange={(event) => void patchSummary({ profileId: event.target.value || null, model: null })}
            >
              <option value="">跟随默认档案</option>
              {summaryProfileId && !summaryProfile && (
                <option value={summaryProfileId}>{summaryProfileMissing ? '已不存在的档案' : '正在读取档案'}（{summaryProfileId}）</option>
              )}
              {models.catalog.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name || profile.provider}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">总结模型</span>
            <select
              className="field__control"
              data-ui-target="总结模型"
              value={summaryProfile ? summaryModel : ''}
              disabled={loading || saving || models.loading || Boolean(models.error) || !summaryProfile}
              onChange={(event) => void patchSummary({ model: event.target.value || null })}
            >
              <option value="">档案默认模型{summaryProfile ? '（' + summaryProfile.defaultModel + '）' : ''}</option>
              {summaryProfile && summaryModel && !summaryProfile.models.includes(summaryModel) && (
                <option value={summaryModel}>已不在档案中的模型（{summaryModel}）</option>
              )}
              {summaryProfile?.models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
          {summaryProfileMissing && (
            <p className="hint-text hint-text--error">所选档案已不存在，摘要将回退到当前会话使用的档案。请选择其他档案或跟随默认档案。</p>
          )}
          {models.error && <p className="hint-text hint-text--error">档案列表读取失败：{models.error}</p>}

          <div className="memory-num">
            <span className="memory-num__label">近期话题上限</span>
            <NumberField
              className="field__control field__control--sm"
              min={SUMMARY_CHARS_RANGE.min}
              max={SUMMARY_CHARS_RANGE.max}
              value={summaryCfg?.shortTermMaxChars ?? 400}
              disabled={!summaryCfg?.enabled}
              onCommit={(next) => void patchSummary({ shortTermMaxChars: next })}
            />
            <span className="memory-num__unit">字符 · 0 不截断</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">你的信息上限</span>
            <NumberField
              className="field__control field__control--sm"
              min={SUMMARY_CHARS_RANGE.min}
              max={SUMMARY_CHARS_RANGE.max}
              value={summaryCfg?.userInfoMaxChars ?? 600}
              disabled={!summaryCfg?.enabled}
              onCommit={(next) => void patchSummary({ userInfoMaxChars: next })}
            />
            <span className="memory-num__unit">字符 · 0 不截断</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">重要约定上限</span>
            <NumberField
              className="field__control field__control--sm"
              min={SUMMARY_CHARS_RANGE.min}
              max={SUMMARY_CHARS_RANGE.max}
              value={summaryCfg?.promisesMaxChars ?? 400}
              disabled={!summaryCfg?.enabled}
              onCommit={(next) => void patchSummary({ promisesMaxChars: next })}
            />
            <span className="memory-num__unit">字符 · 0 不截断</span>
          </div>

          <div className="memory-num">
            <span className="memory-num__label">长期经历上限</span>
            <NumberField
              className="field__control field__control--sm"
              min={SUMMARY_CHARS_RANGE.min}
              max={SUMMARY_CHARS_RANGE.max}
              value={summaryCfg?.longTermMaxChars ?? 1200}
              disabled={!summaryCfg?.enabled}
              onCommit={(next) => void patchSummary({ longTermMaxChars: next })}
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

      {settings && <StoryRecallPanel settings={settings} saving={saving} save={save} />}

      <details data-ui-target="普通聊天事实记忆">
        <summary>事实记忆（普通聊天使用）</summary>
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
            <dt>RAG 事实条数</dt>
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
            className="btn-primary"
            data-ui-target="下载 RAG 模型"
            disabled={downloading !== null || Boolean(status?.modelInstalled)}
            onClick={() => void startModelDownload()}
          >
            {status?.modelInstalled ? '向量模型已安装' : downloading ? '下载中…' : '一键下载并配置模型'}
          </button>
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
        {downloading && (
          <p className="hint-text" data-ui-target="下载进度">
            {downloading.phase === 'verifying' ? '校验中' : downloading.file || '准备中'} ·{' '}
            {Math.round(downloading.ratio * 100)}%（{(downloading.receivedBytes / 1048576).toFixed(1)} /{' '}
            {(downloading.totalBytes / 1048576).toFixed(1)} MB）
          </p>
        )}
        {downloadError && <p className="hint-text hint-text--error">{downloadError}</p>}
        {status && !status.modelReady && (
          <p className="hint-text">
            点「一键下载并配置模型」即可，无需手动放文件；下载到{' '}
            <code>{status.downloadDir}</code>，装完自动生效。
            缺文件时记忆会退化为纯关键词检索。
          </p>
        )}
      </section>

      <section className="setting-group">
        <h3 className="setting-group__title">检索参数</h3>
        <p className="setting-group__desc">
          预算决定每轮对话最多塞多少记忆进上下文。这里没有硬上限：填多少就按多少走，代价是你的模型上下文。
          调小更省 token，调大记性更好但更容易干扰当前话题。
          关闭这个开关只停 RAG 事实的写入与召回 —— 聊天记录、上下文、人设历史、对话摘要一律照常。
        </p>
        <div data-ui-target="检索参数">
        <label className="memory-check">
          <input
            type="checkbox"
            checked={Boolean(memory?.enabled)}
            disabled={saving}
            onChange={(event) => void patch({ enabled: event.target.checked })}
          />
          <span>启用 RAG 记忆（关闭后不写入、不召回检索到的事实；聊天记录与对话摘要照常）</span>
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
          <NumberField
            className="field__control field__control--sm"
            min={MEMORY_TOP_K_RANGE.min}
            max={MEMORY_TOP_K_RANGE.max}
            value={memory?.topK ?? 5}
            disabled={!memory?.enabled}
            onCommit={(next) => void patch({ topK: next })}
          />
          <span className="memory-num__unit">条</span>
        </div>
        <div className="memory-num">
          <span className="memory-num__label">token 预算</span>
          <NumberField
            className="field__control field__control--sm"
            min={MEMORY_BUDGET_RANGE.min}
            step={MEMORY_BUDGET_RANGE.step}
            value={memory?.budgetTokens ?? 1200}
            disabled={!memory?.enabled}
            onCommit={(next) => void patch({ budgetTokens: next })}
          />
          <span className="memory-num__unit">token · 不设上限</span>
        </div>
        <div className="memory-num">
          <span className="memory-num__label">分数下限</span>
          <NumberField
            className="field__control field__control--sm"
            min={0}
            max={1}
            step={0.05}
            value={memory?.minScore ?? 0.55}
            disabled={!memory?.enabled}
            onCommit={(next) => void patch({ minScore: next })}
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
        <h3 className="setting-group__title">按人查看与清理</h3>
        {selected === null ? (
          <>
            <p className="setting-group__desc">
              每个人一行：<strong>记忆</strong>是 RAG 事实条数，<strong>历史</strong>是人设聊天条数 ——
              两张表分别计数，不是一回事。点「查看」进详情：人设、近期聊天、库文件真实路径，以及按人删除。
            </p>
            <div className="qq-table qq-table--memory" data-ui-target="按人列表">
              <div className="qq-table__head">
                <span>用户</span>
                <span>人设</span>
                <span>记忆</span>
                <span>历史</span>
                <span>操作</span>
              </div>
              {users.length === 0 && (
                <p className="hint-text">还没有任何人的记忆。聊几句、抽出事实后就会出现在这里。</p>
              )}
              {users.map((row) => (
                <div className="qq-table__row" key={row.userId}>
                  <span title={row.userId}>
                    {row.label ? row.label + '（' + row.userId + '）' : row.userId}
                    {row.inAllowList ? null : <em className="qq-tag-multi">未授权</em>}
                  </span>
                  <span>{row.personaCount}</span>
                  <span>{row.memoryCount}</span>
                  <span>{row.historyCount}</span>
                  <span className="qq-table__actions">
                    <button
                      type="button"
                      className="btn-ghost btn-ghost--sm"
                      disabled={busy}
                      onClick={() => void openUser(row.userId)}
                    >
                      查看
                    </button>
                  </span>
                </div>
              ))}
            </div>
            {report && (
              <p className="hint-text" data-ui-target="删除结果">
                已删除：记忆 {report.memories} / 历史 {report.histories} / 人设 {report.personas} / 摘要{' '}
                {report.summaries} / 会话 {report.sessions}；
                {report.stillAuthorized ? '授权仍然有效' : '此人本来就不在授权名单里'}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="memory-inline" data-ui-target="返回按人列表">
              <button
                type="button"
                className="btn-ghost btn-ghost--sm"
                onClick={() => {
                  setSelected(null)
                  setReport(null)
                  setEntries([])
                  setHistory([])
                  setOpenPersona(null)
                }}
              >
                ← 返回按人列表
              </button>
              <strong>{selected.label || selected.userId}</strong>
            </div>

            <dl className="info-grid" data-ui-target="存储位置">
              <dt>库文件</dt>
              <dd>{selected.dbPath}</dd>
              <dt>这个人的位置</dt>
              <dd>
                <code>user_id = {selected.userId}</code> ·{' '}
                <code>persona_id = {selected.personas.find((row) => row.isActive)?.personaId ?? 'default'}</code>
              </dd>
              <dt>说明</dt>
              <dd>
                所有人共用<strong>一个</strong> <code>memory.db</code>，靠用户列与人设列（<strong>租户列</strong>）分区，
                不是每人一个文件 —— 别去磁盘上找不存在的目录。故事区例外：每个故事一个
                <code>stories/&lt;id&gt;/memory.db</code>。
              </dd>
            </dl>
            <div className="settings-actions" data-ui-target="打开目录">
              <button type="button" className="btn-ghost" onClick={() => void openUserDataDir()}>
                打开目录
              </button>
            </div>

            <p className="setting-group__desc" data-ui-target="跨场景共享提示">
              同一个人设的记忆与聊天历史在<strong>私聊 / 群聊 / 桌面</strong>之间共享 ——
              换场景不会换人设，所以私聊里说过的事，群里也可能被想起。
            </p>

            <h4>人设</h4>
            <div className="qq-table qq-table--memory-personas" data-ui-target="人设表">
              <div className="qq-table__head">
                <span>人设</span>
                <span>激活</span>
                <span>记忆</span>
                <span>历史</span>
                <span>操作</span>
              </div>
              {selected.personas.length === 0 && (
                <p className="hint-text">这个人还没有注册人设（下一轮消息会自动建 default）。</p>
              )}
              {selected.personas.map((persona) => (
                <div className="qq-table__row" key={persona.personaId}>
                  <span title={persona.personaId}>{persona.personaId}</span>
                  <span>{persona.isActive ? '★' : '—'}</span>
                  <span>{persona.memoryCount}</span>
                  <span>{persona.historyCount}</span>
                  <span className="qq-table__actions">
                    <button
                      type="button"
                      className="btn-ghost btn-ghost--sm"
                      disabled={busy}
                      onClick={() => void viewPersona(persona.personaId)}
                    >
                      查看
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-ghost--sm btn-ghost--danger"
                      disabled={busy || persona.isActive}
                      title={persona.isActive ? '激活中的人设不能删，先 //switch 到别的人设' : '只删这个人设的记忆与历史'}
                      onClick={() => void runDeletePersona(persona)}
                    >
                      删除
                    </button>
                  </span>
                </div>
              ))}
            </div>

            {openPersona && (
              <div data-ui-target="人设条目">
                <div className="memory-inline" data-ui-target="添加记忆">
                  <input
                    className="field__control"
                    type="text"
                    placeholder="手动添加一条事实到这个人的这个人设"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void addEntry()
                    }}
                  />
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy || !draft.trim()}
                    onClick={() => void addEntry()}
                  >
                    添加
                  </button>
                </div>

                <h4>记忆（{entries.length} 条）</h4>
                {entries.length === 0 ? (
                  <p className="hint-text">这个人设还没有记忆。</p>
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

                <h4>近期聊天（{history.length} 条）</h4>
                {history.length === 0 ? (
                  <p className="hint-text">这个人设还没有聊天记录。</p>
                ) : (
                  <ul className="memory-list" data-ui-target="近期聊天">
                    {history.map((item) => (
                      <li key={item.id} className="memory-list__item">
                        <div className="memory-list__body">
                          <span className="memory-list__text">{item.content}</span>
                          <span className="memory-list__meta">
                            {item.role === 'user' ? '你' : 'ta'} · {formatDate(item.createdAt)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {report && (
              <p className="hint-text" data-ui-target="删除结果">
                已删除：记忆 {report.memories} / 历史 {report.histories} / 人设 {report.personas} / 摘要{' '}
                {report.summaries} / 会话 {report.sessions}；
                {report.stillAuthorized ? '授权仍然有效' : '此人本来就不在授权名单里'}
              </p>
            )}

          </>
        )}
      </section>

      </details>

      {/* D-1：危险区**与 selected 无关**，永远渲染在页面最末。
          「清空全部数据」清的是所有人，把它挂在某个人的详情下发等于「先随便点一个人才能清全部」——
          语义错、可达性也错（真机实测：列表态根本看不到这个按钮）。 */}
      <section className="setting-group memory-danger" data-ui-target="危险区">
        <h3 className="setting-group__title">危险区</h3>
        {selected ? (
          <>
            <p className="setting-group__desc">
              按人删除会真删数据、且不可撤销。它删的是「记得的东西」，不是「这段关系」：授权保留，他还能说话。
            </p>
            <div className="settings-actions" data-ui-target="按人删除">
              <button
                type="button"
                className="btn-ghost btn-ghost--danger"
                disabled={busy}
                onClick={() => void runDeleteUser()}
              >
                按人删除（{selected.label || selected.userId}）
              </button>
            </div>
          </>
        ) : (
          <p className="setting-group__desc">
            「按人删除」需要先在上面选一个人点「查看」—— 它删的是<strong>那一个人</strong>的数据。
            下面这一项不受此限制。
          </p>
        )}
        <p className="setting-group__desc">
          下面这一项比「按人删除」更重：它清掉<strong>所有人</strong>的会话、记忆、人设历史、摘要与故事区。
          设置、授权（channels/）、群语料（observe/）、预设与工作区一律保留。
        </p>
        <div className="settings-actions" data-ui-target="清空全部数据">
          <button
            type="button"
            className="btn-ghost btn-ghost--danger"
            disabled={busy}
            onClick={() => setWipeOpen(true)}
          >
            清空全部数据（不可撤销）
          </button>
        </div>
        {wipeOpen && (
          <WipeDialog
            onClose={(reason) => {
              setWipeOpen(false)
              if (!reason) return
              setWipeNotice(reason)
              // D-2：提示渲染在**危险区**（页面最底），而用户此刻就在底部 ——
              // 但滚一下更稳（弹框关闭后视口可能停在别处）。
              requestAnimationFrame(() => {
                document
                  .querySelector('[data-ui-target="危险区提示"]')
                  ?.scrollIntoView({ block: 'center' })
              })
            }}
          />
        )}
        {wipeNotice && (
          <p className="hint-text" data-ui-target="危险区提示">
            {wipeNotice}
          </p>
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