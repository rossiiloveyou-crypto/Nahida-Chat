import type { TransferResult } from '@shared/transfer'
import { useChatStore } from '../chat/store'
import { useStoryStore } from '../story/store'

export async function refreshImported(result: TransferResult, activate = true): Promise<void> {
  if (!result.ok) throw new Error(result.cancelled ? '导入已取消' : result.error)
  await useStoryStore.getState().refreshStories()
  if (result.storyId) {
    await useStoryStore.getState().refreshBranches()
    if (activate) await useStoryStore.getState().openStory(result.storyId)
  } else {
    await useChatStore.getState().resync()
    if (activate && result.sessionIds?.[0]) useChatStore.getState().select(result.sessionIds[0])
  }
}
