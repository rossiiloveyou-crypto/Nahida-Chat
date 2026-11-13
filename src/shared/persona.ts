/**
 * 人设（persona）纯契约。主进程 / preload / 渲染层共用。
 *
 * 🔴 本文件零运行时依赖：只 export 类型、常量与纯函数。
 *    不允许 import `node:*` / `electron`（三端共用，渲染层跑不了）。
 */

/** 人设名：1–32 字符，允许中文 / 字母 / 数字 / 下划线 / 连字符，不含空白与路径分隔符 */
export const PERSONA_NAME_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,32}$/

export const DEFAULT_PERSONA_ID = 'default'

/** 桌面端虚拟用户：没有 QQ 号，但仍拥有一套完整的人设与记忆 */
export const ROOT_USER_ID = 'root'

export type CommandPermissionLevel = 'none' | 'low' | 'medium' | 'high'

export const COMMAND_LEVEL_WEIGHT: Record<CommandPermissionLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3
}

export interface UserPersonaRow {
  userId: string
  personaId: string
  isActive: boolean
  createdAt: number
}

/** 一次「用户 × 人设」的身份锚定结果。缺一不可：没有它就不写记忆、不写历史 */
export interface PersonaIdentity {
  userId: string
  personaId: string
}

export function isValidPersonaId(value: unknown): value is string {
  return typeof value === 'string' && PERSONA_NAME_PATTERN.test(value)
}

/** 人设名的规范化：去首尾空白；不做大小写折叠（中文无大小写，英文大小写视为不同人设） */
export function normalizePersonaId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return isValidPersonaId(trimmed) ? trimmed : null
}

export function levelAtLeast(
  actual: CommandPermissionLevel,
  required: CommandPermissionLevel
): boolean {
  return COMMAND_LEVEL_WEIGHT[actual] >= COMMAND_LEVEL_WEIGHT[required]
}

/* ── P4：指令契约（纯类型 + 纯函数，零运行时依赖） ─────────────────────── */

/** P4：可用指令。**新增指令 = 同时改这里、COMMAND_DEFAULT_THRESHOLDS、指令实现、测试**（B2） */
export type CommandName = 'list' | 'switch' | 'add' | 'dele'

/** 全部指令名（顺序即面板上的顺序）。新增指令时**只改上面那一行**，这里自动跟上 */
export const COMMAND_NAMES: readonly CommandName[] = ['list', 'switch', 'add', 'dele']

/**
 * 每条指令的**默认门槛**（D6：门槛可配，这里是出厂值）。
 *
 * 取值理由（写死在代码里，便于后人质疑时能追）：
 *  - `list`：**low** —— 只读，看得见「我有哪些人设」不构成风险，但要挡掉 `none`
 *  - `switch`：**low** —— 只改自己的激活项，不删数据
 *  - `add`：**medium** —— 会写 `user_personas`（新行），但仍不删
 *  - `dele`：**high** —— 会删人设，不可逆
 */
export const COMMAND_DEFAULT_THRESHOLDS: Record<CommandName, CommandPermissionLevel> = {
  list: 'low',
  switch: 'low',
  add: 'medium',
  dele: 'high'
}

/** 用户可改的每指令门槛。缺字段 = 用 COMMAND_DEFAULT_THRESHOLDS 的出厂值 */
export type CommandThresholds = Partial<Record<CommandName, CommandPermissionLevel>>

/** 归一化：非法值 / 缺字段一律回落出厂值；**不抛**（一个坏配置不该让 QQ 功能瘫痪） */
export function normalizeThresholds(value: unknown): Record<CommandName, CommandPermissionLevel> {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const out: Record<CommandName, CommandPermissionLevel> = { ...COMMAND_DEFAULT_THRESHOLDS }
  for (const name of COMMAND_NAMES) {
    const candidate = raw[name]
    if (candidate === 'none' || candidate === 'low' || candidate === 'medium' || candidate === 'high') {
      out[name] = candidate
    }
  }
  return out
}

