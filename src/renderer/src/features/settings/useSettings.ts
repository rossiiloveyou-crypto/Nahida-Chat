import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '@shared/types'

/**
 * 全局设置的一份共享镜像。
 *
 * 为什么不是每个组件各拉一次：composer 下方能改权限模式，设置页也能改，
 * 聊天页顶部还在展示模型角标。三处各存一份 state 的话，一处保存另外两处就是
 * 陈旧数据——用户会看到"明明改了却没生效"。所以这里做进程内单例 + 订阅。
 */
let cached: Settings | null = null
let inflight: Promise<Settings> | null = null
const listeners = new Set<(value: Settings) => void>()

function publish(next: Settings): void {
  cached = next
  for (const listener of [...listeners]) listener(next)
}

function load(): Promise<Settings> {
  if (inflight) return inflight
  inflight = window.nahida.settings
    .get()
    .then((value) => {
      publish(value)
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useSettings(): {
  settings: Settings | null
  loading: boolean
  saving: boolean
  error: string | null
  save: (patch: Partial<Settings>) => Promise<boolean>
} {
  const [settings, setSettings] = useState<Settings | null>(cached)
  const [loading, setLoading] = useState(cached === null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const listener = (value: Settings): void => {
      if (alive) setSettings(value)
    }
    listeners.add(listener)
    if (!cached) {
      load()
        .catch((cause: unknown) => {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    }
    return () => {
      alive = false
      listeners.delete(listener)
    }
  }, [])

  const save = useCallback(async (patch: Partial<Settings>): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const next = await window.nahida.settings.save(patch)
      publish(next)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  return { settings, loading, saving, error, save }
}
