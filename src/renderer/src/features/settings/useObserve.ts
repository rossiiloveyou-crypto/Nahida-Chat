import { useCallback, useEffect, useRef, useState } from 'react'
import type { ObserveConversation, ObserveRecord, ObserveStatus } from '@shared/observe'

/**
 * 旁听库的渲染层状态（P8 G8）。
 *
 * 与 useChannels / useZones 同一套路：只做「拉取 / 重拉 / 取尾部」，
 * 判定与写盘全在主进程（features/observe/store.ts）。
 *
 * 🔴 这里**没有** clear / delete —— 旁听库「只增不清」是硬要求（M21b）。
 *    别为了「面板看起来功能齐」加一个清空按钮，那会直接违背用户裁决。
 */
export interface ObserveState {
  status: ObserveStatus | null
  conversations: ObserveConversation[]
  loading: boolean
  error: string
  /** 打开 observe/ 根目录；返回空串表示成功，非空是系统给的错误串 */
  openDir: () => Promise<string>
  /** 取某会话最近 limit 条 */
  tail: (item: ObserveConversation, limit?: number) => Promise<ObserveRecord[]>
  refresh: () => Promise<void>
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useObserve(): ObserveState {
  const [status, setStatus] = useState<ObserveStatus | null>(null)
  const [conversations, setConversations] = useState<ObserveConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextStatus, rows] = await Promise.all([
        window.nahida.observe.status(),
        window.nahida.observe.conversations()
      ])
      if (!alive.current) return
      setStatus(nextStatus)
      setConversations(rows)
      setError('')
    } catch (cause) {
      if (alive.current) setError(messageOf(cause))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  const openDir = useCallback(async (): Promise<string> => {
    try {
      return await window.nahida.observe.openDir()
    } catch (cause) {
      const message = messageOf(cause)
      if (alive.current) setError(message)
      return message
    }
  }, [])

  const tail = useCallback(
    async (item: ObserveConversation, limit = 50): Promise<ObserveRecord[]> => {
      try {
        return await window.nahida.observe.tail({
          uin: item.uin,
          chatType: item.chatType,
          chatId: item.chatId,
          limit
        })
      } catch (cause) {
        if (alive.current) setError(messageOf(cause))
        return []
      }
    },
    []
  )

  return { status, conversations, loading, error, openDir, tail, refresh }
}
