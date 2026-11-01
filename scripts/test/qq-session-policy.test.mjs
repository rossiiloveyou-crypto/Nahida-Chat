/**
 * 记忆域（P5 G5 → P6 改写：会话身份改由外部键承担，不再注入绑定表）。
 *
 * 旧断言（P4）：绑定到 QQ 的会话「完全隔离」，recall 0 次、extract 0 次。
 * 新断言（P5）：QQ 会话**记在自己的域里**，recall 1 次（scopes=[自己的域]）、
 *               extract 1 次（scope=自己的域）。
 * P6 改写：会话 id 就是外部键（qq:<uin>:<type>:<id>），域由 zones/scope 的解析式判定给出，
 *           不再是「往测试里塞一张 sessionId → 域 的假表」。
 *
 * 保留 P4 的对照物：桌面会话仍然走 zone:root（拒绝「全都不召回」的坏实现）。
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
// 记录的是「调用了几次 + 传了哪些域」。
globalThis.__memProbe = {
  recall: 0,
  extract: 0,
  scopes: [],
  extractScopes: [],
  async buildContextBlock(_query, _settings, scopes) {
    globalThis.__memProbe.recall += 1
    globalThis.__memProbe.scopes.push(scopes)
    return 'MEMORY-BLOCK'
  },
  async extractInBackground(params) {
    globalThis.__memProbe.extract += 1
    globalThis.__memProbe.extractScopes.push(params.scope)
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

const { chatService, HeadlessSink, setSessionPolicy, sessionPolicy, createScopeResolver, ZoneStore, soloScope } =
  await bundleModule(
    'policy',
    [
      `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
      `export { HeadlessSink } from '${p('src/main/features/chat/sink.ts')}'`,
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
check('域解析：未归区的群 → solo:外部键', JSON.stringify(resolver.resolveRecallScopes(channelSession.id)) === JSON.stringify([SOLO]), JSON.stringify(resolver.resolveRecallScopes(channelSession.id)))
check('域解析：桌面 UUID → zone:root', resolver.resolvePrimaryScope(normalSession.id) === 'zone:root', resolver.resolvePrimaryScope(normalSession.id))

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
  '召回时传的 scopes 就是它自己的域',
  JSON.stringify(globalThis.__memProbe.scopes.at(-1)) === JSON.stringify([SOLO]),
  JSON.stringify(globalThis.__memProbe.scopes.at(-1))
)

let boundExtract = 0
for (let i = 0; i < 60 && boundExtract === 0; i += 1) {
  await sleep(50)
  boundExtract = globalThis.__memProbe.extract - before.extract
}
check('extractInBackground 调用 1 次（P4 是 0 次）', boundExtract === 1, boundExtract)
check(
  '抽取写入的 scope 就是它自己的域',
  globalThis.__memProbe.extractScopes.at(-1) === SOLO,
  String(globalThis.__memProbe.extractScopes.at(-1))
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
  'scopes = [zone:root]',
  JSON.stringify(globalThis.__memProbe.scopes.at(-1)) === JSON.stringify(['zone:root']),
  JSON.stringify(globalThis.__memProbe.scopes.at(-1))
)
let normalExtract = 0
for (let i = 0; i < 60 && normalExtract === 0; i += 1) {
  await sleep(50)
  normalExtract = globalThis.__memProbe.extract - beforeNormal.extract
}
check('抽取 1 次（对照物）', normalExtract === 1, normalExtract)
check('抽取 scope = zone:root', globalThis.__memProbe.extractScopes.at(-1) === 'zone:root', String(globalThis.__memProbe.extractScopes.at(-1)))

console.log('scopes = [] 的会话：fail-closed')
const beforeMuted = { recall: globalThis.__memProbe.recall, extract: globalThis.__memProbe.extract }
const mutedOutcome = await chatService.sendAwait(
  { sessionId: mutedSession.id, content: '这条不该进任何域' },
  new HeadlessSink()
)
check('对话本身仍然跑完', mutedOutcome.status === 'done', mutedOutcome.status)
check('召回 0 次', globalThis.__memProbe.recall - beforeMuted.recall === 0, globalThis.__memProbe.recall - beforeMuted.recall)
await sleep(400)
check('抽取 0 次', globalThis.__memProbe.extract - beforeMuted.extract === 0, globalThis.__memProbe.extract - beforeMuted.extract)

done()
