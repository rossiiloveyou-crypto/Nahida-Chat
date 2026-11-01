import { useCallback, useEffect, useRef, useState } from 'react'
import type { UnzonedChannelItem } from '@shared/channels'
import type { Zone, ZoneConfig, ZoneMemberDraft, ZoneStat } from '@shared/zones'

/**
 * 设置页「区块」面板的数据源（P5 G7，P6 G8 换候选来源）。
 *
 * 一次拉齐 zones / stats / 未归区候选。统计与列表分开拉是因为它们来自两个库
 * （zones.json 与 memory.db），其中一个坏了不该把面板清空。
 *
 * P6：「未归区的 QQ 会话」不再由渲染层拿绑定表算 —— 主进程的 `zones:unzoned`
 * 直接返回白名单条目（带 inZone / permissions）。这样「加白即可入区」只有一处真源，
 * 渲染层不会因为少拿一份数据就悄悄少列一条。
 */
export interface ZonesPanelState {
  zones: Zone[]
  stats: ZoneStat[]
  /** 白名单里还没归区的会话（已由主进程过滤） */
  unzoned: UnzonedChannelItem[]
  loading: boolean
  busy: boolean
  error: string | null
  notice: string | null
}

export interface ZonesPanelActions {
  refresh: () => Promise<void>
  create: (name: string) => Promise<void>
  rename: (zoneId: string, name: string) => Promise<void>
  remove: (zoneId: string) => Promise<void>
  updateConfig: (zoneId: string, patch: Partial<ZoneConfig>) => Promise<void>
  addMember: (draft: ZoneMemberDraft) => Promise<void>
  removeMember: (zoneId: string, key: string) => Promise<void>
  adopt: (
    zoneId: string,
    members: Array<{ key: string; chatType: 'private' | 'group'; chatId: string; displayName?: string }>
  ) => Promise<void>
  clearNotice: () => void
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useZones(): ZonesPanelState & ZonesPanelActions {
  const [zones, setZones] = useState<Zone[]>([])
  const [stats, setStats] = useState<ZoneStat[]>([])
  const [unzoned, setUnzoned] = useState<UnzonedChannelItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [zoneResult, statResult, unzonedResult] = await Promise.allSettled([
        window.nahida.zones.list(),
        window.nahida.zones.stats(),
        window.nahida.zones.unzoned()
      ])
      if (!alive.current) return
      if (zoneResult.status === 'fulfilled') setZones(zoneResult.value)
      if (statResult.status === 'fulfilled') setStats(statResult.value)
      if (unzonedResult.status === 'fulfilled') setUnzoned(unzonedResult.value)
      const failed = [zoneResult, statResult].find((item) => item.status === 'rejected')
      setError(failed && failed.status === 'rejected' ? messageOf(failed.reason) : null)
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
    async (task: () => Promise<void>, done?: string): Promise<void> => {
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
    },
    []
  )

  const create = useCallback(
    (name: string) =>
      run(async () => {
        setZones(await window.nahida.zones.create({ zoneName: name }))
        await refresh()
      }, '区块已创建'),
    [refresh, run]
  )

  const rename = useCallback(
    (zoneId: string, name: string) =>
      run(async () => {
        setZones(await window.nahida.zones.rename(zoneId, name))
      }, '已改名'),
    [run]
  )

  const remove = useCallback(
    (zoneId: string) =>
      run(async () => {
        setZones(await window.nahida.zones.remove(zoneId))
        await refresh()
      }, '区块已删除（其中的记忆搬回主区块）'),
    [refresh, run]
  )

  const updateConfig = useCallback(
    (zoneId: string, patch: Partial<ZoneConfig>) =>
      run(async () => {
        setZones(await window.nahida.zones.updateConfig(zoneId, patch))
      }, '设置已保存'),
    [run]
  )

  const addMember = useCallback(
    (draft: ZoneMemberDraft) =>
      run(async () => {
        setZones(await window.nahida.zones.addMember(draft))
        await refresh()
      }, '已加入本区块'),
    [refresh, run]
  )

  const removeMember = useCallback(
    (zoneId: string, key: string) =>
      run(async () => {
        setZones(await window.nahida.zones.removeMember(zoneId, key))
        await refresh()
      }, '已移出本区块（该会话回到 solo 域）'),
    [refresh, run]
  )

  const adopt = useCallback(
    (
      zoneId: string,
      members: Array<{ key: string; chatType: 'private' | 'group'; chatId: string; displayName?: string }>
    ) =>
      run(async () => {
        const result = await window.nahida.zones.adopt(zoneId, members)
        setZones(result.zones)
        await refresh()
        if (result.errors.length > 0) throw new Error(result.errors.join('；'))
      }, '已加入本区块'),
    [refresh, run]
  )

  return {
    zones,
    stats,
    unzoned,
    loading,
    busy,
    error,
    notice,
    refresh,
    create,
    rename,
    remove,
    updateConfig,
    addMember,
    removeMember,
    adopt,
    clearNotice: () => setNotice(null)
  }
}
