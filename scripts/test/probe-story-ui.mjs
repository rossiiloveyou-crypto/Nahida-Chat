/**
 * 探针 P-1 / P-2 · P7 可达性与检索数据面（PHASE-7 §6.5）。
 *
 * 用法：node scripts/test/probe-story-ui.mjs --phase=before|after
 *   before = P7 之前：取 **git HEAD（v0.1 已提交、不含 P7 改动）** 的文件快照来判
 *            —— 侧栏无「故事分区」、preload 无 story:session、service 无 searchStory
 *   after  = P7 之后：读工作区真实文件；另造 1 个故事区（根 10 条含「钟楼」）+ 派生子分支，
 *            真实跑 searchStory 打印命中。
 *
 * 🔴 只读探针：fixture 全在临时 userData 里造，碰不到真实用户目录。
 * 🔴 before 判据来自 git HEAD 的**已提交字节**，不是凭空声称「以前没有」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const phase = (process.argv.find((arg) => arg.startsWith('--phase=')) || '--phase=after').split('=')[1]
const projectRoot = process.cwd()

function gitShow(rel) {
  try {
    return execFileSync('git', ['show', 'HEAD:' + rel.replace(/\\/g, '/')], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (error) {
    return ''
  }
}
function countOf(text, needle) {
  if (!text) return 0
  return text.split(needle).length - 1
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-probe-story-ui-'))
installElectronStub(userData)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ defaultCharacterId: 'nahida', memory: { enabled: false, autoExtract: false } }),
  'utf8'
)

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-probe-story-ui-stub-'))
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  'export const memoryService = { async buildContextBlock() { return "" }, async extractInBackground() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n',
  'utf8'
)
const plugin = {
  name: 'probe-story-ui-rag-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) => (args.importer.endsWith('chatService.ts') ? { path: ragStub } : null))
  }
}

if (phase === 'before') {
  const sidebar = gitShow('src/renderer/src/components/Sidebar.tsx')
  const preload = gitShow('src/preload/index.ts')
  const service = gitShow('src/main/features/story/service.ts')
  console.log('P-1 · 可达性 · BEFORE（P7 之前 = git HEAD 已提交字节）')
  console.log('  侧栏故事分区: ' + (countOf(sidebar, 'B 故事分区') > 0 ? 'PRESENT' : 'ABSENT'))
  console.log('  story:session: ' + (countOf(preload, 'storySession') > 0 ? 'PRESENT' : 'ABSENT'))
  console.log('P-2 · 检索数据面 · BEFORE')
  console.log('  searchStory: ' + (countOf(service, 'export function searchStory') > 0 ? 'PRESENT' : 'ABSENT'))
  process.exit(0)
}

/* ── AFTER：读工作区真实文件 + 造 fixture 跑 searchStory ── */
const sidebarNow = fs.readFileSync(path.join(projectRoot, 'src/renderer/src/components/Sidebar.tsx'), 'utf8')
const preloadNow = fs.readFileSync(path.join(projectRoot, 'src/preload/index.ts'), 'utf8')

const mod = await bundleModule(
  'probe-story-ui',
  [
    "export { createStory, deriveBranch, searchStory } from '" + p('src/main/features/story/service.ts') + "'",
    "export { chatService } from '" + p('src/main/features/chat/chatService.ts') + "'",
    "export { StoryStore } from '" + p('src/main/features/story/store.ts') + "'"
  ].join('\n'),
  [plugin]
)
const { createStory, deriveBranch, searchStory, chatService } = mod

const story = createStory({ title: 'P-2 探针', characterId: 'nahida', worldbookMode: 'default', synopsis: '探针' })
const storyId = story.meta.storyId
const root = chatService.listSessionsByStory(storyId)[0]
const messages = []
for (let i = 0; i < 10; i += 1) {
  messages.push({
    id: 'r' + i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: i === 2 ? '钟楼的指针停在了三点' : '第' + i + '句普通台词',
    createdAt: 1000 + i,
    status: 'done'
  })
}
chatService.appendMessages(root.id, messages)
const derived = deriveBranch({ storyId, fromSessionId: root.id, fromMessageId: 'r4', title: '子分支' })
chatService.appendMessages(derived.sessionId, [
  { id: 'c0', role: 'user', content: '子分支里也提到了钟楼', createdAt: 2000, status: 'done' }
])
const hits = searchStory(storyId, '钟楼')

console.log('P-1 · 可达性 · AFTER（P7 之后 = 工作区真实源码）')
console.log('  侧栏故事分区: ' + (countOf(sidebarNow, 'B 故事分区') > 0 ? 'PRESENT' : 'ABSENT'))
console.log('  story:session: ' + (countOf(preloadNow, 'storySession') > 0 ? 'PRESENT' : 'ABSENT'))
console.log('P-2 · 检索数据面 · AFTER')
const childHit = hits.find((hit) => hit.branchId === derived.sessionId)
console.log('  searchStory: hits=' + hits.length + '（含子分支命中=' + (childHit ? 'yes' : 'no') + '）')
