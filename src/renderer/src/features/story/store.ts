import { create } from 'zustand'
import type { StoryBranchNode, StorySearchHit, StorySummary } from '@shared/story'
import { useChatStore } from '../chat/store'

/**
 * 渲染层的故事 UI 状态（P7）。
 *
 * 🔴 树只有一份来源：每次操作都用主进程 getBranchTree 的结果覆盖，**渲染层零树计算**（B2）。
 * 🔴 视口换源只能走 adoptStorySession：故事会话必须在 useChatStore.sessions 里，否则流式会丢。
 * 🔴 不读 zones（总蓝图 §附 前向兼容）：故事相关只绑 storyId。
 */
interface StoryUiStore {
  stories: StorySummary[]
  currentStoryId: string | null
  tree: StoryBranchNode[]
  drawerOpen: boolean
  searchHits: StorySearchHit[]
  searchQuery: string
  focusMessageId: string | null
  busy: boolean
  error: string | null
  refreshStories: () => Promise<void>
  openStory: (storyId: string) => Promise<void>
  closeStory: () => void
  refreshTree: () => Promise<void>
  switchTo: (branchId: string) => Promise<void>
  deriveFrom: (messageId: string, title?: string) => Promise<void>
  removeBranch: (branchId: string) => Promise<void>
  runSearch: (query: string) => Promise<void>
  clearSearch: () => void
  setFocus: (messageId: string | null) => void
  toggleDrawer: (open?: boolean) => void
}

function flatten(nodes: StoryBranchNode[]): StoryBranchNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

export const useStoryStore = create<StoryUiStore>()((set, get) => ({
  stories: [],
  currentStoryId: null,
  tree: [],
  drawerOpen: false,
  searchHits: [],
  searchQuery: '',
  focusMessageId: null,
  busy: false,
  error: null,

  refreshStories: async () => {
    try {
      const stories = await window.nahida.story.list()
      set({ stories, error: null })
      // 正在看的故事被删掉了 → 收起抽屉，别让用户对着一块幽灵界面操作
      const current = get().currentStoryId
      if (current && !stories.some((item) => item.storyId === current)) {
        set({ currentStoryId: null, drawerOpen: false, tree: [], searchHits: [] })
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  openStory: async (storyId) => {
    set({ busy: true, currentStoryId: storyId, error: null, searchHits: [], searchQuery: '' })
    try {
      const session = await window.nahida.story.session(storyId)
      if (session) useChatStore.getState().adoptStorySession(session)
      set({ drawerOpen: true })
      await get().refreshTree()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ busy: false })
    }
  },

  closeStory: () => set({ currentStoryId: null, drawerOpen: false, tree: [], searchHits: [], searchQuery: '' }),

  refreshTree: async () => {
    const storyId = get().currentStoryId
    if (!storyId) return set({ tree: [] })
    try {
      set({ tree: await window.nahida.story.branches(storyId) })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  switchTo: async (branchId) => {
    const storyId = get().currentStoryId
    if (!storyId) return
    set({ busy: true, error: null })
    try {
      set({ tree: await window.nahida.story.switchBranch(storyId, branchId) })
      const session = await window.nahida.story.session(storyId, branchId)
      if (session) useChatStore.getState().adoptStorySession(session)
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ busy: false })
    }
  },

  deriveFrom: async (messageId, title) => {
    const storyId = get().currentStoryId
    const chat = useChatStore.getState()
    const fromSessionId = chat.activeId
    if (!storyId || !fromSessionId) return
    set({ busy: true, error: null })
    try {
      const result = await window.nahida.story.derive({
        storyId,
        fromSessionId,
        fromMessageId: messageId,
        title
      })
      // 🔴 派生即激活（P6 append 时 makeActive=true）；这里必须**再取一次**树与视口，
      //    否则用户点完「从此处分支出新剧情」看不到任何变化（H-09 的反例手感）。
      await get().refreshTree()
      const session = await window.nahida.story.session(storyId, result.branch.branchId)
      if (session) useChatStore.getState().adoptStorySession(session)
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ busy: false })
    }
  },

  removeBranch: async (branchId) => {
    const storyId = get().currentStoryId
    if (!storyId) return
    set({ busy: true, error: null })
    try {
      await window.nahida.story.removeBranch(storyId, branchId)
      await get().refreshTree()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ busy: false })
    }
  },

  runSearch: async (query) => {
    const storyId = get().currentStoryId
    const text = query.trim()
    set({ searchQuery: query })
    if (!storyId || !text) return set({ searchHits: [] })
    try {
      set({ searchHits: await window.nahida.story.search(storyId, text) })
    } catch (error) {
      set({ searchHits: [], error: error instanceof Error ? error.message : String(error) })
    }
  },

  clearSearch: () => set({ searchHits: [], searchQuery: '' }),

  setFocus: (messageId) => set({ focusMessageId: messageId }),

  toggleDrawer: (open) => set((state) => ({ drawerOpen: open === undefined ? !state.drawerOpen : open }))
}))

/** 当前活跃分支节点（抽屉标题、时间轴用）。树来自主进程，这里只查不改。 */
export function activeBranchOf(tree: StoryBranchNode[]): StoryBranchNode | null {
  return flatten(tree).find((node) => node.isActive) ?? null
}

export { flatten as flattenBranchTree }
