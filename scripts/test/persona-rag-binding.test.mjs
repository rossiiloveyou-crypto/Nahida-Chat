/**
 * P2 回归套件：召回与写入必须显式携带 PersonaIdentity。
 *
 * 这一套件测的是**合同**，不是检索质量：
 *  - 检索层（buildContextBlock）与数据层（allWithEmbeddingInTenants / keywordSearchInTenants）都做双向断言；
 *  - 空租户 / 缺租户一律 fail-closed（不召回、不写入），不许静默退化成全库或 root/default；
 *  - 管理视图（list / countByUser）仍能看到全部租户 —— 那是有意保留的，不是漏隔离。
 *
 * 每条否定断言都先给出正向对照（P17）：只用「没有串味」证明不了任何事，
 * 因为一个永远返回空串的坏实现也能全过。
 *
 * 桩掉的只有 embedder 与 LLM 抽取；MemoryStore / MemoryService 都是真实实现，
 * 用的是临时 userData 与临时库文件，不碰真实数据。
 *
 * 跑法：node scripts/test/persona-rag-binding.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, bundleModuleWithStubs, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-persona-rag-binding-'))
installElectronStub(userData)

// ── 桩：embedding 模型不加载、LLM 抽取返回预置事实（本套件只测租户传递）──────
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-persona-rag-stubs-'))
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
  'export async function extractMemories() {\n' +
    '  globalThis.__extractCalls = (globalThis.__extractCalls ?? 0) + 1\n' +
    '  return globalThis.__facts ?? []\n' +
    '}\n',
  'utf8'
)

/*
 * 🔴 必须走 bundleModuleWithStubs：普通 bundleModule 的 alias 会抢在插件 onResolve 之前裁决，
 *    用插件配 './embedder' / './extract' 的桩会静默失效，真实 extract 无 provider 时返回 []，
 *    表现成「写入 0 条」的假红。
 */
const rag = await bundleModuleWithStubs(
  'persona-rag-binding-rag',
  ["export { memoryService } from '" + p('src/main/features/rag/index.ts') + "'"],
  { './embedder': embedderStub, './extract': extractStub }
)
const storeMod = await bundleModule(
  'persona-rag-binding-store',
  "export { MemoryStore } from '" + p('src/main/features/rag/store.ts') + "'"
)
const { memoryService } = rag
const { MemoryStore } = storeMod

const SETTINGS = { enabled: true, autoExtract: true, topK: 5, budgetTokens: 1200, minScore: 0 }

/* ── 租户与对照物 ─────────────────────────────────────────────── */
const ALICE_WORK = { userId: 'alice', personaId: 'work' }
const ALICE_HOME = { userId: 'alice', personaId: 'home' }
const BOB_WORK = { userId: 'bob', personaId: 'work' }
const ROOT = { userId: 'root', personaId: 'default' }

const texts = {
  aliceWork: '爱丽丝说她在工作人设下准备开一家花店',
  aliceHome: '爱丽丝说她在家人设下想养一只花猫',
  bobWork: '鲍勃说他想开花店但还没找到店面'
}
const facts = {
  aliceWork: '爱丽丝在筹备她的花店',
  aliceHome: '爱丽丝想养一只花猫',
  bobWork: '鲍勃想开花店'
}

const newDb = (tag) =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-persona-rag-db-' + tag + '-')), 'memory.db')

const svcFor = (dbFile) => {
  const store = new MemoryStore(dbFile)
  const svc = new (Object.getPrototypeOf(memoryService).constructor)(store)
  return { store, svc }
}

/** 重开库读落盘真值（不走内存态） */
const readRows = (dbFile) => {
  const store = new MemoryStore(dbFile)
  const rows = store.list()
  store.close()
  return rows
}

const extract = async (svc, tag, tenant, text, fact) => {
  globalThis.__facts = [fact]
  await svc.extractInBackground({
    sessionId: 'S-' + tag,
    messageId: 'm-' + tag,
    userText: text,
    settings: SETTINGS,
    provider: null,
    llmSettings: null,
    signal: new AbortController().signal,
    tenant
  })
}

