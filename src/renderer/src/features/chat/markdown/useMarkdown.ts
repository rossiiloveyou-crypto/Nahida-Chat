/**
 * 气泡 markdown 的两个 hook（P1 建，P3 加 `useDisplay`）。
 *
 * 为什么用 useMemo 而不是 useState + useEffect：
 * 渲染是纯函数，流式时每来一个字 source 就变一次，effect 会多渲染一帧空内容，
 * 表现为气泡「闪一下」。useMemo 在同一次渲染里出结果，没有中间态。
 *
 * 🔴 不做节流 / 防抖：先保证正确，性能按实测决定（PHASE-1 §一 非目标）。
 * 🔴 必须在**组件顶层**调用；不要在条件分支或 map 回调里调（React hooks 顺序错误）。
 */
import { useMemo } from 'react'
import type { StRegexScript } from '@shared/regex'
import { displayOf } from './display'
import { renderMarkdown } from './render'

/** 只做 markdown（不跑 ST 正则）：旁白、思考块这类 NC 自有文本用它。 */
export function useMarkdown(source: string): string {
  return useMemo(() => renderMarkdown(source), [source])
}

/**
 * 显示层（P3）：先跑 ST 的 markdown 通道正则，再渲染。
 *
 * `scripts` 与 `depth` 都是依赖项：脚本清单到达（首帧 `[]` → 真清单）与流式增长都要重算。
 */
export function useDisplay(source: string, scripts: StRegexScript[], depth?: number): string {
  return useMemo(() => displayOf(source, scripts, depth), [source, scripts, depth])
}
