import type { CardData } from '../markdown/structure'

// Presentation labels only: the tokenizer and shared regex engine remain preset-independent.
const TITLES: Record<string, string> = {
  wave_plan: '创作规划', wave_summary: '本楼记事', wave_review: '成稿回看',
  wave_options: '行动选项', wave_mind: '内心话',
  wave_comment: '附页', wave_parallel: '附页', wave_original: '附页'
}

export function BubbleCard({ card }: { card: CardData }) {
  const title = TITLES[card.tag] ?? card.tag
  return (
    <details className="bubble-card">
      <summary data-ui-target={title + '折叠卡'}>{title}</summary>
      <div className="bubble-card__text">{card.text}</div>
    </details>
  )
}
