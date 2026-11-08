import { branchStore } from './branches'

/**
 * 一条分支能看见哪些记忆（P6 / T12）。
 *
 * 规则（第 k 层祖先的边界 = 沿父链一路取**最小**的锚点下标）：
 *   self        : 无上界（自己说的全可见）
 *   parent      : sourceMessageIndex <= anchor(self)
 *   grandparent : sourceMessageIndex <= min(anchor(self), anchor(parent))
 *   …
 *
 * 为什么取**最小**：派生复制的是**前缀**，消息下标在复制中 1:1 保留，
 * 所以第 k 层祖先的第 i 条记忆要「同时落在每一层的前缀之内」才真的进了 self 的 messages。
 *
 * 🔴 这是「算」不是「抄」：派生时不复制记忆，记忆的 sourceSessionId 仍指向它诞生的分支，
 *    新分支靠本函数算出来能看见什么（避免同一条事实在库里出现 N 份、被去重吃掉）。
 */
export interface BranchVisibility {
  /** branchId → 该分支可见的最大消息下标；null = 无上界 */
  bounds: Map<string, number | null>
  /** 判断入口，直接喂给 retriever 的 visible */
  visible(entry: { sourceSessionId: string | null; sourceMessageIndex?: number | null }): boolean
}

export function branchVisibility(storyId: string, branchId: string): BranchVisibility {
  const file = branchStore.read(storyId)
  const bounds = new Map<string, number | null>()

  // 还没有树（branches.json 不存在 / 坏）→ 退化到 P5 行为：全可见
  if (!file) {
    return { bounds, visible: () => true }
  }

  const byId = new Map(file.branches.map((branch) => [branch.branchId, branch]))
  let cursor: string | null = branchId
  let minAnchor: number | null = null
  const seen = new Set<string>()

  while (cursor) {
    // 环保护：纯读函数不能假设文件一定干净（§4.9.3 第 3 条）
    if (seen.has(cursor)) {
      console.warn('[story] branchVisibility 遇到环，停止上溯：' + cursor)
      break
    }
    seen.add(cursor)
    bounds.set(cursor, minAnchor)

    const node = byId.get(cursor)
    if (!node || !node.parentBranchId) break

    // 分叉点在父分支里的下标（未知 → 父及更上按 fail-open 全可见）
    const fork =
      typeof node.parentMessageIndex === 'number' && Number.isFinite(node.parentMessageIndex)
        ? node.parentMessageIndex
        : null
    if (fork === null) {
      bounds.set(node.parentBranchId, null)
      break
    }
    minAnchor = minAnchor === null ? fork : Math.min(minAnchor, fork)
    cursor = node.parentBranchId
  }

  const visible = (entry: {
    sourceSessionId: string | null
    sourceMessageIndex?: number | null
  }): boolean => {
    // 1) 没有来源会话（手工添加 / P4 之前的老记忆）→ 可见（fail-open）
    if (!entry.sourceSessionId) return true
    // 2) 该分支不在可见集里（别人的分支）→ 不可见
    if (!bounds.has(entry.sourceSessionId)) return false
    const bound = bounds.get(entry.sourceSessionId)
    // 3) 无上界（自己 / 根）→ 可见
    if (bound === null || bound === undefined) return true
    // 4) 有上界但这条记忆没有下标（老数据）→ 可见（fail-open）
    if (entry.sourceMessageIndex === null || entry.sourceMessageIndex === undefined) return true
    // 5) 正常判定：产生在锚点之前（含锚点）才可见
    return entry.sourceMessageIndex <= bound
  }

  return { bounds, visible }
}
