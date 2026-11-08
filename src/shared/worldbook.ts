/**
 * 世界书（Worldbook）的纯数据契约（P9）。
 *
 * 与 `shared/story.ts` / `shared/zones.ts` 同规矩：**零 import**，三端都能直接打进去。
 * 解析、序列化、落盘、路径守卫全在 `main/features/worldbook/`。
 *
 * 心智模型（P9 §2.1 / §2.2）：
 *  - **一个世界书 = 一个目录**，目录里每个 `.md` 文件装若干条目；
 *  - 一个条目 = `## 标题` + 六个 `- key: value`（id/触发词/常驻/优先级/内在价值/连带触发词）+ 正文；
 *  - 条目之间用 `---` 分隔；`README.md` 是索引，**不是**条目文件。
 *
 * 🔴 本文件只描述**形状**，不写任何解析逻辑 —— 解析只在 `main/features/worldbook/parse.ts` 一处
 *    （B2：同一语义不许有两处载体，UI 不拼模板）。
 */

/** 新建 / 编辑条目时提交的草稿（没有 id —— id 由编辑器生成） */
export interface WorldbookEntryDraft {
  title: string
  /** 触发词：逗号/顿号分隔的自由文本，解析后是数组 */
  keywords: string[]
  /** 常驻：`- 常驻: 是/否` */
  always: boolean
  /** 优先级 1–10（激活后的排序 tiebreaker） */
  priority: number
  /** 内在价值 0–100（抗遗忘基准） */
  value: number
  /** 连带触发词：本条被命中时顺手激活的其他条目关键词 */
  chained: string[]
  /** 正文 markdown（可含 ### 小标题、**加粗**、> 引用块） */
  body: string
}

/** 从文件里解析出来的一条（带 id 与来源文件） */
export interface WorldbookEntry extends WorldbookEntryDraft {
  id: string
  /** 来源文件（绝对路径；UI 只显示 basename） */
  file: string
  /**
   * 缺 id 但结构合规的段落：**保留并标出来**，编辑时补。
   * 缺省 false（有 id）。
   */
  missingId?: boolean
}

/** 一个 .md 文件解析出来的全部条目 */
export interface WorldbookFile {
  file: string
  entries: WorldbookEntry[]
}

/**
 * 一次列表的结果。
 * `target` 可以是**目录**（聚合目录内全部 .md）或**单个任意名 .md 文件**（用户要求任意文件名可编辑）。
 */
export interface WorldbookListing {
  target: string
  kind: 'dir' | 'file'
  files: WorldbookFile[]
}

/** 「已知世界书」下拉的一项：角色世界书（chat/agent/story 共用）或某故事区的剧本世界书 */
export interface WorldbookDirInfo {
  /** 展示名。角色项形如 `纳西妲 · nahida`（含角色 id，便于定位目录） */
  label: string
  /** 绝对目录 */
  dir: string
  kind: 'character' | 'story'
}

/**
 * 同文件内重复的触发词 —— **仅提示**。
 * 🔴 用户 2026-11-07 明确：「不限制写入，仅作提醒」。所以这个类型只用于 UI 标红，不参与任何拒绝逻辑。
 */
export interface DuplicateKeyword {
  keyword: string
  /** 占用者条目标题（可能多个） */
  owners: string[]
}

/** 索引文件名：`promptStore` 会跳过它，编辑器也不把它当条目文件（P9 §2.1） */
export const WORLDBOOK_INDEX_FILE = 'README.md'

/** 字段取值范围（与 README.md 的字段含义一致） */
export const WORLDBOOK_PRIORITY_MIN = 1
export const WORLDBOOK_PRIORITY_MAX = 10
export const WORLDBOOK_VALUE_MIN = 0
export const WORLDBOOK_VALUE_MAX = 100

/** 缺省值：新增条目时表单的初始值，也是解析缺字段时的回落值 */
export const WORLDBOOK_DEFAULT_PRIORITY = 5
export const WORLDBOOK_DEFAULT_VALUE = 50
