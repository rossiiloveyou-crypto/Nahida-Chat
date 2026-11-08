import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type {
  StoryDraft,
  StoryMeta,
  StoryMetaFile,
  StoryMetaPatch,
  StorySummary,
  StoryWorldbookMode
} from '@shared/story'
import { STORY_META_FILE, STORY_META_VERSION, STORY_WORLDBOOK_MODE_DEFAULT } from '@shared/story'
import { MemoryStore } from '../rag/store'
import { assertStoryId, isStoryId, newStoryId, storiesRoot } from './paths'

/**
 * 故事区元信息的落盘层（P4）。
 *
 * 存盘纪律照抄 `zones/store.ts`（**已被验证过的形状**）：
 *  - 写：write tmp → rename（原子）
 *  - 读：文件不存在返回 null、JSON 坏或字段不合法 → **返回 null 并 warn，不抛**
 *
 * 🔴 与 paths.ts 的分工：paths.ts 定义布局，这里只是允许把根换掉（测试用）。
 *    `this.root` 缺省就是 storiesRoot()，**没有第二套目录语义**。
 */
export class StoryStore {
  private readonly explicitRoot: string | null

  /** 传 dir 可把存储放到别处（测试用）；缺省 userData/stories */
  constructor(dir?: string) {
    this.explicitRoot = dir ? dir : null
  }

  get root(): string {
    return this.explicitRoot ?? storiesRoot()
  }

  /** 一个区的目录。🔴 assertStoryId 在这里也必须过一遍（防路径穿越） */
  private dirOf(storyId: string): string {
    return join(this.root, assertStoryId(storyId))
  }

