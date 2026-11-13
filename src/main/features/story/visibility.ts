import type { StoryMemoryBound } from '@shared/story'
import { branchStore } from './branches'

/**
 * 一条分支能看见哪些记忆（P6 / T12）。
 *
 * 🔴 P6 修订（分支独立）：**不再沿父链上溯**。
 *    可见范围在派生那一刻就固化进 branches.json 的 memoryBounds（快照），这里只读快照。
 *    于是：父分支改名 / 继续往下说话 / 被整个删掉，都不改变这条分支的召回范围。
 *    （旧实现是「从当前分支一路走到根、每层取最小分叉下标」——
 *      父分支一被删，这条链就断了，子分支的记忆会成片消失。现在断不了，因为没有链。）
 *
 * 语义与旧实现**等价**，只是从「算」变成「读」：
 *   self        : 无上界（自己说的全可见）
 *   parent      : sourceMessageIndex <= 派生时的分叉下标
 *   grandparent : <= min(各层分叉下标)
 *
 * 🔴 边界本身不是依赖，是正确性：派生复制的是**前缀**，
 *    分叉点之后父分支才说的话并没有进这条分支的消息，那些事实也不该被召回。
 */
export interface BranchVisibility {
  /** branchId → 该分支可见的最大消息下标；null = 无上界 */
  bounds: Map<string, number | null>
  /** 判断入口，直接喂给 retriever 的 visible */
  visible(entry: { sourceSessionId: string | null; sourceMessageIndex?: number | null }): boolean
}

export function branchVisibility(storyId: string, branchId: string): BranchVisibility {
  const bounds = new Map<string, number | null>()

  const file = branchStore.read(storyId)
  // 还没有 branches.json（老故事 / 文件坏）→ 退化到 P5 行为：全可见
  if (!file) {
    return { bounds, visible: () => true }
  }

  const node = file.branches.find((branch) => branch.branchId === branchId)
  // 文件在、但这条分支不在里面（脏数据 / 会话直接建的）→ 只看得见自己（fail-closed）
  const list: StoryMemoryBound[] =
    node && node.memoryBounds && node.memoryBounds.length > 0
      ? node.memoryBounds
      : [{ branchId, maxMessageIndex: null }]

  for (const bound of list) {
    if (!bounds.has(bound.branchId)) {
      bounds.set(bound.branchId, bound.maxMessageIndex)
      continue
    }
    bounds.set(bound.branchId, stricter(bounds.get(bound.branchId) ?? null, bound.maxMessageIndex))
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
    // 3) 无上界（自己）→ 可见
    if (bound === null || bound === undefined) return true
    // 4) 有上界但这条记忆没有下标（老数据）→ 可见（fail-open）
    if (entry.sourceMessageIndex === null || entry.sourceMessageIndex === undefined) return true
    // 5) 正常判定：产生在锚点之前（含锚点）才可见
    return entry.sourceMessageIndex <= bound
  }

  return { bounds, visible }
}

/** 取更严的边界：null = 无上界，所以 min(null, x) === x */
function stricter(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}
