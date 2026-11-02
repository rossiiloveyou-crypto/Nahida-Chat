import { useEffect, useRef } from 'react'
import type { Message } from '@shared/types'
import { brandFor } from '../../../assets/nahida'
import { useTheme } from '../../settings/useTheme'
import { ToolCalls } from './ToolCalls'

interface MessageListProps {
  messages: Message[]
}

export function MessageList({ messages }: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null)
  const tailLength = messages.length > 0 ? messages[messages.length - 1].content.length : 0
  // 头像日夜成对（P9）：和侧栏 brand-mark 用同一枚素材，切主题时一起换
  const brand = brandFor(useTheme().resolved)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, tailLength])

  return (
    <div className="message-list">
      <div className="message-list__inner">
        {messages.map((message, index) => {
          const isUser = message.role === 'user'
          // 头像与气泡都要能被网格覆盖层定位：UI 改动常落在这两处（头像形状/大小、
          // 气泡圆角与内边距），没有 data-ui-target 就没法在图上报坐标。
          const nth = index + 1
          return (
            <div key={message.id} className={isUser ? 'message message--user' : 'message message--assistant'}>
              <div
                className={isUser ? 'avatar avatar--user' : 'avatar avatar--assistant'}
                data-ui-target={isUser ? `用户头像 ${nth}` : `AI 头像 ${nth}`}
              >
                {isUser ? (
                  '我'
                ) : (
                  /*
                   * 纳西妲头像改成素材图（P9）。
                   * 原来这里是一个「纳」字 + 纯色底 —— 28px 下汉字辨识度很差，
                   * 而且和侧栏的品牌头像（已经是图）不是同一个形象，两处对不上。
                   * 素材由 scripts/ui/build-nahida-avatar.py 从立绘裁出，主题切换走 brandFor。
                   * alt="" + aria-hidden：紧邻的气泡已经有发言人语义，头像重复朗读是噪音。
                   */
                  <img className="avatar__image" src={brand.avatar} alt="" aria-hidden="true" />
                )}
              </div>
              <div className="message__column">
                <div
                  className={message.status === 'error' ? 'bubble bubble--error' : 'bubble'}
                  data-ui-target={isUser ? `用户气泡 ${nth}` : `AI 气泡 ${nth}`}
                >
                  {message.content ? (
                    message.content
                  ) : (
                    <span className="typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
                {message.toolCalls && message.toolCalls.length > 0 && <ToolCalls calls={message.toolCalls} />}
              </div>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
    </div>
  )
}
