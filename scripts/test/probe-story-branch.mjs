/**
 * 探针 P-1 · 分支树（P6 §7.2）。
 *
 * 用法：node scripts/test/probe-story-branch.mjs --phase=before|after
 *   before = P6 之前：这个区没有 branches.json（没有「分支树」这个概念）
 *   after  = P6 之后：造 3 层（根 → A → B），打印 getBranchTree 的扁平序列
 *          （depth / msgs / active / parent@msg）
 *
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
fs.writeFileSync(ragStub, 'export const memoryService = { async buildContextBlock() { return "" }, async extractInBackground() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n', 'utf8')
const plugin = {
  name: 'probe-rag-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) => (args.importer.endsWith('chatService.ts') ? { path: ragStub } : null))
  }
}
const mod = await bundleModule(
  'probe-story-branch',
  [
    `export { deriveBranch, getBranchTree } from '${p('src/main/features/story/service.ts')}'`,
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { StoryStore } from '${p('src/main/features/story/store.ts')}'`,
    `export { storyBranchesPath } from '${p('src/main/features/story/paths.ts')}'`
  ].join('\n'),
  [plugin]
)
const { deriveBranch, getBranchTree, chatService, StoryStore, storyBranchesPath } = mod

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
  console.log('P-1 分支树 · BEFORE（P6 之前）')
  console.log('branches.json: ' + (exists ? 'EXISTS' : 'ABSENT'))
  console.log('说明：P6 之前没有分支树概念，getBranchTree 不存在；一个故事区只有 createStory 建的一条会话。')
  process.exit(0)
}

const root = chatService.createSession({ mode: 'story', storyId: story.storyId, title: '根' })
addMessages(root.id, 8, 'r')
const A = deriveBranch({ storyId: story.storyId, fromSessionId: root.id, fromMessageId: 'r3', title: 'A' })
const aSession = chatService.listSessionsByStory(story.storyId).find((s) => s.id === A.sessionId)
const B = deriveBranch({ storyId: story.storyId, fromSessionId: A.sessionId, fromMessageId: aSession.messages[2].id, title: 'B' })

const tree = getBranchTree(story.storyId)
console.log('P-1 分支树 · AFTER（P6 之后，3 层：根 → A → B）')
console.log('depth | msgs | active | node<parent@msg')
const walk = (nodes, depth) => {
  for (const node of nodes) {
    console.log(
      depth + ' | ' + node.messageCount + ' | ' + (node.isActive ? 'YES' : 'no') + ' | ' + node.title + '<' + (node.parentBranchId ? 'parent' : 'ROOT') + '@' + String(node.parentMessageIndex)
    )
    walk(node.children, depth + 1)
  }
}
walk(tree, 0)

// V11：已知答案自检 —— 根 8 条、A 复制前缀 4 条、树应正好 1 个根
const rootNode = tree[0]
const ok = tree.length === 1 && rootNode.messageCount === 8 && rootNode.children.length === 1 && rootNode.children[0].messageCount === 4 && rootNode.children[0].children.length === 1
console.log('SELFCHECK=' + (ok ? 'ok' : 'FAIL'))
if (!ok) process.exit(1)
