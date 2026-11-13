/**
 * 故事区（Stories）的纯数据契约（P4）。
 *
 * 与 `shared/qqHost.ts` / `shared/zones.ts` 同规矩：**零 import**，三端都能直接打进去。
 * 落盘、校验、不变量全在 `main/features/story/`。
 *
 * 心智模型（M08 / M11）：
 *  - 一个故事区 = `userData/stories/<storyId>/` 一个自包含目录
 *  - 该目录里至少有 `story.json`（元信息）与 `memory.db`（这个区**自己的**记忆库）
 *  - 分支元数据 `branches.json` 归 P6，本 Phase **不建**
 */

/** 故事区元信息。落盘为 userData/stories/<storyId>/story.json */
export interface StoryMeta {
  /** story_<base36 时间戳>_<rand6>；目录名就是它 */
  storyId: string
  /** 故事标题，用户可改 */
  title: string
  /** 用哪个角色的提示词（Prompt/characters/<id>/） */
  characterId: string
  /** 剧本概要。P7 的卡片要显示它（M12）。空串 = 用户没填，卡片回落显示 title */
  synopsis: string
  /** 用户自填的「剧本世界书」目录；缺省 = 用角色的 worldbook（M15 的覆盖模式在 P5 实现） */
  worldbookDir?: string
  /**
   * 世界书档位（P5 / M15）。缺省 = 'default'。
   *  - 'default'   角色 worldbook **+** 剧本世界书（两段都注入）
   *  - 'override'  只注入剧本世界书，**跳过**角色默认 worldbook
   * 🔴 缺省刻意选 default：老故事区没有这个键 → 行为与 P4 完全一致。
   */
  worldbookMode?: StoryWorldbookMode
  /** P8：背景与剧本设定（开场环境/场景介绍，正文型；注入提示词设定层，不是第一条消息） */
  background?: string
  createdAt: number
  updatedAt: number
}

/** 新建故事区时提交的草稿 */
export interface StoryDraft {
  title: string
  characterId: string
  synopsis?: string
  /** 剧本世界书目录（相对 storiesRoot()）；缺省 = 不配 */
  worldbookDir?: string
  /** 世界书档位；缺省 = 'default' */
  worldbookMode?: StoryWorldbookMode
  /** P8：背景与剧本设定（可空）。注入提示词设定层，不是第一条消息 */
  background?: string
  /**
   * AI 开场文案（D12）。
   * 🔴 由**调用方传入**，代码里不硬编码任何角色文本（总蓝图 §7.1：Prompt/ 是用户资产）。
   * 非空时，建区的最后一步把它写成故事会话的**首条 assistant 消息**（M14 允许的口子）。
   */
  openingText?: string
}

/** 列表 / 卡片用的一行（P7 会用，本 Phase 只提供数据） */
export interface StorySummary {
  storyId: string
  title: string
  characterId: string
  synopsis: string
  createdAt: number
  /** 该故事区当前活跃会话的最后更新时间；没有会话时为 0 */
  lastActiveAt: number
  /** 这个区有多少条会话（分支数；P6 之后会 > 1） */
  sessionCount: number
  /** 记忆条数（来自它自己的 memory.db） */
  memoryCount: number
  /** 当前活跃分支的会话 id；没有分支时为 null（P6 / M12，P7 的卡片要用） */
  activeBranchId: string | null
  /** 分支数（≥ 1）（P6 / M12） */
  branchCount: number
}

/** 删除前的备份回执（J-12：备份要排在删除之前，且要能被复核） */
export interface StoryBackupReceipt {
  storyId: string
  /** 备份目录的绝对路径 */
  backupPath: string
  /** 备份里包含的文件数 */
  fileCount: number
  /** 备份总字节 */
  bytes: number
  createdAt: number
}

/** 删除结果。🔴 失败时**不返回未知**，只有这几种明确原因（H8：不允许「未知/待定」） */
export type StoryDeleteResult =
  | { ok: true; receipt: StoryBackupReceipt; sessionsRemoved: number }
  | { ok: false; reason: 'not_found' | 'need_confirm' | 'backup_mismatch'; detail: string }

/**
 * 世界书档位（M15）。两档，不做第三档 ——
 * 档位越多，「覆盖」的边界越模糊（P5 蓝图 §2.9 第 7 行）。
 */
export type StoryWorldbookMode = 'default' | 'override'

/** 缺省档位。改它 = 改所有老故事区的行为，非必要不动 */
export const STORY_WORLDBOOK_MODE_DEFAULT: StoryWorldbookMode = 'default'

/** 故事画像文件名（M17）：userData/stories/<storyId>/profile.md */
export const STORY_PROFILE_FILE = 'profile.md'

export const STORY_ID_PREFIX = 'story_'
export const STORY_META_FILE = 'story.json'
export const STORY_DB_FILE = 'memory.db'
export const STORY_TRASH_DIR = '.trash'
export const STORY_META_VERSION = 1

/** story.json 的整体形状（带版本，便于将来迁移） */
export interface StoryMetaFile {
  version: typeof STORY_META_VERSION
  meta: StoryMeta
}

/* ───────────────────────── P6 · 分支列表（M08 / M13） ───────────────────────── */

