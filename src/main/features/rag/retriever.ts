import {
  MEMORY_KEYWORD_WEIGHT,
  MEMORY_VECTOR_WEIGHT
} from '@shared/constants'
import type { MemoryRecallHit } from '@shared/types'
import type { MemoryScopeId } from '@shared/zones'
import { embedder } from './embedder'
import type { MemoryStore } from './store'
import { cosine } from './vector'
import { toMatchQuery } from './tokenize'

/**
 * 混合检索：向量（语义）+ FTS5（关键词）加权融合。
 *
 * 为什么必须混合：
 * - 纯向量在专有名词、编号、人名上会翻车（「须弥」和「雨林」向量很近，
 *   但用户问的是须弥）。
 * - 纯关键词在口语改写上会翻车（「我住哪」匹配不到「用户在上海市」）。
 * 两者分数各自归一化后加权，任一路失效都不影响另一路。
 */

/** 召回候选池大小：先宽召回再按分数截断，避免 topK 太小漏掉正确答案 */
const CANDIDATE_MULTIPLIER = 4

/**
 * 相对截断：只保留分数达到 top1 这个比例的条目。
 *
 * 为什么需要它：绝对阈值只能挡住「完全无关」，挡不住「同一查询里的弱相关噪声」。
 * 实测（bge-m3，5 条记忆）：
 *   问「我住在哪里」→ 上海 0.6691 / 深夜工作 0.5064（后者是噪声）
 *   问「我对什么过敏」→ 花生 0.7198 / 上海 0.4985（后者是噪声）
 * 用 0.8 的相对截断，两条噪声都被挡掉，而真正相关的多条事实
 * （比如问「我的个人信息」同时命中住址+职业）分数接近，不会被误伤。
 */
const RELATIVE_CUTOFF = 0.8

export interface RecallOptions {
  topK: number
  minScore: number
  /**
   * 只在这些域内检索。
   *  - 省略（undefined）= 全库，**仅为兼容既有测试**；生产调用必须显式传
   *  - 空数组 = 不检索（fail-closed），不是"不过滤"
   */
  scopes?: MemoryScopeId[]
}

export async function recall(
  store: MemoryStore,
  query: string,
  options: RecallOptions
): Promise<MemoryRecallHit[]> {
  const text = query.trim()
  if (!text) return []
  // 🔴 空 scopes 必须在这里拦住：往下走会生成 IN ()（语法错误），
  // 更糟的是"退回全库"会把配置错误变成隐私泄漏。
  if (options.scopes !== undefined && options.scopes.length === 0) return []

  const candidateLimit = Math.max(options.topK * CANDIDATE_MULTIPLIER, 10)

  // ── 路径 1：向量 ──
  const vectorScores = new Map<string, number>()
  const stored =
    options.scopes === undefined ? store.allWithEmbedding() : store.allWithEmbeddingIn(options.scopes)
  if (stored.length > 0) {
    const queryVector = await embedder.embedOne(text)
    if (queryVector) {
      for (const item of stored) {
        if (!item.embedding) continue
        vectorScores.set(item.id, cosine(queryVector, item.embedding))
      }
    }
  }

  // ── 路径 2：关键词 ──
  const keywordScores = new Map<string, number>()
  // 两路必须传同一个 scopes，否则向量按域、关键词全库 —— 等于没隔离
  const keywordHits =
    options.scopes === undefined
      ? store.keywordSearch(toMatchQuery(text), candidateLimit)
      : store.keywordSearchIn(toMatchQuery(text), candidateLimit, options.scopes)
  for (const hit of keywordHits) {
    keywordScores.set(hit.id, hit.score)
  }

  if (vectorScores.size === 0 && keywordScores.size === 0) return []

  // ── 融合 ──
  // 关键设计：向量分用「绝对余弦值」，不做按最大值归一化。
  //
  // 踩过的坑：一开始按 √ 最大值归一化，结果任何查询的最高分恒为 0.7，
  // 于是「今天天气怎么样」这种无关问题也会稳定召回 topK 条记忆，
  // minScore 完全失去意义。绝对余弦才有「这条到底有多相关」的语义，
  // 阈值才拦得住无关查询。
  //
  // 关键词分没有绝对量纲（bm25 是相对的），只能相对归一化；
  // 但它只占 0.3 权重，且没有向量时会被折价，不会单独把噪声顶上去。
  const maxKeyword = Math.max(...keywordScores.values(), 0)

  const ids = new Set<string>([...vectorScores.keys(), ...keywordScores.keys()])
  // 关键词命中但没有向量的条目也要能带出正文，所以按 id 精确回查
  const all = new Map(store.getByIds([...ids]).map((item) => [item.id, item]))

  const merged: MemoryRecallHit[] = []
  for (const id of ids) {
    const vectorRaw = vectorScores.get(id) ?? 0
    const keywordRaw = keywordScores.get(id) ?? 0
    const keywordNorm = maxKeyword > 0 ? keywordRaw / maxKeyword : 0

    // 余弦可能为负（完全反向），夹到 0，避免负分被当成「负相关」惩罚
    const vectorPart = vectorScores.has(id) ? Math.max(0, vectorRaw) : 0

    // 关键词只「补足余量」，不做加权平均。
    //
    // 踩过的坑：一开始写成 0.7×向量 + 0.3×关键词，等于把余弦整体乘 0.7，
    // 一条本来 0.69 的正确命中被压到 0.48，直接掉到阈值以下——
    // 而 0.69 才是「这条到底有多相关」的真实语义。加权平均会系统性地
    // 稀释绝对分数，让阈值失去可解释性。
    //
    // 现在：score 仍以余弦为主轴，关键词命中只把剩余空间往上抬，
    // 所以向量弱但字面强命中（专有名词、编号）能救回来，而向量分不会被缩小。
    const score = vectorPart + (1 - vectorPart) * keywordNorm * MEMORY_KEYWORD_WEIGHT

    const entry = all.get(id)
    if (!entry) continue
    merged.push({
      id,
      content: entry.content,
      score,
      vectorScore: vectorRaw,
      keywordScore: keywordRaw
    })
  }

  merged.sort((a, b) => b.score - a.score)
  const topScore = merged.length > 0 ? merged[0].score : 0
  const relativeFloor = topScore * RELATIVE_CUTOFF

  return merged
    .filter((item) => item.score >= options.minScore && item.score >= relativeFloor)
    .slice(0, options.topK)
}