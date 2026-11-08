import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEntry, Session } from '@shared/types'
import type {
  StoryBranchNode,
  StoryDeleteResult,
  StoryDraft,
  StoryMeta,
  StoryMetaPatch,
  StorySearchHit,
  StorySummary
} from '@shared/story'
import { chatService } from '../chat/chatService'
import { settingsStore } from '../settings/settingsStore'
import { MemoryStore } from '../rag/store'
import { branchStore, toBranchSessionInfo } from './branches'
import { closeStoryMemory, storyMemory } from './memory'
import { isStoryId, storyProfilePath, trashRoot } from './paths'
import { storyStore, StoryStore } from './store'

/** 分支相关对外入口（P6 / T8）。deriveBranch / deleteBranch 的真身在 derive.ts。 */
export { deriveBranch, deleteBranch } from './derive'

/**
 * 故事区的对外门面（P4）。渲染层只认这一层，不直接碰 store / memory。
 *
 * 🔴 删区是本文件**唯一不可逆**的动作，顺序写死（J-12 / C10）：
 *    ① 校验存在 → ② 建备份（放到 storiesRoot()/.trash/，**不是** storyDir 里）
 *    → ③ 逐文件校验备份 → ④ 关句柄 → ⑤ 删目录 → ⑥ 清会话 → ⑦ 复核
 *    任一步失败：**不继续**，返回 ok:false + 明确 reason（不许返回「未知」）。
 *
 * 🔴 代码可回滚，数据不可回滚（C9）：一旦删了故事区，回退代码也回不来数据。
 *    所以备份 + 校验排在删除**之前**，而不是「删完发现不对再想办法」。
 */
/** 主进程单例（供 IPC 薄转发用；测试直接调下面的函数） */
export function storyStoreOf(): StoryStore {
  return storyStore
}

export function listStories(): StorySummary[] {
  const summaries = storyStore.list()
  const sessions = chatService.listSessions()
  return summaries.map((item) => {
    const own = sessions.filter((session) => session.storyId === item.storyId)
    const file = branchStore.read(item.storyId)
    const activeBranchId = file ? file.activeBranchId : null
    const branchCount = file ? file.branches.length : own.length
    // §2.9 第 7 条：lastActiveAt 由 activeBranchId 推导，不再直接等于 max(updatedAt)（B2）
    let lastActiveAt = 0
    if (activeBranchId) {
      const active = own.find((session) => session.id === activeBranchId)
      if (active) lastActiveAt = active.updatedAt
    }
    if (!lastActiveAt) {
      lastActiveAt = own.reduce((max, session) => Math.max(max, session.updatedAt), 0)
    }
    return {
      ...item,
      sessionCount: own.length,
      lastActiveAt,
      memoryCount: countMemories(item.storyId),
      activeBranchId,
      branchCount
    }
  })
}

export function getStory(storyId: string): StoryMeta | null {
  // 形状非法 → null（fail-closed）：IPC 那边不该因为一个坏 id 抛到渲染层。
  if (!isStoryId(storyId)) return null
  return storyStore.get(storyId)
}

export function createStory(draft: StoryDraft): { meta: StoryMeta; sessionId: string } {
  const meta = storyStore.create(draft, { characterId: settingsStore.get().defaultCharacterId })
  // 建故事会话：mode 显式 'story'，并带上 storyId（T2 / T10 的落点）
  const session = chatService.createSession({
    mode: 'story',
    storyId: meta.storyId,
    characterId: meta.characterId,
    title: meta.title
  })
  // AI 开场：写成**首条 assistant 消息**（M14 明确允许；文案由调用方传入，代码零硬编码）
  if (typeof draft?.openingText === 'string' && draft.openingText.trim()) {
    chatService.appendOpeningMessage(session.id, draft.openingText.trim())
  }
  return { meta, sessionId: session.id }
}

/** 故事区自己的记忆条数。🔴 只读已存在的库，不制造空库（R10：判存在前先确认创建时机） */
function countMemories(storyId: string): number {
  const file = join(storyStore.dirPathOf(storyId), 'memory.db')
  if (!existsSync(file)) return 0
  const store = new MemoryStore(file)
  try {
    return store.healthy() ? store.count() : 0
  } finally {
    store.close()
  }
}

/**
 * 这个区的分支树（P7 的抽屉直接用，P6 只提供数据 / T6）。
 *
 * 🔴 懒迁移（A-14）：没有 branches.json 但有会话时，第一次读产出单节点树**并写回**；
 *    第二次读到 file 非 null 就完全不写（否则 P7 一开抽屉就刷盘）。
 * 🔴 会话真源仍是 chatService；结构真源是 branches.json —— 两者在这里合并成树。
 */