  /**
   * 列出全部故事区元信息，按 createdAt 倒序。
   * 读不出来 = 跳过（不抛）；.trash 与任何非 story_* 目录一律不算故事区。
   * sessionCount / lastActiveAt / memoryCount 由 service 补齐（store 不依赖 chatService）。
   */
  list(): StorySummary[] {
    if (!existsSync(this.root)) return []
    const summaries: StorySummary[] = []
    let entries: Array<{ name: string; isDirectory: () => boolean }> = []
    try {
      entries = readdirSync(this.root, { withFileTypes: true })
    } catch (error) {
      console.warn('[story] 读取故事区根目录失败', error)
      return []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!isStoryId(entry.name)) continue
      const meta = this.get(entry.name)
      if (!meta) continue
      summaries.push({
        storyId: meta.storyId,
        title: meta.title,
        characterId: meta.characterId,
        synopsis: meta.synopsis,
        createdAt: meta.createdAt,
        lastActiveAt: 0,
        sessionCount: 0,
        memoryCount: 0,
        // P6：分支字段由 service.listStories 补齐；store 不依赖 chatService / branches
        activeBranchId: null,
        branchCount: 0
      })
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt)
  }

  get(storyId: string): StoryMeta | null {
    const id = assertStoryId(storyId)
    const file = join(this.dirOf(id), STORY_META_FILE)
    try {
      if (!existsSync(file)) return null
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return normalizeMetaFile(parsed, id)
    } catch (error) {
      console.warn('[story] story.json 读取失败：' + id, error)
      return null
    }
  }

  /**
   * 建一个故事区。
   *
   * 🔴 顺序**就是判据**（J-12：副作用排在判定之后）：
   *   1 校验 draft → 2 生成 id → 3 mkdir → 4 写 story.json
   *   → 5 **显式打开一次** memory.db → 6 返回 meta
   * 🔴 第 4 步失败要回滚第 3 步，否则留下「没有 story.json 的半截目录」：
   *    list() 会跳过它，用户却看得见磁盘上的垃圾。
   * 🔴 第 5 步必须 close()：不关的话「目录里只有 memory.db」这条判据会看到 -wal / -shm（§2.3 E）。
   */
  create(draft: StoryDraft, defaults: { characterId: string }): StoryMeta {
    const now = Date.now()
    const title = text(draft?.title) || '未命名故事'
    const characterId = text(draft?.characterId) || text(defaults?.characterId)
    const synopsis = typeof draft?.synopsis === 'string' ? draft.synopsis.trim() : ''
    // P5 / T1：契约已补全，不再走 (draft as unknown as Record<…>) 的类型旁路（B2）。
    const worldbookDir = text(draft?.worldbookDir)
    const worldbookMode: StoryWorldbookMode =
      draft?.worldbookMode === 'override' ? 'override' : STORY_WORLDBOOK_MODE_DEFAULT

    // 🔴 守卫必须排在 mkdirSync 之前（J-12）：override 但没配世界书 ⇒ 角色设定被跳过 +
    //    剧本世界书为空 ⇒ 世界书整段消失，她看起来只是「失忆了」。
    //    先抛错，磁盘上什么都不留（A-02 判的是「抛错且磁盘没建东西」两个条件）。
    if (worldbookMode === 'override' && !worldbookDir) {
      throw new Error('选择「完全覆盖」时必须指定剧本世界书目录，否则世界书会整段消失')
    }

    const storyId = newStoryId(now)
    const dir = this.dirOf(storyId)
    const meta: StoryMeta = {
      storyId,
      title,
      characterId,
      synopsis,
      createdAt: now,
      updatedAt: now
    }
    if (worldbookDir) meta.worldbookDir = worldbookDir
    // 只在非缺省时落盘：让 story.json 里不出现 'default' 这种噪音键（B2：同一语义不许两处载体）
    if (worldbookMode !== STORY_WORLDBOOK_MODE_DEFAULT) meta.worldbookMode = worldbookMode
    // P8：背景与剧本设定（非空才落盘，与 worldbookDir 同款）
    if (typeof draft?.background === "string" && draft.background.trim()) meta.background = draft.background.trim()

    mkdirSync(dir, { recursive: true })
    try {
      this.writeMeta(meta)
    } catch (error) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (rollbackError) {
        console.error('[story] 回滚半截目录失败：' + dir, rollbackError)
      }
      throw error instanceof Error ? error : new Error(String(error))
    }

    // 库是**懒创建**的：只有 new DatabaseSync(file) 才落盘（§2.3 ③）。
    // 不在这里显式打开一次，目录里就只有 story.json，D7 判不过。
    const store = new MemoryStore(join(dir, 'memory.db'))
    try {
      store.healthy()
    } finally {
      store.close()
    }
    return cloneMeta(meta)
  }

  /** 改标题。空串 → 保持原值（不抛，面板不会因此报错） */
  rename(storyId: string, title: string): StoryMeta | null {
    const meta = this.get(storyId)
    if (!meta) return null
    const next = text(title)
    if (!next) return cloneMeta(meta)
    meta.title = next
    meta.updatedAt = Date.now()
    this.writeMeta(meta)
    return cloneMeta(meta)
  }

  updateSynopsis(storyId: string, synopsis: string): StoryMeta | null {
    const meta = this.get(storyId)
    if (!meta) return null
    meta.synopsis = typeof synopsis === 'string' ? synopsis.trim() : ''
    meta.updatedAt = Date.now()
    this.writeMeta(meta)
    return cloneMeta(meta)
  }
  /**
   * P7：多字段更新（白名单）。非法 storyId → null。空 title 忽略（不许把标题清成空）。
   *
   * 🔴 与 create 的落盘一致：worldbookMode === 'default' 与 worldbookDir 为空一律**删键**，
   *    避免同一语义在两处载体（B2）。
   */
  updateMeta(storyId: string, patch: StoryMetaPatch): StoryMeta | null {
    const meta = this.get(storyId)
    if (!meta) return null
    if (typeof patch?.title === 'string' && patch.title.trim()) meta.title = patch.title.trim()
    if (typeof patch?.synopsis === 'string') meta.synopsis = patch.synopsis.trim()
    if (typeof patch?.characterId === 'string' && patch.characterId.trim()) {
      meta.characterId = patch.characterId.trim()
    }
    if (patch?.worldbookDir !== undefined) {
      const dir = typeof patch.worldbookDir === 'string' ? patch.worldbookDir.trim() : ''
      if (dir) meta.worldbookDir = dir
      else delete meta.worldbookDir
    }
    if (patch?.worldbookMode !== undefined) {
      if (patch.worldbookMode === 'override') meta.worldbookMode = 'override'
      else delete meta.worldbookMode
    }
    // P8：背景与剧本设定（非空才落盘，空串 = 删键）
    if (patch?.background !== undefined) {
      if (typeof patch.background === 'string' && patch.background.trim()) meta.background = patch.background.trim()
      else delete meta.background
    }
    meta.updatedAt = Date.now()
    this.writeMeta(meta)
    return cloneMeta(meta)
  }

  /**
   * 删目录。🔴 调用方必须先备份、先关句柄（§4.11）；本方法只负责 rmSync 与返回结果。
   * 返回值判的是**可观测后果**（目录真的不在了），不是「没抛异常」（R10）。
   */
  removeDir(storyId: string): boolean {
    const dir = this.dirOf(storyId)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      console.warn('[story] 删除故事区目录失败：' + dir, error)
      return false
    }
    return !existsSync(dir)
  }

  /** 文件布局的其余部分（service 备份时要用，避免它自己再拼一遍路径） */
  filesOf(storyId: string): string[] {
    const dir = this.dirOf(storyId)
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  dirPathOf(storyId: string): string {
    return this.dirOf(storyId)
  }

  private writeMeta(meta: StoryMeta): void {
    const dir = this.dirOf(meta.storyId)
    const file = join(dir, STORY_META_FILE)
    const payload: StoryMetaFile = { version: STORY_META_VERSION, meta }
    mkdirSync(dir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, file)
  }
}

