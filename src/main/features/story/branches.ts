import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  StoryBranch,
  StoryBranchesFile,
  StoryBranchItem,
  StoryForkOrigin,
  StoryMemoryBound
} from '@shared/story'
import { STORY_BRANCHES_VERSION, STORY_BRANCH_TITLE_PREFIX, STORY_BRANCHES_FILE } from '@shared/story'
import { assertStoryId, storiesRoot } from './paths'

/**
 * branches.json 的落盘层（P6 / M08）。
 *
 * 存盘纪律照抄 `zones/store.ts` / `story/store.ts`（**已被验证过的形状**）：
 *  - 写：write tmp → rename（原子）
 *  - 读：文件不存在返回 null；JSON 坏 / 结构不合法 / version 不认识 / 空数组 → **返回 null 并 warn，不抛**
 *
 * 🔴 P6 修订（**分支独立**）：分支之间没有父子依赖。
 *    - 落盘形状是**扁平列表**，没有 parentBranchId。「从哪儿分出来的」只以 forkedFrom
 *      快照的形式留一行字给界面看，运行时不解析它 —— 父分支删了、改名了，这行字也不变。
 *    - 记忆可见性不再是「沿父链上溯计算」，而是派生那一刻固化进 memoryBounds 的快照。
 *      于是删父分支不影响子分支召回，删任意分支都不会让别人的可见范围静默变形。
 *    - 归一化表（`4.3，写死，不「看情况」）：
 *        · activeBranchId 不在 branches 里 → 回落第一条
 *        · 同一 branchId 出现两次 → 保留第一条（warn 一次）
 *        · version === 1 的老文件 → 就地迁移成 v2（父链转 forkedFrom + memoryBounds）
 *        · 悬空的 forkedFrom / memoryBounds 条目**不修**：它们本来就是快照，
 *          指向的分支可以不存在（那正是「删掉父分支后子分支照常工作」的实现方式）
 */

/** list() 需要的会话信息（只读投影，避免把整个 Session 搬进来） */
export interface BranchSessionInfo {
  id: string
  createdAt: number
  updatedAt: number
  messageCount: number
  title?: string
}

/** 把 Session 投影成 list() 要的输入（全仓唯一一处投影，B2） */
export function toBranchSessionInfo(session: {
  id: string
  createdAt: number
  updatedAt: number
  title?: string
  messages: unknown[]
}): BranchSessionInfo {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    title: session.title
  }
}

function emptyFile(): StoryBranchesFile {
  return { version: STORY_BRANCHES_VERSION, activeBranchId: '', branches: [] }
}

/** 根分支的形状（唯一构造点）：没有来源，只看得见自己 */
export function rootBranchOf(session: BranchSessionInfo): StoryBranch {
  return {
    branchId: session.id,
    title: (session.title && session.title.trim()) || STORY_BRANCH_TITLE_PREFIX + '1',
    createdAt: session.createdAt,
    forkedFrom: null,
    memoryBounds: [{ branchId: session.id, maxMessageIndex: null }]
  }
}

export class BranchStore {
  private readonly explicitRoot: string | null

  /** 传 dir 可把存储放到别处（测试用）；缺省 userData/stories */
  constructor(dir?: string) {
    this.explicitRoot = dir ? dir : null
  }

  get root(): string {
    return this.explicitRoot ?? storiesRoot()
  }

  private dirOf(storyId: string): string {
    return join(this.root, assertStoryId(storyId))
  }

  private fileOf(storyId: string): string {
    return join(this.dirOf(storyId), STORY_BRANCHES_FILE)
  }

