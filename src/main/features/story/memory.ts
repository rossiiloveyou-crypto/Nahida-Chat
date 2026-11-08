import { MemoryService } from '../rag'
import { MemoryStore } from '../rag/store'
import { storyDbPath } from './paths'

/**
 * 故事区的记忆库句柄（P4 / M11）。
 *
 * 一个 storyId → 一个 MemoryService（含一个 MemoryStore，指到该区的 memory.db）。
 * 句柄**缓存在 Map 里**，不是每次 new：
 *   - 每次 new 都会多一条 SQLite 连接，旧连接不关 → 删目录时 EPERM（§2.2 C 实测）
 *   - WAL 下多连接并发写会互相等锁，而这里没有并发的必要
 *
 * 🔴 唯一的关闭入口是 closeStoryMemory / closeAllStoryMemory，删区必须先调（§4.11）。
 */
const handles = new Map<string, MemoryService>()

export function storyMemory(storyId: string): MemoryService {
  const exists = handles.get(storyId)
  if (exists) return exists
  const created = new MemoryService(new MemoryStore(storyDbPath(storyId)))
  handles.set(storyId, created)
  return created
}

/** 关掉这个区的句柄（§2.2 C：任何一个没关，删目录都会 EPERM） */
export function closeStoryMemory(storyId: string): void {
  const handle = handles.get(storyId)
  if (!handle) return
  handle.dispose()
  handles.delete(storyId)
}

export function closeAllStoryMemory(): void {
  for (const id of [...handles.keys()]) closeStoryMemory(id)
}
