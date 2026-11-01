import { useCallback, useEffect, useRef, useState } from 'react'
import type { QqEventFeedItem, QqSettings, QqStatusPayload } from '@shared/qq'
import type { QqProcessSnapshot } from '@shared/qqHost'

/**
 * 设置页「QQ」面板的数据源（P4 G7，P6 收敛）。
 *
 * 一次拉齐 status / processes / settings，并订阅 `qq:event` 推送。
 * 事件流**只保留最后 20 条**：这是排查"为什么不回我"的现场，不是日志系统
 * （完整日志在 host 的 recentLogs 里）。
 *
 * P6：绑定表已下线 —— 授权（谁能回 / 谁能用工具）在「渠道控制台」，
 * 数据源是 `window.nahida.channels`，本 hook 不再持有任何绑定状态。
 */
export interface QqPanelState {
  status: QqStatusPayload | null
  processes: QqProcessSnapshot[]
  settings: QqSettings | null
  events: QqEventFeedItem[]
  loading: boolean
  busy: boolean
  error: string | null
  notice: string | null
}

export interface QqPanelActions {
  refresh: () => Promise<void>
  load: (pid: number) => Promise<void>
  unload: (pid: number) => Promise<void>
  restart: () => Promise<void>
  saveSettings: (patch: Partial<QqSettings>) => Promise<void>
  clearNotice: () => void
}

const EVENT_LIMIT = 20

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useQq(): QqPanelState & QqPanelActions {
  const [status, setStatus] = useState<QqStatusPayload | null>(null)
  const [processes, setProcesses] = useState<QqProcessSnapshot[]>([])
  const [settings, setSettings] = useState<QqSettings | null>(null)
  const [events, setEvents] = useState<QqEventFeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // 用 allSettled 而不是 all：宿主降级时 processes() 会 reject，
      // 但「宿主状态 / 设置」仍然是可读的——一个失败不该把整块面板清空
      // （那会让用户看到"宿主状态不可用"这种二义性结论）。
      const [statusResult, processResult, settingResult] = await Promise.allSettled([
        window.nahida.qq.status(),
        window.nahida.qq.processes(),
        window.nahida.qq.getSettings()
      ])
      if (!alive.current) return
      if (statusResult.status === 'fulfilled') setStatus(statusResult.value)
      if (processResult.status === 'fulfilled') setProcesses(processResult.value)
      if (settingResult.status === 'fulfilled') setSettings(settingResult.value)
      const firstFailure = [statusResult, processResult].find((item) => item.status === 'rejected')
      setError(
        firstFailure && firstFailure.status === 'rejected' ? messageOf(firstFailure.reason) : null
      )
    } catch (cause) {
      if (alive.current) setError(messageOf(cause))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    const unsubscribe = window.nahida.qq.onEvent((item) => {
      setEvents((prev) => [item, ...prev].slice(0, EVENT_LIMIT))
      // 顺带刷新统计：事件流不带 stats，但面板上的计数要跟着动
      window.nahida.qq
        .status()
        .then((value) => {
          if (alive.current) setStatus(value)
        })
        .catch(() => {})
    })
    return () => {
      alive.current = false
      unsubscribe()
    }
  }, [refresh])

  const run = useCallback(async (task: () => Promise<void>, done?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await task()
      if (done) setNotice(done)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  const load = useCallback(
    (pid: number) =>
      run(async () => {
        await window.nahida.qq.load(pid)
        await refresh()
      }, '已注入 PID ' + String(pid)),
    [refresh, run]
  )

  const unload = useCallback(
    (pid: number) =>
      run(async () => {
        await window.nahida.qq.unload(pid)
        await refresh()
      }, '已卸载 PID ' + String(pid)),
    [refresh, run]
  )

  const restart = useCallback(
    () =>
      run(async () => {
        await window.nahida.qq.restart()
        await refresh()
      }, '宿主已重启'),
    [refresh, run]
  )

  const saveSettings = useCallback(
    (patch: Partial<QqSettings>) =>
      run(async () => {
        const next = await window.nahida.qq.saveSettings(patch)
        setSettings(next)
      }, '设置已保存'),
    [run]
  )

  return {
    status,
    processes,
    settings,
    events,
    loading,
    busy,
    error,
    notice,
    refresh,
    load,
    unload,
    restart,
    saveSettings,
    clearNotice: () => setNotice(null)
  }
}