  /** 读 + 归一化（含 v1→v2 迁移）。坏文件 → null（调用方负责重建） */
  read(storyId: string): StoryBranchesFile | null {
    let raw: unknown
    const file = this.fileOf(storyId)
    if (!existsSync(file)) return null
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      console.warn('[story] branches.json 解析失败，按「没有分支」处理：' + file, error)
      return null
    }
    return normalizeBranches(raw)
  }

  /** 原子写：先写 tmp 再 rename。成功后 tmp 不存在（A-04） */
  write(storyId: string, file: StoryBranchesFile): void {
    const target = this.fileOf(storyId)
    mkdirSync(dirname(target), { recursive: true })
    const tmp = target + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmp, target)
  }

  /**
   * 懒迁移（A-14）：没有 branches.json 但有会话 → 造一条根分支并**写回**一次。
   * 第二次读到 file 非 null 就完全不写（否则每次 list 都刷盘）。
   */
  ensure(storyId: string, sessions: BranchSessionInfo[]): StoryBranchesFile | null {
    const existing = this.read(storyId)
    if (existing) return existing
    if (!sessions || sessions.length === 0) return null
    const root = [...sessions].sort((a, b) => a.createdAt - b.createdAt)[0]
    const file: StoryBranchesFile = {
      version: STORY_BRANCHES_VERSION,
      activeBranchId: root.id,
      branches: [rootBranchOf(root)]
    }
    this.write(storyId, file)
    return file
  }

  /**
   * 扁平分支列表（读时算，不落盘）；没有文件 / 坏文件 → 把现存会话当一条根分支。
   * 🔴 按 createdAt 升序，顺序稳定；界面直接画，渲染层零计算。
   */
  list(storyId: string, sessions: BranchSessionInfo[]): StoryBranchItem[] {
    const file = this.read(storyId)
    const infos = new Map((sessions ?? []).map((session) => [session.id, session]))
    let branches = file ? file.branches : []
    let activeBranchId = file ? file.activeBranchId : ''
    if (branches.length === 0) {
      if (!sessions || sessions.length === 0) return []
      const root = rootBranchOf([...sessions].sort((a, b) => a.createdAt - b.createdAt)[0])
      branches = [root]
      activeBranchId = root.branchId
    }
    return branches
      .map((branch): StoryBranchItem => {
        const session = infos.get(branch.branchId)
        return {
          branchId: branch.branchId,
          title: branch.title,
          createdAt: branch.createdAt,
          forkedFrom: branch.forkedFrom ?? null,
          messageCount: session?.messageCount ?? 0,
          lastActiveAt: session?.updatedAt ?? branch.createdAt,
          isActive: branch.branchId === activeBranchId
        }
      })
      .sort((a, b) => a.createdAt - b.createdAt || a.branchId.localeCompare(b.branchId))
  }

  /** 派生时追加一个节点；不动其它节点 */
  append(storyId: string, branch: StoryBranch, makeActive: boolean): StoryBranchesFile {
    const current = this.read(storyId) ?? emptyFile()
    const branches = current.branches.filter((item) => item.branchId !== branch.branchId)
    branches.push(branch)
    const next: StoryBranchesFile = {
      version: STORY_BRANCHES_VERSION,
      activeBranchId: makeActive ? branch.branchId : current.activeBranchId || branch.branchId,
      branches
    }
    this.write(storyId, next)
    return next
  }

  /**
   * 删一条分支。**没有「先处理子分支」这一条了** —— 分支之间本来就没有父子关系。
   * nextActiveId：删的正好是活跃分支时，调用方挑好的接替者（缺省 = 剩下的第一条）。
   */
  remove(storyId: string, branchId: string, nextActiveId?: string): StoryBranchesFile {
    const current = this.read(storyId)
    if (!current) throw new Error('分支不存在：' + branchId)
    if (!current.branches.some((item) => item.branchId === branchId)) {
      throw new Error('分支不存在：' + branchId)
    }
    const branches = current.branches.filter((item) => item.branchId !== branchId)
    let activeBranchId = current.activeBranchId
    if (activeBranchId === branchId) {
      activeBranchId =
        nextActiveId && branches.some((item) => item.branchId === nextActiveId)
          ? nextActiveId
          : branches[0]?.branchId ?? ''
    }
    const next: StoryBranchesFile = { version: STORY_BRANCHES_VERSION, activeBranchId, branches }
    this.write(storyId, next)
    return next
  }

  /** 切换活跃分支；branchId 不在 branches[] 里 → 抛 */
  setActive(storyId: string, branchId: string): StoryBranchesFile {
    const current = this.read(storyId)
    if (!current) throw new Error('分支不存在：' + branchId)
    if (!current.branches.some((item) => item.branchId === branchId)) {
      throw new Error('分支不存在：' + branchId)
    }
    const next: StoryBranchesFile = { ...current, activeBranchId: branchId }
    this.write(storyId, next)
    return next
  }
}

