import { useEffect, useRef } from 'react'
import type { Message } from '@shared/types'
import { brandFor } from '../../../assets/nahida'
import { useTheme } from '../../settings/useTheme'
import { bubbleClassOf, bubbleViewOf } from '../bubble'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCalls } from './ToolCalls'

interface MessageListProps {
  messages: Message[]
  /** P7：检索命中的消息 id（滚动到中间 + 高亮，由 ChatPage 2 秒后清除） */
  focusMessageId?: string | null
  /** 这个会话此刻是否在生成（决定哪一条才是「活」的打字气泡） */
  isStreaming?: boolean
  /** 重试最后一条回复（失败/中断/空回复时出现） */
  onRetry?: (messageId: string) => void
  /** 删掉一条消息 */
  onRemove?: (messageId: string) => void
}

/**
 * 消息列。
 *
 * 2026-11-14：助手气泡的形态改由纯函数 `bubbleViewOf` 决定。
 * 原来只有一个 `message.content ? 正文 : 三个点`，于是**失败**的消息也走「三个点」这一支 ——
 * 请求挂了以后气泡就永远在转圈，既没有原因也没有重试键。现在失败/中断/空回复统称 failed，
 * 气泡里写明原因，下面给「重试 / 删除」两个按钮。
 */
export function MessageList({
  messages,
  focusMessageId,
  isStreaming = false,
  onRetry,
  onRemove
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null)
  const tailLength = messages.length > 0 ? messages[messages.length - 1].content.length : 0
  // 头像日夜成对（P9）：和侧栏 brand-mark 用同一枚素材，切主题时一起换
  const brand = brandFor(useTheme().resolved)

  // 检索命中：只滚到命中那条，**不要**同时被下面的自动滚底带走（两个 effect 会打架）
  useEffect(() => {
    if (!focusMessageId) return
    const node = document.querySelector('[data-message-id="' + focusMessageId + '"]')
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusMessageId])

  useEffect(() => {
    if (focusMessageId) return
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, tailLength, focusMessageId])

  return (
    <div className="message-list">
      <div className="message-list__inner">
        {messages.map((message, index) => {
          const isUser = message.role === 'user'
          const isNarration = message.role === 'narration'
          // 头像与气泡都要能被网格覆盖层定位：UI 改动常落在这两处（头像形状/大小、
          // 气泡圆角与内边距），没有 data-ui-target 就没法在图上报坐标。
          const nth = index + 1
          const isTail = index === messages.length - 1
          // 只有「会话在生成 + 是最后一条 + 状态还写着 streaming」才是真的在打字；
          // 其余的 streaming 都是上次没跑完留下的残骸（重启、崩、被杀）。
          const isLive = isStreaming && isTail && message.status === 'streaming'
          const view = bubbleViewOf(message, { isLive, isTail })

          // 旁白是“舞台说明”，不是任何一方的发言：无头像、无气泡，整列居中。
          if (isNarration) {
            return (
              <div
                key={message.id}
                data-message-id={message.id}
                className={'message message--narration' + (focusMessageId === message.id ? ' is-focus' : '')}
              >
                <p className="narration-line" data-ui-target={`旁白 ${nth}`}>
                  <span className="narration-line__label">旁白：</span>
                  {message.content}
                </p>
              </div>
            )
          }

          return (
            <div
              key={message.id}
              data-message-id={message.id}
              className={
                (isUser ? 'message message--user' : 'message message--assistant') +
                (focusMessageId === message.id ? ' is-focus' : '')
              }
            >
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
                {/* 思考过程在气泡**之前**：读的时候要「先想再答」，位置与语义一致 */}
                {!isUser && message.reasoning && (
                  <ReasoningBlock message={message} uiLabel={`思考 ${nth}`} live={isLive} />
                )}
                <div
                  className={isUser ? 'bubble' : bubbleClassOf(view.phase)}
                  data-ui-target={isUser ? `用户气泡 ${nth}` : `AI 气泡 ${nth}`}
                >
                  {view.phase === 'typing' && (
                    <span className="typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {view.phase === 'text' && message.content}
                  {view.phase === 'failed' && (
                    <>
                      {message.content && <span className="bubble__partial">{message.content}</span>}
                      <span className="bubble__note">{view.note}</span>
                    </>
                  )}
                </div>
                {view.phase === 'failed' && (
                  <div className="bubble-actions" data-ui-target={`失败操作 ${nth}`}>
                    {view.canRetry ? (
                      <button
                        type="button"
                        className="bubble-actions__retry"
                        data-ui-target={`重试这一轮 ${nth}`}
                        onClick={() => onRetry?.(message.id)}
                      >
                        重试这一轮
                      </button>
                    ) : (
                      <span className="bubble-actions__hint">后面已经有新消息了，只能重试最后一轮</span>
                    )}
                    <button
                      type="button"
                      className="bubble-actions__remove"
                      data-ui-target={`删除这条 ${nth}`}
                      onClick={() => onRemove?.(message.id)}
                    >
                      删除这条
                    </button>
                  </div>
                )}
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
