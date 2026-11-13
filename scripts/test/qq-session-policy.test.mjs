/**
 * 记忆域（P5 G5 → P6 改写：会话身份改由外部键承担，不再注入绑定表）。
 *
 * 旧断言（P4）：绑定到 QQ 的会话「完全隔离」，recall 0 次、extract 0 次。
 * 新断言（P5）：QQ 会话**记在自己的域里**，recall 1 次、extract 1 次。
 * P6 改写：会话 id 就是外部键（qq:<uin>:<type>:<id>），域由 zones/scope 的解析式判定给出。
 * P2 改写：记忆门面的入参从「旧 scope 字符串数组」换成 PersonaIdentity[]，
 *          抽取入参从 scope 换成 tenant。route.scope 只剩「有没有可写域」的哨兵语义。
 * P3 改写：租户不再恒为 root/default，改由 sink.senderId 解析（chatService.memoryTenantOf）。
 *          桌面 / 无头 sink 仍落 root/default —— 那是**对照物**，不许删；
 *          另加一组「渠道 + 带发言人」的断言，证明它落的是发言人租户。
 *
 * 跑法：node scripts/test/qq-session-policy.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-policy-test-'))
installElectronStub(userData)

// 记忆开着：能召回的会话必须真的去召回/抽取
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: true, autoExtract: true } }),
  'utf8'
)

// 用 stub 顶替 rag 模块：真去加载 embedding 模型会拖几分钟，而且与本判据无关。
// 记录的是「调用了几次 + 传了哪些租户」。

/** 桌面 / 无头 sink 的租户（P3 起是 fail-safe 兜底值，不再是「所有人共用」的唯一值） */
const TENANT = { userId: 'root', personaId: 'default' }
/** P3：渠道会话 + sink.senderId 之后，租户 = 发言人 */
const SENDER_TENANT = { userId: '10001', personaId: 'default' }
globalThis.__memProbe = {
  recall: 0,
  extract: 0,
  tenants: [],
  extractTenants: [],
  history: [],
  // P3：chatService 现在会通过门面读人设表、写人设历史，桩必须补齐这四个方法，
  // 否则会抛「memoryService.activePersona is not a function」——
  // 那会把「桩不完整」伪装成产品缺陷（P2 报告 §十 记过同一类坑）。
  activePersona: () => null,
  upsertPersona: () => {},
  appendHistory(entry) {
    globalThis.__memProbe.history.push(entry)
  },
  async buildContextBlock(_query, _settings, tenants) {
    globalThis.__memProbe.recall += 1
    globalThis.__memProbe.tenants.push(tenants)
    return 'MEMORY-BLOCK'
  },
  async extractInBackground(params) {
    globalThis.__memProbe.extract += 1
    globalThis.__memProbe.extractTenants.push(params.tenant)
    return null
  }
}

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-rag-stub-'))
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  'export const memoryService = (globalThis as unknown as { __memProbe: unknown }).__memProbe\n',
  'utf8'
)

const plugin = {
  name: 'stub-rag',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) => {
      if (args.importer.endsWith('chatService.ts')) return { path: ragStub }
      return null
    })
  }
}

