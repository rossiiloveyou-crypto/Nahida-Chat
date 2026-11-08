import { randomUUID } from 'node:crypto'
import type { Message } from '@shared/types'
import type { StoryBranch, StoryBranchesFile, StoryDeriveDraft } from '@shared/story'
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
 *   ⑥ 写 branches.json（append，makeActive=true —— 派生即激活）
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
    parentBranchId: source.id,
    parentMessageId: draft.fromMessageId,
    parentMessageIndex: idx,
    createdAt: Date.now(),
    title
  }
  branchStore.append(storyId, branch, true)
  return { branch, sessionId: session.id }
}

/**
 * 删分支（P6 / T7）—— **三道拒绝，缺一不可**：
 *   ① 不能删活跃分支（否则用户当前的稿被换掉）
 *   ② 不能删有子分支的分支（否则树形静默改变）
 *   ③ 分支必须存在（静默成功会让调用方以为删掉了）
 *
 * 🔴 顺序：先写 branches.json，再删会话（J-12：结构先落地，数据后消失）。
 *    反过来中途失败会留下「会话没了但树里还挂着」的幽灵节点。
 * 🔴 删分支 = 删会话（M13），**不可逆**（C10）。
 */
export function deleteBranch(storyId: string, branchId: string): StoryBranchesFile {
  if (!isStoryId(storyId)) throw new Error('非法的故事区 id：' + String(storyId))
  const file = branchStore.read(storyId)
  if (!file) throw new Error('分支不存在：' + branchId)
  const target = file.branches.find((branch) => branch.branchId === branchId)
  if (!target) throw new Error('分支不存在：' + branchId)
  if (file.activeBranchId === branchId) throw new Error('不能删除当前分支')
  if (file.branches.some((branch) => branch.parentBranchId === branchId)) {
    throw new Error('先处理它的子分支，再删除这条分支')
  }

  const next = branchStore.remove(storyId, branchId)
  chatService.deleteSession(branchId)
  return next
}
