import { useEffect, useRef, useState } from 'react'
import type { Message } from '@shared/types'

/**
 * 模型思考过程 —— DeepSeek 网页那种「先想再答」的折叠块。
 *
 * 行为（照抄 DeepSeek 的观感，但状态机是自己写的）：
 * - 思考中且还没开始回答 → **展开**，正文逐字追加，末尾带闪烁光标；
 * - 正文一开始出现 → **自动收起**，只在气泡上方留一行「已思考 · N 字」；
 * - 用户手动点开/收起过之后，就再也不自动收 —— 否则读一半被收走很恼人。
 *
 * 只在 assistant 消息上出现，且必须真的有过思考（`message.reasoning` 非空）。
 * 演示模式也会产生思考文本（明写「这是演示」），所以首装即能看到这个块。
 */
export function ReasoningBlock({ message, uiLabel }: { message: Message; uiLabel: string }) {
  const text = message.reasoning ?? ''
  const streaming = message.status === 'streaming'
  // 「已经在回答」= 正文有内容了。工具调用不算回答，所以不看 toolCalls。
  const answering = message.content.trim().length > 0

  // 初值即「思考中且未开始回答」：挂载时就在思考 → 展开
  const [open, setOpen] = useState(streaming && !answering)
  // 用户是否亲手点过。点过之后不再自动收起（见上）
  const touched = useRef(false)

  useEffect(() => {
    if (!answering || touched.current) return
    setOpen(false)
  }, [answering])

  if (!text.trim()) return null

  const chars = text.length
  const label = streaming && !answering ? '思考中…' : '已思考 · ' + String(chars) + ' 字'
  const live = streaming && !answering

  return (
    <div className={'reasoning' + (live ? ' reasoning--live' : '')}>
      <button
        type="button"
        className="reasoning__toggle"
        data-ui-target={uiLabel}
        aria-expanded={open}
        onClick={() => {
          touched.current = true
          setOpen((value) => !value)
        }}
      >
        <span className="reasoning__badge">思考</span>
        <span className="reasoning__label">{label}</span>
        <span className="reasoning__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="reasoning__body">
          {text}
          {live && <span className="reasoning__cursor" aria-hidden="true" />}
        </div>
      )}
    </div>
  )
}