/** 主进程单例（与 storyStore 同款纪律：分支列表只有这一份读写入口） */
export const branchStore = new BranchStore()

/* ───────────────────────── 归一化 / 迁移 ───────────────────────── */

/**
 * 归一化入口（导出给测试直接喂坏数据用）。
 *
 * 🔴 v1（有 parentBranchId 的老文件）**不丢弃**：就地迁移成 v2。
 *    迁移只做字段换算，不写盘 —— 下一次 append / remove / setActive 自然落成 v2。
 */
export function normalizeBranches(raw: unknown): StoryBranchesFile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.branches) || record.branches.length === 0) return null
  if (record.version === STORY_BRANCHES_VERSION) return normalizeV2(record)
  if (record.version === 1) return migrateV1(record)
  return null
}

function normalizeV2(record: Record<string, unknown>): StoryBranchesFile | null {
  const byId = new Map<string, StoryBranch>()
  for (const item of record.branches as unknown[]) {
    const branch = coerceBranch(item)
    if (!branch) continue
    if (byId.has(branch.branchId)) {
      console.warn('[story] branches.json 出现重复 branchId，保留第一条：' + branch.branchId)
      continue
    }
    byId.set(branch.branchId, branch)
  }
  if (byId.size === 0) return null
  const branches = [...byId.values()]
  const active =
    typeof record.activeBranchId === 'string' && byId.has(record.activeBranchId)
      ? record.activeBranchId
      : branches[0].branchId
  return { version: STORY_BRANCHES_VERSION, activeBranchId: active, branches }
}

function coerceBranch(value: unknown): StoryBranch | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const branchId = typeof record.branchId === 'string' ? record.branchId.trim() : ''
  if (!branchId) return null
  const createdAt =
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now()
  const title = typeof record.title === 'string' ? record.title : ''
  return {
    branchId,
    title,
    createdAt,
    forkedFrom: coerceOrigin(record.forkedFrom),
    memoryBounds: coerceBounds(record.memoryBounds, branchId)
  }
}

function coerceOrigin(value: unknown): StoryForkOrigin | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const branchId = typeof record.branchId === 'string' ? record.branchId.trim() : ''
  if (!branchId) return null
  return {
    branchId,
    title: typeof record.title === 'string' ? record.title : '',
    messageNumber:
      typeof record.messageNumber === 'number' && Number.isFinite(record.messageNumber)
        ? record.messageNumber
        : null,
    messageId: typeof record.messageId === 'string' ? record.messageId : ''
  }
}

/**
 * 记忆可见范围（快照）。
 * 缺省 / 非法 → 只看得见自己（fail-closed：宁可少召回，也不许跨分支泄漏）。
 * 🔴 自己的那一条必须存在，否则「自己产生的记忆」反而会看不见。
 */
function coerceBounds(value: unknown, selfId: string): StoryMemoryBound[] {
  const list: StoryMemoryBound[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const branchId = typeof record.branchId === 'string' ? record.branchId.trim() : ''
      if (!branchId) continue
      const maxMessageIndex =
        typeof record.maxMessageIndex === 'number' && Number.isFinite(record.maxMessageIndex)
          ? record.maxMessageIndex
          : null
      list.push({ branchId, maxMessageIndex })
    }
  }
  if (!list.some((item) => item.branchId === selfId)) {
    list.unshift({ branchId: selfId, maxMessageIndex: null })
  }
  return list
}

/** v1 的形状（只在这里出现；迁移完就没有 parent 了） */
interface LegacyBranch {
  branchId: string
  parentBranchId: string | null
  parentMessageId: string | null
  parentMessageIndex: number | null
  createdAt: number
  title: string
}

