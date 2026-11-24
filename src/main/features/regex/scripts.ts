/**
 * 读 ST 的 `regex_scripts`（P2 建，P3 按 J-08 补正 **C-01**）—— **只读，绝不写盘**。
 *
 * 为什么有五个候选源：ST 把脚本存在三处，而且历史上搬过家。2026-11-15 实测
 * `D:/ST/SillyTavern/data/default-user/settings.json`（1.7 MB）的真实结构：
 *
 * | # | 路径 | 语义 | 实测 |
 * |---|---|---|---|
 * | A | `extension_settings.regex` | 全局脚本区；ST 1.13+ 的 `getScriptsByType(GLOBAL)` 读的就是它 | 0 条 |
 * | B | `oai_settings.extensions.regex_scripts` | 预设内嵌（OpenAI 系） | 12 条 |
 * | C | `kai_settings.extensions.regex_scripts` | 预设内嵌（Kobold 系） | 12 条 |
 * | D | `kai_settings.extensions.SPreset.RegexBinding.regexes` | 第三方绑定，同一批 | 12 条 |
 * | E | `extension_settings.regex_scripts` / 顶层 `regex_scripts` | 早期 ST 与手改文件残留 | 无此键 |
 *
 * B / C / D 是**同一批 12 条**（`id` 相同），按 `id` 去重后只剩一份 —— 实测唯一 **12 条**
 * （9 条 `markdownOnly` + 3 条 `promptOnly`）。这正是 A3 判据的来源：
 * 读对路径才拿得到脚本；**不去重会让显示层把同一条脚本跑三遍**（产物被反复套）。
 *
 * 🔴 刻意**不读**「当前选中的预设文件」（`OpenAI Settings/*.json`）：那是「某个预设」的概念，
 *    由桥接层（P4）合并进本轮请求；M9 要求显示层零预设耦合，这里只按**文件里的真实键**读。
 * 🔴 刻意**不读** `regex_presets`（实测 0 条，是另一套「脚本预设包」结构，不是运行清单）。
 *
 * 缓存按 **mtime + size** 失效：ST 改设置时整文件重写，这两项任一变化都会命不中缓存。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { StRegexScript } from '@shared/regex'

interface CachedFile {
  mtimeMs: number
  size: number
  scripts: StRegexScript[]
}

const cache = new Map<string, CachedFile>()

/**
 * ST 数据目录的兜底值。
 *
 * M6 已拍板「ST 服务常开、部署在 `D:\ST\SillyTavern`、端口固定」，
 * 所以这里给一个字面量兜底是**部署事实**，不是预设耦合。
 * 调用方（IPC 的 `stDir` 参数、P4 的桥接设置）一律优先；环境变量 `NAHIDA_ST_DATA_DIR`
 * 只为人手排障留一个不改代码的入口。
 */
export const DEFAULT_ST_DATA_DIR = 'D:\\ST\\SillyTavern\\data\\default-user'

