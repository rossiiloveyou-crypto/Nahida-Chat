import type { ConversationMode } from '@shared/types'
import type { StorySummary } from '@shared/story'
import { StoryCard } from '../../story/StoryCard'
import { brandFor } from '../../../assets/nahida'
import { useTheme } from '../../settings/useTheme'

interface EmptyStateProps {
  mode: ConversationMode
  onModeChange: (mode: ConversationMode) => void
  disabled: boolean
  stories?: StorySummary[]
  storyError?: string | null
  onNewStory?: () => void
  onOpenStory?: (storyId: string) => void
}

const MODE_COPY: Record<ConversationMode, { label: string; hint: string }> = {
  chat: { label: 'Chat', hint: '纯对话，不调用工具' },
  agent: { label: 'Agent', hint: '可调用工具完成任务' },
  story: { label: '故事', hint: '创建或继续独立故事' }
}

/**
 * 新对话首页。
 *
 * Chat / Agent 保留原功能键；故事模式额外展示创建入口与最近故事。标题、角色说明、示例问题都先移除，
 * 等整体视觉重构之后再补回文案。聊天入口仍然是下方输入框。
 *
 * 一个会话从第一条消息开始就锁定模式：Chat 不给工具，Agent 才走审批循环。
 */
export function EmptyState({ mode, onModeChange, disabled, stories = [], storyError, onNewStory, onOpenStory }: EmptyStateProps) {
  // 徽章走绝对定位，不参与空态的排版：滑块位置由 .mode-dock 的 margin-top 定（AGENTS §二）
  const brand = brandFor(useTheme().resolved)

  return (
    <div className="empty-state">
      {/* 三处飘叶/星芒：纯装饰，位置由 .empty-state__leaf--1/2/3 定，不参与布局 */}
      <span className="empty-state__leaf empty-state__leaf--1" aria-hidden="true" />
      <span className="empty-state__leaf empty-state__leaf--2" aria-hidden="true" />
      <span className="empty-state__leaf empty-state__leaf--3" aria-hidden="true" />
      <img className="empty-state__emblem" src={brand.emblem} alt="" aria-hidden="true" />
      <div className="mode-dock">
        <div className="mode-switch" data-ui-region="B 模式滑块" role="radiogroup" aria-label="会话模式">
          {(['chat', 'agent', 'story'] as ConversationMode[]).map((item) => {
            const active = item === mode
            return (
              <button
                key={item}
                role="radio"
                aria-checked={active}
                data-ui-target={MODE_COPY[item].label}
                className={'mode-switch__item sel-frame--card' + (active ? ' is-active' : '')}
                onClick={() => onModeChange(item)}
                disabled={disabled}
              >
                <strong>{MODE_COPY[item].label}</strong>
                <span>{MODE_COPY[item].hint}</span>
              </button>
            )
          })}
        </div>
      </div>
      {mode === 'story' && onNewStory && (
        <section data-ui-region="C 故事入口" aria-label="故事列表与创建" style={{ width: 'min(100%, 500px)', minHeight: 0, paddingBottom: 12 }}>
          <button type="button" className="sidebar__new" data-ui-target="新建故事" onClick={onNewStory} disabled={disabled}>
            + 新建故事
          </button>
          {storyError && <p role="alert" className="story-dialog__error">{storyError}</p>}
          {stories.length === 0 ? (
            <p className="session-list__empty">还没有故事区，创建一个开始吧。</p>
          ) : (
            <div className="story-list" data-ui-target="最近故事列表" style={{ maxHeight: '24vh' }} aria-label="最近故事">
              {stories.map((story) => (
                <StoryCard key={story.storyId} story={story} active={false} characterName={story.characterId} onOpen={(storyId) => { if (!disabled) onOpenStory?.(storyId) }} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
