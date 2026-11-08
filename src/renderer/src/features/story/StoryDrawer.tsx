import { useEffect, useState } from 'react'
import type { StoryBranchNode } from '@shared/story'
import { useChatStore } from '../chat/store'
import { activeBranchOf, useStoryStore } from './store'
import { relativeTime } from './StoryCard'

interface StoryDrawerProps {
  storyId: string
  title: string
}

/**
 * 分支抽屉（D14 / H-09 / D15 / H-08）。
 *
 * 三块：检索 / 分支树 / 消息时间轴。
 * 🔴 树只用 store 里 getBranchTree 的结果，渲染层零树计算（B2）。
 * 🔴 派生与切换都必须换视口（adoptStorySession 在 store 里），否则用户点完以为没反应。
 * 🔴 不读 zones：故事相关只绑 storyId（总蓝图 §附 前向兼容）。
 */
export function StoryDrawer({ storyId, title }: StoryDrawerProps) {
  const tree = useStoryStore((s) => s.tree)
  const drawerOpen = useStoryStore((s) => s.drawerOpen)
  const busy = useStoryStore((s) => s.busy)
  const error = useStoryStore((s) => s.error)
  const hits = useStoryStore((s) => s.searchHits)
  const toggleDrawer = useStoryStore((s) => s.toggleDrawer)
  const switchTo = useStoryStore((s) => s.switchTo)
  const deriveFrom = useStoryStore((s) => s.deriveFrom)
  const removeBranch = useStoryStore((s) => s.removeBranch)
  const runSearch = useStoryStore((s) => s.runSearch)
  const clearSearch = useStoryStore((s) => s.clearSearch)
  const setFocus = useStoryStore((s) => s.setFocus)

  const messages = useChatStore((s) => {
    const active = s.activeId ? s.sessions.find((item) => item.id === s.activeId) : null
    return active && active.storyId === storyId ? active.messages : []
  })
  const activeBranch = activeBranchOf(tree)
  const [query, setQuery] = useState('')

  // 抽屉收起时清空检索结果：下次打开是干净的一块，不会留着上一次的旧命中
  useEffect(() => {
    if (!drawerOpen) {
      setQuery('')
      clearSearch()
    }
  }, [drawerOpen, clearSearch])

  const openHit = async (branchId: string, messageId: string): Promise<void> => {
    if (branchId !== (activeBranch?.branchId ?? '')) {
      await switchTo(branchId)
    }
    setFocus(messageId)
  }

  const removeWithConfirm = (node: StoryBranchNode): void => {
    if (node.isActive) return
    if (!window.confirm(`这条分支有 ${node.messageCount} 条消息，删除后不可恢复`)) return
    void removeBranch(node.branchId)
  }

  if (!drawerOpen) {
    return (
      <button
        type="button"
        className="story-drawer__handle sel-frame--stitch"
        data-ui-target="打开分支抽屉"
        onClick={() => toggleDrawer(true)}
        title="分支与检索"
      >
        分支
      </button>
    )
  }

  return (
    <aside className="story-drawer" data-ui-region="D 故事分支抽屉">
      <div className="story-drawer__head">
        <div>
          <strong>{title}</strong>
          <span className="story-drawer__sub">
            {activeBranch ? `${activeBranch.title} · ${activeBranch.messageCount} 条消息` : '还没有分支'}
          </span>
        </div>
        <button className="story-drawer__close" aria-label="收起" onClick={() => toggleDrawer(false)}>
          ×
        </button>
      </div>

      {error && <p className="story-drawer__error">{error}</p>}

      <div className="story-search" data-ui-region="E 故事检索">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void runSearch(query)
          }}
        >
          <input
            data-ui-target="故事检索输入"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="在本故事全部分支里找…"
            aria-label="故事全文检索"
          />
          <button type="submit" data-ui-target="执行检索" disabled={busy}>
            找
          </button>
        </form>
        {hits.length > 0 && (
          <>
            <p className="story-search__hint">{hits.length} 条命中（跨全部分支）</p>
            <ul className="story-hit-list">
              {hits.map((hit, index) => (
                <li key={`${hit.branchId}-${hit.messageId}`}>
                  <button
                    type="button"
                    className={'story-hit' + (hit.isActiveBranch ? ' is-current' : '')}
                    data-ui-target={`检索命中 ${index + 1}`}
                    onClick={() => void openHit(hit.branchId, hit.messageId)}
                  >
                    <span className="story-hit__head">
                      {hit.branchTitle} · 第 {hit.messageIndex + 1} 条 · {hit.role === 'narration' ? '旁白' : hit.role === 'user' ? '我' : '她'}
                    </span>
                    <span className="story-hit__snippet">{hit.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="story-tree" data-ui-region="F 分支树">
        <p className="story-drawer__section">分支</p>
        {tree.length === 0 && <p className="story-drawer__empty">还没有分支</p>}
        <ul className="story-tree__list">
          {tree.map((node) => (
            <BranchNodeRow
              key={node.branchId}
              node={node}
              depth={0}
              busy={busy}
              onSwitch={(branchId) => void switchTo(branchId)}
              onRemove={removeWithConfirm}
            />
          ))}
        </ul>
      </div>

      <div className="story-timeline" data-ui-region="G 消息时间轴">
        <p className="story-drawer__section">时间轴（{activeBranch?.title ?? '当前分支'}）</p>
        {messages.length === 0 && <p className="story-drawer__empty">这条分支还没有消息</p>}
        <ol className="story-timeline__list">
          {messages.map((message, index) => (
            <li key={message.id} className="story-timeline__item">
              <span className="story-timeline__text">
                {index + 1}. {message.role === 'narration' ? '旁白' : message.role === 'user' ? '我' : '她'} ·{' '}
                {message.content ? message.content.slice(0, 40) : '（生成中）'}
              </span>
              <button
                type="button"
                data-ui-target={`从此处分支出新剧情 ${index + 1}`}
                disabled={busy}
                onClick={() => void deriveFrom(message.id)}
                title="从这条消息之后开一条新分支"
              >
                由此分支
              </button>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  )
}

function BranchNodeRow({
  node,
  depth,
  busy,
  onSwitch,
  onRemove
}: {
  node: StoryBranchNode
  depth: number
  busy: boolean
  onSwitch: (branchId: string) => void
  onRemove: (node: StoryBranchNode) => void
}) {
  return (
    <li>
      <div
        className={'story-tree__node' + (node.isActive ? ' is-active' : '')}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-ui-target={`分支 ${node.title}`}
      >
        <button
          type="button"
          className="story-tree__main"
          disabled={busy || node.isActive}
          onClick={() => onSwitch(node.branchId)}
          title={node.isActive ? '当前分支' : '切换至此分支'}
        >
          <span className="story-tree__title">{node.title}</span>
          <span className="story-tree__meta">
            {node.messageCount} 条 · {relativeTime(node.lastActiveAt)}
            {node.isActive ? ' · 当前' : ''}
          </span>
        </button>
        {!node.isActive && (
          <button
            type="button"
            className="story-tree__delete"
            aria-label={`删除分支 ${node.title}`}
            disabled={busy}
            onClick={() => onRemove(node)}
          >
            ×
          </button>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="story-tree__list">
          {node.children.map((child) => (
            <BranchNodeRow
              key={child.branchId}
              node={child}
              depth={depth + 1}
              busy={busy}
              onSwitch={onSwitch}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
