import type { ConversationMode } from '@shared/types'
import { brandFor } from '../../../assets/nahida'
import { useTheme } from '../../settings/useTheme'

interface EmptyStateProps {
  mode: ConversationMode
  onModeChange: (mode: ConversationMode) => void
  disabled: boolean
}

const MODE_COPY: Record<ConversationMode, { label: string; hint: string }> = {
  chat: { label: 'Chat', hint: '纯对话，不调用工具' },
  agent: { label: 'Agent', hint: '可调用工具完成任务' }
}

/**
 * 新对话首页。
 *
 * 当前只保留功能键（Chat / Agent 滑块）：标题、角色说明、示例问题都先移除，
 * 等整体视觉重构之后再补回文案。聊天入口仍然是下方输入框。
 *
 * 一个会话从第一条消息开始就锁定模式：Chat 不给工具，Agent 才走审批循环。
 */
export function EmptyState({ mode, onModeChange, disabled }: EmptyStateProps) {
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
          {(['chat', 'agent'] as ConversationMode[]).map((item) => {
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
    </div>
  )
}
