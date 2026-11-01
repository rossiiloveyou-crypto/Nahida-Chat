import { useCallback, useEffect, useState } from 'react'
import type { PromptLibrary } from '@shared/types'

/** 提示词库目录结构（不含正文），聊天页只需要角色名做展示。 */
export function usePromptLibrary(): { library: PromptLibrary | null; reload: () => Promise<void> } {
  const [library, setLibrary] = useState<PromptLibrary | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setLibrary(await window.nahida.prompts.library())
    } catch {
      setLibrary(null)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { library, reload }
}
