/**
 * P2 行为探针：旧 scope 门面（before）vs 显式租户门面（after）。
 *
 * 这不是单元测试，是**因果证据生成器**：同一个探针在改前 / 改后各跑一次，
 * 用 key=value 输出可被机器差集的两份快照。不进入主测试链。
 *
 * 跑法：
 *   node scripts/test/probe-persona-rag-binding.mjs --mode=before
 *   node scripts/test/probe-persona-rag-binding.mjs --mode=after
 *
 * 期望：
 *   before → OLD_BRIDGE_COLLIDES=true（旧 scope 串味）
 *   after  → NEW_TENANTS_ISOLATED=true / EMPTY_TENANTS_FAIL_CLOSED=true / STORY_PHYSICAL_ISOLATION=true
 *
 * 四条键缺一条即视为探针坏掉（V11：已知答案自检），不会用「全绿」代替因果证据。
 * 桩掉的只有 embedder 与 LLM 抽取：本探针测的是门面合同，不是模型质量。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, bundleModuleWithStubs, installElectronStub, p } from './qq-test-util.mjs'

const mode = process.argv.includes('--mode=after') ? 'after' : 'before'
const problems = []

installElectronStub(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-probe-')))

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-probe-stubs-'))
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
fs.writeFileSync(extractStub, 'export async function extractMemories() { return globalThis.__facts ?? [] }\n', 'utf8')

/*
 * 🔴 必须走 bundleModuleWithStubs：普通 bundleModule 的 alias 会抢在插件 onResolve 之前裁决，
 *    用插件配 './embedder' / './extract' 的桩会**静默失效**，真实 extract 无 provider 时返回 []，
 *    表现成「写入 0 条」的假红。2026-11-11 实测，详见 qq-test-util 里 bundleModuleWithStubs 的注释。
 */
const rag = await bundleModuleWithStubs(
  'p2-probe-rag',
  ["export { memoryService } from '" + p('src/main/features/rag/index.ts') + "'"],
  { './embedder': embedderStub, './extract': extractStub }
)
// MemoryStore 不依赖那两个模块，走普通 bundleModule
const storeMod = await bundleModule(
  'p2-probe-store',
  "export { MemoryStore } from '" + p('src/main/features/rag/store.ts') + "'"
)
const { memoryService } = rag
const { MemoryStore } = storeMod

const SETTINGS = { enabled: true, autoExtract: true, topK: 5, budgetTokens: 1200, minScore: 0 }
/** P2 的目标合同：门面只认 PersonaIdentity。改之前这里是 false。 */
const HAS_TENANT_CONTRACT = memoryService.buildContextBlock.toString().includes('tenants')

const OLD_A = 'solo:qq:1:private:10001'
const OLD_B = 'solo:qq:1:group:88'
const TENANT_A = { userId: 'alice', personaId: 'work' }
const TENANT_B = { userId: 'bob', personaId: 'default' }
// 🔴 两个人各自的话里都要含同一个查询词：否则召回被 minScore / 相对截断挡掉一条，
//    「只看得到自己那条」会变成假阳性（那不是隔离，是没命中）。事实与用户原文都必须含「花店」。
const TALK_TEXT = ['爱丽丝跟我说她在筹备一家花店，准备明年开张', '鲍勃说他也想开一家花店，正在找店面']
const SAID = ['爱丽丝在筹备她的花店', '鲍勃想开花店']
const QUESTION = '花店'
/** 故事区专用的查询词：与第 ① 段不同，避免同一查询词在两处混淆 */
const STORY_QUESTION = '黑猫'

const newStore = (tag) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p2-probe-db-' + tag + '-')), 'memory.db')
  return { file, store: new MemoryStore(file) }
}

/** 重新打开库读取落盘行（证明确实写进了磁盘，不是内存态） */
const readRows = (dbFile) => {
  const store = new MemoryStore(dbFile)
  const rows = store.list()
  store.close()
  return rows
}

