/** 设置 · ST 桥接：开关仍存 Settings，运行配置与进程由主进程 host 管理。 */
import { useCallback, useEffect, useState } from 'react'
import type { BridgeHealth, BridgeOverrideState } from '@shared/bridge'
import { useSettings } from '../useSettings'

type RuntimeDraft = { stRoot: string; cardName: string; port: string; nodePath: string; generateTimeoutMs: string }
type Action = 'openSt' | 'stopSt' | 'openLog'

function bytes(value: number): string {
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  return (value / (1024 * 1024)).toFixed(1) + ' MB'
}

export function BridgeSection() {
  const { settings, loading, saving, error, save } = useSettings()
  const [health, setHealth] = useState<BridgeHealth | null>(null)
  const [draft, setDraft] = useState<RuntimeDraft | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<Action | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const [override, setOverride] = useState<BridgeOverrideState | null>(null)
  const [overrideText, setOverrideText] = useState('')
  const [overrideLoading, setOverrideLoading] = useState(true)
  const [overrideSaving, setOverrideSaving] = useState(false)
  const [overrideError, setOverrideError] = useState<string | null>(null)
  const [overrideSaved, setOverrideSaved] = useState(false)
  const enabled = settings?.bridge?.enabled === true

  const applyHealth = useCallback((next: BridgeHealth): void => {
    setHealth(next)
    // 只初始化一次草稿，轮询或刷新状态时保留用户尚未应用的输入。
    setDraft((current) => current ?? {
      stRoot: next.config.stRoot,
      cardName: next.config.cardName,
      port: String(next.config.port),
      nodePath: next.config.nodePath ?? '',
      generateTimeoutMs: String(Math.round(next.config.generateTimeoutMs / 1000))
    })
    setHealthError(null)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      applyHealth(await window.nahida.bridge.health())
    } catch (cause) {
      setHealthError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [applyHealth])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const loadOverride = useCallback(async (): Promise<void> => {
    setOverrideLoading(true)
    setOverrideError(null)
    try {
      const next = await window.nahida.bridge.override.get()
      setOverride(next)
      setOverrideText(next.text)
      setOverrideSaved(false)
    } catch (cause) {
      setOverrideError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOverrideLoading(false)
    }
  }, [])

  useEffect(() => { void loadOverride() }, [loadOverride])

  const saveOverride = async (): Promise<void> => {
    if (overrideLoading || overrideSaving || !override) return
    setOverrideSaving(true)
    setOverrideError(null)
    setOverrideSaved(false)
    try {
      const next = await window.nahida.bridge.override.save(overrideText)
      setOverride(next)
      setOverrideText(next.text)
      setOverrideSaved(true)
    } catch (cause) {
      setOverrideError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOverrideSaving(false)
    }
  }

  const toggle = async (next: boolean): Promise<void> => {
    const ok = await save({ bridge: { enabled: next } })
    if (ok) setSavedAt(Date.now())
    void refresh()
  }

  const runAction = async (action: Action): Promise<void> => {
    if (action === 'openLog') {
      try { await window.nahida.bridge.openLog(); await refresh() }
      catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
      return
    }
    if (pending && action !== 'stopSt') return
    setActionError(null)
    setPending(action)
    try {
      if (action === 'openSt') {
        if (!draft?.stRoot.trim()) throw new Error('请填写 ST 安装目录。')
        if (!draft.cardName.trim()) throw new Error('请填写桥接角色。')
        const port = Number(draft.port)
        if (!/^\d+$/.test(draft.port) || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error('端口须为 1–65535 的整数。')
        }
        const seconds = Number(draft.generateTimeoutMs)
        if (!/^\d+$/.test(draft.generateTimeoutMs) || !Number.isInteger(seconds) || seconds < 10 || seconds > 3600) {
          throw new Error('单轮上限须为 10–3600 秒的整数。')
        }
        applyHealth(await window.nahida.bridge.openSt({
          stRoot: draft.stRoot.trim(), cardName: draft.cardName.trim(), port, nodePath: draft.nodePath.trim(), generateTimeoutMs: seconds * 1000
        }))
      } else if (action === 'stopSt') {
        applyHealth(await window.nahida.bridge.stopSt())
      } else {
        await window.nahida.bridge.openLog()
        await refresh()
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
      // 启动失败也可能已打开首次引导窗口，读取 host 的实际进程状态。
      await refresh()
    } finally {
      setPending((current) => current === action ? null : current)
    }
  }

  const overrideDirty = override !== null && overrideText !== override.text
  const overrideDisabled = overrideLoading || overrideSaving || override === null
  const processBusy = pending !== null || health?.busy === true
  const editingDisabled = processBusy || !draft || health?.stRunning === true

  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>ST 桥接</h1>
        <p>故事模式可由 SillyTavern 的提示词管线生成；上下文与分支由 NC 管理。</p>
      </div>

      <section className="setting-group" data-ui-region="桥接开关">
        <h3 className="setting-group__title">总开关</h3>
        <p className="setting-group__desc">
          关闭后故事模式使用 NC 的模型配置；渠道会话（QQ）始终走原来的路径。
          此开关只控制生成路由，停止进程请使用「停止 ST」。
        </p>
        <label className="setting-toggle" data-ui-target="桥接开关">
          <input type="checkbox" checked={enabled} disabled={loading || saving}
            onChange={(event) => void toggle(event.target.checked)} />
          <span>故事模式走 ST 桥接</span>
        </label>
        {savedAt > 0 && <p className="hint-text">已保存。</p>}
        {error && <p className="hint-text hint-text--error">保存失败：{error}</p>}
      </section>

      <section className="setting-group" data-ui-region="桥接进程配置">
        <h3 className="setting-group__title">ST 进程与日志</h3>
        <p className="setting-group__desc">
          填写包含 server.js 的 ST 安装目录，点击「打开 ST」应用配置并启动可见窗口。
          运行配置由主进程保存到 userData/nc-bridge/config.json；修改前请先停止 ST。
          打开窗口不要求模型已连通，首次启动请在 ST 窗口完成初始化向导。
          请先在 ST 内导入角色卡并配置模型与世界书。NC 不自动导入卡或世界书。
        </p>
        <form onSubmit={(event) => { event.preventDefault(); void runAction('openSt') }}>
          <label className="field">
            <span className="field__label">ST 目录</span>
            <input className="field__control" data-ui-target="ST 目录" value={draft?.stRoot ?? ''}
              disabled={editingDisabled} placeholder="包含 server.js 的安装目录"
              onChange={(event) => setDraft((current) => current && { ...current, stRoot: event.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">桥接角色</span>
            <input className="field__control" data-ui-target="桥接角色" value={draft?.cardName ?? ''}
              disabled={editingDisabled} placeholder="酒馆中的角色卡名称"
              onChange={(event) => setDraft((current) => current && { ...current, cardName: event.target.value })} />
            <span className="hint-text">填写酒馆里角色卡的名称；点击「打开 ST」时选中它。运行期间不可修改，请先停止 ST。</span>
          </label>
          <div className="field__row">
            <label className="field">
              <span className="field__label">端口</span>
              <input className="field__control" data-ui-target="ST 端口" type="number" min={1} max={65535} step={1}
                value={draft?.port ?? ''} disabled={editingDisabled}
                onChange={(event) => setDraft((current) => current && { ...current, port: event.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">nodePath（可选）</span>
              <input className="field__control" data-ui-target="ST Node 路径" value={draft?.nodePath ?? ''}
                disabled={editingDisabled} placeholder="留空自动选择 Node"
                onChange={(event) => setDraft((current) => current && { ...current, nodePath: event.target.value })} />
            </label>
          </div>
          <label className="field">
            <span className="field__label">单轮上限（秒）</span>
            <input className="field__control" data-ui-target="ST 单轮上限" type="number" min={10} max={3600} step={1}
              value={draft?.generateTimeoutMs ?? ''} disabled={editingDisabled} placeholder="180"
              onChange={(event) => setDraft((current) => current && { ...current, generateTimeoutMs: event.target.value })} />
            <span className="hint-text">超时即判定本轮失败并停止生成。默认 180 秒，可填 10–3600。</span>
          </label>
          <div className="field__row">
            <button type="submit" className="theme-option sel-frame--stitch" data-ui-target="打开 ST"
              disabled={processBusy || !draft || healthError !== null}>
              {pending === 'openSt' ? '正在打开…' : '打开 ST'}
            </button>
            <button type="button" className="theme-option sel-frame--stitch" data-ui-target="停止 ST"
              disabled={pending === 'stopSt' || (!health?.stRunning && !health?.busy && pending !== 'openSt')} onClick={() => void runAction('stopSt')}>
              {pending === 'stopSt' ? '正在停止…' : '停止 ST'}
            </button>
            <button type="button" className="theme-option sel-frame--stitch" data-ui-target="打开日志"
              onClick={() => void runAction('openLog')}>
              打开日志
            </button>
          </div>
        </form>
        {actionError && <p role="alert" className="hint-text hint-text--error">操作失败：{actionError}</p>}
      </section>

      <section className="setting-group" data-ui-region="桥接最高权重规则" aria-busy={overrideLoading || overrideSaving}>
        <h3 className="setting-group__title">最高权重规则</h3>
        <p className="setting-group__desc" id="bridge-override-help">
          默认空，仅故事模式的 ST 桥接使用。每轮生成前以系统角色注入 IN_CHAT、depth 0，
          放在最后一条消息之后，设计意图是在与角色卡或预设冲突时优先采用此处规则；
          实际模型服从不作保证。可清空并保存，后续轮次即停止注入。
          内容保存在 userData/nc-bridge/st-override.md；最多使用 8000 字符，超出会截断并提示。
        </p>
        <form onSubmit={(event) => { event.preventDefault(); void saveOverride() }}>
          <label className="field">
            <span className="field__label">规则正文</span>
            <textarea className="field__control" data-ui-target="最高权重规则正文" rows={6} style={{ height: 'auto', minHeight: 144, padding: 12, resize: 'vertical' }}
              aria-describedby="bridge-override-help" value={overrideText} disabled={overrideDisabled}
              placeholder="默认留空；需要额外规则时在此填写，清空并保存即可停用。"
              onChange={(event) => { setOverrideText(event.target.value); setOverrideSaved(false) }} />
          </label>
          <p className="hint-text">{overrideText.length} / 8000 字符{overrideDirty ? ' · 有未保存的修改' : ''}</p>
          {overrideText.length > 8000 && <p className="hint-text">超出部分将在保存时截断，仅保留前 8000 字符。</p>}
          <button type="submit" className="theme-option sel-frame--stitch" data-ui-target="保存最高权重规则"
            disabled={overrideDisabled || (!overrideDirty && !override?.truncated)}>
            {overrideSaving ? '正在保存…' : '保存规则'}
          </button>
          {overrideError && <button type="button" className="theme-option sel-frame--stitch" data-ui-target="重新读取最高权重规则"
            disabled={overrideLoading || overrideSaving} onClick={() => void loadOverride()}>
            重新读取
          </button>}
        </form>
        <p role="status" className="hint-text" data-ui-target="最高权重规则状态">
          {overrideLoading ? '正在加载规则…' : override
            ? (overrideSaved ? '已保存。' : '') + (override.active ? '当前已保存规则已启用，将在后续故事桥接轮次注入。' : '当前已保存规则为空或仅含空白，未启用注入。')
            : '尚未读取到规则。'}
        </p>
        {override?.warning && <p role="status" className="hint-text">{override.warning}</p>}
        {overrideError && <p role="alert" className="hint-text hint-text--error">规则读取或保存失败：{overrideError}</p>}
      </section>

      <section className="setting-group" data-ui-region="桥接健康度">
        <h3 className="setting-group__title">运行状态</h3>
        {healthError && <p className="hint-text hint-text--error">读取失败：{healthError}</p>}
        {health && (
          <>
            {health.needsOnboarding && <p role="status" className="hint-text">
              ST 首次启动，请在弹出的窗口完成初始化向导，再点「打开 ST」重试。
            </p>}
            <dl className="info-grid" data-ui-target="桥接状态">
              <dt>已检测角色卡</dt><dd>{health.cardAvatar ? health.cardName + " · " + health.cardAvatar : "尚未检测"}</dd>
              <dt>ST 进程</dt><dd>{health.stRunning ? '运行中' : '未启动 / 已停止'}</dd>
              <dt>进程 PID</dt><dd>{health.stPid ?? '—'}</dd>
              <dt>端口</dt><dd>{health.port}</dd>
              <dt>ST 窗口</dt><dd>{health.alive ? '已就绪' : '未就绪 / 已关闭'}</dd>
              <dt>当前操作</dt><dd>{health.busy || pending ? '正在启动或执行' : '空闲'}</dd>
              <dt>日志大小</dt><dd>{bytes(health.logBytes)}</dd>
              <dt>日志路径</dt><dd>{health.config.logPath || 'ST 目录/data-nc/logs/st-bridge.log'}</dd>
              <dt>Node 来源</dt><dd>{health.nodeSource ?? '尚未选择'}</dd>
              <dt>孤儿进程数</dt><dd>{health.orphans}</dd>
              <dt>重建次数</dt><dd>{health.rebuilds}</dd>
              <dt>最近错误</dt><dd>{health.lastError ?? '无'}</dd>
              <dt>ST 地址</dt><dd>{health.config.stUrl}</dd>
              <dt>ST 数据目录</dt><dd>{health.config.stDataDir}</dd>
              <dt>单轮上限</dt><dd>{Math.round(health.config.generateTimeoutMs / 1000)} 秒</dd>
            </dl>
          </>
        )}
        <button type="button" className="theme-option sel-frame--stitch" data-ui-target="刷新桥接状态"
          onClick={() => void refresh()}>
          刷新状态
        </button>
      </section>
    </>
  )
}