const { chatService, HeadlessSink, QqSink, setSessionPolicy, sessionPolicy, createScopeResolver, ZoneStore, soloScope } =
  await bundleModule(
    'policy',
    [
      `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
      `export { HeadlessSink } from '${p('src/main/features/chat/sink.ts')}'`,
      `export { QqSink } from '${p('src/main/features/qq/sink.ts')}'`,
      `export { setSessionPolicy, sessionPolicy } from '${p('src/main/features/chat/sessionPolicy.ts')}'`,
      `export { createScopeResolver } from '${p('src/main/features/zones/scope.ts')}'`,
      `export { ZoneStore } from '${p('src/main/features/zones/store.ts')}'`,
      `export { soloScope } from '${p('src/shared/zones.ts')}'`
    ].join('\n'),
    [plugin]
  )

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// P6：真实的渠道会话 id（会话在第一次 ensure 时凭空建出来）
const CHANNEL_KEY = 'qq:10001:group:88888'
const channelSession = chatService.ensureChannelSession(CHANNEL_KEY, { title: '测试群' })
const normalSession = chatService.createSession({ mode: 'chat' })
const mutedSession = chatService.createSession({ mode: 'chat' })

// 用**真实**的域解析器接线（空 ZoneStore：该群未归区 → solo:外部键）
const emptyZoneStore = new ZoneStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-policy-zones-')))
const resolver = createScopeResolver({ zones: emptyZoneStore })
const SOLO = soloScope(CHANNEL_KEY)

setSessionPolicy({
  isMemoryIsolated: (id) => id === channelSession.id,
  recallScopes: (id) => (id === mutedSession.id ? [] : resolver.resolveRecallScopes(id)),
  primaryScope: (id) => (id === mutedSession.id ? '' : resolver.resolvePrimaryScope(id)),
  injectOwnerProfile: (id) => id !== mutedSession.id
})

check(
  '注册表四个方法齐全',
  ['isMemoryIsolated', 'recallScopes', 'primaryScope', 'injectOwnerProfile'].every(
    (key) => typeof sessionPolicy()[key] === 'function'
  )
)
check('渠道会话被标为「隔离」', sessionPolicy().isMemoryIsolated(channelSession.id) === true)
check('桌面会话不被隔离', sessionPolicy().isMemoryIsolated(normalSession.id) === false)

console.log('渠道会话：记在自己的域（P5 新语义 + P6 解析式判定）')
check(
  '域解析：未归区的群 → solo:外部键',
  JSON.stringify(resolver.resolveRecallScopes(channelSession.id)) === JSON.stringify([SOLO]),
  JSON.stringify(resolver.resolveRecallScopes(channelSession.id))
)
check(
  '域解析：桌面 UUID → zone:root',
  resolver.resolvePrimaryScope(normalSession.id) === 'zone:root',
  resolver.resolvePrimaryScope(normalSession.id)
)

const before = { recall: globalThis.__memProbe.recall, extract: globalThis.__memProbe.extract }
const boundOutcome = await chatService.sendAwait(
  { sessionId: channelSession.id, content: '记住我说的话' },
  new HeadlessSink()
)
check('对话本身仍然跑完', boundOutcome.status === 'done' && boundOutcome.content.length > 0, boundOutcome.status)
check(
  'recallMemory 调用 1 次（P4 是 0 次）',
  globalThis.__memProbe.recall - before.recall === 1,
  globalThis.__memProbe.recall - before.recall
)
check(
  '无头 sink 的召回租户 = [root/default]（P3 起是 fail-safe 兜底值，不是「所有人共用」）',
  JSON.stringify(globalThis.__memProbe.tenants.at(-1)) === JSON.stringify([TENANT]),
  JSON.stringify(globalThis.__memProbe.tenants.at(-1))
)

const waitExtract = async (from) => {
  let got = 0
  for (let i = 0; i < 60 && got === 0; i += 1) {
    await sleep(50)
    got = globalThis.__memProbe.extract - from
  }
  return got
}

const boundExtract = await waitExtract(before.extract)
check('extractInBackground 调用 1 次（P4 是 0 次）', boundExtract === 1, boundExtract)
check(
  '无头 sink 的抽取 tenant = root/default',
  JSON.stringify(globalThis.__memProbe.extractTenants.at(-1)) === JSON.stringify(TENANT),
  JSON.stringify(globalThis.__memProbe.extractTenants.at(-1))
)

console.log('桌面会话：必须仍然走 root（对照物）')
const beforeNormal = { recall: globalThis.__memProbe.recall, extract: globalThis.__memProbe.extract }
const normalOutcome = await chatService.sendAwait(
  { sessionId: normalSession.id, content: '今天天气不错' },
  new HeadlessSink()
)
check('桌面会话正常完成', normalOutcome.status === 'done', normalOutcome.status)
check('召回 1 次', globalThis.__memProbe.recall - beforeNormal.recall === 1, globalThis.__memProbe.recall - beforeNormal.recall)
check(
  '桌面会话的召回租户也是 [root/default]',
  JSON.stringify(globalThis.__memProbe.tenants.at(-1)) === JSON.stringify([TENANT]),
  JSON.stringify(globalThis.__memProbe.tenants.at(-1))
)
const normalExtract = await waitExtract(beforeNormal.extract)
check('抽取 1 次（对照物）', normalExtract === 1, normalExtract)
check(
  '桌面会话的抽取租户 = root/default',
  JSON.stringify(globalThis.__memProbe.extractTenants.at(-1)) === JSON.stringify(TENANT),
  JSON.stringify(globalThis.__memProbe.extractTenants.at(-1))
)

console.log('P3：渠道会话 + 带发言人的 sink → 租户 = 发言人（不是 root）')
const senderSession = chatService.ensureChannelSession('qq:10001:private:22222', { title: '私聊' })
const beforeSender = {
  recall: globalThis.__memProbe.recall,
  extract: globalThis.__memProbe.extract,
  history: globalThis.__memProbe.history.length
}
const senderOutcome = await chatService.sendAwait(
  { sessionId: senderSession.id, content: '我叫小P，请记住我' },
  new QqSink(() => {}, '10001')
)
check('带发言人的渠道会话正常完成', senderOutcome.status === 'done', senderOutcome.status)
check(
  '召回 1 次',
  globalThis.__memProbe.recall - beforeSender.recall === 1,
  globalThis.__memProbe.recall - beforeSender.recall
)
check(
  '召回租户 = [10001/default]（发言人租户，不是 root）',
  JSON.stringify(globalThis.__memProbe.tenants.at(-1)) === JSON.stringify([SENDER_TENANT]),
  JSON.stringify(globalThis.__memProbe.tenants.at(-1))
)
const senderExtract = await waitExtract(beforeSender.extract)
check('抽取 1 次', senderExtract === 1, senderExtract)
check(
  '抽取写入的 tenant = 10001/default',
  JSON.stringify(globalThis.__memProbe.extractTenants.at(-1)) === JSON.stringify(SENDER_TENANT),
  JSON.stringify(globalThis.__memProbe.extractTenants.at(-1))
)

// 只比对**这一组新增**的历史：前面几组（桌面 / 无头）本来就该落 root，
// 把它们算进来会让「发言人组」的否定断言恒假。
const senderHistory = globalThis.__memProbe.history.slice(beforeSender.history)
check('人设历史至少写了两条（user + assistant）', senderHistory.length >= 2, senderHistory.length)
check(
  '人设历史写入的租户也是 10001/default',
  senderHistory.length > 0 &&
    senderHistory.every((entry) => entry.userId === '10001' && entry.personaId === 'default'),
  JSON.stringify(senderHistory.map((entry) => entry.userId + '/' + entry.personaId))
)

console.log('没有可写域的会话（route.scope 为空串）：fail-closed')
const beforeMuted = { recall: globalThis.__memProbe.recall, extract: globalThis.__memProbe.extract }
const mutedOutcome = await chatService.sendAwait(
  { sessionId: mutedSession.id, content: '这条不该进任何租户' },
  new HeadlessSink()
)
check('对话本身仍然跑完', mutedOutcome.status === 'done', mutedOutcome.status)
check('召回 0 次', globalThis.__memProbe.recall - beforeMuted.recall === 0, globalThis.__memProbe.recall - beforeMuted.recall)
await sleep(400)
check('抽取 0 次', globalThis.__memProbe.extract - beforeMuted.extract === 0, globalThis.__memProbe.extract - beforeMuted.extract)

done()
