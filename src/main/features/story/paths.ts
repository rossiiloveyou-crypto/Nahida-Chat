import { isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import {
  STORY_BRANCHES_FILE,
  STORY_DB_FILE,
  STORY_ID_PREFIX,
  STORY_META_FILE,
  STORY_PROFILE_FILE,
  STORY_TRASH_DIR
} from '@shared/story'

/**
 * 故事区的路径约定（P4）—— 全仓**唯一**一处拼故事区路径的地方。
 *
 * 布局（M11：每区自包含，删区 = 删一个目录）：
 *   userData/stories/
 *   ├── .trash/<storyId>-<时分秒>/     删区前的自动备份（§4.11；**不在 storyDir 里**，见下）
 *   └── story_<base36 时间戳>_<rand6>/
 *       ├── story.json      元信息（StoryMetaFile）
 *       └── memory.db       这个区**自己的**记忆库（运行时另有 -wal / -shm）
 *
 * 🔴 为什么不做成 Settings 里可配：故事区是**数据**不是**配置**。
 *    可配路径会让「库跑丢了」变成用户可制造的状态，而记忆库丢了无法恢复。
 *    （对比 P3 的 channelWorkspaceDir：那是工具落点，丢了可以重建，所以可配。）
 * 🔴 .trash 必须与 storiesRoot 同级：备份若放在 storyDir/backups/，
 *    删区那一步 rmSync(storyDir) 会把备份一起删 —— 备份与删除对象同生共死（§2.2 / §4.11）。
 */
export function storiesRoot(): string {
  return join(app.getPath('userData'), 'stories')
}

export function storyDir(storyId: string): string {
  return join(storiesRoot(), assertStoryId(storyId))
}

export function storyMetaPath(storyId: string): string {
  return join(storyDir(storyId), STORY_META_FILE)
}

export function storyDbPath(storyId: string): string {
  return join(storyDir(storyId), STORY_DB_FILE)
}

/** branches.json 的路径（与 story.json 并列，M08） */
export function storyBranchesPath(storyId: string): string {
  return join(storyDir(storyId), STORY_BRANCHES_FILE)
}

export function trashRoot(): string {
  return join(storiesRoot(), STORY_TRASH_DIR)
}

/** storyId 只允许本函数产出的形状；不是这个形状一律拒绝（防路径穿越） */
const STORY_ID_PATTERN = /^story_[a-z0-9]+_[0-9a-f]{6}$/

/**
 * 🔴 这是路径穿越的唯一防线：storyId 会直接拼进路径，一个 `../../` 就能让
 *    「删故事区」变成「删 userData 的上一级」。**每个**拼路径的函数都要过一遍。
 */
export function assertStoryId(value: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!STORY_ID_PATTERN.test(id)) throw new Error('非法的故事区 id：' + String(value))
  return id
}

export function isStoryId(value: unknown): value is string {
  return typeof value === 'string' && STORY_ID_PATTERN.test(value)
}

export function newStoryId(now: number = Date.now()): string {
  return STORY_ID_PREFIX + now.toString(36) + '_' + randomBytes(3).toString('hex')
}

/**
 * 把 `StoryMeta.worldbookDir` 解析成**绝对目录**（P5 / T4）。
 *
 * 🔴 相对路径**必须相对 storiesRoot()**，不是进程 cwd（P5 蓝图 §2.10 I2）：
 *    用 cwd 解析时，dev 启动与打包启动会落到两个不同目录，而用户看不出区别。
 * 🔴 绝对路径原样返回；「是不是目录」由调用方判（这里只解析，不触碰磁盘）。
 */
export function resolveWorldbookDir(meta: { worldbookDir?: string }): string | null {
  const raw = typeof meta.worldbookDir === 'string' ? meta.worldbookDir.trim() : ''
  if (!raw) return null
  return isAbsolute(raw) ? resolve(raw) : resolve(storiesRoot(), raw)
}

/**
 * 故事画像文件路径（M17）：`userData/stories/<storyId>/profile.md`
 * 🔴 它是**用户**的画像，不是角色的设定 —— 所以不放 `Prompt/`，也不放 `worldbook/`。
 */
export function storyProfilePath(storyId: string): string {
  return join(storyDir(storyId), STORY_PROFILE_FILE)
}
