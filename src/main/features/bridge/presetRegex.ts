/**
 * 当前预设里内嵌的正则脚本（J-08 里点名「由 P4 从当前预设文件合并」的那一半）。
 *
 * 为什么在桥接层而不是显示层（M9 / J-08）：**「当前选中的预设」只有知道 ST 布局的人才认**。
 * 显示层必须零预设耦合（换预设后代码零改动），它只接收 `StRegexScript[]` 入参。
 * `src/main/features/regex/scripts.ts` 读的是 `settings.json` 里的**全局**脚本（C-01 正的那一处），
 * 预设内嵌的那批住在本文件负责的位置。
 *
 * 读盘路径（2026-11-15 实测，ST 1.13 当前安装）：
 *   `<stDir>/settings.json` → `oai_settings.preset_settings_openai` 是预设**名**，
 *   正文在 `<stDir>/OpenAI Settings/<名>.json`，脚本在它的顶层 `regex_scripts`
 *   （`extensions.regex_scripts` 是旧位置，作为兼容源一起读）。
 *
 * 🔴 只读，绝不写（M2）；坏 JSON / 缺文件 → 空数组，绝不抛。
 * 🔴 预设名是**用户数据**：含 `/ ` `\` 或 `..` 的一律拒读（防路径穿越到目录外）。
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { StRegexScript } from '@shared/regex'
import { normalizeScript } from '../regex/scripts'

/** 预设文件所在的子目录（ST 的约定；TextGen / Kobold 预设与桥接无关，不读） */
const PRESET_DIR = 'OpenAI Settings'

interface CachedScripts {
  mtimeMs: number
  size: number
  scripts: StRegexScript[]
}

const cache = new Map<string, CachedScripts>()

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** 预设名合法性：单段文件名，且不含路径分隔符 */
export function isPresetName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed === '.' || trimmed === '..') return false
  if (/[\\/]/.test(trimmed)) return false
  if (trimmed.includes('..')) return false
  return true
}

/** 读 `settings.json` 里的当前 OpenAI 预设名；读不到返回空串 */
export function readCurrentPresetName(stDir: string): string {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(join(stDir, 'settings.json'), 'utf8'))
  } catch {
    return ''
  }
  const oai = asRecord(asRecord(data)?.oai_settings)
  const name = oai?.preset_settings_openai
  return typeof name === 'string' ? name.trim() : ''
}

/** 预设文件里所有带 `findRegex` 的脚本行（顶层 + 旧位置的 `extensions.regex_scripts`） */
function collectScripts(data: unknown): StRegexScript[] {
  const root = asRecord(data)
  if (!root) return []
  const out: StRegexScript[] = []
  const seen = new Set<string>()
  const pushAll = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      const script = normalizeScript(item)
      if (!script) continue
      if (script.id) {
        if (seen.has(script.id)) continue
        seen.add(script.id)
      }
      out.push(script)
    }
  }
  pushAll(root.regex_scripts)
  pushAll(asRecord(root.extensions)?.regex_scripts)
  return out
}

/**
 * 读当前预设内嵌的正则脚本。
 * 任何一步失败（没配预设 / 文件不在 / JSON 坏）都返回空数组 —— 显示层因此退化成
 * 「只跑全局脚本」，不是崩掉。
 */
export function readPresetRegexScripts(stDir: string): StRegexScript[] {
  const name = readCurrentPresetName(stDir)
  if (!isPresetName(name)) return []
  const file = join(stDir, PRESET_DIR, name + '.json')

  let stat
  try {
    stat = statSync(file)
  } catch {
    return []
  }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.scripts.slice()

  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const scripts = collectScripts(data)
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, scripts })
  return scripts.slice()
}

/**
 * 合并两个来源的脚本（全局 + 预设内嵌），按 `id` 去重、**先到先得**。
 *
 * 顺序是刻意的：调用方传 `globalFirst = true`（缺省）时全局在前 —— 与 ST 的
 * `getScriptsByType(GLOBAL)` 合并顺序一致，同名脚本以用户手改过的全局那份为准。
 */
export function mergeRegexScripts(
  globalScripts: StRegexScript[],
  presetScripts: StRegexScript[],
  globalFirst = true
): StRegexScript[] {
  const left = globalFirst ? globalScripts : presetScripts
  const right = globalFirst ? presetScripts : globalScripts
  const out: StRegexScript[] = []
  const seen = new Set<string>()
  for (const script of [...left, ...right]) {
    if (!script) continue
    if (script.id) {
      if (seen.has(script.id)) continue
      seen.add(script.id)
    }
    out.push(script)
  }
  return out
}

/** 清缓存；不给目录就全清（设置页改预设后调用） */
export function invalidatePresetCache(stDir?: string): void {
  if (stDir === undefined) {
    cache.clear()
    return
  }
  cache.clear()
}
