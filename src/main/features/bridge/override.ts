/** 用户自定义的 ST 最高权重规则：空文件为默认，每轮读取，不缓存正文。 */
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BridgeOverrideState } from '@shared/bridge'

const MAX_CHARACTERS = 8000

/** 首次创建空文件；排他创建保证已有正文（含外部编辑）原样保留。 */
export function ensureOverrideFile(userData = app.getPath('userData')): string {
  const directory = join(userData, 'nc-bridge')
  const file = join(directory, 'st-override.md')
  mkdirSync(directory, { recursive: true })
  try {
    writeFileSync(file, '', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return file
}

function stateOf(text: string): BridgeOverrideState {
  const truncated = text.length > MAX_CHARACTERS
  const bounded = text.slice(0, MAX_CHARACTERS)
  return {
    text: bounded,
    active: bounded.trim().length > 0,
    truncated,
    warning: truncated ? '最高权重规则超过 8000 字符，已截断至前 8000 字符。' : null
  }
}

/** 每次读盘都限长；仅限制返回内容，不静默改写用户的原文件。 */
export function getOverride(userData = app.getPath('userData')): BridgeOverrideState {
  return stateOf(readFileSync(ensureOverrideFile(userData), 'utf8'))
}

/** IPC 输入先校验；仅用户明确保存时将限长后的文本写入文件。 */
export function saveOverride(text: unknown, userData = app.getPath('userData')): BridgeOverrideState {
  if (typeof text !== 'string') throw new TypeError('最高权重规则须为文本。')
  const state = stateOf(text)
  writeFileSync(ensureOverrideFile(userData), state.text, 'utf8')
  return state
}
