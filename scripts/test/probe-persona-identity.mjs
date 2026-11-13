/**
 * P3 行为探针：一条消息到底落进哪个 (userId, personaId) 租户。
 *
 * 这套东西不进主测链，只产机器可读的 key=value，供 before / after 差集比对。
 *
 * 为什么必须单独存在：P3 之前，所有发送者的记忆都串在 root/default；
 * P3 之后按 sink.senderId 分租户。**只有 before 快照才能证明这条改动真的生效**
 * （经验库 V13：标量基线全绿也可能是没动过）。
 *
 * 跑法：
 *   node scripts/test/probe-persona-identity.mjs --mode=before
 *   node scripts/test/probe-persona-identity.mjs --mode=after
 *
 * 🔴 顺序铁律（P15）：before 必须在改 chatService.ts **之前**跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const modeArg = process.argv.find((item) => item.startsWith('--mode='))
const MODE = modeArg ? modeArg.slice('--mode='.length) : 'unknown'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-persona-identity-'))
installElectronStub(userData)

// 记忆开着（否则 chatService 直接跳过召回与抽取）；摘要关掉（它是用户的功能，与本探针无关）
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    memory: { enabled: true, autoExtract: true },
    summary: { enabled: false }
  }),
  'utf8'
)

/* ── 桩：rag 门面（记录租户，并把落点真的写进临时库） ───────────────── */

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-persona-identity-stubs-'))
const storePath = p('src/main/features/rag/store.ts')

const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  [
    'import { MemoryStore } from ' + JSON.stringify(storePath),
    'const g = globalThis as any',
    'g.__probe = g.__probe ?? { recall: [], extract: [], history: [] }',
    'const store = new MemoryStore()',
    'export const memoryService = {',
    '  async buildContextBlock(query: string, settings: any, tenants: any[]) {',
    '    g.__probe.recall.push({ query, tenants })',
    '    return ""',
    '  },',
    '  async extractInBackground(params: any) {',
    '    g.__probe.extract.push({ sessionId: params.sessionId, tenant: params.tenant })',
    '    // 落点写进真库：这样「记忆落哪个租户」是读盘得到的，不是抄桩记录',
    '    store.upsert({',
    '      content: "MEM:" + params.sessionId + ":" + params.messageId,',
    '      userId: params.tenant.userId,',
    '      personaId: params.tenant.personaId,',
    '      sourceSessionId: params.sessionId,',
    '      sourceMessageId: params.messageId',
    '    })',
    '    return null',
    '  },',
    '  appendHistory(entry: any) {',
    '    g.__probe.history.push(entry)',
    '    store.appendHistory(entry)',
    '  },',
    '  activePersona(userId: string) { return store.activePersona(userId) },',
    '  upsertPersona(userId: string, personaId: string, activate?: boolean) {',
    '    store.upsertPersona(userId, personaId, activate)',
    '  },',
    '  listPersonas(userId: string) { return store.listPersonas(userId) },',
    '  listByTenant(userId: string, personaId: string) { return store.listByTenant(userId, personaId) },',
    '  recentHistory(userId: string, personaId: string, limit: number) {',
    '    return store.recentHistory(userId, personaId, limit)',
    '  },',
    '  status() { return { enabled: true } },',
    '  dispose() {}',
    '}',
    'export { MemoryStore }'
  ].join('\n'),
  'utf8'
)

const llmStub = path.join(stubDir, 'llm-stub.ts')
fs.writeFileSync(
  llmStub,
  [
    'export function createProvider() {',
    '  return {',
    '    id: "stub",',
    '    label: "stub",',
    '    offline: true,',
    '    async *stream() {',
    '      yield { type: "text", text: "收到，记住了。" }',
    '      yield { type: "finish" }',
    '    }',
    '  }',
    '}',
    'export function describeProviders() { return [] }'
  ].join('\n'),
  'utf8'
)

const plugin = {
  name: 'probe-stubs',
  setup(build) {
    const isChat = (importer) => (importer || '').replace(/\\/g, '/').endsWith('features/chat/chatService.ts')
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) => (isChat(args.importer) ? { path: ragStub } : null))
    build.onResolve({ filter: /^\.\.\/llm$/ }, (args) => (isChat(args.importer) ? { path: llmStub } : null))
  }
}

