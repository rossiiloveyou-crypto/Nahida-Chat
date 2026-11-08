import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StoryBranch, StoryBranchesFile, StoryBranchNode } from '@shared/story'
import { STORY_BRANCH_TITLE_PREFIX, STORY_BRANCHES_FILE, STORY_BRANCHES_VERSION } from '@shared/story'
import { assertStoryId, storiesRoot } from './paths'

/**
 * branches.json 的落盘层（P6 / M08）。
 *
 * 存盘纪律照抄 `zones/store.ts` / `story/store.ts`（**已被验证过的形状**）：
 *  - 写：write tmp → rename（原子）
 *  - 读：文件不存在返回 null；JSON 坏 / 结构不合法 / version 不对 / 空数组 → **返回 null 并 warn，不抛**
 *
 * 🔴 归一化表（§4.3，写死，不「看情况」）：
 *  - activeBranchId 不在 branches 里 → 回落第一条（用户还有数据，不该整棵树消失）
 *  - parentBranchId 指向不存在的分支 → 挂到根（warn 一次），不丢弃
 *  - 同一 branchId 出现两次 → 保留第一条（warn 一次）
 *  - 出现环（A→B→A）→ 该节点挂到根（warn 一次）。环会让 tree() 无限递归，必须防。
 */

/** tree() 需要的会话信息（只读投影，避免把整个 Session 搬进来） */
export interface BranchSessionInfo {
  id: string
  createdAt: number
  updatedAt: number
  messageCount: number
  title?: string
}

/** 把 Session 投影成 tree() 要的输入（全仓唯一一处投影，B2） */
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

