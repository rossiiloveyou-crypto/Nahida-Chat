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
