import { useEffect, useRef } from 'react'
import type { Message } from '@shared/types'
import { ToolCalls } from './ToolCalls'

interface MessageListProps {
  messages: Message[]
}

export function MessageList({ messages }: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null)
  const tailLength = messages.length > 0 ? messages[messages.length - 1].content.length : 0

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, tailLength])

  return (
    <div className="message-list">
      <div className="message-list__inner">
        {messages.map((message) => {
          const isUser = message.role === 'user'
          return (
            <div key={message.id} className={isUser ? 'message message--user' : 'message message--assistant'}>
              <div className={isUser ? 'avatar avatar--user' : 'avatar avatar--assistant'}>{isUser ? '我' : '纳'}</div>
              <div className="message__column">
                <div className={message.status === 'error' ? 'bubble bubble--error' : 'bubble'}>
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