/** 改前 / 改后都能跑的召回调用：第三个参数既接受旧 scope 字符串数组，也接受租户数组。 */
/**
 * 召回助手。
 * 优先复用**写入用的那个实例**：P2 实测，同一个库文件被「写实例」与「新实例」交替打开时，
 * 小库偶尔读不到刚落盘的行（不是本 Phase 的行为，不做归因，也不把它混进探针结论）。
 * 需要落盘真值的地方（SAID_ROWS）另用 readRows() 单开一次库。
 */
const recallWith = async (svc, argument, query = QUESTION) => svc.buildContextBlock(query, SETTINGS, argument)

const recall = async (dbFile, argument, query = QUESTION) => {
  const store = new MemoryStore(dbFile)
  const svc = new (Object.getPrototypeOf(memoryService).constructor)(store)
  const text = await svc.buildContextBlock(query, SETTINGS, argument)
  store.close()
  return text
}

/* ── ① 旧门面串味 / 新门面隔离 ─────────────────────────────────── */
const tenants = [TENANT_A, TENANT_B]
const oldScopes = [OLD_A, OLD_B]
const talk = newStore('talk')
const talkSvc = new (Object.getPrototypeOf(memoryService).constructor)(talk.store)
for (let i = 0; i < TALK_TEXT.length; i += 1) {
  globalThis.__facts = [SAID[i]]
  await talkSvc.extractInBackground({
    sessionId: 'S-' + String(i),
    messageId: 'm-' + String(i),
    userText: TALK_TEXT[i],
    settings: SETTINGS,
    provider: null,
    llmSettings: null,
    signal: new AbortController().signal,
    // before：**只给旧 scope**。旧门面的过渡桥把它恒等映射到 root/default，
    //         于是「两个不同 scope」的两条事实落进同一个租户 —— 串味就发生在这里。
    // after ：只给 tenant，两条事实真正按租户落盘。
    ...(mode === 'before' ? { scope: oldScopes[i] } : { tenant: tenants[i] })
  })
}
const rows = readRows(talk.file)

let collides = false
let isolated = false
let emptyClosed = false
let detailTalk = ''

if (mode === 'before') {
  /*
   * 🔴 P1 的过渡桥把**任何**旧 scope 都映射到 root/default，所以这一段的「串味」是：
   *    alice 的旧 scope 与 bob 的旧 scope 拿到**完全相同**的注入块，两个人的事实互相可见。
   *    数据必须写在 root/default（桥的落点）才能被旧 scope 召回 —— 这正是串味的证据本身。
   */
  const asA = await recallWith(talkSvc, [OLD_A])
  const asB = await recallWith(talkSvc, [OLD_B])
  collides = asA !== '' && asA === asB && SAID.every((fact) => asA.includes(fact))
  detailTalk = 'A=' + String(Number(asA.includes(SAID[0]))) + '/' + String(Number(asA.includes(SAID[1]))) +
    ' B=' + String(Number(asB.includes(SAID[0]))) + '/' + String(Number(asB.includes(SAID[1])))
} else {
  if (!HAS_TENANT_CONTRACT) problems.push('门面未建立租户合同（buildContextBlock 仍不见 tenants）')
  const asA = await recallWith(talkSvc, [TENANT_A])
  const asB = await recallWith(talkSvc, [TENANT_B])
  isolated =
    asA.includes(SAID[0]) && !asA.includes(SAID[1]) &&
    asB.includes(SAID[1]) && !asB.includes(SAID[0])
  detailTalk = 'A=' + String(Number(asA.includes(SAID[0]))) + '/' + String(Number(asA.includes(SAID[1]))) +
    ' B=' + String(Number(asB.includes(SAID[0]))) + '/' + String(Number(asB.includes(SAID[1])))

  /* ── ② 空租户 fail-closed ───────────────────────────────────── */
  const empty = await recallWith(talkSvc, [])
  const control = await recallWith(talkSvc, [TENANT_A])
  // 正向对照必须在：空串 + 对照物也空 = 数据没造出来，那不是隔离生效
  emptyClosed = empty === '' && control.includes(SAID[0])
}

