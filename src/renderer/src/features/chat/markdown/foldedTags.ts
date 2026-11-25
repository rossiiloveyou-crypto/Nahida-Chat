/** 用户标签兜底；代码区、转义标签和未闭合标签保持原样。 */
export function normalizeFoldedTags(input: string | string[]): string[] {
  return [...new Set((Array.isArray(input) ? input : [input]).flatMap(x => x.split(/[,，\r\n]+/))
    .map(x => x.replace(/[<>/]/g, '').trim().toLowerCase())
    .filter(x => /^[a-z][a-z0-9_-]*$/.test(x)))].slice(0, 20)
}
export interface FoldPart { text: string; tag?: string; offset: number }
export function splitFoldedTags(source: string, tags: string[], covered: (raw: string) => boolean = () => false): FoldPart[] {
  const wanted = new Set(tags)
  if (!wanted.size) return [{ text: source, offset: 0 }]
  const masked = maskCode(source)
  const stack: { tag: string; start: number; end: number }[] = []
  const parts: FoldPart[] = []
  let cursor = 0
  for (const m of masked.matchAll(/<(\/?)([a-z][a-z0-9_-]*)\s*>/gi)) {
    const at = m.index!, tag = m[2].toLowerCase()
    if (!wanted.has(tag) || source[at - 1] === '\\') continue
    if (!m[1]) { stack.push({tag, start: at, end: at + m[0].length}); continue }
    const open = stack.at(-1)
    if (!open || open.tag !== tag) continue
    stack.pop()
    if (stack.length) continue
    if (covered(source.slice(open.start, at + m[0].length))) continue
    if (cursor < open.start) parts.push({text: source.slice(cursor, open.start), offset: cursor})
    parts.push({tag, text: source.slice(open.end, at), offset: open.start})
    cursor = at + m[0].length
  }
  if (cursor < source.length) parts.push({text: source.slice(cursor), offset: cursor})
  return parts
}
function maskCode(source: string): string {
  let fence = ''
  return source.split(/(?<=\n)/).map(line => {
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (run && run[1][0] === fence[0] && run[1].length >= fence.length && !line.slice(run[0].length).trim()) fence = ''
      return line.replace(/[^\r\n]/g, ' ')
    }
    if (run) { fence = run[1]; return line.replace(/[^\r\n]/g, ' ') }
    if (/^(?: {4}|\t)/.test(line)) return line.replace(/[^\r\n]/g, ' ')
    return line
  }).join('').replace(/(`+)([\s\S]*?)\1(?!`)/g, m => ' '.repeat(m.length))
    // Existing HTML folds own their summary and body; never split their title out.
    .replace(/<details\b[^>]*>[\s\S]*?<\/details\s*>/gi, m => m.replace(/[^\r\n]/g, ' '))
}

export function preserveFoldedTagLiterals(source: string, tags: string[]): string {
  const visible = maskCode(source)
  return source.replace(/<\/?([a-z][a-z0-9_-]*)\s*>/gi, (raw, tag: string, offset: number) =>
    tags.includes(tag.toLowerCase()) && visible.slice(offset, offset + raw.length) === raw
      ? raw.replace(/</g, "&lt;").replace(/>/g, "&gt;") : raw)
}
