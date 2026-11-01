/**
 * A4 按域召回与写入（P5 G4/G5）—— 本 Phase 最关键的一组。
 *
 * 两个方向都要断言（D33）：自己的域命中、别人的域不命中。
 * 只断言「不命中」的话，一个「永远返回空串」的坏实现也能全绿。
 *
 * embedder 与 LLM 抽取都被桩掉：本判据测的是**域过滤**，不是模型质量。
 *
 * 跑法：node scripts/test/memory-scope-isolation.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-scope-'))
installElectronStub(userData)

// ── 桩：embedding 模型不加载（本判据只测域过滤）────────────────────────────
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-stubs-'))
const embedderStub = path.join(stubDir, 'embedder-stub.ts')
fs.writeFileSync(
  embedderStub,
  [
    'export const embedder = {',
    '  async embedOne() { return null },',
    '  async embed(list) { return null },',
    '  status() { return { ready: false, dimensions: 0, modelPath: "", lastError: null } },',
    '  modelInstalled() { return false }',
    '}'
  ].join('\n'),
  'utf8'
)
const extractStub = path.join(stubDir, 'extract-stub.ts')
fs.writeFileSync(
  extractStub,
  'export async function extractMemories() { return globalThis.__facts ?? [] }\n',
  'utf8'
)
const plugin = {
  name: 'stub-rag-deps',
  setup(build) {
    build.onResolve({ filter: /^\.\/embedder$/ }, (args) =>
      args.importer.includes('features/rag') || args.importer.includes('features\\rag') ? { path: embedderStub } : null
    )
    build.onResolve({ filter: /^\.\/extract$/ }, (args) =>
      args.importer.includes('features/rag') || args.importer.includes('features\\rag') ? { path: extractStub } : null
    )
  }
}

const mod = await bundleModule(
  'memory-scope',
  [
    `export { memoryService } from '${p('src/main/features/rag/index.ts')}'`,
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`
  ].join('\n'),
  [plugin]
)
const { memoryService, MemoryStore } = mod

const dbFile = path.join(userData, 'memory.db')
const seed = new MemoryStore(dbFile)
const ROOT = 'zone:root'
const SOLO = 'solo:qq:1:group:88'
const ZONE_A = 'zone:zone_a'
const SETTINGS = { enabled: true, autoExtract: true, topK: 5, budgetTokens: 1200, minScore: 0 }

seed.upsert({ content: '我住在上海', scopeId: ROOT })
seed.upsert({ content: '群友说喜欢猫', scopeId: SOLO })
seed.upsert({ content: '柯基叫豆豆', scopeId: ZONE_A })
seed.upsert({ content: '柯基爱散步', scopeId: ZONE_A })

const block = (query, scopes) => memoryService.buildContextBlock(query, SETTINGS, scopes)

console.log('1 · solo 域只读自己')
const soloBlock = await block('喜欢猫吗', [SOLO])
check('命中「猫」', soloBlock.includes('喜欢猫'), soloBlock.replace(/\n/g, ' | '))
check('读不到桌面的「上海」', !soloBlock.includes('上海'), soloBlock.replace(/\n/g, ' | '))

console.log('2 · root 域读不到群里的东西（反向对照）')
const rootBlock = await block('上海', [ROOT])
check('命中「上海」', rootBlock.includes('上海'), rootBlock.replace(/\n/g, ' | '))
check('读不到群里的「猫」', !rootBlock.includes('猫'), rootBlock.replace(/\n/g, ' | '))

console.log('3 · 同一区块的两个群共享记忆')
const zoneBlock = await block('柯基', [ZONE_A])
check('两条都命中', zoneBlock.includes('叫豆豆') && zoneBlock.includes('爱散步'), zoneBlock.replace(/\n/g, ' | '))

console.log('4 · scopes = [] → 不召回（fail-closed，不是全库）')
const emptyBlock = await block('上海', [])
check('返回空串', emptyBlock === '', JSON.stringify(emptyBlock))

console.log('5 · scopes 省略 → 全库（仅为兼容，生产不许这么调）')
const legacyBlock = await block('上海', undefined)
check('仍能命中「上海」', legacyBlock.includes('上海'), legacyBlock.replace(/\n/g, ' | '))

console.log('6 · extractInBackground 写入指定域')
globalThis.__facts = ['群友喜欢柯基']
await memoryService.extractInBackground({
  sessionId: 'S-88',
  messageId: 'm-88',
  userText: '群里有人养了一只柯基犬叫豆豆',
  settings: SETTINGS,
  provider: null,
  llmSettings: null,
  signal: new AbortController().signal,
  scope: SOLO
})
const soloRows = seed.listByScope(SOLO)
check(
  '新条目 scope_id = solo:…',
  soloRows.some((item) => item.content === '群友喜欢柯基' && item.scopeId === SOLO),
  JSON.stringify(soloRows.map((item) => item.content + '@' + item.scopeId))
)

done()
