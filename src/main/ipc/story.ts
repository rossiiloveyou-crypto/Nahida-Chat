import { dialog, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { MemoryEntry, Session } from '@shared/types'
import type {
  StoryBranch,
  StoryBranchesFile,
  StoryBranchItem,
  StoryDeleteResult,
  StoryDeriveDraft,
  StoryDraft,
  StoryMeta,
  StoryMetaPatch,
  StorySearchHit,
  StorySummary
} from '@shared/story'
import {
  clearStoryMemories,
  createStory,
  deleteBranch,
  deleteStory,
  deleteStoryMemory,
  deriveBranch,
  listStoryBranches,
  getStory,
  getStorySession,
  listStories,
  listStoryMemories,
  readStoryProfile,
  saveStoryProfile,
  searchStory,
  switchBranch,
  updateStoryMeta
} from '../features/story/service'

/**
 * 故事区的 IPC handler（P4 §4.12 / P6 §4.7）。
 *
 * 一律「薄转发」：不变量、校验、删区六步、分支三道拒绝都在 features/story/。
 * 这里唯一的语义是**删除必须显式确认**：缺 confirmed 一律 { ok:false, reason:'need_confirm' }，
 * 不删。理由：本 Phase 没有界面，这个参数将来给 P7 的确认框用；
 * 现在不写它，等于留下一条「一次 IPC 调用删掉全部剧情」的通道（C10）。
 */
export function registerStoryIpcHandlers(): void {
  ipcMain.handle(IPC.storyList, (): StorySummary[] => listStories())
  ipcMain.handle(IPC.storyCreate, (_event, draft: StoryDraft) => createStory(draft))
  ipcMain.handle(IPC.storyGet, (_event, storyId: string): StoryMeta | null => getStory(storyId))
  ipcMain.handle(
    IPC.storyDelete,
    (_event, storyId: string, opts?: { confirmed?: boolean }): StoryDeleteResult =>
      deleteStory(storyId, { confirmed: opts?.confirmed === true })
  )
  // P6：分支四条（薄转发到 service；拒绝在 derive.deleteBranch）
  // 🔴 分支是**扁平列表**，没有父子依赖（P6 修订）：删任意一条都不会影响别人
  ipcMain.handle(
    IPC.storyBranches,
    (_event, storyId: string): StoryBranchItem[] => listStoryBranches(storyId)
  )
  ipcMain.handle(
    IPC.storyDerive,
    (_event, draft: StoryDeriveDraft): { branch: StoryBranch; sessionId: string } => deriveBranch(draft)
  )
  ipcMain.handle(
    IPC.storySwitch,
    (_event, storyId: string, branchId: string): StoryBranchItem[] => switchBranch(storyId, branchId)
  )
  ipcMain.handle(
    IPC.storyBranchDelete,
    (_event, storyId: string, branchId: string): StoryBranchesFile => deleteBranch(storyId, branchId)
  )

  // P7：会话视口 / 检索 / meta / 画像 / 目录选择（仍是一律薄转发）
  ipcMain.handle(
    IPC.storySession,
    (_event, storyId: string, branchId?: string): Session | null => getStorySession(storyId, branchId)
  )
  ipcMain.handle(
    IPC.storySearch,
    (_event, storyId: string, query: string): StorySearchHit[] => searchStory(storyId, query)
  )
  ipcMain.handle(
    IPC.storyUpdateMeta,
    (_event, storyId: string, patch: StoryMetaPatch): StoryMeta | null => updateStoryMeta(storyId, patch)
  )
  ipcMain.handle(IPC.storyProfileGet, (_event, storyId: string): string => readStoryProfile(storyId))
  ipcMain.handle(
    IPC.storyProfileSave,
    (_event, storyId: string, text: string): boolean => saveStoryProfile(storyId, text)
  )
  ipcMain.handle(IPC.storyPickWorldbookDir, async (): Promise<string> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0]
  })

  // P8：故事长期记忆（列表 / 删单条 / 清空）—— 仍是一律薄转发，全部走该区自己的库
  ipcMain.handle(IPC.storyMemoryList, (_event, storyId: string): MemoryEntry[] => listStoryMemories(storyId))
  ipcMain.handle(
    IPC.storyMemoryDelete,
    (_event, storyId: string, id: string): MemoryEntry[] => deleteStoryMemory(storyId, id)
  )
  ipcMain.handle(IPC.storyMemoryClear, (_event, storyId: string): MemoryEntry[] => clearStoryMemories(storyId))
}