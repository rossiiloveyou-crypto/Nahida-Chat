/**
 * ST 正则引擎（P2；P3 从 `main/features/regex/engine.ts` 迁到 `shared/`）——`engine.js` 的等价实现。
 *
 * 🔴 位置说明：显示层要在**渲染进程**里跑正则，而渲染进程不能 import `main/`（AGENTS.md 分层铁律）。
 *    本文件是纯函数，天然属于 `shared/`；main 侧的读盘层（`main/features/regex/scripts.ts`）从这里取引擎。
 *
 * 🔴 本文件是**纯函数**：不 import electron、不读盘、不碰全局状态（除一个自带上限的正则编译缓存）。
 *    理由是 P3 的显示层要在渲染进程里调它，而渲染进程没有 fs。
 *
 * 语义对齐 ST `public/scripts/extensions/regex/engine.js`，逐条：
 *   S1 通道过滤：markdownOnly 只走 markdown 通道、promptOnly 只走 prompt 通道、
 *      两者皆否的脚本**只在非 markdown 且非 prompt** 时跑（与 ST 的 else-if 链一致）
 *   S2 深度：depth 为数字时才过滤；minDepth >= -1 且 depth < minDepth → 跳过；
 *      maxDepth >= 0 且 depth > maxDepth → 跳过
 *   S3 按数组顺序串行，前一条的产物是后一条的输入
 *   S4 findRegex 是斜杠包裹的字符串 → 解析成 RegExp
 *   S5 replaceString 里的 `{{match}}` 先变成 `$0`
 *   S6 支持 `$1..$n` 与 `$<name>`
 *   S7 捕获组先过 trimStrings（逐个删除子串）
 *   S8 替换产物过宏展开；整段结束时再过一次
 *
 * M9 降级：一条脚本的产物若含 HTML 宿主标记（`<!doctype` / `<html` / `<iframe` / `<script` / `<style`），
 * **该条不生效**、文本回落到这条脚本执行前的样子，并记一条 debug。判据只看产物形态，不看脚本名。
 */
import { SUBSTITUTE_FIND_REGEX } from './regex'
import type { RegexRunOptions, StRegexScript } from './regex'

/** 产物里出现这些标记，就认定它想当 HTML/iframe 宿主（M9：只看形态）。 */
const HTML_HOST_MARKERS = ['<!doctype', '<html', '<iframe', '<script', '<style'] as const

/**
 * M9 降级时写进 debug 的固定前缀。
 * 🔴 必须是导出常量：显示层（`markdown/structure.ts`）靠**匹配这句前缀**来判定
 *    「这条脚本确实被 M9 拦下了」，据此决定要不要把标签降级成卡片。
 *    两边各写一份字面量 = 谁改一下措辞，卡片就静默消失、裸标签回来（不报错）。
 *    `chat-display-cards` 有一条判据钉住「结构层不许出现这段字面量」。
 */
export const HOST_FALLBACK_DEBUG = '输出含 HTML 宿主标记'

/** 正则编译缓存的上限：与 ST 的 RegexProvider 同量级，够用且封顶。 */
const REGEX_CACHE_MAX = 1000
const regexCache = new Map<string, RegExp | null>()

/** 判定「这条产物是不是想当 HTML 宿主」，返回命中的标记（没命中返回 null）。 */
export function htmlHostMarker(text: string): string | null {
  if (!text) return null
  const lower = text.toLowerCase()
  for (const marker of HTML_HOST_MARKERS) {
    if (lower.includes(marker)) return marker
  }
  return null
}

function lastUnescapedSlash(input: string): number {
  for (let i = input.length - 1; i > 0; i -= 1) {
    if (input[i] !== '/') continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && input[j] === '\\'; j -= 1) backslashes += 1
    // 偶数个反斜杠 → 这个斜杠不是被转义的
    if (backslashes % 2 === 0) return i
  }
  return -1
}