/** 账号没设置等级时的默认等级：**low**（能 list / switch，不能 add / dele） */
export const DEFAULT_ACCOUNT_LEVEL: CommandPermissionLevel = 'low'

/** 把任意值收敛成合法等级；非法 → DEFAULT_ACCOUNT_LEVEL */
export function normalizeLevel(value: unknown): CommandPermissionLevel {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high'
    ? value
    : DEFAULT_ACCOUNT_LEVEL
}

/**
 * 这个人能不能用这条指令。
 *
 * 🔴 纯函数、零依赖：只吃 `level` 与 `thresholds`，不读盘、不碰 store。
 *    这样它能被 `test:command-level` 直接在内存里单测（与 resolveMessageAccess 同规格）。
 */
export function canUseCommand(
  level: CommandPermissionLevel,
  name: CommandName,
  thresholds: Record<CommandName, CommandPermissionLevel>
): boolean {
  return levelAtLeast(level, thresholds[name])
}

/** 指令前缀。**不做全角兼容**（变两个前缀 = B2 的第二载体） */
export const COMMAND_PREFIX = '//'

export interface ParsedCommand {
  name: CommandName
  /** 逗号 / 空白分隔的参数，已 trim、已去空串 */
  args: string[]
  /** 原始整行（写进旁听 detail / 日志用） */
  raw: string
}

export type ParseCommandResult =
  | { known: true; command: ParsedCommand }
  | { known: false; name: string }
  | null

/**
 * 去掉**行首的 @ 提及**。
 *
 * 🔴 这不是「第二种指令前缀」，而是传输层塞进来的一层东西：
 *    `inbound.ts` 的 `textFromSegments` 把 `at` 段渲染成 `@<qq>`，
 *    而群聊必须先 @ 她才能过闸（M11）。用户打的是「@机器人 //list」，
 *    拼出来的 `inbound.text` 是 `@10001//list` —— 不剥掉就永远解析不出指令，
 *    功能在群里 100% 不工作，而任何只测私聊的用例都不会变红。
 *
 * 只剥**行首连续的** `@非空白`，命令前缀仍然是唯一的 `//`。
 */
function stripLeadingMentions(text: string): string {
  let rest = text
  for (;;) {
    // 只认 **QQ 号** 或 **全体成员** 这两种 @ 渲染结果（`inbound.ts` 的 textFromSegments
    // 就是这么拼的，且**不带分隔符**：『@10001//list』）。不能宽到 `@[^\s]+` ——
    // 那会把 `@10001//list` 整行吃掉，指令反而永远解析不出来。
    const hit = /^@(\d+|全体成员)\s*/.exec(rest)
    if (!hit) return rest
    rest = rest.slice(hit[0].length)
  }
}

/**
 * 解析一条指令。
 *
 * 🔴 返回 `null` 有三种情况，**调用方必须区分**：
 *    ① 不是指令（不以 `//` 开头）→ 正常消息，照旧进模型
 *    ② 是指令但名字不认识 → 要回「未知指令」
 *    ③ 是指令但没给名字（只有 `//`）→ 同上，按未知处理
 *    所以本函数把 ② ③ 也返回出来（`{ known: false }`），**不要**用 null 表达「不认识」。
 */
export function parseCommand(text: string): ParseCommandResult {
  const raw = stripLeadingMentions(typeof text === 'string' ? text.trim() : '')
  if (!raw.startsWith(COMMAND_PREFIX)) return null
  const body = raw.slice(COMMAND_PREFIX.length).trim()
  if (!body) return { known: false, name: '' }
  const pieces = body.split(/\s+/)
  const name = pieces[0].toLowerCase()
  const args = pieces
    .slice(1)
    .flatMap((part) => part.split(/[,，]/))
    .map((item) => item.trim())
    .filter(Boolean)
  if (!(COMMAND_NAMES as readonly string[]).includes(name)) {
    return { known: false, name }
  }
  return { known: true, command: { name: name as CommandName, args, raw } }
}
