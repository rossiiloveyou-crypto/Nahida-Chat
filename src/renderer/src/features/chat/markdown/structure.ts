import type { StRegexScript } from '@shared/regex'
import { REGEX_PLACEMENT } from '@shared/regex'
import { getRegexedString, HOST_FALLBACK_DEBUG } from '@shared/regexEngine'

export interface CardData {
  kind: 'card'
  tag: string
  text: string
  raw: string
  offset: number
}
export interface TextData {
  kind: 'text'
  text: string
  offset: number
}
export type StructureToken = CardData | TextData

/** Mask code without changing offsets. An unfinished fence remains code through EOF. */
function maskCode(source: string): string {
  let fence = ''
  return source.split(/(?<=\n)/).map(line => {
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const out = line.replace(/[^\r\n]/g, ' ')
      if (run && run[1][0] === fence[0] && run[1].length >= fence.length && !line.slice(run[0].length).trim()) fence = ''
      return out
    }
    if (run) {
      fence = run[1]
      return line.replace(/[^\r\n]/g, ' ')
    }
    if (/^(?: {4}|\t)/.test(line)) return line.replace(/[^\r\n]/g, ' ')
    return line
  }).join('').replace(/(`+)([\s\S]*?)\1(?!`)/g, m => ' '.repeat(m.length))
}

/** M9 stays in the shared engine. Only a real host-fallback event admits a card.
 * No preset names or replacement HTML are interpreted here; original text is retained.
 */
export function structureOf(source: string, scripts: StRegexScript[] = [], depth?: number): StructureToken[] {
  if (!source) return []
  const visible = maskCode(source)
  // Custom structured tags only; ordinary HTML keeps the existing markdown path.
  const tags = /<(\/?)([a-z][a-z0-9]*[_-][a-z0-9_-]+)\s*>/gi
  const stack: { tag: string; start: number; end: number }[] = []
  const cards: CardData[] = []
  for (const match of visible.matchAll(tags)) {
    const tag = match[2].toLowerCase()
    const start = match.index!
    if (!match[1]) { stack.push({ tag, start, end: start + match[0].length }); continue }
    const opening = stack.at(-1)
    if (!opening || opening.tag !== tag) continue
    stack.pop()
    if (stack.length) continue
    const end = start + match[0].length
    const raw = source.slice(opening.start, end)
    let hostFallback = false
    getRegexedString(raw, REGEX_PLACEMENT.AI_OUTPUT, {
      scripts, isMarkdown: true, depth,
      // 🔴 与引擎共用同一个常量（`HOST_FALLBACK_DEBUG`）：卡片的存在依赖这次匹配，
      //    两边各写一份字面量的话，改一个措辞就会静默退化成裸标签。
      onDebug: message => { if (message.includes(HOST_FALLBACK_DEBUG)) hostFallback = true }
    })
    if (hostFallback) cards.push({ kind: 'card', tag, text: source.slice(opening.end, start), raw, offset: opening.start })
  }
  const result: StructureToken[] = []
  let cursor = 0
  for (const card of cards) {
    if (cursor < card.offset) result.push({ kind: 'text', text: source.slice(cursor, card.offset), offset: cursor })
    result.push(card)
    cursor = card.offset + card.raw.length
  }
  if (cursor < source.length) result.push({ kind: 'text', text: source.slice(cursor), offset: cursor })
  return result
}