/**
 * S4：把 `/body/flags` 解析成 RegExp；不是斜杠包裹就整串当 pattern。
 * 解析不出来返回 `null`（等价于 ST 的 `regexFromString` 返回空，脚本被跳过）。
 */
export function parseFindRegex(input: string): RegExp | null {
  const text = typeof input === 'string' ? input : ''
  if (!text) return null
  if (text.startsWith('/')) {
    const end = lastUnescapedSlash(text)
    if (end > 0) {
      const body = text.slice(1, end)
      const flags = text.slice(end + 1).replace(/[^dgimsuvy]/g, '')
      try {
        return new RegExp(body, flags)
      } catch {
        return null
      }
    }
  }
  try {
    return new RegExp(text)
  } catch {
    return null
  }
}

/** 带缓存的编译。缓存命中也要把 lastIndex 归零，否则 `/g` 会从上一次的位置继续。 */
export function compileFindRegex(input: string): RegExp | null {
  const key = typeof input === 'string' ? input : ''
  if (regexCache.has(key)) {
    const hit = regexCache.get(key) ?? null
    if (hit) resetLastIndex(hit)
    return hit
  }
  const built = parseFindRegex(key)
  if (regexCache.size >= REGEX_CACHE_MAX) {
    const oldest = regexCache.keys().next().value
    if (oldest !== undefined) regexCache.delete(oldest)
  }
  regexCache.set(key, built)
  if (built) resetLastIndex(built)
  return built
}

function resetLastIndex(regex: RegExp): void {
  if (regex.global || regex.sticky) regex.lastIndex = 0
}

/** 清空编译缓存（测试用；也留给「用户改完脚本」这类场景）。 */
export function clearRegexCache(): void {
  regexCache.clear()
}

function report(options: RegexRunOptions, message: string): void {
  if (options.onDebug) {
    options.onDebug(message)
    return
  }
  console.debug(message)
}

/** 宏展开：先查 `macros` 表，再交给调用方的 `macroExpand`。 */
function expandMacros(text: string, options: RegexRunOptions): string {
  let out = text
  const table = options.macros
  if (table) {
    out = out.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (whole, name: string) => {
      const value = table[name]
      return value === undefined ? whole : String(value)
    })
  }
  if (options.macroExpand) out = options.macroExpand(out)
  return out
}

/** S7：逐个删掉 trimStrings 里的子串；trimString 自己也可以含宏。 */
export function applyTrimStrings(value: string, trimStrings: string[] | undefined, options: RegexRunOptions = {}): string {
  let out = value
  for (const raw of trimStrings ?? []) {
    const token = expandMacros(String(raw ?? ''), options)
    // 空 token 用 split/join 会把它插进每个字符之间 —— 与 ST 的 replaceAll('' , '') 行为一致地「什么都不做」
    if (!token) continue
    out = out.split(token).join('')
  }
  return out
}

/** ST 的 `sanitizeRegexMacro`：把宏值转成可以被当成字面量塞进正则的写法。 */
function sanitizeRegexMacro(value: string): string {
  return value.replace(/[\n\r\t\v\f\0.^$*+?{}\[\]\\/|()]/g, (char) => {
    switch (char) {
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
      case '\v':
        return '\\v'
      case '\f':
        return '\\f'
      case '\0':
        return '\\0'
      default:
        return '\\' + char
    }
  })
}

/** findRegex 在编译前的样子：按 `substituteRegex` 决定要不要先展开宏。 */
function resolveFindRegex(script: StRegexScript, options: RegexRunOptions): string {
  switch (Number(script.substituteRegex)) {
    case SUBSTITUTE_FIND_REGEX.RAW:
      return expandMacros(script.findRegex, options)
    case SUBSTITUTE_FIND_REGEX.ESCAPED:
      return sanitizeRegexMacro(expandMacros(script.findRegex, options))
    default:
      return script.findRegex
  }
}

