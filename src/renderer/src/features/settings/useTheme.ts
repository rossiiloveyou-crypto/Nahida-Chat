import { useCallback, useEffect, useState } from 'react'
import type { ThemeMode } from '@shared/types'
import { useSettings } from './useSettings'

/** 把 mode 解析成真正要落到 DOM 上的 'light' | 'dark' */
function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply(theme: 'light' | 'dark'): void {
  const root = document.documentElement
  if (theme === 'dark') root.dataset.theme = 'dark'
  else delete root.dataset.theme // 浅色 = 没有属性，与 tokens.css 的 :root 对齐
}

/**
 * 主题状态：当前偏好模式 + 实际生效的明暗 + 切换方法。
 *
 * 落 DOM 与存盘是两条独立路径，且**先落 DOM 再存盘**：保存是异步的，
 * 等它回来再变色会有肉眼可见的延迟。
 */
export function useTheme(): {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  setMode: (next: ThemeMode) => void
} {
  const { settings, save } = useSettings()
  // 首次渲染时 settings 可能还没回来：用 preload 注入的同步值兜底，
  // 否则会先把已经正确的深色 DOM 属性错误地抹成浅色。
  const mode: ThemeMode =
    settings?.appearance?.theme ?? (window.nahida?.initialTheme === 'dark' ? 'dark' : 'light')
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolve(mode))

  // mode 变了就重算并落 DOM
  useEffect(() => {
    const next = resolve(mode)
    setResolved(next)
    apply(next)
  }, [mode])

  // system 模式下监听系统切换（只在 Windows/macOS 有意义）
  useEffect(() => {
    if (mode !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      const next = media.matches ? 'dark' : 'light'
      setResolved(next)
      apply(next)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [mode])

  const setMode = useCallback(
    (next: ThemeMode) => {
      // 先落 DOM 再存盘：保存是异步的，等它回来再变色会有肉眼可见的延迟
      const nextResolved = resolve(next)
      setResolved(nextResolved)
      apply(nextResolved)
      void save({ appearance: { theme: next } })
    },
    [save]
  )

  return { mode, resolved, setMode }
}
