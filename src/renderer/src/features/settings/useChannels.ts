import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChannelAccessConfig } from '@shared/channelAccess'
import { DEFAULT_CHANNEL_ACCESS } from '@shared/channelAccess'

/**
 * 渠道授权的渲染层状态（P7 G3 → **P9-R3 v2：按「人」授权**）。
 *
 * 与 useQq / useZones 同一套路：这里只管「拉取 / 提交 / 重拉」，
 * 归一化、校验、迁移、原子写全在主进程（features/channels/store.ts）。
 *
 * 🔴 每次提交后**整表重拉**，不做乐观更新 ——
 *    这是授权数据，「界面上看着改成功了、盘里其实没改」比慢 100 ms 危险得多。
 *
 * 🔴 这里的 error 是**主进程抛回的原文**，面板直接显示，不加工、不翻译、不自己判。
 *    校验规则只有一份（在主进程），渲染层复制一份必然分叉（J-34）。
 */
export interface ChannelsState {
  config: ChannelAccessConfig
  /** access.json 所在目录（面板 D 区展示） */
  dataDir: string
  /** access.json 的完整路径 */
  file: string
  loading: boolean
  busy: boolean
  error: string
  /** 最近一次成功操作的提示，面板可显示一句「已保存」 */
  notice: string
  refresh: () => Promise<void>
  saveAccount: (draft: {
    userId: string
    label?: string
    permissions?: Partial<ChannelAccessConfig['accounts'][number]['permissions']>
  }) => Promise<boolean>
  removeAccount: (userId: string) => Promise<boolean>
  saveGroup: (draft: { chatId: string; label?: string }) => Promise<boolean>
  removeGroup: (chatId: string) => Promise<boolean>
  setGates: (patch: { groupMemberGate?: boolean; toolGate?: boolean }) => Promise<boolean>
  rememberUin: (uin: string) => Promise<void>
  clearNotice: () => void
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useChannels(): ChannelsState {
  const [config, setConfig] = useState<ChannelAccessConfig>(DEFAULT_CHANNEL_ACCESS)
  const [dataDir, setDataDir] = useState('')
  const [file, setFile] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [next, status] = await Promise.all([
        window.nahida.channels.config(),
        window.nahida.channels.status()
      ])
      if (!alive.current) return
      setConfig(next)
      setDataDir(status.dataDir)
      setFile(status.file)
      setError('')
    } catch (cause) {
      if (alive.current) setError(messageOf(cause))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  const run = useCallback(
    async <T,>(work: () => Promise<T>, success: string): Promise<boolean> => {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        await work()
        await refresh()
        if (alive.current) setNotice(success)
        return true
      } catch (cause) {
        // 主进程的错误原文原样留下（例如「QQ 号只能是数字」）
        if (alive.current) setError(messageOf(cause))
        return false
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [refresh]
  )

  const saveAccount = useCallback<ChannelsState['saveAccount']>(
    (draft) => run(() => window.nahida.channels.saveAccount(draft), '已保存'),
    [run]
  )
  const removeAccount = useCallback<ChannelsState['removeAccount']>(
    (userId) => run(() => window.nahida.channels.removeAccount(userId), '已删除。历史会话与记忆不受影响。'),
    [run]
  )
  const saveGroup = useCallback<ChannelsState['saveGroup']>(
    (draft) => run(() => window.nahida.channels.saveGroup(draft), '已保存'),
    [run]
  )
  const removeGroup = useCallback<ChannelsState['removeGroup']>(
    (chatId) => run(() => window.nahida.channels.removeGroup(chatId), '已删除。历史会话与记忆不受影响。'),
    [run]
  )
  const setGates = useCallback<ChannelsState['setGates']>(
    (patch) => run(() => window.nahida.channels.setGates(patch), '已保存'),
    [run]
  )
  /**
   * 记一个机器人登录号。**不提示成功** —— 它是自动动作（识别到已注入进程时调），
   * 弹一句「已保存」只会让用户以为自己做错了什么。
   */
  const rememberUin = useCallback(
    async (uin: string): Promise<void> => {
      if (!uin) return
      try {
        await window.nahida.channels.rememberUin(uin)
        await refresh()
      } catch {
        /* 记号失败不打扰用户：群白名单照样能存，只是区块里暂时展不开 */
      }
    },
    [refresh]
  )

  return {
    config,
    dataDir,
    file,
    loading,
    busy,
    error,
    notice,
    refresh,
    saveAccount,
    removeAccount,
    saveGroup,
    removeGroup,
    setGates,
    rememberUin,
    clearNotice: () => setNotice('')
  }
}
