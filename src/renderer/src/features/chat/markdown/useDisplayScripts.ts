import { useEffect, useState } from 'react'
import type { StRegexScript } from '@shared/regex'
import type { DisplayScriptsState } from '@shared/types'
import { useSettings } from '../../settings/useSettings'
import { normalizeFoldedTags } from './foldedTags'
import { setDisplayFoldedTags } from './display'

let cached: DisplayScriptsState | null = null
let pending: Promise<DisplayScriptsState> | null = null
let generation = 0
const listeners = new Set<(value: DisplayScriptsState) => void>()
const empty = (): DisplayScriptsState => ({ scripts: [], stDir: '', preset: '', warning: null })

export function loadDisplayScripts(refresh = false): Promise<DisplayScriptsState> {
  if (!refresh && cached) return Promise.resolve(cached)
  if (!refresh && pending) return pending
  if (refresh) generation++
  const epoch = generation
  const api = typeof window === 'undefined' ? undefined : window.nahida?.regex
  const request = api?.scriptsState ? api.scriptsState({ refresh })
    : api?.listScripts ? api.listScripts().then(scripts => ({ ...empty(), scripts }))
    : Promise.resolve({ ...empty(), warning: '显示脚本接口尚未就绪。' })
  const current = request.catch(() => ({ ...empty(), warning: '显示脚本读取失败，请在 ST 桥接设置中刷新。' }))
    .then(value => {
      if (epoch === generation) {
        cached = value
        for (const listener of listeners) listener(value)
      }
      return value
    }).finally(() => { if (pending === current) pending = null })
  pending = current
  return current
}

/** 已挂载消费者同步失效；旧响应不再发布。 */
export function resetDisplayScriptsCache(): void {
  generation++
  cached = null
  pending = null
  for (const listener of listeners) listener(empty())
  if (listeners.size) void loadDisplayScripts(true)
}

export function useDisplayScriptsState(): DisplayScriptsState {
  const [state, setState] = useState(cached ?? empty())
  useEffect(() => {
    if (listeners.size === 0) window.addEventListener('focus', resetDisplayScriptsCache)
    listeners.add(setState)
    if (cached) setState(cached)
    void loadDisplayScripts()
    return () => {
      listeners.delete(setState)
      if (listeners.size === 0) window.removeEventListener('focus', resetDisplayScriptsCache)
    }
  }, [])
  return state
}

/** 签名保持不变，设置偏好变化会产生新数组，触发既有气泡 memo 重算。 */
export function useDisplayScripts(): StRegexScript[] {
  const state = useDisplayScriptsState()
  const { settings } = useSettings()
  const key = JSON.stringify(settings?.bridge?.foldedTags ?? [])
  const [scripts, setScripts] = useState(state.scripts)
  useEffect(() => {
    setDisplayFoldedTags(normalizeFoldedTags(JSON.parse(key)))
    setScripts([...state.scripts])
  }, [state, key])
  return scripts
}
