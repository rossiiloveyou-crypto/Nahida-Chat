import { useEffect, useMemo, useRef, useState } from 'react'
import type { StRegexScript } from '@shared/regex'
import type { Message } from '@shared/types'
import { brandFor } from '../../../assets/nahida'
import { useTheme } from '../../settings/useTheme'
import { bubbleClassOf, bubbleViewOf } from '../bubble'
import { displayPartsOf, displayOf } from '../markdown/display'
import { BubbleCard } from './BubbleCard'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCalls } from './ToolCalls'

/** 稳定引用：避免每次渲染都给子组件一个新数组，把 useMemo 全部打穿。 */
const EMPTY_SCRIPTS: StRegexScript[] = []

type MessageActionKind = 'edit' | 'retry' | 'delete' | 'copy' | 'check'
function MessageActionIcon({ kind }: { kind: MessageActionKind }) {
  const paths: Record<MessageActionKind, string> = {
    edit: 'M14 5l5 5M4 20l4-1 12-12a2.1 2.1 0 0 0-5-3L3 16l-1 5z',
    retry: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6',
    delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    copy: 'M9 9h11v12H9zM15 9V3H3v12h6',
    check: 'M5 12l4 4L19 6'
  }
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>
}

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
  readOnly?: boolean
  onUpdate?: (messageId: string, content: string) => Promise<boolean>
  onResend?: (messageId: string, content: string) => Promise<boolean>
  onEditingChange?: (editing: boolean) => void
  /**
   * ST 的 `regex_scripts` 清单（P3 显示层）。
   *
   * 🔴 由上层**一次性**取（`useDisplayScripts`）再传进来：不许在 map 里每条消息各发一次 IPC。
   * 缺省 `[]` = 只做 markdown（P1 行为），接口保持向后兼容。
   */
  displayScripts?: StRegexScript[]
}

/**
 * 气泡正文的 markdown 宿主（P1）。
 *
 * 为什么单独成一个组件，而不是在下面的 messages.map 里直接调 `useDisplay`：
 * hook 只能写在组件顶层 —— 写在 map 回调里会触发 React 的「hooks 顺序」错误。
 * 单独成组件还顺带拿到缓存收益：content 没变的消息不会重新解析一遍。
 *
 * P3：正文从「纯 markdown」升级成「ST 正则（markdown 通道）→ markdown」，
 * 两个入参都来自上层（脚本清单一次性取、depth 按 ST 口径算好），本组件不自己取数据。
 *
 * 类名 `bubble__md` 是**对外契约**：P3 的显示层（正则 + HTML 降级）也走这个容器，
 * 改名前先看 PHASE-1 §十 的交接提示。
 */
