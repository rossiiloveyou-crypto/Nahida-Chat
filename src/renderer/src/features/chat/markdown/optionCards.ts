/** Q3.5: only the measured options/option format, never arbitrary HTML. */
export const BUILTIN_FOLDS: Record<string, string> = {
  summary: '剧情小总结', comment: '小猫留言'
}

export function parseOptionCard(source: string): { items: string[]; consumed: boolean } {
  const block = /^<options\s*>([\s\S]*?)<\/options>$/i.exec(source.trim())
  if (!block) return { items: [], consumed: false }
  const items: string[] = []
  let cursor = 0
  for (const match of block[1].matchAll(/<option\s*>([\s\S]*?)<\/option>/gi)) {
    // A missing close, nested option, or stray content invalidates the whole block.
    if (block[1].slice(cursor, match.index).trim() || /<\/?options?\b/i.test(match[1])) return { items: [], consumed: false }
    const text = match[1].replace(/<[^>]*>/g, '').trim()
    if (!text) return { items: [], consumed: false }
    items.push(text)
    cursor = match.index! + match[0].length
  }
  const consumed = items.length > 0 && !block[1].slice(cursor).trim()
  return { items: consumed ? items : [], consumed }
}
