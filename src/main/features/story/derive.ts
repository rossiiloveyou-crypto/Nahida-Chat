import { randomUUID } from 'node:crypto'
import type { Message } from '@shared/types'
import type { StoryBranch, StoryBranchesFile, StoryDeriveDraft, StoryMemoryBound } from '@shared/story'
import { STORY_BRANCH_TITLE_PREFIX, STORY_BRANCHES_VERSION } from '@shared/story'
import { chatService } from '../chat/chatService'
import { branchStore, toBranchSessionInfo } from './branches'
import { isStoryId } from './paths'
import { storyStore } from './store'

/**
 * 派生分支（P6 / T3，本 Phase 的核心）与删分支（T7）。
 *
 * 🔴 顺序写死（J-12：副作用排在判定之后）：
 *   ① 校验 storyId 形状 → 故事区必须存在
 *   ② 源会话必须在本区
 *   ③ fromMessageId 必须在源会话里（取下标 idx）
 *   ④ 建新会话（同一条 createSession，不另开 API）
 *   ⑤ 抄前缀 messages[0..idx]，每条重新生成 id + 写 copiedFromMessageId + status 一律 'done'
 *   ⑥ 算 memoryBounds 快照（源分支已有的边界全部夹到 idx，再补上自己）
 *   ⑦ 写 branches.json（append，makeActive=true —— 派生即激活）
 *
 * 🔴 **派生完就独立**（P6 修订）：新分支不持有任何指向父分支的**活引用**。
 *    父分支只以两张快照留在新分支里 —— forkedFrom（给人看的一行字）与
 *    memoryBounds（记忆可见范围）。之后父分支改名、继续写、被整个删掉，
 *    这条分支的读写、检索、召回范围完全不变。
 *
 * 🔴 ⑤ 的三条硬规矩：重新生成 id（同 id 会让 mapMessage 语义崩）/ 写 copiedFrom 保可追溯 /
 *    status 一律 'done'（把 'streaming' 抄过去，新会话会永远转圈）。
 */
export function deriveBranch(draft: StoryDeriveDraft): { branch: StoryBranch; sessionId: string } {
  const storyId = String(draft?.storyId ?? '')
  if (!isStoryId(storyId) || !storyStore.get(storyId)) {
    throw new Error('故事区不存在：' + storyId)
  }

  const sessions = chatService.listSessionsByStory(storyId)
  const source = sessions.find((session) => session.id === draft.fromSessionId)
  if (!source) throw new Error('分支不存在：' + draft.fromSessionId)

  const idx = source.messages.findIndex((message) => message.id === draft.fromMessageId)
  if (idx < 0) throw new Error('消息不存在：' + draft.fromMessageId)

  // 先把根分支懒迁移出来 —— 这样「分支 N」的 N 才是准的，也保证 append 有结构可加
  const file =
    branchStore.ensure(storyId, sessions.map(toBranchSessionInfo)) ??
    ({ version: STORY_BRANCHES_VERSION, activeBranchId: '', branches: [] } as StoryBranchesFile)
  const sourceBranch = file.branches.find((branch) => branch.branchId === source.id)
  const title =
    (draft.title && draft.title.trim()) || STORY_BRANCH_TITLE_PREFIX + String(file.branches.length + 1)

  const session = chatService.createSession({ mode: 'story', storyId, title })

  const copies: Message[] = source.messages.slice(0, idx + 1).map((message) => ({
    id: randomUUID(),
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: 'done',
    copiedFromMessageId: message.id
  }))
  chatService.appendMessages(session.id, copies)

  const branch: StoryBranch = {
    branchId: session.id,
    title,
    createdAt: Date.now(),
    forkedFrom: {
      branchId: source.id,
      title: (sourceBranch?.title && sourceBranch.title.trim()) || source.title?.trim() || '原分支',
      messageNumber: idx + 1,
      messageId: draft.fromMessageId
    },
    memoryBounds: boundsAfterFork(sourceBranch?.memoryBounds, source.id, idx, session.id)
  }
  branchStore.append(storyId, branch, true)
  return { branch, sessionId: session.id }
}