export function getBranchTree(storyId: string): StoryBranchNode[] {
  if (!isStoryId(storyId)) return []
  const sessions = chatService.listSessionsByStory(storyId)
  const infos = sessions.map(toBranchSessionInfo)
  // ensure 只在没有文件时写一次（幂等）；之后 tree 只读
  branchStore.ensure(storyId, infos)
  return branchStore.tree(storyId, infos)
}

/** 切换活跃分支。返回切换后的树；branchId 非法 → 抛（P7 只调这个，不自己改指针） */
export function switchBranch(storyId: string, branchId: string): StoryBranchNode[] {
  if (!isStoryId(storyId)) throw new Error('非法的故事区 id：' + String(storyId))
  branchStore.setActive(storyId, branchId)
  return getBranchTree(storyId)
}
/** P7：取某故事的某条分支会话（带 messages，给渲染层视口用）。branchId 省略 = 活跃分支。 */
export function getStorySession(storyId: string, branchId?: string): Session | null {
  if (!isStoryId(storyId)) return null
  const sessions = chatService.listSessionsByStory(storyId)
  if (sessions.length === 0) return null
  const active = branchStore.read(storyId)?.activeBranchId ?? ''
  const targetId = branchId && branchId.trim() ? branchId.trim() : active || sessions[0].id
  return sessions.find((session) => session.id === targetId) ?? null
}

/**
 * P7：全文检索（内存扫，范围 = 当前故事区全部分支；BL-09 未到 FTS 门槛）。
 *
 * 🔴 有意选择内存扫（M16 只要求能检索会话消息）：单区 > 5000 条再做 FTS。
 * 🔴 snippet 必须截断（A-20：超长消息不许把整段塞进结果）。
 */
export function searchStory(storyId: string, query: string): StorySearchHit[] {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!isStoryId(storyId) || !q) return []
  const lower = q.toLowerCase()
  const active = branchStore.read(storyId)?.activeBranchId ?? ''
  const hits: StorySearchHit[] = []
  for (const session of chatService.listSessionsByStory(storyId)) {
    session.messages.forEach((message, index) => {
      if (!message.content) return
      const pos = message.content.toLowerCase().indexOf(lower)
      if (pos < 0) return
      const from = Math.max(0, pos - 20)
      const to = Math.min(message.content.length, pos + q.length + 40)
      const snippet =
        (from > 0 ? '…' : '') + message.content.slice(from, to) + (to < message.content.length ? '…' : '')
      hits.push({
        branchId: session.id,
        branchTitle: session.title,
        messageId: message.id,
        messageIndex: index,
        role: message.role === 'narration' ? 'narration' : message.role === 'user' ? 'user' : 'assistant',
        snippet: snippet.length > 160 ? snippet.slice(0, 159) + '…' : snippet,
        isActiveBranch: session.id === active
      })
    })
  }
  // 稳定顺序：活跃分支优先，其次 branchId，再按下标
  hits.sort(
    (a, b) =>
      Number(b.isActiveBranch) - Number(a.isActiveBranch) ||
      a.branchId.localeCompare(b.branchId) ||
      a.messageIndex - b.messageIndex
  )
  return hits.slice(0, 100)
}

export function updateStoryMeta(storyId: string, patch: StoryMetaPatch): StoryMeta | null {
  if (!isStoryId(storyId)) return null
  return storyStore.updateMeta(storyId, patch ?? {})
}

/** P7：读故事画像（不存在 → 空串）。🔴 路径必须用 storyProfilePath（B4）。 */
export function readStoryProfile(storyId: string): string {
  if (!isStoryId(storyId)) return ''
  const file = storyProfilePath(storyId)
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch (error) {
    console.warn('[story] 读取画像失败：' + storyId, error)
    return ''
  }
}

/** P7：写故事画像（空串 = 删除文件）。原子写 tmp→rename。 */
export function saveStoryProfile(storyId: string, text: string): boolean {
  if (!isStoryId(storyId)) return false
  const file = storyProfilePath(storyId)
  const body = typeof text === 'string' ? text : ''
  try {
    if (!body.trim()) {
      if (existsSync(file)) rmSync(file)
      return true
    }
    const tmp = file + '.tmp'
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, file)
    return true
  } catch (error) {
    console.warn('[story] 写入画像失败：' + storyId, error)
    return false
  }
}

/* ───────────────────────── P8 · 故事长期记忆展示（D-C） ───────────────────────── */

