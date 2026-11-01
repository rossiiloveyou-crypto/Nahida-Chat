import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceCatalog, WorkspaceDraft } from '@shared/types'

/**
 * 工作区清单的进程内共享镜像。
 *
 * 和 useSettings 同一个理由：侧栏要列工作区、对话头要显示当前会话落在哪、
 * 输入区工具条要能切换 —— 三处各存一份 state 必然出现"改了这里那里还是旧的"。
 * 所以单例 + 订阅，任何一处写完全部同步。
 */
let cached: WorkspaceCatalog | null = null
let inflight: Promise<WorkspaceCatalog> | null = null
const listeners = new Set<(value: WorkspaceCatalog) => void>()

function publish(next: WorkspaceCatalog): void {
  cached = next
  for (const listener of [...listeners]) listener(next)
}

function load(): Promise<WorkspaceCatalog> {
  if (inflight) return inflight
  inflight = window.nahida.workspaces
    .list()
    .then((value) => {
      publish(value)
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export interface WorkspaceApi {
  catalog: WorkspaceCatalog
  ready: boolean
  error: string | null
  activeWorkspaceId: string | null
  /** 新建或改名；返回是否成功（失败原因写在 error 里） */
  save: (draft: WorkspaceDraft) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  setActive: (id: string) => Promise<boolean>
  /** 弹系统目录选择框；取消返回空串 */
  pickDirectory: () => Promise<string>
  open: (id: string) => Promise<void>
}

const EMPTY: WorkspaceCatalog = { workspaces: [], activeWorkspaceId: null }

export function useWorkspaces(): WorkspaceApi {
  const [catalog, setCatalog] = useState<WorkspaceCatalog>(cached ?? EMPTY)
  const [ready, setReady] = useState(cached !== null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const listener = (value: WorkspaceCatalog): void => {
      if (alive) setCatalog(value)
    }
    listeners.add(listener)
    if (!cached) {
      load()
        .catch((cause: unknown) => {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (alive) setReady(true)
        })
    }
    return () => {
      alive = false
      listeners.delete(listener)
    }
  }, [])

  // 三个写操作形状一样：清错误 -> 调主进程 -> 发布新清单 -> 返回真假
  const run = useCallback(
    async (action: () => Promise<WorkspaceCatalog>): Promise<boolean> => {
      setError(null)
      try {
        publish(await action())
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        return false
      }
    },
    []
  )

  const save = useCallback(
    (draft: WorkspaceDraft) => run(() => window.nahida.workspaces.save(draft)),
    [run]
  )
  const remove = useCallback(
    (id: string) => run(() => window.nahida.workspaces.remove(id)),
    [run]
  )
  const setActive = useCallback(
    (id: string) => run(() => window.nahida.workspaces.setActive(id)),
    [run]
  )
  const pickDirectory = useCallback(
    () => window.nahida.workspaces.pickDirectory(),
    []
  )
  const open = useCallback(async (id: string): Promise<void> => {
    await window.nahida.workspaces.open(id)
  }, [])

  return {
    catalog,
    ready,
    error,
    activeWorkspaceId: catalog.activeWorkspaceId,
    save,
    remove,
    setActive,
    pickDirectory,
    open
  }
}