function BubbleMarkdown({
  source,
  scripts,
  depth
}: {
  source: string
  scripts: StRegexScript[]
  depth?: number
}) {
  // P7: structured cards only when bridge scripts are supplied; ordinary chat keeps P3 rendering.
  const parts = useMemo(() => scripts.length ? displayPartsOf(source, scripts, depth)
    : [{ kind: 'text' as const, offset: 0, html: displayOf(source, scripts, depth, undefined, true) }], [source, scripts, depth])
  if (!parts.length) return null
  return <div className="bubble__md">{parts.map(part => part.kind === 'card'
    ? <BubbleCard key={part.offset} card={part} />
    : <div key={part.offset} dangerouslySetInnerHTML={{ __html: part.html }} />)}</div>
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
  onRemove,
  readOnly = false,
  onUpdate,
  onResend,
  onEditingChange,
  displayScripts = EMPTY_SCRIPTS
}: MessageListProps) {
  /**
   * depth 与 ST **同口径**：非 system 消息总数 − 该条在其中的下标 − 1（最后一条 = 0）。
   * 不一致的后果很具体：带 `maxDepth` 的脚本（例如「只对最近几楼生效」）在两边表现不同，
   * 同一条回复在 ST 里干净、在 NC 里带标签。
   * 取不到（system 消息）→ 不给键 → 调用处传 undefined → 引擎不做深度过滤。
   */
  const depths = useMemo(() => {
    const orderable = messages.filter((item) => item.role !== 'system')
    const map = new Map<string, number>()
    orderable.forEach((item, index) => map.set(item.id, orderable.length - index - 1))
    return map
  }, [messages])
  const [editor, setEditor] = useState<{ id: string; draft: string } | null>(null)
  const [confirming, setConfirming] = useState<{ id: string; kind: 'delete' | 'resend' } | null>(null)
  const [saving, setSaving] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  useEffect(() => {
    if (!copiedId) return
    const timer = setTimeout(() => setCopiedId(null), 1800)
    return () => clearTimeout(timer)
  }, [copiedId])
  const [editError, setEditError] = useState<string | null>(null)
  useEffect(() => {
    onEditingChange?.(editor !== null)
  }, [editor !== null, onEditingChange])
  useEffect(() => () => onEditingChange?.(false), [onEditingChange])
  useEffect(() => {
    if (readOnly || (editor && !messages.some((message) => message.id === editor.id))) {
      setEditor(null)
      setConfirming(null)
    }
  }, [readOnly, messages, editor?.id])
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

  const saveEdit = async (resend: boolean): Promise<boolean> => {
    if (!editor || saving || isStreaming || readOnly || !editor.draft.trim()) return false
    const action = resend ? onResend : onUpdate
    if (!action) return false
    setSaving(true)
    setEditError(null)
    try {
      const ok = await action(editor.id, editor.draft)
      if (ok) { setEditor(null); setConfirming(null) }
      return ok
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error))
      return false
    } finally { setSaving(false) }
  }

  const actionsFor = (message: Message, index: number) => {
    if (readOnly) return null
    const nth = index + 1
    const editable = message.role === 'user' || message.role === 'narration'
    const editing = editor?.id === message.id
    const locked = isStreaming || saving
    const reason = isStreaming ? '当前会话仍在生成中，先停止再重试' : saving ? '正在保存消息' : undefined
    const previousAssistant = messages.slice(0, index).findLastIndex(item => item.role === 'assistant')
    const hasReplyInput = messages.some(item => item.role === 'user')
      || messages.slice(previousAssistant + 1, index).some(item => item.role === 'narration' && item.content.trim())
    const tailReply = message.role === 'assistant' && index === messages.length - 1 && hasReplyInput
    return <div className="message-actions">
      {editing ? (
        <div className="message-editor" data-ui-region="消息行内编辑">
          <label htmlFor={'edit-' + message.id}>编辑{message.role === 'narration' ? '旁白' : '消息'}原文</label>
          <textarea id={'edit-' + message.id} data-ui-target="编辑消息正文" rows={4} value={editor.draft}
            disabled={locked} onChange={event => { setEditor({ id: message.id, draft: event.target.value }); setConfirming(null) }} />
          <div className="bubble-actions">
            <button type="button" data-ui-target="保存不发送" disabled={locked || !editor.draft.trim()}
              title={reason} onClick={() => void saveEdit(false)}>保存不发送</button>
            <button type="button" data-ui-target="保存并重新提问" disabled={locked || !editor.draft.trim()}
              title={reason} onClick={() => setConfirming({ id: message.id, kind: 'resend' })}>保存并重新提问</button>
            <button type="button" disabled={saving} onClick={() => { setEditor(null); setConfirming(null); setEditError(null) }}>取消编辑</button>
          </div>
          {(editError || reason) && <p className="bubble-actions__hint" role="status">{editError || reason}</p>}
        </div>
      ) : (
        <div className="message-toolbar" role="group" aria-label="消息操作" data-ui-target={'消息操作 ' + nth}>
          {editable && onUpdate && <button type="button" className="message-action" disabled={locked || editor !== null} title={reason || '编辑消息'} aria-label="编辑这条" data-tooltip="编辑消息"
            data-ui-target={'编辑这条 ' + nth} onClick={() => { setEditor({ id: message.id, draft: message.content }); setConfirming(null); setEditError(null) }}><MessageActionIcon kind="edit" /><span className="message-action__label">编辑这条</span></button>}
          {tailReply && onRetry && <button type="button" className="message-action" aria-label="重试这一轮" data-tooltip="重新生成"
            disabled={locked || editor !== null} title={reason || '重新生成'} onClick={() => onRetry?.(message.id)}><MessageActionIcon kind="retry" /><span className="message-action__label">重试这一轮</span></button>}
          {message.role === 'assistant' && !tailReply && message.status === 'error' && <span className="bubble-actions__hint">后面已经有新消息了，只能重试最后一轮</span>}
          {onRemove && <button type="button" className="message-action message-action--delete" disabled={locked || editor !== null}
            title={reason || '删除消息'} aria-label="删除这条" data-tooltip="删除消息" data-ui-target={'删除这条 ' + nth}
            onClick={() => setConfirming({ id: message.id, kind: 'delete' })}><MessageActionIcon kind="delete" /><span className="message-action__label">删除这条</span></button>}
          {message.content && <button type="button" className="message-action" aria-label={copiedId === message.id ? '已复制' : '复制原稿'} title={copiedId === message.id ? '已复制' : '复制原稿'} data-tooltip={copiedId === message.id ? '已复制' : '复制'} data-ui-target="复制原稿"
            onClick={() => { void navigator.clipboard.writeText(message.content).then(() => setCopiedId(message.id)).catch(() => setEditError('复制失败，请重试')) }}><MessageActionIcon kind={copiedId === message.id ? 'check' : 'copy'} /><span className="message-action__label">{copiedId === message.id ? '已复制' : '复制原稿'}</span></button>}
          {isStreaming && editable && <span className="bubble-actions__hint">{reason}</span>}
        </div>
      )}
      {confirming?.id === message.id && <div className="message-confirm" role="group" aria-label="确认消息操作">
        <span>{confirming.kind === 'delete' ? '删除这条消息？后续消息保留。' : '保存并重新提问？这条之后的全部消息将被移除。'}</span>
        <button type="button" disabled={locked} data-ui-target="确认消息操作" onClick={() => {
          if (locked) return
          if (confirming.kind === 'resend') void saveEdit(true)
          else { onRemove?.(message.id); setConfirming(null) }
        }}>确认</button>
        <button type="button" disabled={saving} onClick={() => setConfirming(null)}>取消</button>
      </div>}
    </div>
  }

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
                {actionsFor(message, index)}
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
                  {view.phase === 'text' && (
                    <BubbleMarkdown
                      source={message.content}
                      scripts={isUser ? EMPTY_SCRIPTS : displayScripts}
                      depth={depths.get(message.id)}
                    />
                  )}
                  {view.phase === 'failed' && (
                    <>
                      {/* 半截正文也排版：断在 `**粗体` 中间确实会显示成半个星号，但没有渲染器时它整段都是裸符号 */}
                      {message.content && (
                        <div className="bubble__partial">
                          <BubbleMarkdown
                            source={message.content}
                            scripts={isUser ? EMPTY_SCRIPTS : displayScripts}
                            depth={depths.get(message.id)}
                          />
                        </div>
                      )}
                      <span className="bubble__note">{view.note}</span>
                    </>
                  )}
                </div>
                {actionsFor(message, index)}
                {/*
                  P6 / F-06：桥接这一轮的人话告警（开关被临时压制、还原失败…）。
                  🔴 一行灰字，**不是**红字：它不是失败 —— 这一轮正文照样落库、照样可读。
                  🔴 不阻断、不折叠、不进正文（M5：content 永远是原稿）。
                  用户的消息与旁白不带告警，所以只挂在助手这一支上。
                */}
                {!isUser && message.warnings && message.warnings.length > 0 && (
                  <p className="bubble__warnings" data-ui-target={`告警 ${nth}`}>
                    {message.warnings.join('；')}
                  </p>
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