/**
 * 派生时的可见范围快照 —— 全仓唯一一处算它的地方。
 *
 * 旧规则：self → 无上界；第 k 层祖先 → 沿父链取**最小**分叉下标。
 * 派生出来的新分支的规则：自己 → 无上界；源分支 → min(源边界, idx) = idx（源边界本来就是无上界）；
 * 更上层祖先 → min(它的边界, idx)。
 * 所以「把源分支那张快照整体夹到 idx，再补上自己」与旧算法逐字等价 —— 只是把结果存下来了。
 */
function boundsAfterFork(
  sourceBounds: StoryMemoryBound[] | undefined,
  sourceId: string,
  forkIndex: number,
  newId: string
): StoryMemoryBound[] {
  const base: StoryMemoryBound[] =
    sourceBounds && sourceBounds.length > 0
      ? sourceBounds
      : [{ branchId: sourceId, maxMessageIndex: null }]

  const merged = new Map<string, number | null>()
  for (const bound of base) {
    const clamped = bound.maxMessageIndex === null ? forkIndex : Math.min(bound.maxMessageIndex, forkIndex)
    const prev = merged.get(bound.branchId)
    merged.set(bound.branchId, prev === undefined ? clamped : prev === null ? clamped : Math.min(prev, clamped))
  }
  // 源分支那一层必须有：它的边界就是分叉下标（缺了会让源分支的记忆整片消失）
  if (!merged.has(sourceId)) merged.set(sourceId, forkIndex)

  const out: StoryMemoryBound[] = [{ branchId: newId, maxMessageIndex: null }]
  for (const [branchId, maxMessageIndex] of merged) out.push({ branchId, maxMessageIndex })
  return out
}

/**
 * 删分支（P6 / T7）。
 *
 * 🔴 P6 修订：**不再有「不能删有子分支的分支」** —— 分支之间没有父子关系，
 *    删掉任何一条都不会让别人的结构变形（子分支本来就不依赖它存在）。
 *    现在只剩两条拒绝，都不是「依赖」，而是「故事得有东西可看」：
 *      ① 分支必须存在（静默成功会让调用方以为删掉了）
 *      ② 不能删最后一条（删完这个故事就没有会话可进了）
 *    删的正好是活跃分支时：**允许**，接替者取剩下的里面最近活动的那条。
 *
 * 🔴 顺序：先写 branches.json，再删会话（J-12：结构先落地，数据后消失）。
 *    反过来中途失败会留下「会话没了但列表里还挂着」的幽灵条目。
 * 🔴 删分支 = 删会话（M13），**不可逆**（C10）。
 */
export function deleteBranch(storyId: string, branchId: string): StoryBranchesFile {
  if (!isStoryId(storyId)) throw new Error('非法的故事区 id：' + String(storyId))
  const file = branchStore.read(storyId)
  if (!file) throw new Error('分支不存在：' + branchId)
  const target = file.branches.find((branch) => branch.branchId === branchId)
  if (!target) throw new Error('分支不存在：' + branchId)
  if (file.branches.length <= 1) throw new Error('这是故事里最后一条分支，删了就没有会话可进了')

  const remaining = file.branches.filter((branch) => branch.branchId !== branchId)
  const nextActiveId =
    file.activeBranchId === branchId
      ? pickNextActive(remaining, chatService.listSessionsByStory(storyId))
      : undefined

  const next = branchStore.remove(storyId, branchId, nextActiveId)
  chatService.deleteSession(branchId)
  return next
}

/** 删掉活跃分支后接替谁：剩下的里面「最近说过话」的那条（没有会话信息时退回创建时间） */
function pickNextActive(
  remaining: StoryBranch[],
  sessions: { id: string; updatedAt: number }[]
): string | undefined {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  let best: string | undefined
  let bestAt = Number.NEGATIVE_INFINITY
  for (const branch of remaining) {
    const session = byId.get(branch.branchId)
    const at = session ? session.updatedAt : branch.createdAt
    if (at > bestAt) {
      bestAt = at
      best = branch.branchId
    }
  }
  return best
}