/** 读盘归一化：版本不对 / 结构不对 / id 对不上 → null（不抛） */
function normalizeMetaFile(raw: unknown, expectedId: string): StoryMeta | null {
  const record = asRecord(raw)
  if (!record) return null
  if (record.version !== STORY_META_VERSION) return null
  const meta = asRecord(record.meta)
  if (!meta) return null
  if (text(meta.storyId) !== expectedId) return null
  const createdAt = finiteOrNow(meta.createdAt)
  const updatedAt = finiteOrNow(meta.updatedAt)
  const title = text(meta.title) || '未命名故事'
  const characterId = text(meta.characterId)
  const synopsis = typeof meta.synopsis === 'string' ? meta.synopsis.trim() : ''
  const worldbookDir = text(meta.worldbookDir)
  // fail-safe 方向：读坏了 / 老文件没有这个键 ⇒ 一律 default（宁可多注入角色设定，不可少）
  const worldbookMode: StoryWorldbookMode =
    meta.worldbookMode === 'override' ? 'override' : STORY_WORLDBOOK_MODE_DEFAULT
  // P8：背景与剧本设定（读时回落空串；非空才放键）
  const background = typeof meta.background === 'string' ? meta.background.trim() : ''
  return {
    storyId: expectedId,
    title,
    characterId,
    synopsis,
    ...(worldbookDir ? { worldbookDir } : {}),
    ...(worldbookMode !== STORY_WORLDBOOK_MODE_DEFAULT ? { worldbookMode } : {}),
    ...(background ? { background } : {}),
    createdAt,
    updatedAt
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteOrNow(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

function cloneMeta(meta: StoryMeta): StoryMeta {
  return { ...meta }
}

/**
 * 主进程单例（P6 / BL-20）。
 *
 * 🔴 为什么必须是**一个**实例：StoryStore 现在无状态（只有只读的 explicitRoot，每次读盘），
 *    所以两份实例「碰巧」行为一致 —— 但那是巧合，不是设计。任何人给 StoryStore 加缓存
 *    （P6 要频繁读 branches.json，很可能就会加），两份实例会立刻分叉，
 *    症状是「面板看到的分支」与「chatService 看到的分支」不同，极难排查（B2）。
 * 🔴 #P4 / P5 里 chatService 与 story/service 各自 new 了一个，本次收敛为这一份。
 */
export const storyStore = new StoryStore()