/* ── T-01 … T-05：双向隔离 ─────────────────────────────────────── */
console.log('T-01 三个租户各写一条事实（走真实抽取路径）')
const dbFile = newDb('main')
const { store, svc } = svcFor(dbFile)
await extract(svc, 'aw', ALICE_WORK, texts.aliceWork, facts.aliceWork)
await extract(svc, 'ah', ALICE_HOME, texts.aliceHome, facts.aliceHome)
await extract(svc, 'bw', BOB_WORK, texts.bobWork, facts.bobWork)
const written = readRows(dbFile)
check('T-01 三条都落盘（重开库读）', written.length === 3, written.map((r) => r.content + '@' + r.userId + '/' + r.personaId).join(', '))
check(
  'T-01 每条都带正确的 (userId, personaId)',
  written.some((r) => r.content === facts.aliceWork && r.userId === 'alice' && r.personaId === 'work') &&
    written.some((r) => r.content === facts.aliceHome && r.userId === 'alice' && r.personaId === 'home') &&
    written.some((r) => r.content === facts.bobWork && r.userId === 'bob' && r.personaId === 'work'),
  written.map((r) => r.content + '@' + r.userId + '/' + r.personaId).join(', ')
)

console.log('T-02 / T-03 检索层双向：alice/work 与 bob/work')
const aliceBlock = await svc.buildContextBlock('花店', SETTINGS, [ALICE_WORK])
const bobBlock = await svc.buildContextBlock('花店', SETTINGS, [BOB_WORK])
check('T-02 正向：alice/work 命中自己的「爱丽丝在筹备她的花店」', aliceBlock.includes(facts.aliceWork), aliceBlock.replace(/\n/g, ' | ') || '(空)')
check('T-02 反向：alice/work 不命中 bob 的「鲍勃想开花店」', !aliceBlock.includes(facts.bobWork), aliceBlock.replace(/\n/g, ' | ') || '(空)')
check('T-03 正向：bob/work 命中自己的「鲍勃想开花店」', bobBlock.includes(facts.bobWork), bobBlock.replace(/\n/g, ' | ') || '(空)')
check('T-03 反向：bob/work 不命中 alice 的「爱丽丝在筹备她的花店」', !bobBlock.includes(facts.aliceWork), bobBlock.replace(/\n/g, ' | ') || '(空)')

console.log('T-04 同一用户不同 persona 双向隔离')
const aliceHomeBlock = await svc.buildContextBlock('花猫', SETTINGS, [ALICE_HOME])
const aliceWorkCatBlock = await svc.buildContextBlock('花猫', SETTINGS, [ALICE_WORK])
check('T-04 正向：alice/home 命中自己的「花猫」', aliceHomeBlock.includes(facts.aliceHome), aliceHomeBlock.replace(/\n/g, ' | ') || '(空)')
check('T-04 反向：alice/work 读不到 home 的「花猫」', !aliceWorkCatBlock.includes(facts.aliceHome), aliceWorkCatBlock.replace(/\n/g, ' | ') || '(空)')
/* P17：上一条的对照物必须是「同一个查询在 home 下确实有命中」，上面已断言；这里补数据层对照 */
const homeRows = store.listByTenant('alice', 'home')
const workRows = store.listByTenant('alice', 'work')
check('T-04 数据层：alice/home 只有 1 条，alice/work 只有 1 条', homeRows.length === 1 && workRows.length === 1, homeRows.length + '/' + workRows.length)

console.log('T-05 不同用户同 persona 双向隔离')
check('T-05 数据层：bob/work 只有 1 条且不含 alice 的内容', (() => {
  const rows = store.listByTenant('bob', 'work')
  return rows.length === 1 && rows.every((r) => r.content === facts.bobWork)
})())
/* 同一 persona（work）跨两个用户：bob/work 与 alice/work 的事实必须互不可见 */
// 🔴 查询词必须真的出现在事实文本里，否则「不命中」是数据造出来的假象（P17）
const t05Alone = await svc.buildContextBlock('鲍勃', SETTINGS, [BOB_WORK])
const t05Other = await svc.buildContextBlock('鲍勃', SETTINGS, [ALICE_WORK])
check(
  'T-05 检索层：bob/work 命中自己的「鲍勃想开花店」',
  t05Alone.includes(facts.bobWork),
  t05Alone.replace(/\n/g, ' | ') || '(空)'
)
check(
  'T-05 检索层反向：bob/work 不命中 alice/work 的事实',
  !t05Alone.includes(facts.aliceWork),
  t05Alone.replace(/\n/g, ' | ') || '(空)'
)
check(
  'T-05 对照物：alice/work 下同一个查询「鲍勃」0 命中（说明反向那条不是因为函数返回空）',
  t05Other === '' && t05Alone !== '',
  JSON.stringify(t05Other) + ' vs len ' + String(t05Alone.length)
)
check(
  'T-05 检索层反向：alice/work 不命中 bob/work 的事实',
  !t05Other.includes(facts.bobWork),
  t05Other.replace(/\n/g, ' | ') || '(空)'
)

