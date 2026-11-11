/**
 * 对话摘要（会话滚动摘要）行为测试。
 *
 * 测的是**真实边界**，不是「把实现再写一遍」：
 * - 阈值不达到 → 一次模型都不调（否则等于每轮烧钱）
 * - 达到 → 四段并发、游标前移、锚点写对
 * - 撤回一条已覆盖消息 → 锚点漂移 → 整份摘要作废、回落全量历史
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-summary-'))
installElectronStub(userData)

const EXPORTS = [
  "export { SummaryService, SummaryStore } from '" + p('src/main/features/summary/service.ts') + "'",
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
check('撤回已覆盖消息 → 回落全量历史', service.historyOf(session).length === 49, service.historyOf(session).length)
check('撤回后摘要仍在（不删库）', service.systemBlock({ id: 'sess', messages: [] }).includes('【近期】'))
check('消息清空后不崩', service.historyOf({ id: 'sess', messages: [] }).length === 0)

// ── 4. 落盘与读回 ─────────────────────────────────────────────────────────────
const file = path.join(dataDir, 'summaries.json')
check('summaries.json 已落盘', fs.existsSync(file))
const service2 = new modA.SummaryService(new modA.SummaryStore(() => dataDir), readSettings)
check('新实例能读回摘要', Boolean(service2.stateOf('sess')))
check('status 统计覆盖条数', service2.status().coveredMessages === 45, service2.status().coveredMessages)

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

done()