if (rows.length !== 2) problems.push('写入条数 ' + String(rows.length) + ' ≠ 2')

/* ── ③ 故事库物理隔离 ─────────────────────────────────────────── */
// P2 不改故事区选库逻辑：一故事一库是既有事实，这里把 before / after 共有的这条事实记下来。
const storyTenant = { userId: 'root', personaId: 'default' }
const storyFacts = ['故事里她收留了一只黑猫', '故事里也收留了一只黑猫']
const storyArg = HAS_TENANT_CONTRACT ? [storyTenant] : [OLD_A]
// 两个故事库各写一条**查询词相同**的事实：各自只应看到自己那条，且库里只有 1 行
const storyA = newStore('story-a')
storyA.store.upsert({ content: storyFacts[0], ...storyTenant, weight: 1 })
const rowsA = storyA.store.list().length
storyA.store.close()
const storyB = newStore('story-b')
storyB.store.upsert({ content: storyFacts[1], ...storyTenant, weight: 1 })
const rowsB = storyB.store.list().length
storyB.store.close()
const storyBlockA = await recall(storyA.file, storyArg, STORY_QUESTION)
const storyBlockB = await recall(storyB.file, storyArg, STORY_QUESTION)
const storyIsolated =
  storyA.file !== storyB.file &&
  rowsA === 1 && rowsB === 1 &&
  storyBlockA.includes(storyFacts[0]) && !storyBlockA.includes(storyFacts[1]) &&
  storyBlockB.includes(storyFacts[1]) && !storyBlockB.includes(storyFacts[0])
console.log('DETAIL_STORY=' + JSON.stringify({ rowsA, rowsB, a: storyBlockA.length, b: storyBlockB.length, aSelf: storyBlockA.includes(storyFacts[0]), aOther: storyBlockA.includes(storyFacts[1]), bSelf: storyBlockB.includes(storyFacts[1]), bOther: storyBlockB.includes(storyFacts[0]) }))

/* ── 输出（机器可解析 key=value）────────────────────────────────── */
console.log('MODE=' + mode)
console.log('TENANT_CONTRACT=' + String(HAS_TENANT_CONTRACT))
console.log('SAID_ROWS=' + String(rows.length))
console.log('RETAINED_ROWS=' + rows.map((row) => row.userId + '/' + row.personaId).join(','))
console.log('DETAIL_TALK=' + detailTalk)
if (mode === 'before') {
  console.log('OLD_BRIDGE_COLLIDES=' + String(collides))
} else {
  console.log('NEW_TENANTS_ISOLATED=' + String(isolated))
  console.log('EMPTY_TENANTS_FAIL_CLOSED=' + String(emptyClosed))
}
console.log('STORY_PHYSICAL_ISOLATION=' + String(storyIsolated))

const expected =
  mode === 'before'
    ? { OLD_BRIDGE_COLLIDES: true, STORY_PHYSICAL_ISOLATION: true }
    : { NEW_TENANTS_ISOLATED: true, EMPTY_TENANTS_FAIL_CLOSED: true, STORY_PHYSICAL_ISOLATION: true }
const actual = {
  OLD_BRIDGE_COLLIDES: collides,
  NEW_TENANTS_ISOLATED: isolated,
  EMPTY_TENANTS_FAIL_CLOSED: emptyClosed,
  STORY_PHYSICAL_ISOLATION: storyIsolated
}
for (const key of Object.keys(expected)) {
  if (actual[key] !== expected[key]) problems.push(key + '=' + String(actual[key]) + '，期望 ' + String(expected[key]))
}
const selfcheck = problems.length === 0
console.log('SELFCHECK=' + (selfcheck ? 'ok' : 'FAIL'))
if (!selfcheck) {
  console.log('PROBLEMS=' + problems.join(' | '))
  process.exit(1)
}