/** 解析「用哪个 ST 数据目录」：入参 → 环境变量 → 部署默认值。空串当没给。 */
export function resolveStDataDir(override?: string): string {
  const given = typeof override === 'string' ? override.trim() : ''
  if (given) return given
  const env = typeof process !== 'undefined' && process.env ? process.env.NAHIDA_ST_DATA_DIR : ''
  if (typeof env === 'string' && env.trim()) return env.trim()
  return DEFAULT_ST_DATA_DIR
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const num = Number(item)
    if (Number.isFinite(num)) out.push(num)
  }
  return out
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** `null` 表示不限；非数字一律当「不限」，不要拿 NaN 去比较。 */
function asDepth(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 把一条来路不明的 JSON 行规整成 `StRegexScript`。
 * 没有 `findRegex` 的行直接丢弃 —— 跑不起来的脚本不是脚本。
 */
export function normalizeScript(input: unknown): StRegexScript | null {
  const row = asRecord(input)
  if (!row) return null
  const findRegex = asString(row.findRegex)
  if (!findRegex) return null

  return {
    id: asString(row.id),
    scriptName: asString(row.scriptName, asString(row.name)),
    disabled: row.disabled === true,
    runOnEdit: row.runOnEdit === true,
    findRegex,
    replaceString: asString(row.replaceString),
    trimStrings: asStrings(row.trimStrings),
    placement: asNumbers(row.placement),
    substituteRegex: Number.isFinite(Number(row.substituteRegex)) ? Number(row.substituteRegex) : 0,
    minDepth: asDepth(row.minDepth),
    maxDepth: asDepth(row.maxDepth),
    markdownOnly: row.markdownOnly === true,
    promptOnly: row.promptOnly === true
  }
}

/** 按真实结构取各个候选源的数组；取不到给 `undefined`（不是空数组 —— 便于区分「没有这个键」）。 */
function sourceList(data: Record<string, unknown>): Array<{ label: string; value: unknown }> {
  const extension = asRecord(data.extension_settings)
  const oai = asRecord(data.oai_settings)
  const kai = asRecord(data.kai_settings)
  const spreset = asRecord(asRecord(kai?.extensions)?.SPreset)

  return [
    // A：全局脚本区（ST 1.13+ 的正式位置）
    { label: 'extension_settings.regex', value: extension?.regex },
    // B：预设内嵌（OpenAI 系）
    { label: 'oai_settings.extensions.regex_scripts', value: asRecord(oai?.extensions)?.regex_scripts },
    // C：预设内嵌（Kobold 系）
    { label: 'kai_settings.extensions.regex_scripts', value: asRecord(kai?.extensions)?.regex_scripts },
    // D：第三方绑定（与 B/C 同批）
    { label: 'kai_settings.extensions.SPreset.RegexBinding.regexes', value: asRecord(spreset?.RegexBinding)?.regexes },
    // E：早期 ST / 手改文件残留
    { label: 'extension_settings.regex_scripts', value: extension?.regex_scripts },
    { label: 'regex_scripts', value: data.regex_scripts }
  ]
}

/**
 * 从一个已解析的 `settings.json` 对象里收集脚本（纯函数，单测直接用）。
 *
 * 去重规则：有 `id` 按 `id`；没有 `id` 的按 `findRegex + '\u0000' + replaceString`。
 * **先到先得** —— A（全局）在最前，所以「全局区与预设内嵌同时存在同一条」时以全局为准。
 */
export function collectScripts(data: unknown): StRegexScript[] {
  const root = asRecord(data)
  if (!root) return []

  const out: StRegexScript[] = []
  const seen = new Set<string>()

  for (const source of sourceList(root)) {
    if (!Array.isArray(source.value)) continue
    for (const item of source.value) {
      const script = normalizeScript(item)
      if (!script) continue
      const key = script.id ? 'id:' + script.id : 'body:' + script.findRegex + '\u0000' + script.replaceString
      if (seen.has(key)) continue
      seen.add(key)
      out.push(script)
    }
  }

  return out
}

/**
 * 读 `<stDir>/settings.json` 里的正则脚本。
 *
 * 文件不存在 / JSON 坏掉 → 返回空数组（显示层因此退化成「不做正则」，不是崩掉）。
 * 🔴 返回的数组与缓存共享元素对象：**调用方只读**，不要去改字段。
 */
export function readScripts(stDir: string): StRegexScript[] {
  const file = join(stDir, 'settings.json')

  let stat
  try {
    stat = statSync(file)
  } catch {
    return []
  }

  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.scripts.slice()
  }

  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 坏 JSON 不写缓存：下次 mtime 变了还要能重试
    return []
  }

  const scripts = collectScripts(data)
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, scripts })
  return scripts.slice()
}

/**
 * 显示层真正要跑的那批：`markdownOnly === true` ∧ 未禁用 ∧ 作用位置含 `AI_OUTPUT(2)`。
 *
 * 这是 S1 的过滤条件，单独导出是给「有没有要跑的脚本」这类判断用的；
 * 引擎自己也会按通道过滤，这里只是让调用方少传无用数据。
 */
export function listMarkdownOnlyScripts(stDir: string): StRegexScript[] {
  return readScripts(stDir).filter(
    (script) => script.markdownOnly === true && script.disabled !== true && script.placement.includes(2)
  )
}

/** 清缓存；不给目录就全清。 */
export function invalidateScriptsCache(stDir?: string): void {
  if (stDir === undefined) {
    cache.clear()
    return
  }
  cache.delete(join(stDir, 'settings.json'))
}

/** 显示层合并：保留全局顺序，同 id 原位以当前预设覆盖；无 id 行不合并。 */
export function mergeDisplayScripts(globalScripts: StRegexScript[], presetScripts: StRegexScript[]): StRegexScript[] {
  const out: StRegexScript[] = []
  const positions = new Map<string, number>()
  for (const script of [...globalScripts, ...presetScripts]) {
    const at = script.id ? positions.get(script.id) : undefined
    if (at !== undefined) out[at] = script
    else {
      if (script.id) positions.set(script.id, out.length)
      out.push(script)
    }
  }
  return out
}
