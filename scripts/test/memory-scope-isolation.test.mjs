/**
 * A4 按租户召回与写入（P1 起：用户 × 人设）—— 本 Phase 最关键的一组。
 *
 * 两个方向都要断言（D33）：自己的租户命中、别人的租户不命中。
 * 只断言「不命中」的话，一个「永远返回空串」的坏实现也能全绿。
 *
 * P1 改动说明（T1 判据集变更）：原判据按 `scopeId` 构造记忆；
 * `MemoryEntry` 已无 `scopeId`，分区键换成 `(userId, personaId)`。
 * P2 改动说明（T1）：旧 scope 门面已删除，`buildContextBlock` 的第三参改成 `PersonaIdentity[]`。
 * 于是本套件从「过渡桥恒等映射」改成「检索层与数据层**都**做双向租户隔离」，
 * 并新增「传 [] = 不召回」的 fail-closed 断言；「省略 scopes = 全库」那条生产门面测试被删除
 * （门面已无此入口，留着它等于留一条测不到任何行为的空转判据）。
 *
 * embedder 与 LLM 抽取都被桩掉：本判据测的是**租户过滤**，不是模型质量。
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

// ── 桩：embedding 模型不加载（本判据只测租户过滤）────────────────────────────
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

/* P1：三个租户 = 桌面的 root/default、QQ 用户的 alice/work、QQ 用户的 bob/default */
const ROOT = { userId: 'root', personaId: 'default' }
const ALICE = { userId: 'alice', personaId: 'work' }
const BOB = { userId: 'bob', personaId: 'default' }
/*
 * 🔴 P2：两个方向都要断言（D33）—— 自己的租户命中、别人的租户不命中。
 *    只断言「不命中」的话，一个「永远返回空串」的坏实现也能全绿，所以每条否定断言都配正向对照。
 *    检索层（buildContextBlock）与数据层（allWithEmbeddingInTenants / keywordSearchInTenants）**都**做双向，
 *    避免「只在 key 拼接上做隔离」（B8）。
 */

const SETTINGS = { enabled: true, autoExtract: true, topK: 5, budgetTokens: 1200, minScore: 0 }

/* 🔴 数据层隔离必须要真向量：allWithEmbeddingInTenants 只返回 embedding IS NOT NULL 的行。
   本套件把 embedder 桩成返回 null（检索层的向量路径本来就走不通），所以这里直接塞一个
   确定的 1024 维向量 —— 测的是「租户过滤是否生效」，不是模型。 */
const fakeVector = (seedValue) => {
  const vec = new Float32Array(1024)
  for (let i = 0; i < vec.length; i += 1) vec[i] = ((i % 13) + seedValue) / 13
  return vec
}

seed.upsert({ content: '我住在上海', ...ROOT, embedding: fakeVector(1) })
seed.upsert({ content: '群友说喜欢猫', ...ALICE, embedding: fakeVector(2) })
seed.upsert({ content: '柯基叫豆豆', ...BOB, embedding: fakeVector(3) })
seed.upsert({ content: '柯基爱散步', ...BOB, embedding: fakeVector(4) })

const block = (query, tenants) => memoryService.buildContextBlock(query, SETTINGS, tenants)

console.log('1 · 检索层双向隔离：alice 命中自己的、bob 命中自己的')
const aliceBlock = await block('喜欢猫', [ALICE])
check('alice/work 命中「喜欢猫」', aliceBlock.includes('群友说喜欢猫'), aliceBlock.replace(/\n/g, ' | ') || '(空)')
check('反向对照：alice 看不到 root 的「上海」', !aliceBlock.includes('上海'), aliceBlock.replace(/\n/g, ' | ') || '(空)')
const bobBlock = await block('柯基', [BOB])
check('bob/default 命中「柯基」', bobBlock.includes('柯基'), bobBlock.replace(/\n/g, ' | ') || '(空)')
check('反向对照：bob 看不到 alice 的「猫」', !bobBlock.includes('喜欢猫'), bobBlock.replace(/\n/g, ' | ') || '(空)')
const rootBlock = await block('上海', [ROOT])
check('root/default 命中「上海」', rootBlock.includes('我住在上海'), rootBlock.replace(/\n/g, ' | ') || '(空)')
check('反向对照：root 看不到别人的「柯基」', !rootBlock.includes('柯基'), rootBlock.replace(/\n/g, ' | ') || '(空)')

console.log('2 · 同一用户不同 persona / 不同用户同 persona 都不串味')
const splitUser = { userId: 'carol', personaId: 'work' }
const splitUserOther = { userId: 'carol', personaId: 'home' }
seed.upsert({ content: '卡罗尔在工作人设下说要加班', ...splitUser, embedding: fakeVector(5) })
seed.upsert({ content: '卡罗尔在家人设下说想养猫', ...splitUserOther, embedding: fakeVector(6) })
const asWork = await block('卡罗尔', [splitUser])
const asHome = await block('卡罗尔', [splitUserOther])
check('carol/work 命中「加班」', asWork.includes('加班'), asWork.replace(/\n/g, ' | ') || '(空)')
check('carol/work 看不到 carol/home 的内容', !asWork.includes('想养猫'), asWork.replace(/\n/g, ' | ') || '(空)')
check('carol/home 命中「想养猫」', asHome.includes('想养猫'), asHome.replace(/\n/g, ' | ') || '(空)')
check('carol/home 看不到 carol/work 的内容', !asHome.includes('加班'), asHome.replace(/\n/g, ' | ') || '(空)')

