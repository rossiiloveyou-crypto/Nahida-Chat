import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { INPUT_LENGTH_WARN } from '@shared/constants'
import { brandFor } from '../../../assets/nahida'
import { useTheme } from '../../settings/useTheme'
import { ComposerBar } from './ComposerBar'

interface ComposerProps {
  disabled: boolean
  streaming: boolean
  onSend: (content: string) => void
  /** 故事区旁白：不触发生成，只把内容追加为一条居中旁白 */
  onNarrate: (content: string) => void
  /** 只有故事会话才显示「对话 / 旁白」徽章 */
  canNarrate: boolean
  onStop: () => void
  /** 还没有会话时，选择器改的是"下一句话用什么"，由 ChatPage 暂存 */
  draftProfileId: string | null
  draftModelId: string | null
  onPickModel: (profileId: string, modelId: string) => void
  /** 当前生效的工作区；同理由 ChatPage 解析后传进来 */
  workspaceId: string | null
  onPickWorkspace: (workspaceId: string) => void
  /**
   * P6 G3：Agent 模式且零工作区 —— 整块输入区变成"点击即建区"的引导态。
   * 判据由 ChatPage 算，这里只负责呈现。
   */
  needsWorkspace: boolean
  /** 门禁态下点任意位置都走这个（复用 WorkspaceSection 的建区逻辑） */
  onCreateWorkspace: () => void
}

/**
 * 输入区。
 *
 * 这里刻意不设 maxLength：截断用户粘贴的长文本是最气人的一种"保护"，
 * 而且模型上下文早就比 8000 字大得多。只在超过阈值时把计数标红提醒。
 */
export function Composer({
  disabled,
  streaming,
  onSend,
  onNarrate,
  canNarrate,
  onStop,
  draftProfileId,
  draftModelId,
  onPickModel,
  workspaceId,
  onPickWorkspace,
  needsWorkspace,
  onCreateWorkspace
}: ComposerProps) {
  const [value, setValue] = useState('')
  const [inputKind, setInputKind] = useState<'dialogue' | 'narration'>('dialogue')
  // 旁白只在故事会话可见；切去普通对话时必须回到「对话」，否则控件消失后仍可能走旁白分支。
  useEffect(() => {
    if (!canNarrate) setInputKind('dialogue')
  }, [canNarrate])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // 发送图标日夜成对；两张 SVG 的 viewBox 不同（40 vs 44），尺寸由 CSS 锁死
  const brand = brandFor(useTheme().resolved)

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = Math.min(element.scrollHeight, 168) + 'px'
  }, [value])

  const submittingNarration = canNarrate && inputKind === 'narration'

  const submit = (): void => {
    const text = value.trim()
    // needsWorkspace 也要拦：readOnly 只是不接受新输入，
    // 但"先打了字、再把工作区删空"这种情况 value 还在，回车/发送键必须无效。
    if (!text || disabled || streaming || needsWorkspace) return
    if (submittingNarration) onNarrate(text)
    else onSend(text)
    setValue('')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const over = value.length > INPUT_LENGTH_WARN

  return (
    <div className="composer" data-ui-region="C 输入区">
      <div className="composer__row">
        {canNarrate && (
          <div className="composer__mode" role="group" aria-label="输入类型" data-ui-target="对话旁白切换">
            <button
              type="button"
              className={inputKind === 'dialogue' ? 'composer__mode-btn is-active' : 'composer__mode-btn'}
              aria-pressed={inputKind === 'dialogue'}
              onClick={() => setInputKind('dialogue')}
              disabled={disabled || streaming}
            >
              对话
            </button>
            <button
              type="button"
              className={inputKind === 'narration' ? 'composer__mode-btn is-active' : 'composer__mode-btn'}
              aria-pressed={inputKind === 'narration'}
              onClick={() => setInputKind('narration')}
              disabled={disabled || streaming}
            >
              旁白
            </button>
          </div>
        )}
        <div
          className={'composer__box' + (needsWorkspace ? ' is-gated' : '') + (submittingNarration ? ' is-narration' : '')}
          data-ui-target="输入框"
          onClick={needsWorkspace ? onCreateWorkspace : undefined}
        >
        <textarea
          ref={textareaRef}
          className="composer__input"
          rows={1}
          value={value}
          /*
           * P6 G3 的实现要害：用 readOnly 而不是 disabled。
           * disabled 的元素**不接收点击事件**，点了没反应，也就没法实现"点一下就跳去建工作区"。
           * readOnly 保留焦点与点击，同时不接受输入。
           */
          readOnly={needsWorkspace}
          placeholder={
            needsWorkspace
              ? '先创建一个工作区，Agent 才能开始干活'
              : submittingNarration
                ? '写一段旁白，发送后不会触发模型…（Enter 发送 / Shift + Enter 换行）'
                : '给纳西妲发消息…（Enter 发送 / Shift + Enter 换行）'
          }
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {streaming ? (
          <button className="composer__action composer__action--stop" onClick={onStop} title="停止生成">
            ■
          </button>
        ) : (
          <button
            className={'composer__action' + (submittingNarration ? ' composer__action--narration' : '')}
            onClick={submit}
            disabled={disabled || needsWorkspace || !value.trim()}
            title={needsWorkspace ? '先创建一个工作区' : submittingNarration ? '发送旁白' : '发送'}
          >
            {/* 停止按钮仍用 Unicode ■：资产包 55 个文件里没有 stop 图标，
                硬套发送图标会让人误读成"再发一次"（PHASE-2 §十二 有意保留） */}
            {submittingNarration ? (
              <span className="composer__action-text">旁</span>
            ) : (
              <img className="composer__action-icon" src={brand.send} alt="" aria-hidden="true" />
            )}
          </button>
          )}
        </div>
      </div>
      <ComposerBar
        disabled={disabled}
        streaming={streaming}
        draftProfileId={draftProfileId}
        draftModelId={draftModelId}
        onPickModel={onPickModel}
        workspaceId={workspaceId}
        onPickWorkspace={onPickWorkspace}
      />
      <div className="composer__hint">
        <span>
          {submittingNarration ? '旁白不触发生成，会随下一次对话作为系统提示下发给模型' : '内容仅保存在本机 userData 目录'}
        </span>
        <span className={over ? 'composer__count is-over' : 'composer__count'}>
          {value.length.toLocaleString()}
          {over ? ' 字（超出常规范畴，注意模型上下文）' : ' 字'}
        </span>
      </div>
    </div>
  )
}
