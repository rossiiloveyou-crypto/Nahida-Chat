import { useCallback, useEffect, useState } from 'react'
import type {
  ModelProfile,
  ModelProfileCatalog,
  ModelProfileDraft,
  ModelTestRequest,
  ModelTestResult
} from '@shared/types'

interface UseModelProfilesResult {
  catalog: ModelProfileCatalog
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  save: (draft: ModelProfileDraft) => Promise<ModelProfileCatalog>
  remove: (id: string) => Promise<ModelProfileCatalog>
  setDefault: (id: string) => Promise<ModelProfileCatalog>
  test: (request: ModelTestRequest) => Promise<ModelTestResult>
}

const EMPTY: ModelProfileCatalog = { profiles: [], defaultProfileId: null }

/** 模型档案的读写都走主进程，渲染层只保留一份镜像用于展示。 */
export function useModelProfiles(): UseModelProfilesResult {
  const [catalog, setCatalog] = useState<ModelProfileCatalog>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await window.nahida.modelProfiles.list()
      setCatalog(next)
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    window.nahida.modelProfiles
      .list()
      .then((next) => {
        if (alive) setCatalog(next)
      })
      .catch((cause: unknown) => {
        if (alive) setError(messageOf(cause))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const run = useCallback(
    async (operation: () => Promise<ModelProfileCatalog>): Promise<ModelProfileCatalog> => {
      const next = await operation()
      setCatalog(next)
      setError(null)
      return next
    },
    []
  )

  const save = useCallback(
    (draft: ModelProfileDraft) => run(() => window.nahida.modelProfiles.save(draft)),
    [run]
  )

  const remove = useCallback(
    (id: string) => run(() => window.nahida.modelProfiles.remove(id)),
    [run]
  )

  const setDefault = useCallback(
    (id: string) => run(() => window.nahida.modelProfiles.setDefault(id)),
    [run]
  )

  const test = useCallback(
    (request: ModelTestRequest) => window.nahida.modelProfiles.test(request),
    []
  )

  return { catalog, loading, error, reload, save, remove, setDefault, test }
}

/** 从档案复制一份可编辑草稿（深拷贝，避免改草稿时污染列表）。 */
export function draftFromProfile(profile: ModelProfile): ModelProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    models: [...profile.models],
    defaultModel: profile.defaultModel,
    temperature: profile.temperature,
    modelOptions: Object.fromEntries(
      Object.entries(profile.modelOptions).map(([key, option]) => [key, { ...option }])
    )
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
