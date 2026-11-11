/**
 * 故事区记忆隔离（P4 / J-09）—— A-08…A-12，**四个方向**。
 *
 * 只断言「不命中」的话，一个「永远返回空串」的坏实现也能全绿（P17）。
 * 所以 A-08 是**正向对照物**：先证明「能命中」，再证明「不命中」。
 *
 * embedder 与 LLM 抽取都被桩掉：本判据测的是**库与域**，不是模型质量。
 *
 * 跑法：node scripts/test/story-memory-isolation.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-iso-'))
installElectronStub(userData)

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-iso-stubs-'))
const embedderStub = path.join(stubDir, 'embedder-stub.ts')
fs.writeFileSync(
  embedderStub,
  [
    'export const embedder = {',
    '  async embedOne() { return null },',
    '  async embed() { return null },',
    '  status() { return { ready: false, dimensions: 0, modelPath: "", lastError: null } },',
    '  modelInstalled() { return false }',
    '}'
  ].join('\n'),
  'utf8'
)
const extractStub = path.join(stubDir, 'extract-stub.ts')
fs.writeFileSync(
  extractStub,
  'export async function extractMemories() { return (globalThis as any).__facts ?? [] }\n',
  'utf8'
)
const plugin = {
  name: 'stub-rag-deps',
  setup(build) {
    const inRag = (importer) => importer.includes('features/rag') || importer.includes('features\\rag')
    build.onResolve({ filter: /^\.\/embedder$/ }, (args) => (inRag(args.importer) ? { path: embedderStub } : null))
    build.onResolve({ filter: /^\.\/extract$/ }, (args) => (inRag(args.importer) ? { path: extractStub } : null))
  }
}

const mod = await bundleModule(
  'story-iso',
  [
    `export { memoryService, MemoryService } from '${p('src/main/features/rag/index.ts')}'`,
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`,
    `export { StoryStore } from '${p('src/main/features/story/store.ts')}'`,
    `export { storyMemory, closeStoryMemory, closeAllStoryMemory } from '${p('src/main/features/story/memory.ts')}'`,
    `export { memoryRouteOf, storyScope } from '${p('src/main/features/story/route.ts')}'`,
    `export { storyDbPath, storiesRoot } from '${p('src/main/features/story/paths.ts')}'`
  ].join('\n'),
  [plugin]
)
const { memoryService, MemoryStore, StoryStore, storyMemory, closeAllStoryMemory, memoryRouteOf, storyScope, storyDbPath, storiesRoot } = mod

const SETTINGS = { enabled: true, autoExtract: true, topK: 5, budgetTokens: 1200, minScore: 0 }

/**
 * 🔴 照抄 chatService 的选库方式（§4.10 c / d）：**路由给 storyId 就用那个区的库，否则主库**。
 * 测试如果自己直接拿 storyId 去取库，就绕开了生产路径 —— 那样 M1 突变（路由恒返回 null）
 * 只会让测试崩溃，而不会让「故事记忆跑进主库」这条判据变红（J-05 的现场）。
 */
/*
 * P2：门面 buildContextBlock 的第三参改成 PersonaIdentity[]（不再收旧 scope 字符串）。
 * 故事区的**物理隔离**仍由「一故事一库」保证（下面 A-06 照旧断言），
 * 库内数据行由 TENANT 决定 —— P2 的固定租户是 root/default，P3 才换成真实发送者。
 */
const TENANT = { userId: 'root', personaId: 'default' }

const libOf = (route) => (route.storyId ? storyMemory(route.storyId) : memoryService)
const store = new StoryStore()
const storyA = store.create({ title: '故事A', characterId: 'nahida' }, { characterId: 'nahida' })
const storyB = store.create({ title: '故事B', characterId: 'nahida' }, { characterId: 'nahida' })

const routeA = memoryRouteOf({ id: 'session-a-uuid', storyId: storyA.storyId })
const routeB = memoryRouteOf({ id: 'session-b-uuid', storyId: storyB.storyId })
const routePlain = memoryRouteOf({ id: 'session-plain-uuid' })

check('路由：故事会话指向自己的库', routeA.storyId === storyA.storyId, JSON.stringify(routeA))
check('路由：故事会话的域是 story:<id>', routeA.scope === storyScope(storyA.storyId), routeA.scope)
check('路由：普通会话仍是 null 库 + zone:root', routePlain.storyId === null && routePlain.scope === 'zone:root', JSON.stringify(routePlain))
check('路由 fail-closed：形状非法的 storyId 当普通会话', (() => {
  const bad = memoryRouteOf({ id: 'x', storyId: '../../etc' })
  return bad.storyId === null && bad.scope === 'zone:root'
})())

// 两个区的库文件必须真的不同（M11 物理隔离的第一道）
check('A-06 两区 memory.db 是两个文件', storyDbPath(storyA.storyId) !== storyDbPath(storyB.storyId), storyDbPath(storyA.storyId) + ' vs ' + storyDbPath(storyB.storyId))
check('A-06 两区库都在 stories/ 下', storyDbPath(storyA.storyId).startsWith(path.join(userData, 'stories')), storyDbPath(storyA.storyId))

/* ── 写入：故事 A 一条、故事 B 一条、通用一条 ──────────────────────── */

