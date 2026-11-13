/**
 * 探针 P-1 · 分支列表（P6 `7.2）。
 *
 * 用法：node scripts/test/probe-story-branch.mjs --phase=before|after
 *   before = P6 之前：这个区没有 branches.json（没有「分支」这个概念）
 *   after  = P6 之后：造 3 条（根 → A → B），打印 listStoryBranches 的**扁平**序列
 *          （msgs / active / 出处）
 *
 * 🔴 P6 修订后分支之间没有父子依赖，所以这里**没有 depth 这一列**：
 *    派生来源只以 forkedFrom 快照显示，不代表任何结构关系。
 * 🔴 只读探针：全部在临时 userData 里造数据，碰不到真实用户目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const phase = (process.argv.find((arg) => arg.startsWith('--phase=')) || '--phase=after').split('=')[1]
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-probe-branch-'))
installElectronStub(userData)
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ defaultCharacterId: 'nahida', memory: { enabled: false, autoExtract: false } }), 'utf8')

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-probe-branch-stub-'))
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(ragStub, 'export const memoryService = { async buildContextBlock() { return "" }, async extractInBackground() {}, activePersona() { return null }, upsertPersona() {}, appendHistory() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n', 'utf8')
const plugin = {
  name: 'probe-rag-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) => (args.importer.endsWith('chatService.ts') ? { path: ragStub } : null))
  }
}
const mod = await bundleModule(
  'probe-story-branch',
  [
    "export { deriveBranch, listStoryBranches } from '" + p('src/main/features/story/service.ts') + "'",
    "export { chatService } from '" + p('src/main/features/chat/chatService.ts') + "'",
    "export { StoryStore } from '" + p('src/main/features/story/store.ts') + "'",
    "export { storyBranchesPath } from '" + p('src/main/features/story/paths.ts') + "'"
  ].join('\n'),
  [plugin]
)
const { deriveBranch, listStoryBranches, chatService, StoryStore, storyBranchesPath } = mod

const store = new StoryStore()
const story = store.create({ title: 'P-1 探针', characterId: 'nahida' }, { characterId: 'nahida' })

function addMessages(sessionId, count, prefix) {
  const messages = []
  for (let i = 0; i < count; i += 1) {
    messages.push({ id: prefix + i, role: i % 2 === 0 ? 'user' : 'assistant', content: '第' + i + '句', createdAt: 1000 + i, status: 'done' })
  }
  chatService.appendMessages(sessionId, messages)
}

if (phase === 'before') {
  const exists = fs.existsSync(storyBranchesPath(story.storyId))
  console.log('P-1 分支列表 · BEFORE（P6 之前）')
  console.log('branches.json: ' + (exists ? 'EXISTS' : 'ABSENT'))
  console.log('说明：P6 之前没有分支概念，listStoryBranches 不存在；一个故事区只有 createStory 建的一条会话。')
  process.exit(0)
}

const root = chatService.createSession({ mode: 'story', storyId: story.storyId, title: '根' })
addMessages(root.id, 8, 'r')
const A = deriveBranch({ storyId: story.storyId, fromSessionId: root.id, fromMessageId: 'r3', title: 'A' })
const aSession = chatService.listSessionsByStory(story.storyId).find((s) => s.id === A.sessionId)
const B = deriveBranch({ storyId: story.storyId, fromSessionId: A.sessionId, fromMessageId: aSession.messages[2].id, title: 'B' })

const list = listStoryBranches(story.storyId)
console.log('P-1 分支列表 · AFTER（P6 修订后，3 条**独立**分支：根 / A / B）')
console.log('msgs | active | title | 出处（forkedFrom 快照）')
for (const item of list) {
  const from = item.forkedFrom
    ? item.forkedFrom.title + '@第' + String(item.forkedFrom.messageNumber) + '条'
    : 'ROOT'
  console.log(item.messageCount + ' | ' + (item.isActive ? 'YES' : 'no') + ' | ' + item.title + ' | ' + from)
}

// V11：已知答案自检 —— 根 8 条 / A 复制前缀 4 条 / B 3 条；活跃恰好一个；行上没有 children
const byTitle = new Map(list.map((item) => [item.title, item]))
const ok =
  list.length === 3 &&
  byTitle.get('根').messageCount === 8 &&
  byTitle.get('A').messageCount === 4 &&
  byTitle.get('B').messageCount === 3 &&
  list.filter((item) => item.isActive).length === 1 &&
  list.every((item) => item.children === undefined) &&
  byTitle.get('根').forkedFrom === null
console.log('SELFCHECK=' + (ok ? 'ok' : 'FAIL'))
if (!ok) process.exit(1)
