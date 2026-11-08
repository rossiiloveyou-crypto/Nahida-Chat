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

/* ───────────────────────── P6 · 分支树（M08 / M13） ───────────────────────── */

/**
 * 一个分支节点（P6 / M08 / M13）。落盘在 userData/stories/<storyId>/branches.json。
 *
 * 🔴 一条分支**就是一条会话**（M13）：branchId = 该会话的 Session.id。
 *    分支不是「会话的另一种形态」，它没有独立的消息存储。
 */
export interface StoryBranch {
  /** 分支 id = 该分支**会话**的 Session.id（一条分支就是一条会话，M13） */
  branchId: string
  /** 从哪条分支分出来的；null = 这个区的**根分支**（createStory 建的那条） */
  parentBranchId: string | null
  /**
   * 从父分支的**哪条消息**之后分出去的；null = 根分支。
   * 🔴 语义是「这条消息**之后**」——派生出的新分支**包含**该消息本身。
   */
  parentMessageId: string | null
  /**
   * fork 点在父分支 messages 里的下标（P6 实现补充，只做加法）。
   * 用于记忆可见性计算（visibility.ts）：父分支里 sourceMessageIndex <= 它的记忆才进了本分支的前缀。
   * 缺省 / null = 未知来源 → 可见性按 fail-open（对父分支全可见）。
   */
  parentMessageIndex?: number | null
  /** 建这条分支的时间 */
  createdAt: number
  /** 用户可改的分支名；空串 = 用「分支 N」 */
  title: string
}

/** branches.json 的整体形状（带版本，便于将来迁移） */
export interface StoryBranchesFile {
  version: typeof STORY_BRANCHES_VERSION
  /** 这个区的**活跃分支**（用户当前在看哪条）；必须存在于 branches[] 里 */
  activeBranchId: string
  branches: StoryBranch[]
}

/** 给 P7 直接能画的树节点（读时算出来的，**不落盘**） */
export interface StoryBranchNode extends StoryBranch {
  /** 子分支，按 createdAt 升序 */
  children: StoryBranchNode[]
  /** 这条分支有多少条消息（P7 的时间轴要用） */
  messageCount: number
  /** 这条分支最后一次改动的时间（取 Session.updatedAt） */
  lastActiveAt: number
  /** 是否当前活跃分支 */
  isActive: boolean
}

export const STORY_BRANCHES_FILE = 'branches.json'
export const STORY_BRANCHES_VERSION = 1
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