/**
 * P8：列某故事区**自己库**里的长期记忆。
 * 🔴 必须走 storyMemory(storyId)（该区自己的库），不许走全局 memoryService ——
 *    否则把全局记忆当故事记忆展示，也破坏 M11 物理隔离（A-09/A-10 专测）。
 * 非法 id → []（不抛，IPC 不该因坏 id 崩）。
 */
export function listStoryMemories(storyId: string): MemoryEntry[] {
  if (!isStoryId(storyId)) return []
  return storyMemory(storyId).list()
}

/** P8：删一条故事记忆（返回删除后的完整列表）。非法 id → []。 */
export function deleteStoryMemory(storyId: string, id: string): MemoryEntry[] {
  if (!isStoryId(storyId)) return []
  return storyMemory(storyId).remove(id)
}

/** P8：清空该故事区的全部长期记忆（返回清空后的列表 = []）。非法 id → []。 */
export function clearStoryMemories(storyId: string): MemoryEntry[] {
  if (!isStoryId(storyId)) return []
  return storyMemory(storyId).clear()
}

export function deleteStory(storyId: string, opts: { confirmed?: boolean }): StoryDeleteResult {
  // ① 校验存在：非法形状也走 not_found，绝不让坏 id 进入任何路径拼接
  if (!isStoryId(storyId)) {
    return { ok: false, reason: 'not_found', detail: '非法的故事区 id：' + String(storyId) }
  }
  const meta = storyStore.get(storyId)
  if (!meta) return { ok: false, reason: 'not_found', detail: '故事区不存在：' + storyId }
  if (opts?.confirmed !== true) {
    return {
      ok: false,
      reason: 'need_confirm',
      detail: '删除故事区会连同它的记忆库一起删除，需要显式确认'
    }
  }

  const dir = storyStore.dirPathOf(storyId)
  const files = storyStore.filesOf(storyId)

  // ② 建备份：.trash 与 storiesRoot 同级 —— 放进 storyDir 里会被 ⑤ 一起删掉
  const backupDir = join(trashRoot(), storyId + '-' + stamp())
  mkdirSync(backupDir, { recursive: true })
  let bytes = 0
  try {
    for (const name of files) {
      const from = join(dir, name)
      const to = join(backupDir, name)
      copyFileSync(from, to)
      bytes += statSync(to).size
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'backup_mismatch',
      detail: '备份复制失败（' + (error instanceof Error ? error.message : String(error)) + '），未删除任何文件'
    }
  }

  // ③ 逐文件校验 —— 不是走过场：一个只复制了 story.json 的「复制」实现在正常路径下看起来成功，
  //    而用户丢的是几十 MB 的 memory.db，那正是**唯一无法重建**的东西（C10 / V6）。
  const backed = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  if (backed.length !== files.length) {
    return {
      ok: false,
      reason: 'backup_mismatch',
      detail: '备份文件数 ' + String(backed.length) + ' ≠ 源文件数 ' + String(files.length) + '，未删除任何文件'
    }
  }
  for (const name of files) {
    const sourceSize = statSync(join(dir, name)).size
    const backupSize = statSync(join(backupDir, name)).size
    if (sourceSize !== backupSize) {
      return {
        ok: false,
        reason: 'backup_mismatch',
        detail: '文件大小不一致：' + name + '（源 ' + String(sourceSize) + ' / 备份 ' + String(backupSize) + '）'
      }
    }
  }

  // ④ 关句柄 —— 必须在 ⑤ 之前（§2.2 实测 A / C：任何一个没关，删目录都会 EPERM）
  closeStoryMemory(storyId)

  // ⑤ 删目录
  const removed = storyStore.removeDir(storyId)
  if (!removed) {
    return {
      ok: false,
      reason: 'backup_mismatch',
      detail: '目录仍在（句柄未关或被占用）；备份保留在 ' + backupDir
    }
  }

  // ⑥ 清会话（分支）
  const sessionsRemoved = chatService.deleteSessionsByStory(storyId)

  // ⑦ 复核：rmSync 带 force 不会因不存在而抛，所以「没报错」不能证明「删掉了」（R10）
  if (existsSync(dir)) {
    return {
      ok: false,
      reason: 'backup_mismatch',
      detail: '目录仍在；备份保留在 ' + backupDir
    }
  }

  return {
    ok: true,
    receipt: { storyId, backupPath: backupDir, fileCount: files.length, bytes, createdAt: Date.now() },
    sessionsRemoved
  }
}

/** 备份目录名的时间戳：YYYYMMDD-HHmmss（本地时区，人能读） */
function stamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  )
}