globalThis.__facts = ['故事A里她收留了一只黑猫']
await libOf(routeA).extractInBackground({
  sessionId: 'session-a-uuid',
  messageId: 'msg-a-1',
  userText: '故事里她收留了一只黑猫，取名叫乌乌',
  settings: SETTINGS,
  provider: null,
  llmSettings: null,
  signal: new AbortController().signal,
  tenant: TENANT
})

// 🔴 关键词命中的是**子串**：事实文本必须真的含查询词，否则「不命中」是数据造出来的假象。
globalThis.__facts = ['故事B里大雪封了山路']
await libOf(routeB).extractInBackground({
  sessionId: 'session-b-uuid',
  messageId: 'msg-b-1',
  userText: '故事里外面在下很大的雪，她不想出门',
  settings: SETTINGS,
  provider: null,
  llmSettings: null,
  signal: new AbortController().signal,
  tenant: TENANT
})

globalThis.__facts = ['我住在上海']
await libOf(routePlain).extractInBackground({
  sessionId: 'session-plain-uuid',
  messageId: 'msg-p-1',
  userText: '我住在上海，平时喜欢喝咖啡',
  settings: SETTINGS,
  provider: null,
  llmSettings: null,
  signal: new AbortController().signal,
  tenant: TENANT
})

/* ── 读回 ─────────────────────────────────────────────────────────── */

const blockA = (q) => libOf(routeA).buildContextBlock(q, SETTINGS, [TENANT])
const blockB = (q) => libOf(routeB).buildContextBlock(q, SETTINGS, [TENANT])
const blockPlain = (q) => libOf(routePlain).buildContextBlock(q, SETTINGS, [TENANT])

console.log('A-08 正向对照物：故事 A 自己命中')
const own = await blockA('黑猫')
check('A-08 命中「黑猫」', own.includes('黑猫'), own.replace(/\n/g, ' | ') || '(空)')

console.log('A-09 故事 A → 通用会话不命中')
const plainFromA = await blockPlain('黑猫')
check('A-09 通用会话召回 0 条（不含「黑猫」）', !plainFromA.includes('黑猫'), plainFromA.replace(/\n/g, ' | ') || '(空)')
const plainOwn = await blockPlain('上海')
check('A-09 对照物：通用会话自己的「上海」仍能命中', plainOwn.includes('上海'), plainOwn.replace(/\n/g, ' | ') || '(空)')

console.log('A-10 通用 → 故事 A 不命中（反向，J-09）')
const aFromPlain = await blockA('上海')
check('A-10 故事 A 召回 0 条（不含「上海」）', !aFromPlain.includes('上海'), aFromPlain.replace(/\n/g, ' | ') || '(空)')

console.log('A-11 故事 A ↔ 故事 B 互不可见')
const bFromA = await blockB('黑猫')
check('A-11 故事 B 读不到 A 的「黑猫」', !bFromA.includes('黑猫'), bFromA.replace(/\n/g, ' | ') || '(空)')
const aFromB = await blockA('大雪')
check('A-11 故事 A 读不到 B 的「大雪」', !aFromB.includes('大雪'), aFromB.replace(/\n/g, ' | ') || '(空)')
const bOwn = await blockB('大雪')
check('A-11 对照物：B 自己的「大雪」仍能命中', bOwn.includes('大雪'), bOwn.replace(/\n/g, ' | ') || '(空)')

console.log('A-12 落盘的租户字段是真值（读盘，不读内存）')
closeAllStoryMemory()
const diskA = new MemoryStore(storyDbPath(storyA.storyId))
const rowsA = diskA.list()
check('A-12 故事 A 的库里有 1 条', rowsA.length === 1, rowsA.length)
/*
 * P1 判据集变更（T1）：`MemoryEntry` 已无 `scopeId`，分区键是 (userId, personaId)。
 * 故事区的**物理隔离**由「一个故事一个 memory.db」保证（下面 A-06 那条仍在断言），
 * 逻辑租户在 P2 一律是 root/default（chatService.memoryTenantOf 的兜底值），P3 才换成真实发送者。
 * 这里断言的仍是「落盘值是真值、不是内存态」这一件事。
 */
check(
  'A-12 落盘租户 = root/default（P2 的固定租户；P3 才换真实发送者）',
  rowsA[0] && rowsA[0].userId === 'root' && rowsA[0].personaId === 'default',
  rowsA[0] && rowsA[0].userId + '/' + rowsA[0].personaId
)
check('A-12 条目上**没有**遗留的 scopeId 字段', rowsA[0] && !('scopeId' in rowsA[0]))
diskA.close()
const diskMain = new MemoryStore(path.join(userData, 'memory.db'))
const rowsMain = diskMain.list()
check('A-12 主库里只有普通会话那 1 条', rowsMain.length === 1, rowsMain.map((item) => item.content).join(','))
check(
  'A-12 主库条目的租户也是 root/default',
  rowsMain[0] && rowsMain[0].userId === 'root' && rowsMain[0].personaId === 'default',
  rowsMain[0] && rowsMain[0].userId + '/' + rowsMain[0].personaId
)
diskMain.close()

check('A-06 故事区库与主库不是同一个文件', storyDbPath(storyA.storyId) !== path.join(userData, 'memory.db'))
check('stories/ 根确实建出来了', fs.existsSync(storiesRoot()), storiesRoot())

done()
