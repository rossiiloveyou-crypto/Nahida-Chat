/**
 * 对话摘要（会话滚动摘要）行为测试。
 *
 * 测的是**真实边界**，不是「把实现再写一遍」：
 * - 阈值不达到 → 一次模型都不调（否则等于每轮烧钱）
 * - 达到 → 四段并发、游标前移、锚点写对
 * - 删除已覆盖消息 → 按 id 重挂边界；锚点丢失也保留摘要与有界窗口
 * - 消息被清空（游标越界）→ 不崩、不用过期下标切片
 * - 落盘 → 新实例能读回；手改坏字段 → 落回安全默认
 * - 改设置 → 下一次调用立刻生效（不需要重启）
 * - 演示模式（mock）→ 不压缩（假模型写进库比不写更糟）
 * - forget / clear → 只动摘要，不动聊天记录
 *
 * LLM 用桩：本判据测的是**窗口与游标**，不是模型质量。
 *
 * 跑法：node scripts/test/summary-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const deadline = setTimeout(() => { console.error('summary suite deadline exceeded'); process.exit(1) }, 30000)
deadline.unref()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-summary-'))
installElectronStub(userData)

const EXPORTS = [
  "export * from '" + p('src/main/features/summary/service.ts') + "'",
  "export { settingsStore } from '" + p('src/main/features/settings/settingsStore.ts') + "'"
].join('\n')

// ── 1. 老配置（settings.json 里根本没有 summary 这一段）────────────────────────
const modA = await bundleModule('summary-a', EXPORTS)
const defaults = modA.settingsStore.get().summary
check('老配置补出默认开关', defaults.enabled === true)
check('老配置补出触发条数 40', defaults.triggerCount === 40, defaults.triggerCount)
check('老配置补出保留窗口 12', defaults.windowCount === 12, defaults.windowCount)
check('老配置补出四段上限', [
  defaults.shortTermMaxChars,
  defaults.longTermMaxChars,
  defaults.userInfoMaxChars,
  defaults.promisesMaxChars
].join('/') === '400/1200/600/400')

// ── 2. 手改坏的配置：非法值落回默认，越界被夹住 ──────────────────────────────
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    summary: {
      enabled: 'yes',
      triggerCount: 1e9,
      windowCount: -5,
      shortTermMaxChars: 'abc',
      longTermMaxChars: 0,
      userInfoMaxChars: null,
      promisesMaxChars: 3.7
    }
  }),
  'utf8'
)
const modB = await bundleModule('summary-b', EXPORTS)
const repaired = modB.settingsStore.get().summary
check('非布尔开关落回默认', repaired.enabled === true)
check('超上限被夹到 10000', repaired.triggerCount === 10000, repaired.triggerCount)
check('负数被夹到 0', repaired.windowCount === 0, repaired.windowCount)
check('非数字落回默认 400', repaired.shortTermMaxChars === 400, repaired.shortTermMaxChars)
check('0 表示不截断，保留 0', repaired.longTermMaxChars === 0, repaired.longTermMaxChars)
check('null 落回默认 600', repaired.userInfoMaxChars === 600, repaired.userInfoMaxChars)
check('小数四舍五入取整', repaired.promisesMaxChars === 4, repaired.promisesMaxChars)

// ── 3. 运行时行为：用一个可注入的 settings 读者 + 假 LLM ─────────────────────
const BASE = {
  provider: 'mock',
  baseUrl: '',
  apiKey: '',
  model: 'demo',
  temperature: 0.7,
  summary: {
    enabled: true,
    triggerCount: 40,
    windowCount: 12,
    shortTermMaxChars: 400,
    longTermMaxChars: 1200,
    userInfoMaxChars: 600,
    promisesMaxChars: 400
  }
}

let current = { ...BASE, summary: { ...BASE.summary } }
const readSettings = () => ({ ...current, summary: { ...current.summary } })
function setSummary(patch) {
  current = { ...BASE, summary: { ...BASE.summary, ...patch } }
}

function makeProvider() {
  let calls = 0
  const provider = {
    id: 'fake',
    label: 'fake',
    offline: true,
    async *stream(req) {
      calls += 1
      const sys = (req.messages.find((m) => m.role === 'system') || {}).content || ''
      let out = '（空）'
      if (sys.includes('当前话题摘要')) out = '他们正在聊搬家，已经定了下个月的日期。'
      else if (sys.includes('编年史')) out = '用户决定下个月搬去杭州，届时会换工作。'
      else if (sys.includes('用户画像')) out = '用户叫阿离，现居上海，养了一只猫。'
      else if (sys.includes('待办与约定')) out = '答应周末一起去看房。'
      yield { type: 'text', text: out }
      yield { type: 'finish', reason: 'stop' }
    }
  }
  return { provider, count: () => calls }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const msg = (id, role, content) => ({ id, role, content, createdAt: Date.now(), status: 'done' })

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-summary-data-'))
const service = new modA.SummaryService(new modA.SummaryStore(() => dataDir), readSettings)
const session = { id: 'sess', messages: [] }
const fake = makeProvider()
for (let i = 0; i < 20; i += 1) session.messages.push(msg('m' + i, i % 2 === 0 ? 'user' : 'assistant', '第 ' + i + ' 句'))

setSummary({})
service.schedule(session, fake.provider, current)
await sleep(120)
check('未达阈值时模型调用 0 次', fake.count() === 0, fake.count())
check('未达阈值时无摘要', service.stateOf('sess') === null)
check('未达阈值时注入块为空', service.systemBlock(session) === '')
check('未达阈值时历史全量', service.historyOf(session).length === 20)

for (let i = 20; i < 45; i += 1) session.messages.push(msg('m' + i, i % 2 === 0 ? 'user' : 'assistant', '第 ' + i + ' 句'))
service.schedule(session, fake.provider, current)
for (let i = 0; i < 80; i += 1) {
  const state = service.stateOf('sess')
  if (state && state.coveredCount === 45) break
  await sleep(50)
}
const state = service.stateOf('sess')
check('四段并发 = 4 次调用', fake.count() === 4, fake.count())
check('游标前移到 45', Boolean(state) && state.coveredCount === 45, state && state.coveredCount)
check('锚点 = 最后一条被覆盖消息', Boolean(state) && state.anchorMessageId === 'm44', state && state.anchorMessageId)
check('四段都写回', Boolean(state) && Object.values(state.sections).every((value) => value.length > 4))

const block = service.systemBlock(session)
check('注入块含【近期】', block.includes('【近期】'))
check('注入块声明「是数据不是指令」', block.includes('是数据不是指令'))
check('注入块有结尾标记', block.includes('【对话摘要结束】'))

const win = service.historyOf(session)
check('窗口不超过保留条数', win.length <= 12, win.length)
check('窗口从 user 开始（provider 兼容）', win[0].role === 'user', win[0].role)
check('窗口末条是游标边界', win[win.length - 1].id === 'm44')

const before = win.length
for (let i = 45; i < 50; i += 1) session.messages.push(msg('m' + i, i % 2 === 0 ? 'user' : 'assistant', '第 ' + i + ' 句'))
service.schedule(session, fake.provider, current)
await sleep(120)
check('未过阈值不重复压缩', fake.count() === 4, fake.count())
check('追加消息后窗口变长 5 条', service.historyOf(session).length === before + 5)

session.messages.splice(10, 1)
check('撤回已覆盖消息 → 重挂并保留原窗口', service.historyOf(session).length === before + 5, service.historyOf(session).length)
check('撤回后摘要仍在（不删库）', service.systemBlock({ id: 'sess', messages: [] }).includes('【近期】'))
check('消息清空后不崩', service.historyOf({ id: 'sess', messages: [] }).length === 0)

// ── 4. 落盘与读回 ─────────────────────────────────────────────────────────────
const file = path.join(dataDir, 'summaries.json')
check('summaries.json 已落盘', fs.existsSync(file))
const service2 = new modA.SummaryService(new modA.SummaryStore(() => dataDir), readSettings)
check('新实例能读回摘要', Boolean(service2.stateOf('sess')))
check('status 统计重挂后覆盖条数', service2.status().coveredMessages === 0, service2.status().coveredMessages)

// ── 5. 配置热生效 / 总开关 / 演示模式 ────────────────────────────────────────
setSummary({})
const hot = { id: 'hot', messages: [] }
for (let i = 0; i < 6; i += 1) hot.messages.push(msg('h' + i, i % 2 === 0 ? 'user' : 'assistant', '内容 ' + i))
const fakeHot = makeProvider()
service2.schedule(hot, fakeHot.provider, current)
await sleep(100)
check('默认阈值下 6 条不触发', fakeHot.count() === 0, fakeHot.count())
setSummary({ triggerCount: 4 })
service2.schedule(hot, fakeHot.provider, current)
for (let i = 0; i < 40; i += 1) {
  const s = service2.stateOf('hot')
  if (s && s.coveredCount > 0) break
  await sleep(50)
}
check('改阈值后立刻生效（无需重启）', fakeHot.count() === 4, fakeHot.count())

setSummary({ enabled: false })
check('总开关关掉后不注入', service2.systemBlock(hot) === '')
check('总开关关掉后历史全量', service2.historyOf(hot).length === hot.messages.length)
const fakeOff = makeProvider()
service2.schedule(hot, fakeOff.provider, current)
await sleep(80)
check('总开关关掉后不压缩', fakeOff.count() === 0, fakeOff.count())

setSummary({ triggerCount: 2 })
const fakeMock = makeProvider()
fakeMock.provider.id = 'mock'
const demo = { id: 'demo', messages: [msg('a', 'user', '你好'), msg('b', 'assistant', '你好呀'), msg('c', 'user', '在吗')] }
service2.schedule(demo, fakeMock.provider, current)
await sleep(80)
check('演示模式（mock）不压缩', fakeMock.count() === 0, fakeMock.count())

// ── 6. forget / clear 只动摘要 ───────────────────────────────────────────────
service2.forget('sess')
check('forget 清掉该会话', service2.stateOf('sess') === null)
const cleared = service2.clear()
check('clear 后会话数归零', cleared.sessionCount === 0, cleared.sessionCount)
check('clear 后文件仍存在且为空表', JSON.parse(fs.readFileSync(file, 'utf8')).items.sess === undefined)

// ── 7. P3.7 锚点漂移：临时持久库 + 真实 service + 桩 provider ─────────────────
setSummary({ triggerCount: 4, windowCount: 4 })
function anchorFixture(name, count = 36, coveredCount = 24) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-summary-anchor-'))
  const store = new modA.SummaryStore(() => dir)
  const session = { id: name, messages: Array.from({ length: count }, (_, i) =>
    msg('p' + i, i % 2 === 0 ? 'user' : 'assistant', 'ANCHOR_MESSAGE_' + i)) }
  const summary = { sessionId: name, personaId: 'default', coveredCount,
    anchorMessageId: session.messages[coveredCount - 1]?.id ?? 'missing',
    sections: { short_term: '近期记忆', long_term: '长期记忆', user_info: '用户记忆', promises: '重要约定' },
    updatedAt: 1234, lastError: null, lastAttemptAt: 0 }
  store.save(new Map([[name, summary]]))
  const service = new modA.SummaryService(store, readSettings)
  let writes = 0
  const save = store.save.bind(store)
  store.save = map => { writes++; save(map) }
  return { session, summary, service, store, writes: () => writes,
    reload: () => new modA.SummaryService(new modA.SummaryStore(() => dir), readSettings) }
}
const ids = messages => messages.map(m => m.id).join(',')
const stable = anchorFixture('stable')
const stableIds = Array.from({ length: 16 }, (_, i) => 'p' + (20 + i)).join(',')
check('S1 正常窗口逐条 id 与原路径相等', ids(stable.service.historyOf(stable.session)) === stableIds)
check('S1 正常路径不写盘', stable.writes() === 0)

const shifted = anchorFixture('shifted')
shifted.session.messages.splice(6, 1)
const shiftedHistory = shifted.service.historyOf(shifted.session)
check('S2 中间删除仍保留原窗口逐条 id', ids(shiftedHistory) === stableIds)
check('S2 中间删除重挂到仍在的锚点', shifted.service.stateOf('shifted').coveredCount === 23 && shifted.service.stateOf('shifted').anchorMessageId === 'p23')
check('S2 修正已持久化且内容更新时间不变', shifted.reload().stateOf('shifted').coveredCount === 23 && shifted.service.stateOf('shifted').updatedAt === 1234)
check('S2 重挂留下可读诊断且状态页可见', /锚点.*重挂/.test(shifted.service.status().lastError ?? ''))
check('S2 摘要四段逐字保留', JSON.stringify(shifted.service.stateOf('shifted').sections) === JSON.stringify(shifted.summary.sections))

const lost = anchorFixture('lost')
lost.session.messages.splice(23, 1)
check('S5 lost 写回前仍注入长期记忆', lost.service.systemBlock(lost.session).includes('长期记忆'))
const lostHistory = lost.service.historyOf(lost.session)
const healed = lost.service.stateOf('lost')
check('S3 lost 不回落全量且保留既有重叠窗口', ids(lostHistory) === 'p28,p29,p30,p31,p32,p33,p34,p35' && lostHistory.length < lost.session.messages.length)
check('S4 lost 重挂到末尾窗口起点', healed.coveredCount === 31 && healed.anchorMessageId === 'p31')
check('S4 lost 写回可由新实例读回', lost.reload().stateOf('lost').anchorMessageId === 'p31')
check('S4 只改坐标与诊断，时间戳不动', healed.updatedAt === 1234 && healed.lastAttemptAt === 0 && /锚点丢失/.test(healed.lastError ?? ''))
check('S5 lost 写回后仍注入长期记忆', lost.service.systemBlock(lost.session).includes('长期记忆'))
const lostWrites = lost.writes()
check('S6 连续调用输出逐条相等', ids(lost.service.historyOf(lost.session)) === ids(lostHistory))
check('S6 连续调用不重复写盘', lost.writes() === lostWrites && lostWrites === 1)
check('S6 重启后窗口与本轮相等', ids(lost.reload().historyOf(lost.session)) === ids(lostHistory))

const empty = anchorFixture('empty')
empty.session.messages = []
check('S7 清空消息返回空数组', empty.service.historyOf(empty.session).length === 0)
check('S7 清空后边界归零锚点为 null', empty.service.stateOf('empty').coveredCount === 0 && empty.service.stateOf('empty').anchorMessageId === null)
const emptyWrites = empty.writes()
empty.service.historyOf(empty.session)
check('S7 清空后重复调用不写盘', empty.writes() === emptyWrites)
const short = anchorFixture('short')
short.session.messages = [msg('new', 'user', '新对话')]
check('S7 旧边界越界且短于窗口时返回全量', short.service.historyOf(short.session).length === 1 && short.service.stateOf('short').coveredCount === 0)
const over = anchorFixture('over')
over.service.stateOf('over').coveredCount = 100
check('S7 越界但锚点仍在时按 id 找回边界', ids(over.service.historyOf(over.session)) === stableIds && over.service.stateOf('over').coveredCount === 24)

const failedSave = anchorFixture('failed-save')
failedSave.session.messages.splice(23, 1)
failedSave.store.save = () => { throw new Error('P37_WRITE_FAILURE') }
let saveThrew = false, failureHistory
const warnings = [], originalWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
try { failureHistory = failedSave.service.historyOf(failedSave.session) } catch { saveThrew = true } finally { console.warn = originalWarn }
check('写盘失败不影响聊天窗口', !saveThrew && ids(failureHistory ?? []) === ids(lostHistory))
check('写盘失败只警告且内存边界已收敛', warnings.some(w => w.includes('P37_WRITE_FAILURE')) && failedSave.service.stateOf('failed-save').coveredCount === 31)

// 不先调 historyOf：直接在 lost 下 schedule，验证真正送进 provider 的新增对话。
const scheduled = anchorFixture('scheduled', 36, 34)
scheduled.session.messages.splice(33, 1)
const requests = []
const capture = { id: 'fake', async *stream(req) { requests.push(req.messages.at(-1).content); yield { type: 'text', text: '新档案' }; yield { type: 'finish', reason: 'stop' } } }
scheduled.service.schedule(scheduled.session, capture, current)
for (let i = 0; i < 80 && scheduled.service.stateOf('scheduled').coveredCount !== 35; i++) await sleep(10)
check('S8 lost 调度实际调用四段 provider', requests.length === 4, requests.length)
check('S8 压缩输入含旧下标会跳过的消息', requests.length === 4 && requests.every(text => text.includes('ANCHOR_MESSAGE_31') && text.includes('ANCHOR_MESSAGE_32') && text.includes('ANCHOR_MESSAGE_34')))
check('S8 压缩成功后重挂到新尾部并保留提交复核', scheduled.service.stateOf('scheduled').coveredCount === 35 && scheduled.service.stateOf('scheduled').anchorMessageId === 'p35')

// 导出判定函数：先做 service 缺陷回归，再检查四态与纯函数边界。
check('F1 导出两个纯函数', typeof modA.resolveCovered === 'function' && typeof modA.windowStartOf === 'function')
if (typeof modA.resolveCovered === 'function' && typeof modA.windowStartOf === 'function') {
  const config = { enabled: true, triggerCount: 4, windowCount: 4 }
  const resolve = (s, summary, patch = {}) => modA.resolveCovered(s, summary, { ...config, ...patch })
  const snapshot = JSON.stringify(stable.session)
  check('四态 none：无记录、禁用、零边界、空锚点', [resolve(stable.session, null), resolve(stable.session, stable.summary, { enabled: false }), resolve(stable.session, { ...stable.summary, coveredCount: 0 }), resolve(stable.session, { ...stable.summary, anchorMessageId: null })].every(r => r.state === 'none' && r.covered === 0))
  check('S1 纯函数 ok 快路径', resolve(stable.session, stable.summary).state === 'ok' && resolve(stable.session, stable.summary).covered === 24)
  check('S2 纯函数 shifted 按 id 重挂', resolve(shifted.session, shifted.summary).state === 'shifted' && resolve(shifted.session, shifted.summary).covered === 23)
  check('S4 纯函数 lost 新边界', resolve(lost.session, lost.summary).state === 'lost' && resolve(lost.session, lost.summary).covered === 31)
  check('S6 自愈后的判定为 ok', resolve(lost.session, healed).state === 'ok')
  check('纯函数不改输入', JSON.stringify(stable.session) === snapshot)
  const mixed = [msg('old', 'user', '旧'), msg('blank', 'assistant', '  '), msg('one', 'narration', '旁白'), msg('sys', 'system', '注入'), { ...msg('stream', 'assistant', '半句'), status: 'streaming' }, msg('two', 'user', '新')]
  check('窗口只计可读消息，保留中间非可读原记录', modA.windowStartOf(mixed, 2) === 2)
  check('窗口支持从指定边界往回数', modA.windowStartOf(stable.session.messages, 4, 24) === 20)
  check('零窗口边界与空历史', modA.windowStartOf(mixed, 0) === 6 && modA.windowStartOf([], 4) === 0)
  check('S7 lost 短会话的纯函数边界为零', resolve(short.session, short.summary).covered === 0)
}

// 首条 assistant 修正发生在重挂之后，且不拿修正后的起点污染持久坐标。
const assistantFirst = anchorFixture('assistant-first', 35, 24)
assistantFirst.session.messages.splice(23, 1)
const assistantHistory = assistantFirst.service.historyOf(assistantFirst.session)
check('重挂后仍修正首条 assistant', assistantHistory[0].role === 'user')
check('首条修正不改变重挂边界', assistantFirst.service.stateOf('assistant-first').coveredCount === 30 && assistantFirst.service.stateOf('assistant-first').anchorMessageId === 'p30')

setSummary({ enabled: false })
const disabled = anchorFixture('disabled')
disabled.session.messages.splice(23, 1)
check('禁用保持全量、不注入、不自愈写盘', disabled.service.historyOf(disabled.session) === disabled.session.messages && disabled.service.systemBlock(disabled.session) === '' && disabled.writes() === 0)
setSummary({ windowCount: 0 })
const zero = anchorFixture('zero')
zero.session.messages.splice(23, 1)
check('零窗口 lost 重挂到末尾且可返回空历史', zero.service.historyOf(zero.session).length === 0 && zero.service.stateOf('zero').coveredCount === 35)

// ── Q11：真实配置归一化 / 重启 / provider 隔离 ────────────────────────────
check('V01 旧配置摘要选择归一化为 null', defaults.profileId === null && defaults.model === null)
check('V08 旧配置渠道选择归一化为 null', modA.settingsStore.get().channelModelProfileId === null && modA.settingsStore.get().channelModelId === null)
modB.settingsStore.save({ summary: { ...repaired, profileId: ' summary-profile ', model: ' summary-model ' }, channelModelProfileId: ' channel-profile ', channelModelId: ' channel-model ' })
const savedQ11 = (await bundleModule('summary-q11-restart', EXPORTS)).settingsStore
check('V02 摘要选择保存重启并去空白', savedQ11.get().summary.profileId === 'summary-profile' && savedQ11.get().summary.model === 'summary-model')
check('V08 渠道选择保存重启并去空白', savedQ11.get().channelModelProfileId === 'channel-profile' && savedQ11.get().channelModelId === 'channel-model')
savedQ11.save({ channelModelProfileId: 'channel-next', channelModelId: null })
check('V11 改渠道不改变摘要', savedQ11.get().summary.profileId === 'summary-profile' && savedQ11.get().summary.model === 'summary-model')
savedQ11.save({ summary: { ...savedQ11.get().summary, profileId: null, model: null } })
check('V11 改摘要不改变渠道', savedQ11.get().channelModelProfileId === 'channel-next' && savedQ11.get().channelModelId === null)
for (const invalid of ['', '   ', 42, false, {}, []]) {
  savedQ11.save({ summary: { ...savedQ11.get().summary, profileId: invalid, model: invalid }, channelModelProfileId: invalid, channelModelId: invalid })
  const value = savedQ11.get()
  check('Q11 非法选择归一化为 null：' + JSON.stringify(invalid), value.summary.profileId === null && value.summary.model === null && value.channelModelProfileId === null && value.channelModelId === null)
}
// Keep createProvider and its singleton registry real. Only replace each singleton's
// transport-facing stream; assertions inspect request.settings, never factory inputs.
const probe = { streams: [] }
const stubs = {
  '../rag': 'export const memoryService = { activePersona() { return "default" }, upsertPersona() {}, appendHistory() {}, async buildContextBlock() { return "" }, async extractInBackground() {} }'
}
const plugin = { name: 'q11-memory-boundary', setup(build) {
  build.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) && args.importer.replaceAll('\\', '/').endsWith('/chat/chatService.ts') ? { path: args.path, namespace: 'q11-fixture' } : null)
  build.onLoad({ filter: /.*/, namespace: 'q11-fixture' }, args => ({ contents: stubs[args.path], loader: 'ts' }))
} }
const q11 = await bundleModule('summary-q11-provider', EXPORTS + '\n' + [
  'export { chatService } from ' + JSON.stringify(p('src/main/features/chat/chatService.ts')),
  'export { createProvider } from ' + JSON.stringify(p('src/main/features/llm/index.ts')),
  'export { HeadlessSink } from ' + JSON.stringify(p('src/main/features/chat/sink.ts'))
].join('\n'), [plugin])
const catalog = q11.settingsStore.saveProfile({ name: 'Q11 main', provider: 'openai-compatible', baseUrl: 'https://main.invalid/v1', apiKey: 'synthetic-main-key', models: ['main-model'], defaultModel: 'main-model', temperature: 0.4, modelOptions: {} })
const mainId = catalog.profiles.find(item => item.name === 'Q11 main').id
q11.settingsStore.setDefaultProfile(mainId)
const catalog2 = q11.settingsStore.saveProfile({ name: 'Q11 summary', provider: 'openai-compatible', baseUrl: 'https://summary.invalid/v1', apiKey: 'synthetic-summary-key', models: ['summary-default', 'summary-explicit'], defaultModel: 'summary-default', temperature: 0.2, modelOptions: {} })
const summaryId = catalog2.profiles.find(item => item.name === 'Q11 summary').id
q11.settingsStore.save({ summary: { ...q11.settingsStore.get().summary, enabled: false, profileId: summaryId, model: 'summary-explicit' }, memory: { ...q11.settingsStore.get().memory, enabled: false, autoExtract: false } })
const fallback = q11.createProvider(q11.settingsStore.get())
const originalStream = fallback.stream
fallback.stream = async function* (request) {
  probe.streams.push({ provider: this, request: structuredClone({ settings: request.settings, messages: request.messages }) })
  yield { type: 'text', text: 'Q11 reply' }
  yield { type: 'finish', reason: 'stop' }
}
const consume = async provider => {
  const before = probe.streams.length
  for await (const _event of provider.stream({ settings: q11.settingsStore.get(), messages: [{ role: 'user', content: 'Q11 direct summary' }], tools: [], signal: new AbortController().signal })) { /* drain */ }
  return probe.streams[before].request.settings
}
const fallbackWarnings = [], warnBefore = console.warn
const scheduleReal = q11.summaryService.schedule.bind(q11.summaryService)
const scheduledProviders = []
q11.summaryService.schedule = (...args) => { scheduledProviders.push(args[2]); return scheduleReal(...args) }
let actualSession
try {
  const selected = q11.chatService.summaryProvider(q11.settingsStore.get(), fallback)
  const selectedRequest = await consume(selected)
  check('V02 真实 singleton 的 stream 收到摘要独立地址与解密密钥', selectedRequest.baseUrl === 'https://summary.invalid/v1' && selectedRequest.apiKey === 'synthetic-summary-key' && selectedRequest.provider === 'openai-compatible')
  check('V03 stream 使用摘要显式模型', selectedRequest.model === 'summary-explicit')
  q11.settingsStore.save({ summary: { ...q11.settingsStore.get().summary, model: null } })
  const defaultRequest = await consume(q11.chatService.summaryProvider(q11.settingsStore.get(), fallback))
  check('V03 stream 未指定模型时使用档案默认', defaultRequest.model === 'summary-default')
  q11.settingsStore.save({ summary: { ...q11.settingsStore.get().summary, profileId: null } })
  check('V01 未选档案返回原 singleton 同一实例', q11.chatService.summaryProvider(q11.settingsStore.get(), fallback) === fallback)
  q11.settingsStore.save({ summary: { ...q11.settingsStore.get().summary, profileId: 'deleted-profile' } })
  console.warn = (...args) => fallbackWarnings.push(args.join(' '))
  let missing
  try { missing = q11.chatService.summaryProvider(q11.settingsStore.get(), fallback) } finally { console.warn = warnBefore }
  check('V04 失效档案返回同一 fallback singleton', missing === fallback)
  check('V04 失效档案有可读原因且日志无密钥', fallbackWarnings.some(line => /summary/.test(line) && /失效|不可用/.test(line)) && fallbackWarnings.every(line => !line.includes('synthetic-')))
  q11.settingsStore.save({ summary: { ...q11.settingsStore.get().summary, profileId: summaryId, model: 'summary-explicit' } })
  probe.streams.length = 0
  actualSession = q11.chatService.createSession({ modelProfileId: mainId, modelId: 'main-model' })
  const outcome = await q11.chatService.sendAwait({ sessionId: actualSession.id, content: 'Q11 main request' }, new q11.HeadlessSink())
  check('V05 真实发送与 buildPayload 的 stream 仍使用主配置', outcome.status === 'done' && probe.streams.length === 1 && probe.streams[0].request.settings.baseUrl === 'https://main.invalid/v1' && probe.streams[0].request.settings.apiKey === 'synthetic-main-key' && probe.streams[0].request.settings.model === 'main-model' && probe.streams[0].request.messages.some(item => item.content === 'Q11 main request'))
  const scheduledRequest = await consume(scheduledProviders[0])
  check('V05 真实 schedule provider 的 stream 覆盖为摘要配置', scheduledProviders.length === 1 && scheduledRequest.baseUrl === 'https://summary.invalid/v1' && scheduledRequest.model === 'summary-explicit')
  probe.streams.length = 0
  q11.settingsStore.save({ summary: { ...q11.settingsStore.get().summary, enabled: true, triggerCount: 2 } })
  const compressed = q11.chatService.createSession({ modelProfileId: mainId, modelId: 'main-model' })
  const next = await q11.chatService.sendAwait({ sessionId: compressed.id, content: 'Q11 compression request' }, new q11.HeadlessSink())
  for (let i = 0; i < 100 && q11.summaryService.stateOf(compressed.id, 'default')?.coveredCount !== 2; i++) await sleep(10)
  check('V05 同厂商 singleton 五个实际 stream 请求严格分流', next.status === 'done' && probe.streams.length === 5 && probe.streams[0].request.settings.model === 'main-model' && probe.streams.slice(1).every(item => item.request.settings.model === 'summary-explicit' && item.request.settings.baseUrl === 'https://summary.invalid/v1' && item.request.settings.apiKey === 'synthetic-summary-key') && q11.summaryService.stateOf(compressed.id, 'default')?.coveredCount === 2)
  q11.settingsStore.save({ summary: { ...q11.settingsStore.get().summary, enabled: false, profileId: 'deleted-profile' } })
  console.warn = (...args) => fallbackWarnings.push(args.join(' '))
  let fallbackTurn
  try { fallbackTurn = await q11.chatService.sendAwait({ sessionId: actualSession.id, content: 'Q11 fallback request' }, new q11.HeadlessSink()) } finally { console.warn = warnBefore }
  check('V04 失效档案主对话完成且 schedule 沿用同一 singleton', fallbackTurn.status === 'done' && scheduledProviders.at(-1) === fallback && probe.streams.at(-1).request.settings.model === 'main-model')
} finally {
  console.warn = warnBefore
  q11.summaryService.schedule = scheduleReal
  fallback.stream = originalStream
  if (actualSession) q11.chatService.stop(actualSession.id)
}
clearTimeout(deadline)
done()
