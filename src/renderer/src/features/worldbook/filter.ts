/**
 * 世界书条目的搜索过滤（纯函数，零 React / 零 IO）。
 *
 * 用户 2026-11-08 要求：编辑器里可按「标题」或「触发词」搜索条目。
 * 这里只做归一化后的子串匹配；不改排序、不改原数组、不写盘。
 */
export interface WorldbookSearchable {
  title: string
  keywords: string[]
}

export function filterWorldbookEntries<T extends WorldbookSearchable>(entries: readonly T[], query: string): T[] {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!needle) return entries.slice()
  return entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(needle) ||
      entry.keywords.some((keyword) => keyword.toLowerCase().includes(needle))
  )
}
