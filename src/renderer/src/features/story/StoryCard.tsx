import type { StorySummary } from '@shared/story'
import { brandFor } from '../../assets/nahida'
import { useTheme } from '../settings/useTheme'

interface StoryCardProps {
  story: StorySummary
  active: boolean
  characterName: string
  onOpen: (storyId: string) => void
}

/** P7：侧栏「故事」段的一张卡片。角色头像 + 标题/概要 + 活跃分支最后更新时间。 */
export function StoryCard({ story, active, characterName, onOpen }: StoryCardProps) {
  const brand = brandFor(useTheme().resolved)
  const summary = story.synopsis.trim() || story.title
  const branchHint = story.branchCount > 1 ? `活跃分支 · ${relativeTime(story.lastActiveAt)} · ${story.branchCount} 条分支` : `活跃分支 · ${relativeTime(story.lastActiveAt)}`

  return (
    <button
      type="button"
      className={'story-card sel-frame--stitch' + (active ? ' is-active' : '')}
      data-ui-target={`故事卡片 ${story.title}`}
      title={summary}
      onClick={() => onOpen(story.storyId)}
    >
      <img className="story-card__avatar" src={brand.avatar} alt="" aria-hidden="true" />
      <span className="story-card__body">
        <span className="story-card__title">{story.title}</span>
        <span className="story-card__synopsis">{summary}</span>
        <span className="story-card__meta" title={characterName}>
          {branchHint}
        </span>
      </span>
    </button>
  )
}

export function relativeTime(timestamp: number): string {
  if (!timestamp) return '还没有消息'
  const delta = Date.now() - timestamp
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return new Date(timestamp).toLocaleDateString()
}