function emptyFile(activeBranchId = ''): StoryBranchesFile {
  return { version: STORY_BRANCHES_VERSION, activeBranchId, branches: [] }
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

  /** 读 + 归一化。坏文件 → null（调用方负责重建） */
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
   * 懒迁移（A-14）：没有 branches.json 但有会话 → 造一棵单节点树（根 = 最早创建的会话）
   * 并**写回**一次。第二次读到 file 非 null 就完全不写（否则每次 getBranchTree 都刷盘）。
   */
  ensure(storyId: string, sessions: BranchSessionInfo[]): StoryBranchesFile | null {
    const existing = this.read(storyId)
    if (existing) return existing
    if (!sessions || sessions.length === 0) return null
    const root = [...sessions].sort((a, b) => a.createdAt - b.createdAt)[0]
    const title = (root.title && root.title.trim()) || STORY_BRANCH_TITLE_PREFIX + '1'
    const file: StoryBranchesFile = {
      version: STORY_BRANCHES_VERSION,
      activeBranchId: root.id,
      branches: [
        {
          branchId: root.id,
          parentBranchId: null,
          parentMessageId: null,
          parentMessageIndex: null,
          createdAt: root.createdAt,
          title
        }
      ]
    }
    this.write(storyId, file)
    return file
  }

  /** 树（读时算，不落盘）；坏文件 / 无文件 → 单节点树（把现存会话当根） */
  tree(storyId: string, sessions: BranchSessionInfo[]): StoryBranchNode[] {
    const file = this.read(storyId)
    if (file) return buildNodes(file, sessions)
    if (!sessions || sessions.length === 0) return []
    const root = [...sessions].sort((a, b) => a.createdAt - b.createdAt)[0]
    const title = (root.title && root.title.trim()) || STORY_BRANCH_TITLE_PREFIX + '1'
    return buildNodes(
      {
        version: STORY_BRANCHES_VERSION,
        activeBranchId: root.id,
        branches: [
          {
            branchId: root.id,
            parentBranchId: null,
            parentMessageId: null,
            parentMessageIndex: null,
            createdAt: root.createdAt,
            title
          }
        ]
      },
      sessions
    )
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

  /** 删一个节点；调用方必须先过 §4.6 的三道拒绝 */
  remove(storyId: string, branchId: string): StoryBranchesFile {
    const current = this.read(storyId)
    if (!current) throw new Error('分支不存在：' + branchId)
    if (!current.branches.some((item) => item.branchId === branchId)) {
      throw new Error('分支不存在：' + branchId)
    }
    const branches = current.branches.filter((item) => item.branchId !== branchId)
    const next: StoryBranchesFile = {
      version: STORY_BRANCHES_VERSION,
      activeBranchId:
        current.activeBranchId === branchId ? branches[0]?.branchId ?? '' : current.activeBranchId,
      branches
    }
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

/** 主进程单例（与 storyStore 同款纪律：分支树只有这一份读写入口） */
export const branchStore = new BranchStore()

/** 归一化（§4.3 那张表）。导出给测试直接喂坏数据用 */
export function normalizeBranches(raw: unknown): StoryBranchesFile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (record.version !== STORY_BRANCHES_VERSION) return null
  if (!Array.isArray(record.branches) || record.branches.length === 0) return null

  // 同一 branchId 保留第一条
  const byId = new Map<string, StoryBranch>()
  const list: StoryBranch[] = []
  for (const item of record.branches) {
    const branch = coerceBranch(item)
    if (!branch) continue
    if (byId.has(branch.branchId)) {
      console.warn('[story] branches.json 出现重复 branchId，保留第一条：' + branch.branchId)
      continue
    }
    byId.set(branch.branchId, branch)
    list.push(branch)
  }
  if (list.length === 0) return null

  // parentBranchId 指向不存在的分支 → 挂到根
  for (const branch of list) {
    if (branch.parentBranchId && !byId.has(branch.parentBranchId)) {
      console.warn('[story] 分支的父节点不存在，挂到根：' + branch.branchId)
      branch.parentBranchId = null
      branch.parentMessageId = null
      branch.parentMessageIndex = null
    }
  }

  // 环检测：沿父链走，撞到已访问节点 → 该节点挂到根
  for (const branch of list) {
    let cursor = branch.parentBranchId
    const seen = new Set<string>([branch.branchId])
    let cyclic = false
    while (cursor) {
      if (seen.has(cursor)) {
        cyclic = true
        break
      }
      seen.add(cursor)
      const next = byId.get(cursor)
      if (!next) break
      cursor = next.parentBranchId
    }
    if (cyclic) {
      console.warn('[story] 分支树出现环，该节点挂到根：' + branch.branchId)
      branch.parentBranchId = null
      branch.parentMessageId = null
      branch.parentMessageIndex = null
    }
  }

  let activeBranchId = ''
  if (typeof record.activeBranchId === 'string' && byId.has(record.activeBranchId)) {
    activeBranchId = record.activeBranchId
  } else {
    activeBranchId = list[0].branchId
  }

  return { version: STORY_BRANCHES_VERSION, activeBranchId, branches: list }
}

function coerceBranch(value: unknown): StoryBranch | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const branchId = typeof record.branchId === 'string' ? record.branchId.trim() : ''
  if (!branchId) return null
  const parentBranchId =
    typeof record.parentBranchId === 'string' && record.parentBranchId.trim()
      ? record.parentBranchId.trim()
      : null
  const parentMessageId =
    typeof record.parentMessageId === 'string' && record.parentMessageId.trim()
      ? record.parentMessageId.trim()
      : null
  const parentMessageIndex =
    typeof record.parentMessageIndex === 'number' && Number.isFinite(record.parentMessageIndex)
      ? record.parentMessageIndex
      : null
  const createdAt =
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
  const title = typeof record.title === 'string' ? record.title : ''
  return { branchId, parentBranchId, parentMessageId, parentMessageIndex, createdAt, title }
}

function buildNodes(file: StoryBranchesFile, sessions: BranchSessionInfo[]): StoryBranchNode[] {
  const info = new Map(sessions.map((session) => [session.id, session]))
  const nodes = new Map<string, StoryBranchNode>()
  for (const branch of file.branches) {
    const session = info.get(branch.branchId)
    nodes.set(branch.branchId, {
      ...branch,
      children: [],
      messageCount: session?.messageCount ?? 0,
      lastActiveAt: session?.updatedAt ?? branch.createdAt,
      isActive: branch.branchId === file.activeBranchId
    })
  }
  const roots: StoryBranchNode[] = []
  for (const branch of file.branches) {
    const node = nodes.get(branch.branchId)
    if (!node) continue
    const parent = branch.parentBranchId ? nodes.get(branch.parentBranchId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const sortRec = (list: StoryBranchNode[]): void => {
    list.sort((a, b) => a.createdAt - b.createdAt)
    for (const node of list) sortRec(node.children)
  }
  sortRec(roots)
  return roots
}