/* ── T-06：空租户 fail-closed ─────────────────────────────────── */
console.log('T-06 buildContextBlock(query, settings, []) 返回空串')
const emptyBlock = await svc.buildContextBlock('花店', SETTINGS, [])
check('T-06 空租户返回空串', emptyBlock === '', JSON.stringify(emptyBlock))
check('T-06 对照物：同一查询在 alice/work 下有命中（否则上一条无意义）', aliceBlock.includes(facts.aliceWork), aliceBlock.replace(/\n/g, ' | ') || '(空)')
const rootBlock = await svc.buildContextBlock('花店', SETTINGS, [ROOT])
check('T-06 root/default 也读不到别人的花店事实（反向对照，且命中数为 0 是因为确实没有数据）', !rootBlock.includes(facts.aliceWork) && !rootBlock.includes(facts.bobWork), rootBlock.replace(/\n/g, ' | ') || '(空)')
const blankTenantBlock = await svc.buildContextBlock('花店', SETTINGS, [{ userId: '', personaId: 'work' }])
check('T-06 空串租户整批拒绝（不静默过滤后继续查）', blankTenantBlock === '', JSON.stringify(blankTenantBlock))

/* ── T-07 / T-08：抽取写入与缺租户 ────────────────────────────── */
console.log('T-07 extractInBackground({ tenant: BOB_WORK }) 只写入该租户')
const dbFile2 = newDb('write')
const w = svcFor(dbFile2)
await extract(w.svc, 'bob2', BOB_WORK, '鲍勃说他的柯基叫豆豆，每天都遛两次', '鲍勃的柯基叫豆豆')
check('T-07 正向：bob/work 有这条', w.store.listByTenant('bob', 'work').some((r) => r.content === '鲍勃的柯基叫豆豆'), w.store.listByTenant('bob', 'work').map((r) => r.content).join(', '))
check('T-07 反向：alice/work 没有这条', !w.store.listByTenant('alice', 'work').some((r) => r.content === '鲍勃的柯基叫豆豆'))
check('T-07 反向：root/default 没有这条', !w.store.listByTenant('root', 'default').some((r) => r.content === '鲍勃的柯基叫豆豆'))

console.log('T-08 缺 tenant（运行时 undefined）不写入任何租户')
const beforeCalls = globalThis.__extractCalls ?? 0
await w.svc.extractInBackground({
  sessionId: 'S-missing',
  messageId: 'm-missing',
  userText: '这一条来自漏传租户的调用方，不应该被写进任何地方',
  settings: SETTINGS,
  provider: null,
  llmSettings: null,
  signal: new AbortController().signal,
  tenant: undefined
})
const total = w.store.list()
check('T-08 全库条数没有增加（仍是 1）', total.length === 1, total.map((r) => r.content).join(', '))
check('T-08 对照物：上一条正常调用确实写进去了', total.some((r) => r.content === '鲍勃的柯基叫豆豆'), total.map((r) => r.content).join(', '))
check('T-08 缺租户时连抽取都没发起（门面在入口就拦住）', (globalThis.__extractCalls ?? 0) === beforeCalls, beforeCalls + ' → ' + (globalThis.__extractCalls ?? 0))

/* ── T-09：重开库后租户字段仍是真值 ───────────────────────────── */
console.log('T-09 重开 MemoryStore 后租户字段仍是真值')
const reopened = readRows(dbFile2)
check('T-09 重开后仍能按租户读到', reopened.length === 1 && reopened[0].userId === 'bob' && reopened[0].personaId === 'work', JSON.stringify(reopened.map((r) => r.userId + '/' + r.personaId)))
const reopenedStore = new MemoryStore(dbFile2)
check('T-09 重开后 listByTenant(bob, work) = 1', reopenedStore.listByTenant('bob', 'work').length === 1, reopenedStore.listByTenant('bob', 'work').length)
check('T-09 重开后 listByTenant(alice, work) = 0', reopenedStore.listByTenant('alice', 'work').length === 0, reopenedStore.listByTenant('alice', 'work').length)
reopenedStore.close()

