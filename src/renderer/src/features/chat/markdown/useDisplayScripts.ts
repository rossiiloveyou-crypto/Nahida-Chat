/**
 * 显示层脚本清单的取用点（P3）。
 *
 * 三条设计约束：
 *  1. **一次性取**：脚本清单在整个应用生命周期内按 mtime 变化，不是每条消息都变；
 *     每条消息各发一次 IPC 会在 200 条消息的会话里打出 200 次 invoke（蓝图明令禁止）；
 *  2. **模块级缓存**：切换会话、切回列表、重挂载消息区都不该重发；真源失效由主进程的
 *     mtime+size 缓存负责，这里只避免重复 IPC；
 *  3. **失败即空**：拿不到就当成「没有脚本」，气泡退回纯 markdown —— 显示层不能连累聊天。
 */
import { useEffect, useState } from 'react'
import type { StRegexScript } from '@shared/regex'

let cached: StRegexScript[] | null = null
let pending: Promise<StRegexScript[]> | null = null

function load(): Promise<StRegexScript[]> {
  if (cached) return Promise.resolve(cached)
  if (pending) return pending
  const bridge = typeof window !== 'undefined' ? window.nahida : undefined
  if (!bridge?.regex) {
    cached = []
    return Promise.resolve(cached)
  }
  pending = bridge.regex
    .listScripts()
    .then((list) => {
      cached = Array.isArray(list) ? list : []
      return cached
    })
    .catch(() => {
      cached = []
      return cached
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** 取 ST 的正则脚本清单；首帧给 `[]`（气泡先按纯 markdown 出，脚本到了再补正则）。 */
export function useDisplayScripts(): StRegexScript[] {
  const [scripts, setScripts] = useState<StRegexScript[]>(cached ?? [])
  useEffect(() => {
    let alive = true
    void load().then((list) => {
      if (alive) setScripts(list)
    })
    return () => {
      alive = false
    }
  }, [])
  return scripts
}

/** 测试/热更新用：清掉模块级缓存。 */
export function resetDisplayScriptsCache(): void {
  cached = null
  pending = null
}
