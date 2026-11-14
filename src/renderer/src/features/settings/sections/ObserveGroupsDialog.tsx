import { useEffect, useState } from 'react'
import type { ObserveConversation } from '@shared/observe'
import { filterObserveConversations } from '../observeFilter'

interface ObserveGroupsDialogProps {
  conversations: ObserveConversation[]
  /** chatId → 有几个账号在记它（多账号备份的显示口径，见 ObservePanel 注释） */
  accountCount: Map<string, number>
  onClose: () => void
  /** 「看最近」把这一条交回面板（面板下方有 tail 区），弹层自己关掉 */
  onOpenTail: (item: ObserveConversation) => void
}

function sizeLabel(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return String(bytes) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function timeLabel(at: number): string {
  if (!at) return '—'
  try {
    return new Date(at).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

function chatLabelOf(item: ObserveConversation): string {
  if (item.label) return item.label
  return item.chatType === 'group' ? '（未命名群）' : '（未命名）'
}

/**
 * 旁听群号一览（弹层）。
 *
 * 为什么要有它：群号平铺在渠道控制台里会刷屏 —— 一台机器旁听过几十上百个群之后，
 * 那一大块表格把整个设置页顶得老长，可真正要用的动作只有「找到某个群、看它最近说了什么」。
 * 所以面板只留一行概要 + 一个入口，细节在这里看，并且**能搜**。
 *
 * 只读：旁听库「只增不清」是用户裁决（M21b），这里同样不给任何删除 / 清空入口。
 */
export function ObserveGroupsDialog({
  conversations,
  accountCount,
  onClose,
  onOpenTail
}: ObserveGroupsDialogProps) {
  const [query, setQuery] = useState('')
  const hits = filterObserveConversations(conversations, query)

  // Esc 关闭：弹层是全屏遮罩，没有 Esc 的化会被迫去找右上角那个 ×
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="story-dialog__backdrop" role="presentation" onClick={onClose}>
      <div
        className="wb-dialog observe-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="旁听群号一览"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="wb-dialog__head">
          <div>
            <h2>旁听群号一览</h2>
            <p className="wb-dialog__sub">
              只读 · 共 {conversations.length} 行。搜索按 <strong>群号 / 群名 / 账号</strong> 匹配，
              空格分隔多个词时要求<strong>同时命中</strong>（例如「群聊 1234」）。
            </p>
          </div>
          <button type="button" className="story-dialog__close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="observe-dialog__search">
          <input
            className="field__control"
            data-ui-target="旁听群号搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜群号 / 群名 / 账号…"
            aria-label="搜索旁听群号"
            autoFocus
          />
          <button
            type="button"
            className="btn-ghost"
            data-ui-target="清空群号搜索"
            disabled={!query}
            onClick={() => setQuery('')}
          >
            清空
          </button>
          <span className="hint-text observe-dialog__count">
            命中 {hits.length} / {conversations.length}
          </span>
        </div>

        <div className="observe-dialog__body">
          <div className="qq-table qq-table--observe" data-ui-target="旁听群号表">
            <div className="qq-table__head">
              <span>类型</span>
              <span>账号</span>
              <span>会话号</span>
              <span>名称</span>
              <span>行数</span>
              <span>大小</span>
              <span>最近</span>
              <span>操作</span>
            </div>
            {hits.length === 0 && (
              <p className="hint-text">
                {conversations.length === 0
                  ? '还没有任何旁听记录。群里说一句话就会出现在这里（群聊不需要加白名单）。'
                  : '没有匹配的会话。换个关键词，或清空搜索看全部。'}
              </p>
            )}
            {hits.map((item) => (
              <div className="qq-table__row" key={item.key}>
                <span>{item.chatType === 'group' ? '群聊' : '私聊'}</span>
                <span title={'记录账号 uin：' + item.uin}>{item.uin}</span>
                <span title={item.key}>
                  {item.chatId}
                  {(accountCount.get(item.chatId) ?? 0) > 1 && (
                    <em
                      className="qq-tag-multi"
                      title={
                        '该群另有 ' +
                        String((accountCount.get(item.chatId) ?? 1) - 1) +
                        ' 个账号在记录'
                      }
                    >
                      ⧉{accountCount.get(item.chatId)}
                    </em>
                  )}
                </span>
                <span>{chatLabelOf(item)}</span>
                <span>
                  约 {item.lines}
                  {item.segments > 1 ? '（' + String(item.segments) + ' 片）' : ''}
                </span>
                <span>{sizeLabel(item.bytes)}</span>
                <span>{timeLabel(item.lastAt)}</span>
                <span className="qq-table__actions">
                  <button
                    type="button"
                    className="btn-ghost btn-ghost--sm"
                    onClick={() => onOpenTail(item)}
                  >
                    看最近
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
