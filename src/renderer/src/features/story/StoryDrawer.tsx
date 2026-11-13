import { useEffect, useState } from 'react'
import type { StoryBranchItem } from '@shared/story'
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
 * 三块：检索 / 分支列表 / 消息时间轴。
 * 🔴 列表只用 store 里 story.branches 的结果，渲染层零计算（B2）。
 * 🔴 **扁平列表**：分支之间没有父子关系（P6 修订），所以这里既不画缩进也不画 children。
 *    派生来源只作为一行小字（forkedFrom 快照）显示，删掉源分支后这行字依然在。
 * 🔴 派生与切换都必须换视口（adoptStorySession 在 store 里），否则用户点完以为没反应。
 * 🔴 不读 zones：故事相关只绑 storyId（总蓝图 `附 前向兼容）。
 */
export function StoryDrawer({ storyId, title }: StoryDrawerProps) {
  const branches = useStoryStore((s) => s.branches)
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
  const activeBranch = activeBranchOf(branches)
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

  const removeWithConfirm = (branch: StoryBranchItem): void => {
    // 🔴 分支之间没有父子依赖：删任何一条都不会牵连别人，所以这里**不再**要求先处理子分支。
    //    只剩「最后一条不能删」（删完这个故事就没有会话可进了）。
    const tail = branch.isActive ? '删的是当前分支，删完会切到最近活动的那一条。' : ''
    const text =
      '这条分支有 ' + String(branch.messageCount) + ' 条消息，删除后不可恢复。' + tail
    if (!window.confirm(text)) return
    void removeBranch(branch.branchId)
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
            {activeBranch
              ? activeBranch.title + ' · ' + String(activeBranch.messageCount) + ' 条消息'
              : '还没有分支'}
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
                <li key={hit.branchId + '-' + hit.messageId}>
                  <button
                    type="button"
                    className={'story-hit' + (hit.isActiveBranch ? ' is-current' : '')}
                    data-ui-target={'检索命中 ' + String(index + 1)}
                    onClick={() => void openHit(hit.branchId, hit.messageId)}
                  >
                    <span className="story-hit__head">
                      {hit.branchTitle} · 第 {hit.messageIndex + 1} 条 ·{' '}
                      {hit.role === 'narration' ? '旁白' : hit.role === 'user' ? '我' : '她'}
                    </span>
                    <span className="story-hit__snippet">{hit.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="story-tree" data-ui-region="F 分支列表">
        <p className="story-drawer__section">分支</p>
        {branches.length === 0 && <p className="story-drawer__empty">还没有分支</p>}
        <ul className="story-tree__list">
          {branches.map((branch) => (
            <BranchRow
              key={branch.branchId}
              branch={branch}
              busy={busy}
              canRemove={branches.length > 1}
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
                {index + 1}.{' '}
                {message.role === 'narration' ? '旁白' : message.role === 'user' ? '我' : '她'} ·{' '}
                {message.content ? message.content.slice(0, 40) : '（生成中）'}
              </span>
              <button
                type="button"
                data-ui-target={'从此处分支出新剧情 ' + String(index + 1)}
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

/**
 * 一行分支。
 *
 * 🔴 没有 depth：分支之间是平的。旧实现按 depth 做缩进，等于在界面上暗示
 *    「子分支依赖父分支」—— 正是这次要删掉的设计。
 */
function BranchRow({
  branch,
  busy,
  canRemove,
  onSwitch,
  onRemove
}: {
  branch: StoryBranchItem
  busy: boolean
  canRemove: boolean
  onSwitch: (branchId: string) => void
  onRemove: (branch: StoryBranchItem) => void
}) {
  const origin = branch.forkedFrom
  const originText = origin
    ? '从「' +
      (origin.title || '原分支') +
      '」' +
      (origin.messageNumber ? '第 ' + String(origin.messageNumber) + ' 条之后' : '') +
      '分出'
    : '故事的第一条分支'
  return (
    <li>
      <div
        className={'story-tree__node' + (branch.isActive ? ' is-active' : '')}
        data-ui-target={'分支 ' + branch.title}
      >
        <button
          type="button"
          className="story-tree__main"
          disabled={busy || branch.isActive}
          onClick={() => onSwitch(branch.branchId)}
          title={branch.isActive ? '当前分支' : '切换至此分支'}
        >
          <span className="story-tree__title">{branch.title}</span>
          <span className="story-tree__meta">
            {branch.messageCount} 条 · {relativeTime(branch.lastActiveAt)}
            {branch.isActive ? ' · 当前' : ''}
          </span>
          <span className="story-tree__origin">{originText}</span>
        </button>
        <button
          type="button"
          className="story-tree__delete"
          aria-label={'删除分支 ' + branch.title}
          disabled={busy || !canRemove}
          title={canRemove ? '删除这条分支' : '故事至少要留一条分支'}
          onClick={() => onRemove(branch)}
        >
          ×
        </button>
      </div>
    </li>
  )
}