/** S2：这条脚本在当前 depth 上是不是该跳过。 */
export function isOutOfDepth(script: StRegexScript, depth: number): boolean {
  const min = script.minDepth
  const max = script.maxDepth
  if (typeof min === 'number' && !Number.isNaN(min) && min >= -1 && depth < min) return true
  if (typeof max === 'number' && !Number.isNaN(max) && max >= 0 && depth > max) return true
  return false
}

/**
 * 跑一条脚本（S4–S8 + M9 降级）。
 * 输入不是字符串、脚本 disabled、findRegex 编译不出来、输入为空 —— 一律原样返回。
 */
export function runRegexScript(script: StRegexScript, raw: string, options: RegexRunOptions = {}): string {
  const rawString = typeof raw === 'string' ? raw : ''
  if (!script || script.disabled || !script.findRegex || !rawString) return rawString

  const findRegex = compileFindRegex(resolveFindRegex(script, options))
  if (!findRegex) return rawString

  const replaced = rawString.replace(findRegex, (...args: unknown[]) => {
    const groups = args[args.length - 1]
    const named = groups && typeof groups === 'object' ? (groups as Record<string, string>) : undefined

    // S5：{{match}} → $0（大小写不敏感，ST 用的是 /gi）
    const template = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0')

    // S6：$1..$n / $<name>；取不到就是空串
    const built = template.replace(/\$(\d+)|\$<([^>]+)>/g, (_whole, index: string | undefined, name: string | undefined) => {
      let value: unknown
      if (index !== undefined) value = args[Number(index)]
      else if (name !== undefined) value = named ? named[name] : undefined

      if (!value) return ''
      // S7：捕获组先过 trimStrings
      return applyTrimStrings(String(value), script.trimStrings, options)
    })

    // S8：替换产物过宏展开
    return expandMacros(built, options)
  })

  // M9：产物若想当 HTML 宿主，这条脚本不生效
  const marker = htmlHostMarker(replaced)
  if (marker) {
    report(options, `跳过正则脚本「${script.scriptName || script.id || '(未命名)'}」：${HOST_FALLBACK_DEBUG} ${marker}`)
    return rawString
  }

  return replaced
}

/**
 * 对一段文本跑整条脚本链（S1–S3）。
 *
 * `placement` 取不到（undefined / null）时**不做任何事**——ST 在这一步直接返回原文。
 */
export function getRegexedString(rawString: string, placement: number, options: RegexRunOptions = {}): string {
  if (typeof rawString !== 'string') return ''
  if (!rawString) return rawString
  if (placement === undefined || placement === null) return rawString

  const scripts = options.scripts ?? []
  const isMarkdown = options.isMarkdown === true
  const isPrompt = options.isPrompt === true
  let finalString = rawString

  for (const script of scripts) {
    if (!script || script.disabled) continue

    const markdownOnly = script.markdownOnly === true
    const promptOnly = script.promptOnly === true

    // S1：通道判定，与 ST 的 else-if 链等价
    const matchesChannel =
      (markdownOnly && isMarkdown) ||
      (promptOnly && isPrompt) ||
      (!markdownOnly && !promptOnly && !isMarkdown && !isPrompt)
    if (!matchesChannel) continue

    if (options.isEdit === true && script.runOnEdit !== true) {
      report(options, `跳过正则脚本「${script.scriptName || script.id || '(未命名)'}」：编辑既有楼层时不重跑（runOnEdit=false）`)
      continue
    }

    // S2：深度过滤，只在给了 depth 时生效
    if (typeof options.depth === 'number' && isOutOfDepth(script, options.depth)) {
      report(options, `跳过正则脚本「${script.scriptName || script.id || '(未命名)'}」：depth ${options.depth} 不在 [${String(script.minDepth)}, ${String(script.maxDepth)}] 内`)
      continue
    }

    if (!Array.isArray(script.placement) || !script.placement.includes(placement)) continue

    // S3：前一条的产物是后一条的输入
    finalString = runRegexScript(script, finalString, options)
  }

  // S8：整段最后再过一次宏
  return expandMacros(finalString, options)
}