/**
 * 派生来源（**只读快照，不是外键**）。
 *
 * 🔴 派生完成后分支就独立了：父分支改名、继续往下写、被整个删掉，
 *    都不会改变这条分支的任何行为。快照只用于界面上那一行「从《xxx》第 N 条分出」。
 * 🔴 这里存的是**当时的**副本 —— title / messageNumber 都不跟着父分支变。
 */
export interface StoryForkOrigin {
  /** 源分支当时的会话 id（追溯用；运行时不解析，父分支没了也不影响） */
  branchId: string
  /** 源分支当时的标题（快照） */
  title: string
  /** 从源分支第几条消息之后分出（1 起，人读）；null = 当时就没记下下标（老数据） */
  messageNumber: number | null
  /** 分叉点消息 id（追溯用；运行时不解析） */
  messageId: string
}

/**
 * 「哪条分支的哪些记忆可见」—— 派生那一刻**固化**下来的快照。
 *
 * 🔴 这是把旧实现里「沿父链上溯算可见性」改成「派生时算一次、之后只读快照」的落点。
 *    父分支被删之后，它留下的记忆仍然按这里的边界召回，
 *    不会因为树变了而突然看不见（P6 修订：分支独立）。
 */
export interface StoryMemoryBound {
  /** 记忆来源分支的会话 id */
  branchId: string
  /** 该分支里可见的最大消息下标（含）；null = 无上界 */
  maxMessageIndex: number | null
}

/**
 * 一条分支（P6 / M08 / M13）。落盘在 userData/stories/<storyId>/branches.json。
 *
 * 🔴 一条分支**就是一条会话**（M13）：branchId = 该会话的 Session.id。
 *    分支不是「会话的另一种形态」，它没有独立的消息存储。
 * 🔴 **分支之间没有依赖**（P6 修订）：派生完成后它就是一条独立会话，
 *    删掉别的分支（包括它是从哪儿分出来的）都不影响它的读写、检索与记忆召回。
 */
export interface StoryBranch {
  /** 分支 id = 该分支**会话**的 Session.id（一条分支就是一条会话，M13） */
  branchId: string
  /** 用户可改的分支名；空串 = 用「分支 N」 */
  title: string
  /** 建这条分支的时间 */
  createdAt: number
  /** 派生来源快照；null / 缺省 = 这是故事的第一条分支 */
  forkedFrom?: StoryForkOrigin | null
  /** 派生时固化的记忆可见范围；缺省 / 空数组 = 只看得见自己产生的记忆 */
  memoryBounds?: StoryMemoryBound[]
}

/** branches.json 的整体形状（带版本，便于将来迁移） */
export interface StoryBranchesFile {
  version: typeof STORY_BRANCHES_VERSION
  /** 这个区的**活跃分支**（用户当前在看哪条）；必须存在于 branches[] 里 */
  activeBranchId: string
  branches: StoryBranch[]
}

/**
 * 给界面直接画的一行（读时算出来的，**不落盘**）。
 * 🔴 扁平列表：没有 children —— 分支之间不存在父子关系，界面也不该暗示有。
 */
export interface StoryBranchItem extends Omit<StoryBranch, 'memoryBounds'> {
  /** 这条分支有多少条消息（抽屉的时间轴要用） */
  messageCount: number
  /** 这条分支最后一次改动的时间（取 Session.updatedAt） */
  lastActiveAt: number
  /** 是否当前活跃分支 */
  isActive: boolean
}

export const STORY_BRANCHES_FILE = 'branches.json'
/** 2：分支改扁平（parentBranchId → forkedFrom 快照 + memoryBounds 快照）；读到 1 会就地迁移 */
export const STORY_BRANCHES_VERSION = 2
/** 分支名的回落前缀：第 N 条 = 「分支 N」 */
export const STORY_BRANCH_TITLE_PREFIX = '分支 '

/** 派生草稿 */
export interface StoryDeriveDraft {
  storyId: string
  /** 从哪条会话分出去（必须是本区的分支） */
  fromSessionId: string
  /** 从哪条消息**之后**分出去；必须属于 fromSessionId */
  fromMessageId: string
  /** 新分支名；空 = 自动「分支 N」 */
  title?: string
}

/* ───────────────────────── P7 · 检索与设置（M16 / M18） ───────────────────────── */

/** P7：全文检索的一条命中（范围 = 当前故事区，跨分支；见 M16 / BL-22） */
export interface StorySearchHit {
  branchId: string
  branchTitle: string
  messageId: string
  /** 该消息在【它所属分支】消息数组里的下标（0 起） */
  messageIndex: number
  role: 'user' | 'assistant' | 'narration'
  /** 命中片段（已截断，约 120 字符内含查询词） */
  snippet: string
  isActiveBranch: boolean
}

/** P7：设置·故事面板对 StoryMeta 的可改字段（全部可选；worldbookDir 传 null = 清除） */
export interface StoryMetaPatch {
  title?: string
  synopsis?: string
  characterId?: string
  worldbookDir?: string | null
  worldbookMode?: StoryWorldbookMode
  /** P8：背景与剧本设定；传空串 = 清除 */
  background?: string | null
}