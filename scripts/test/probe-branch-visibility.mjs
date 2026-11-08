/**
 * 探针 P-2 · 分支记忆可见性（P6 §4.9.1 / §7.2）。
 *
 * 用法：node scripts/test/probe-branch-visibility.mjs --phase=before|after
 *   场景：分支 A 第 12 条说「这个镇上有个钟楼」；从第 5 条分支出 B，问「钟楼」。
 *   before = P5 行为（召回不看 sourceSessionId）→ true（缺陷在）
 *   after  = P6 行为（branchVisibility 过滤）    → false（修好了）
 *
 * 🔴 只读探针：临时 userData；embedder/extract 桩掉（测的是可见性过滤，不是模型）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const phase = (process.argv.find((arg) => arg.startsWith('--phase=')) || '--phase=after').split('=')[1]
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-probe-vis-'))
installElectronStub(userData)
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ defaultCharacterId: 'nahida', memory: { enabled: false, autoExtract: false } }), 'utf8')

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-probe-vis-stub-'))
const embedderStub = path.join(stubDir, 'embedder-stub.ts')
fs.writeFileSync(embedderStub, ['export const embedder = {', '  async embedOne() { return null },', '  async embed() { return null },', '  status() { return { ready: false, dimensions: 0, modelPath: "", lastError: null } },', '  modelInstalled() { return false }', '}'].join('\n'), 'utf8')
const extractStub = path.join(stubDir, 'extract-stub.ts')
fs.writeFileSync(extractStub, 'export async function extractMemories() { return [] }\n', 'utf8')
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(ragStub, 'export const memoryService = { async buildContextBlock() { return "" }, async extractInBackground() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n', 'utf8')
const plugin = {
  name: 'probe-vis-stub',
  setup(build) {
    const inRag = (importer) => importer.includes('features/rag') || importer.includes('features\\rag')
    build.onResolve({ filter: /^\.\/embedder$/ }, (args) => (inRag(args.importer) ? { path: embedderStub } : null))
    build.onResolve({ filter: /^\.\/extract$/ }, (args) => (inRag(args.importer) ? { path: extractStub } : null))
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) => (args.importer.endsWith('chatService.ts') ? { path: ragStub } : null))
  }
}
const mod = await bundleModule(
  'probe-branch-visibility',
  [
    `export { deriveBranch } from '${p('src/main/features/story/service.ts')}'`,
    `export { branchVisibility } from '${p('src/main/features/story/visibility.ts')}'`,
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { StoryStore } from '${p('src/main/features/story/store.ts')}'`,
    `export { storyDbPath } from '${p('src/main/features/story/paths.ts')}'`,
    `export { storyScope } from '${p('src/main/features/story/route.ts')}'`,
    `export { MemoryService } from '${p('src/main/features/rag/index.ts')}'`,
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`
  ].join('\n'),
  [plugin]
)
const { deriveBranch, branchVisibility, chatService, StoryStore, storyDbPath, storyScope, MemoryService, MemoryStore } = mod

const SETTINGS = { enabled: true, autoExtract: true, topK: 5, budgetTokens: 1200, minScore: 0 }
const store = new StoryStore()
const story = store.create({ title: 'P-2 探针', characterId: 'nahida' }, { characterId: 'nahida' })
const root = chatService.createSession({ mode: 'story', storyId: story.storyId, title: '根' })
const messages = []
for (let i = 0; i < 15; i += 1) {
  messages.push({ id: 'r' + i, role: i % 2 === 0 ? 'user' : 'assistant', content: '第' + i + '句', createdAt: 1000 + i, status: 'done' })
}
chatService.appendMessages(root.id, messages)
const B = deriveBranch({ storyId: story.storyId, fromSessionId: root.id, fromMessageId: 'r4', title: 'B' })

const scope = storyScope(story.storyId)
const mstore = new MemoryStore(storyDbPath(story.storyId))
const svc = new MemoryService(mstore)
mstore.upsert({ content: '这个镇上有个钟楼', scopeId: scope, sourceSessionId: root.id, sourceMessageIndex: 12, weight: 1 })
// 对照物：分叉点之前的事实（分叉点=4）
mstore.upsert({ content: '她怕水', scopeId: scope, sourceSessionId: root.id, sourceMessageIndex: 2, weight: 1 })

const vis = branchVisibility(story.storyId, B.sessionId).visible
const blockBefore = await svc.buildContextBlock('钟楼', SETTINGS, [scope])
const blockAfter = await svc.buildContextBlock('钟楼', SETTINGS, [scope], vis)
const beforeHit = blockBefore.includes('钟楼')
const afterHit = blockAfter.includes('钟楼')

if (phase === 'before') {
  console.log('P-2 记忆可见性 · BEFORE（P5 行为：召回不看 sourceSessionId）')
  console.log('分支 B 能否召回「钟楼」: ' + beforeHit)
  console.log('说明：P5 只按 scope 过滤，同一 story 的所有分支共用一个域 → 分叉点之后的记忆也会被召回。')
  process.exit(0)
}

const control = await svc.buildContextBlock('怕水', SETTINGS, [scope], vis)
console.log('P-2 记忆可见性 · AFTER（P6 行为：branchVisibility 过滤）')
console.log('分支 B 能否召回「钟楼」: ' + afterHit)
console.log('对照物：分支 B 能否召回分叉点之前的事实「怕水」: ' + control.includes('她怕水'))
// V11：已知答案自检
const ok = beforeHit === true && afterHit === false && control.includes('她怕水')
console.log('SELFCHECK=' + (ok ? 'ok' : 'FAIL'))
mstore.close()
if (!ok) process.exit(1)