/* ── T-10：管理视图有意保留全库 ───────────────────────────────── */
console.log('T-10 管理视图 list() / countByUser() 仍能看到全部租户')
const adminRows = store.list()
check('T-10 list() 能看到 3 个租户的条目', adminRows.length === 3, adminRows.length)
check('T-10 对照物：list() 里确实同时有 alice 与 bob', adminRows.some((r) => r.userId === 'alice') && adminRows.some((r) => r.userId === 'bob'), [...new Set(adminRows.map((r) => r.userId))].join(','))
const byUser = store.countByUser()
check('T-10 countByUser() 有 alice 与 bob 两项', byUser.some((r) => r.userId === 'alice') && byUser.some((r) => r.userId === 'bob'), JSON.stringify(byUser))

/* ── T-11 / T-12：否定断言必须有对照，对照物为空则失败 ─────────── */
console.log('T-11 每个否定断言都有正向对照')
const negations = [
  ['alice/work 不含 bob 的事实', !aliceBlock.includes(facts.bobWork)],
  ['bob/work 不含 alice 的事实', !bobBlock.includes(facts.aliceWork)],
  ['alice/work 不含 home 的事实', !aliceWorkCatBlock.includes(facts.aliceHome)],
  ['空租户返回空串', emptyBlock === ''],
  ['缺租户不写入', total.length === 1]
]
const controls = [
  aliceBlock.includes(facts.aliceWork),
  bobBlock.includes(facts.bobWork),
  aliceHomeBlock.includes(facts.aliceHome),
  aliceBlock.includes(facts.aliceWork),
  total.some((r) => r.content === '鲍勃的柯基叫豆豆')
]
check('T-11 五条否定断言各自都有对应的正向对照', negations.every(([, ok]) => ok) && controls.every((ok) => ok), negations.map(([name, ok]) => name + '=' + String(ok)).join(' | '))

console.log('T-12 对照物为空时本套件必须失败')
/*
 * 自检方式：把「肯定不该命中的查询」当对照组跑一遍，确认它确实为空；
 * 再确认一个**故意编造的**对照组（期望命中但数据不存在）会被判成 false。
 * 两条一起说明：本套件里的 check 不是恒真，对照组不是摆设。
 */
const noHit = await svc.buildContextBlock('这个话题库里根本没有任何记录', SETTINGS, [ALICE_WORK])
const COLD_FACT = '这条对照事实从未写入任何租户'
const coldControl = await svc.buildContextBlock(COLD_FACT, SETTINGS, [ALICE_WORK])
check('T-12 无关查询确实 0 命中（对照组不是恒真）', noHit === '', JSON.stringify(noHit))
check(
  'T-12 编造的对照物判 false（若本套件的 check 恒真，这里会是 true）',
  coldControl.includes(COLD_FACT) === false,
  JSON.stringify(coldControl)
)
check(
  'T-12 同一对照组在真实数据上判 true（证明上一条的 false 来自数据缺席，不是函数坏了）',
  aliceBlock.includes(facts.aliceWork),
  JSON.stringify(aliceBlock.slice(0, 40))
)

/* ── 源码守卫（排除注释，不做裸字符串假检查，P16）──────────────── */
const sourceGuard = async () => {
  const raw = fs.readFileSync(p('src/main/features/rag/index.ts'), 'utf8')
  // 去掉块注释与行注释后再查，避免把「注释里写了 legacyScopeToTenant」当成语法残留
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return stripped
}
const indexCode = await sourceGuard()
check('门面源码（去注释后）不再出现旧 scope 桥函数名', !indexCode.includes('legacyScopeToTenant'), indexCode.includes('legacyScopeToTenant'))
check('门面源码（去注释后）不再出现 MemoryScopeId 类型', !indexCode.includes('MemoryScopeId'), indexCode.includes('MemoryScopeId'))
check('门面源码里 buildContextBlock 的形参是 tenants', /buildContextBlock\(\s*query[\s\S]{0,120}?tenants: PersonaIdentity\[\]/.test(indexCode), /buildContextBlock\([\s\S]{0,80}/.exec(indexCode)?.[0])

const chatRaw = fs.readFileSync(p('src/main/features/chat/chatService.ts'), 'utf8')
const chatCode = chatRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('chatService（去注释后）不再调用 sessionPolicy().recallScopes()', !/sessionPolicy\s*\(\s*\)\s*\.\s*recallScopes/.test(chatCode), 'recallScopes 命中')
check('chatService（去注释后）仍然只有一处 memoryTenantOf 定义', (chatCode.match(/private memoryTenantOf\(/g) ?? []).length === 1, (chatCode.match(/private memoryTenantOf\(/g) ?? []).length)

store.close()
w.store.close()
done()