const mod = await bundleModule(
  'persona-identity',
  [
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { HeadlessSink } from '${p('src/main/features/chat/sink.ts')}'`,
    `export { QqSink } from '${p('src/main/features/qq/sink.ts')}'`,
    `export { MemoryStore } from '${storePath}'`
  ].join('\n'),
  [plugin]
)
const { chatService, HeadlessSink, QqSink, MemoryStore } = mod

const probe = globalThis.__probe
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等抽取落地：轮询而不是固定 sleep，避免慢机器上抓到「还没写」 */
async function waitExtract(before) {
  for (let i = 0; i < 80; i += 1) {
    if (probe.extract.length > before) return
    await sleep(25)
  }
}

/* ── 预置：alice 已经切到 work 人设（P4 的 //switch 干的事），其余用户全新 ── */
const setupStore = new MemoryStore()
setupStore.upsertPersona('alice', 'default', false)
setupStore.upsertPersona('alice', 'work', true)
setupStore.close()

const DESKTOP_TEXT = '我是桌面端的本机用户，今天想聊聊天气怎么样'
const ALICE_TEXT = '我叫爱丽丝，我在做花店的准备工作，请记住这件事'
const BOB_TEXT = '我叫鲍勃，我住在上海，周末喜欢去公园散步'
const CAROL_TEXT = '我叫卡罗尔，这是我这辈子第一次跟你说话哦'

/* ── 四个场景：桌面 / 渠道私聊(alice) / 渠道群聊(bob) / 渠道全新用户(carol) ── */
const desktop = chatService.createSession({ mode: 'chat' })
const aliceSession = chatService.ensureChannelSession('qq:10001:private:alice', { title: '爱丽丝' })
const bobSession = chatService.ensureChannelSession('qq:10002:group:88888', { title: '鲍勃群' })
const carolSession = chatService.ensureChannelSession('qq:10003:private:carol', { title: '卡罗尔' })

const broadcast = () => {}

const scenarios = [
  { key: 'desktop', session: desktop, sink: new HeadlessSink(), text: DESKTOP_TEXT },
  { key: 'alice', session: aliceSession, sink: new QqSink(broadcast, 'alice'), text: ALICE_TEXT },
  { key: 'bob', session: bobSession, sink: new QqSink(broadcast, 'bob'), text: BOB_TEXT },
  { key: 'carol', session: carolSession, sink: new QqSink(broadcast, 'carol'), text: CAROL_TEXT }
]

for (const item of scenarios) {
  const before = probe.extract.length
  await chatService.sendAwait({ sessionId: item.session.id, content: item.text }, item.sink)
  await waitExtract(before)
  // 历史写入（P3 新增）在 finally 里同步落，这里多等一拍防异步链
  await sleep(60)
}

/* ── 读盘：落点一律从真库读，不信桩记录 ───────────────────────────── */
const disc = new MemoryStore()
const rows = disc.list()

const tenantOfSession = (sessionId) => {
  const hit = rows.filter((row) => row.sourceSessionId === sessionId)
  if (hit.length === 0) return '(none)'
  return hit.map((row) => row.userId + '/' + row.personaId).join('+')
}

const SENDER_ROWS = [aliceSession, bobSession, carolSession]
  .map((session) => tenantOfSession(session.id))
  .join(',')
const DESKTOP_ROWS = tenantOfSession(desktop.id)

/** 只列真有人设行的租户，外加 root/default 作为对照 */
const pairs = [
  ['alice', 'default'],
  ['alice', 'work'],
  ['bob', 'default'],
  ['carol', 'default'],
  ['root', 'default']
]
const historyRows = []
for (const [userId, personaId] of pairs) {
  const list = disc.recentHistory(userId, personaId, 20)
  if (list.length > 0) historyRows.push(userId + '/' + personaId + ':' + String(list.length))
}
const HISTORY_ROWS = historyRows.length > 0 ? historyRows.join(',') : '(空)'

const carolPersonas = disc.listPersonas('carol')
const AUTO_REGISTERED = carolPersonas.length > 0

/** 历史租户是否与记忆租户一致：每个场景分别比 */
let matchAll = true
for (const [session, sender, personaId] of [
  [aliceSession, 'alice', 'work'],
  [bobSession, 'bob', 'default'],
  [carolSession, 'carol', 'default'],
  [desktop, 'root', 'default']
]) {
  const memoryTenant = tenantOfSession(session.id)
  const history = disc.recentHistory(sender, personaId, 5)
  if (history.length === 0 || memoryTenant !== sender + '/' + personaId) matchAll = false
}
const HISTORY_TENANT_MATCHES_MEMORY = matchAll

/* ── 自检：桌面端在两种模式下都必须落 root/default，否则桩没接通 ───── */
const SELFCHECK = DESKTOP_ROWS === 'root/default' && rows.length >= 4 ? 'ok' : 'FAIL'
disc.close()

console.log('MODE=' + MODE)
console.log('SENDER_ROWS=' + SENDER_ROWS)
console.log('DESKTOP_ROWS=' + DESKTOP_ROWS)
console.log('HISTORY_ROWS=' + HISTORY_ROWS)
console.log('AUTO_REGISTERED=' + String(AUTO_REGISTERED))
console.log('HISTORY_TENANT_MATCHES_MEMORY=' + String(HISTORY_TENANT_MATCHES_MEMORY))
console.log('SELFCHECK=' + SELFCHECK)

process.exit(SELFCHECK === 'ok' ? 0 : 1)
