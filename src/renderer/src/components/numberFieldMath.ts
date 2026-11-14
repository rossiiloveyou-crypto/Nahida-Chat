/**
 * 数字输入框的取值换算（纯函数：不 import React，能被 node 测试直接跑）。
 *
 * 存在的理由：设置页的数字框以前是「一边打字一边 onCommit」，
 * 于是每敲一个键都会被主进程归一化一次，值被钳到下限、光标被拽走，
 * 想把 12 改成 100 变成 1 → 10 → 100，中间两次都被改成下限。
 * 现在把「读草稿」和「钳成合法值」拆成两个纯函数，
 * 组件只在**失焦 / 回车**时调用一次 clampNumber。
 */

/** 把输入框里的字符串读成数字；空串 / 不是有限数 → null（调用方决定回退） */
export function parseNumberDraft(raw: string | null | undefined): number | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/**
 * 提交时把草稿钳成合法值。
 *
 * - 空 / 非法（'1e'、'-'、'abc'）→ 回退到 fallback（= 原来的值），不把 0 写进去；
 * - 小于 min → min；大于 max → max；
 * - min/max 不是有限数时视为「这一侧没有边界」。
 *
 * 🔴 只在提交时调，**不要**放进 onChange：那正是「打不进第二个字符」的老毛病。
 */
export function clampNumber(
  raw: string | null | undefined,
  min: number | undefined,
  max: number | undefined,
  fallback: number
): number {
  const parsed = parseNumberDraft(raw)
  if (parsed === null) return fallback
  let next = parsed
  if (typeof min === 'number' && Number.isFinite(min) && next < min) next = min
  if (typeof max === 'number' && Number.isFinite(max) && next > max) next = max
  return next
}

/** 数字 → 输入框里的文本；非有限数回退到空串（不显示 NaN） */
export function formatNumberDraft(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}