console.log('3 · 数据层：真正的租户隔离（双向）')
const aliceVec = seed.allWithEmbeddingInTenants([ALICE])
check('alice/work 只读到自己的 1 条', aliceVec.length === 1 && aliceVec[0].content === '群友说喜欢猫', aliceVec.length)
const bobVec = seed.allWithEmbeddingInTenants([BOB])
check('bob/default 读到自己的 2 条', bobVec.length === 2, bobVec.length)
check('alice 的结果里没有 bob 的内容', aliceVec.every((item) => item.userId === 'alice'))
check('bob 的结果里没有 alice 的内容', bobVec.every((item) => item.userId === 'bob'))
const mixed = seed.allWithEmbeddingInTenants([ALICE, BOB])
check('传两个租户 = 3 条（只取这两个，不含 root）', mixed.length === 3, mixed.length)
/* FTS 的入参必须是 toMatchQuery 处理过的 MATCH 串，直接喂原文分词不出来（原实现同理） */
const mod2 = await bundleModule('memory-tokenize', [`export { toMatchQuery } from '${p('src/main/features/rag/tokenize.ts')}'`].join('\n'))
const { toMatchQuery } = mod2
const keywordAlice = seed.keywordSearchInTenants(toMatchQuery('喜欢猫'), [ALICE], 10)
check('FTS 也按租户过滤：alice 关键词命中 1 条', keywordAlice.length === 1, keywordAlice.length)
const keywordBob = seed.keywordSearchInTenants(toMatchQuery('喜欢猫'), [BOB], 10)
check('FTS 反向对照：bob 关键词命中 0 条', keywordBob.length === 0, keywordBob.length)
const keywordRoot = seed.keywordSearchInTenants(toMatchQuery('喜欢猫'), [ROOT], 10)
check('FTS 反向对照：root 关键词命中 0 条', keywordRoot.length === 0, keywordRoot.length)
const keywordCarol = seed.keywordSearchInTenants(toMatchQuery('卡罗尔'), [splitUser], 10)
check('FTS 同用户不同 persona：carol/work 只命中自己的 1 条', keywordCarol.length === 1, keywordCarol.length)

console.log('4 · tenants = [] → 不召回（fail-closed，不是全库）')
const emptyBlock = await block('上海', [])
check('返回空串', emptyBlock === '', JSON.stringify(emptyBlock))
/* P17：对照物为空时否定断言自动通过，所以先证明同一个查询在正常租户下确实有命中 */
const emptyControl = await block('上海', [ROOT])
check('对照物：同一查询在 root 下命中「上海」（否则上一条无意义）', emptyControl.includes('我住在上海'), emptyControl.replace(/\n/g, ' | ') || '(空)')

console.log('5 · 门面不再接受「省略租户 = 全库」')
const noTenantBlock = await memoryService.buildContextBlock('上海', SETTINGS, undefined)
check('传 undefined 也返回空串（不是全库）', noTenantBlock === '', JSON.stringify(noTenantBlock))
check(
  'buildContextBlock 的第三个形参名为 tenants（旧 scope 门面已删除）',
  memoryService.buildContextBlock.toString().includes('tenants')
)

console.log('6 · 落库的租户字段是真值（读盘，不读内存）')
const rowsAll = seed.list()
check(
  '各自落在正确的 (userId, personaId)',
  rowsAll.some((item) => item.content === '我住在上海' && item.userId === 'root' && item.personaId === 'default') &&
    rowsAll.some((item) => item.content === '群友说喜欢猫' && item.userId === 'alice' && item.personaId === 'work') &&
    rowsAll.filter((item) => item.userId === 'bob' && item.personaId === 'default').length === 2 &&
    rowsAll.some((item) => item.content === '卡罗尔在工作人设下说要加班' && item.personaId === 'work') &&
    rowsAll.some((item) => item.content === '卡罗尔在家人设下说想养猫' && item.personaId === 'home'),
  rowsAll.map((item) => item.content + '@' + item.userId + '/' + item.personaId).join(', ')
)
check('读回的条目**没有** scopeId 字段', rowsAll.every((item) => !('scopeId' in item)))

console.log('7 · extractInBackground 写入指定租户')
globalThis.__facts = ['群友喜欢柯基']
await memoryService.extractInBackground({
  sessionId: 'S-88',
  messageId: 'm-88',
  userText: '群里有人养了一只柯基犬叫豆豆',
  settings: SETTINGS,
  provider: null,
  llmSettings: null,
  signal: new AbortController().signal,
  tenant: ALICE
})
const aliceRows = seed.listByTenant(ALICE.userId, ALICE.personaId)
check(
  '新条目落在 alice/work',
  aliceRows.some((item) => item.content === '群友喜欢柯基'),
  aliceRows.map((item) => item.content).join(', ')
)
check(
  '对照：没有落进 bob/default',
  !seed.listByTenant(BOB.userId, BOB.personaId).some((item) => item.content === '群友喜欢柯基')
)

console.log('8 · 缺 tenant（运行时 undefined）→ 不写库，也不落 root/default')
globalThis.__facts = ['缺租户时不该写进来的记忆']
await memoryService.extractInBackground({
  sessionId: 'S-99',
  messageId: 'm-99',
  userText: '这是一条来自漏传租户调用方的长文本',
  settings: SETTINGS,
  provider: null,
  llmSettings: null,
  signal: new AbortController().signal,
  tenant: undefined
})
const anywhere = seed.list().some((item) => item.content === '缺租户时不该写进来的记忆')
check('全库都找不到这条（缺租户 = 不写）', !anywhere, anywhere)
check(
  '对照：root/default 没有被兜底写入（旧行为会静默落到这里）',
  !seed.listByTenant('root', 'default').some((item) => item.content === '缺租户时不该写进来的记忆'),
  seed.listByTenant('root', 'default').map((item) => item.content).join(', ')
)
seed.close()
done()