/**
 * v1 → v2 迁移（读时做，不单独写盘）：
 *   ① 三个 parent 字段 → forkedFrom 快照（父分支标题取迁移这一刻的标题）
 *   ② 沿父链算出**旧的**可见性边界，固化成 memoryBounds —— 迁移前后召回结果逐字一致
 *   ③ 环 / 悬空父 → 按根分支处理（只看得见自己），不抛
 */
function migrateV1(record: Record<string, unknown>): StoryBranchesFile | null {
  const legacy: LegacyBranch[] = []
  const seen = new Set<string>()
  for (const item of record.branches as unknown[]) {
    const branch = coerceLegacy(item)
    if (!branch) continue
    if (seen.has(branch.branchId)) {
      console.warn('[story] branches.json 出现重复 branchId，保留第一条：' + branch.branchId)
      continue
    }
    seen.add(branch.branchId)
    legacy.push(branch)
  }
  if (legacy.length === 0) return null
  const byId = new Map(legacy.map((branch) => [branch.branchId, branch]))

  const branches: StoryBranch[] = legacy.map((branch) => {
    const parent = branch.parentBranchId ? byId.get(branch.parentBranchId) : undefined
    const forkedFrom: StoryForkOrigin | null = branch.parentBranchId
      ? {
          branchId: branch.parentBranchId,
          title: parent?.title ?? '',
          messageNumber:
            branch.parentMessageIndex === null ? null : branch.parentMessageIndex + 1,
          messageId: branch.parentMessageId ?? ''
        }
      : null
    return {
      branchId: branch.branchId,
      title: branch.title,
      createdAt: branch.createdAt,
      forkedFrom,
      memoryBounds: legacyBounds(branch.branchId, byId)
    }
  })

  const active =
    typeof record.activeBranchId === 'string' && seen.has(record.activeBranchId)
      ? record.activeBranchId
      : branches[0].branchId
  return { version: STORY_BRANCHES_VERSION, activeBranchId: active, branches }
}

function coerceLegacy(value: unknown): LegacyBranch | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const branchId = typeof record.branchId === 'string' ? record.branchId.trim() : ''
  if (!branchId) return null
  return {
    branchId,
    parentBranchId:
      typeof record.parentBranchId === 'string' && record.parentBranchId.trim()
        ? record.parentBranchId.trim()
        : null,
    parentMessageId:
      typeof record.parentMessageId === 'string' && record.parentMessageId.trim()
        ? record.parentMessageId.trim()
        : null,
    parentMessageIndex:
      typeof record.parentMessageIndex === 'number' && Number.isFinite(record.parentMessageIndex)
        ? record.parentMessageIndex
        : null,
    createdAt:
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? record.createdAt
        : Date.now(),
    title: typeof record.title === 'string' ? record.title : ''
  }
}

/**
 * 旧的可见性算法照抄（P6 原实现），只为把老数据换算成快照：
 *   self → null；第 k 层祖先 → 沿父链一路取**最小**的分叉下标。
 * 🔴 环：与旧归一化「环挂到根」等价 —— 直接按根分支返回单条无上界。
 */
function legacyBounds(id: string, byId: Map<string, LegacyBranch>): StoryMemoryBound[] {
  const out: StoryMemoryBound[] = []
  const seen = new Set<string>()
  let cursor: string | null = id
  let minAnchor: number | null = null
  while (cursor) {
    if (seen.has(cursor)) {
      console.warn('[story] 迁移时发现分支环，按根分支处理：' + id)
      return [{ branchId: id, maxMessageIndex: null }]
    }
    seen.add(cursor)
    out.push({ branchId: cursor, maxMessageIndex: minAnchor })
    const node = byId.get(cursor)
    if (!node || !node.parentBranchId) break
    if (node.parentMessageIndex === null) {
      out.push({ branchId: node.parentBranchId, maxMessageIndex: null })
      break
    }
    minAnchor =
      minAnchor === null ? node.parentMessageIndex : Math.min(minAnchor, node.parentMessageIndex)
    cursor = node.parentBranchId
  }
  return out
}
