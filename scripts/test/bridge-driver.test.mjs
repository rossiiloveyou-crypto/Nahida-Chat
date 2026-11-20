/**
 * 桥接 driver + mapper —— A1（PHASE-4 §3）的机器判据。
 *
 * 跑法：node scripts/test/bridge-driver.test.mjs
 *
 * 这一套测的不是「我自己写的假 SQL」那种自证，测的是三条真实边界：
 * 1. **映射**：`LlmMessage[] ⇄ ST chat[]` 双向往返逐字一致（F-04），含空白、换行、标签、emoji；
 * 2. **顺序**：一轮的步骤序列必须含 prepare → inject → generate → disk stable → restore → clear → delete，
 *    失败/取消/超时也都必须以 clear 收尾（F-02：ST 零残留）；空历史时**一次页面调用都不许有**；
 * 3. **P2 开放判据**：写盘/外网/导航/弹窗/权限拦截移除，可见窗口保留独立分区。
 *
 * 页面是**假宿主**（真实 `BrowserWindow` 在真机探针里跑，见 scripts/probe/bridge-rounds.probe.mjs），
 * 但假宿主会**解析** driver 真正塞进页面的注入表达式、并记录每次调用的标签，
 * 所以「driver 到底把哪份历史送出去了」是被验证的，不是被断言的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bridge-test-'))
installElectronStub(userData)

const mod = await bundleModule(
  'bridge',
  [
    "export { mapMessages, toStChat, fromStChat, roundTripDiff } from '" + p('src/main/features/bridge/mapper.ts') + "'",
    "export { BridgeDriver, generateExpr, STOP_EXPR } from '" + p('src/main/features/bridge/driver.ts') + "'",
    "export { CLEAR_EXPR, EXPOSURE_EXPR } from '" + p('src/main/features/bridge/session.ts') + "'",
    "export { READY_EXPR } from '" + p('src/main/features/bridge/host.ts') + "'",
    "export { readPresetRegexScripts, mergeRegexScripts, isPresetName } from '" + p('src/main/features/bridge/presetRegex.ts') + "'",
    "export { BRIDGE_DEFAULT_CONFIG, BRIDGE_IPC, BRIDGE_EVENT } from '" + p('src/shared/bridge.ts') + "'"
  ].join('\n')
)

const {
  mapMessages,
  toStChat,
  fromStChat,
  roundTripDiff,
  BridgeDriver,
  generateExpr,
  CLEAR_EXPR,
  EXPOSURE_EXPR,
  readPresetRegexScripts,
  mergeRegexScripts,
  isPresetName,
  BRIDGE_DEFAULT_CONFIG,
  BRIDGE_IPC,
  BRIDGE_EVENT
} = mod

const { check, done } = createChecker()

/* ─────────────────────────── 假宿主（mock ST 页面） ─────────────────────────── */

/** 从 driver 真正生成的注入表达式里把历史抠出来（验证「送出去的是什么」） */
function parseInjected(expr) {
  const head = 'const input = '
  const start = expr.indexOf(head)
  if (start < 0) throw new Error('注入表达式里没有 input')
  const tailMarker = ';\n    const ctx = SillyTavern.getContext();'
  const end = expr.indexOf(tailMarker, start)
  if (end < 0) throw new Error('注入表达式里找不到切点')
  return JSON.parse(expr.slice(start + head.length, end))
}

/** 从还原表达式里把 items 抠出来（验证「driver 要还原的到底是哪几个」） */
function parseSwitchItems(expr) {
  const head = 'const items = '
  const start = expr.indexOf(head)
  if (start < 0) throw new Error('还原表达式里没有 items')
  const end = expr.indexOf(';\n    const ctx = SillyTavern.getContext();', start)
  return JSON.parse(expr.slice(start + head.length, end))
}

function createFakeGateway(script = {}) {
  const calls = []
  let eventListener
  let diskContent
  const disk = {
    target: (_root, name, avatar) => ({ name, avatar, file: name + ".jsonl", directory: "/fixture/chats/card", path: "/fixture/chats/card/" + name + ".jsonl" }),
    wait: async (target, injected) => {
      script.beforeDisk?.()
      if (script.diskError) throw script.diskError
      return ({ content: script.diskContent ?? diskContent, actualLines: injected + 2, expectedLines: injected + 2, file: target.file, waitMs: 50 })
    },
    remove: async () => true,
    backups: async () => []
  }
  const injected = []
  let concurrent = 0
  let maxConcurrent = 0

  const page = {
    alive: () => true,
    async eval(expr, label) {
      calls.push(label)
      switch (label) {
        case 'ready':
          return true
        case 'character:assert':
          if (script.characterMismatch) throw new Error('ST 角色不符')
          return { name: '妲妮娅', avatar: '妲妮娅.png' }
        case 'chat:prepare':
          return { index: 0, avatar: '妲妮娅.png', previous: 'original', hadChat: true }
        case 'chat:drain':
          return true
        case 'chat:restore':
          return true
        case 'exposure':
          return script.exposure ?? { missing: [], characters: 3, chat: 0, metadata: 0, prompts: 0 }
        case 'clear':
          return { chat: 0, metadata: 0, prompts: 0, characters: 3 }
        // P5 新增的两个标签：假宿主按「页面开关的原始形态」回报，默认两个开关都不存在
        // （= 与 P4 时行为逐字一致：没动过开关，也就没有还原动作）。
        case 'switch:mute': {
          const pu = script.powerUserSettings ?? {}
          const keys = ['auto_continue', 'auto_swipe']
          const items = keys.map((key) => {
            const raw = pu[key]
            if (raw === undefined || raw === null) return { key, kind: 'absent', before: null, after: null }
            if (typeof raw === 'boolean') {
              pu[key] = false
              return { key, kind: 'boolean', before: raw, after: pu[key] === true }
            }
            if (raw && typeof raw === 'object' && typeof raw.enabled === 'boolean') {
              const before = raw.enabled
              raw.enabled = false
              return { key, kind: 'enabled', before, after: raw.enabled === true }
            }
            return { key, kind: 'unknown', before: null, after: null }
          })
          if (script.mutateSwitches) script.mutateSwitches(items)
          return {
            missingRoot: script.powerUserSettings === null,
            items,
            muted: items.filter((it) => it.before === true).map((it) => it.key)
          }
        }
        case 'switch:restore': {
          const items = parseSwitchItems(expr)
          for (const it of items) {
            if (it.kind === 'boolean') script.powerUserSettings[it.key] = it.before === true
            if (it.kind === 'enabled') {
              const raw = script.powerUserSettings?.[it.key]
              if (raw && typeof raw === 'object') raw.enabled = it.before === true
            }
          }
          return { ok: true, after: {} }
        }
        case 'inject': {
          const rows = parseInjected(expr)
          injected.push(...rows)
          const equal = script.injectEqual === undefined ? true : script.injectEqual
          const flagsEqual = script.injectFlagsEqual === undefined ? equal : script.injectFlagsEqual
          return { equal, flagsEqual, actual: rows.map((row) => row.mes), length: rows.length }
        }
        case 'connect':
          return { attempted: true, ok: true }
        case 'generate': {
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          try {
            eventListener?.({ name: BRIDGE_EVENT.streamToken, payload: { text: '未落盘流片段' } })
            const outcome = await (script.generate ? script.generate() : Promise.resolve(okOutcome('好的。')))
            diskContent = outcome.value
            return outcome
          } finally {
            concurrent -= 1
          }
        }
        case 'stop':
          return true
        default:
          throw new Error('假宿主不认识这个标签：' + String(label))
      }
    }
  }

  return {
    gateway: {
      disk,
      ensure: async () => page,
      onEvent: (listener) => { eventListener = listener; return () => { eventListener = undefined } }
    },
    calls,
    injected,
    maxConcurrent: () => maxConcurrent
  }
}

function okOutcome(value) {
  return { ok: true, timeout: false, ms: 1234, value, chatAfter: 3, lastMes: value, toasts: [], error: null }
}

function newDriver(gateway, overrides = {}) {
  return new BridgeDriver({
    gateway,
    disk: gateway.disk,
    config: { ...BRIDGE_DEFAULT_CONFIG, ...overrides }
  })
}

const HISTORY = [
  { role: 'user', content: '第一句：带空格  两个空格' },
  { role: 'assistant', content: '角色回答，含 <wave_plan>标签</wave_plan> 与 emoji 🌱' },
  { role: 'narration', content: '旁白：雨停了。' },
  { role: 'system', content: '人设/记忆这一段不进 chat' },
  { role: 'user', content: '最后一句：触发这一轮\n带换行' }
]

/* ─────────────────────────── 1–7 · mapper 往返（F-04） ─────────────────────────── */

const chat = toStChat(HISTORY, { now: 1700000000000 })
check('1 · system 不进 chat（4 条进去、1 条被丢）', chat.length === 4, JSON.stringify(chat.map((r) => r.mes)))
check(
  '2 · user/assistant 映射正确',
  chat[0].is_user === true && chat[0].is_system === false && chat[1].is_user === false && chat[1].is_system === false,
  JSON.stringify(chat.slice(0, 2).map((r) => [r.is_user, r.is_system]))
)
check(
  '3 · narration → 保留旁白标记的非 system 历史行',
  chat[2].is_user === false && chat[2].is_system === false && chat[2].extra?.ncBridgeNarration === true,
  JSON.stringify([chat[2].is_user, chat[2].is_system])
)
check(
  '4 · mes 逐字搬运（空格 / 换行 / 标签 / emoji / 中文标点都不许动）',
  chat[1].mes === HISTORY[1].content && chat[3].mes === HISTORY[4].content && chat[0].mes === HISTORY[0].content,
  JSON.stringify([chat[0].mes, chat[1].mes, chat[3].mes])
)
check(
  '5 · send_date 单调递增且是合法 ISO',
  chat.every((row, i) => /^\d{4}-\d{2}-\d{2}T/.test(row.send_date) && Date.parse(row.send_date) === 1700000000000 + i * 1000),
  chat.map((row) => row.send_date).join(',')
)
check(
  '6 · fromStChat(toStChat(x)) 与 x 逐字一致（往返主断言）',
  roundTripDiff(HISTORY, { now: 1700000000000 }).length === 0,
  JSON.stringify(roundTripDiff(HISTORY, { now: 1700000000000 }))
)
const restamped = toStChat(fromStChat(chat), { now: 1700000000000 })
check(
  '7 · ST → NC → ST：mes / is_user / is_system / name 全部保持',
  restamped.length === chat.length &&
    restamped.every(
      (row, i) =>
        row.mes === chat[i].mes && row.is_user === chat[i].is_user && row.is_system === chat[i].is_system && row.name === chat[i].name
    ) &&
    toStChat(fromStChat(chat), { now: 1700000000000 }).map((r) => r.mes).join('|') === chat.map((r) => r.mes).join('|'),
  JSON.stringify(restamped.map((r) => r.mes))
)
const dropped = mapMessages([
  { role: 'system', content: 'a' },
  { role: 'tool', content: 'b' },
  { role: 'user', content: '' },
  { role: 'user', content: '留下' }
])
check(
  '8 · 丢弃有账（system / tool / 空正文各自计数，不静默）',
  dropped.dropped.system === 1 && dropped.dropped.tool === 1 && dropped.dropped.empty === 1 && dropped.chat.length === 1,
  JSON.stringify(dropped.dropped)
)

/* ─────────────────────── 9–16 · driver 一轮的步骤与结局 ─────────────────────── */

{
  const fake = createFakeGateway({ generate: () => Promise.resolve(okOutcome('  原稿带前后空格  ')) })
  const driver = newDriver(fake.gateway)
  const detail = await driver.runTurn({ sessionId: 's1', messages: HISTORY })
  check('9 · 成功：status=done 且 content 逐字等于稳定落盘值（不 trim）', detail.result.status === 'done' && detail.result.content === '  原稿带前后空格  ', JSON.stringify(detail.result.content))
  check(
    '10 · 成功：结果只有契约里的字段（P5 起含 warnings）',
    Object.keys(detail.result).sort().join(',') === 'content,error,ms,raw,status,warnings',
    Object.keys(detail.result).join(',')
  )
  check(
    '11 · P4 页面步骤逐项匹配，prepare 在注入前、restore 在末次 clear 前',
    // 🔴 P5 有意插入一格：开关必须在**清场之后、注入之前**压制（先清场是为了让 ST 的
    //    自动续写没有可续的 chat；先于注入是为了抢在 generate 之前）。断言跟着改，判据没放宽：
    //    「注入前必须已就绪、generate 后必须清场」这两条仍然逐字成立。
    fake.calls.join(' > ') === 'exposure > character:assert > clear > switch:mute > chat:prepare > inject > character:assert > generate > chat:drain > chat:drain > chat:restore > clear',
    fake.calls.join(' > ')
  )
  check('12 · 注入到页面的是 4 条（system 已剔）且逐字一致', fake.injected.length === 4 && fake.injected[1].mes === HISTORY[1].content, JSON.stringify(fake.injected.map((r) => r.mes)))
  check('13 · characters 未被误清（J-02 的反向判据）', detail.trace.charactersKept === true, String(detail.trace.charactersKept))
}

{
  const fake = createFakeGateway({ generate: () => Promise.resolve(okOutcome('')) })
  const driver = newDriver(fake.gateway)
  const detail = await driver.runTurn({ sessionId: 's2', messages: HISTORY })
  check(
    '14 · 稳定落盘空串 = 失败（不许当成功写进分支）',
    detail.result.status === 'error' && detail.result.content === '' && /空串/.test(String(detail.result.error)),
    String(detail.result.error)
  )
  check('15 · 空串失败也照样以 clear 收尾', fake.calls[fake.calls.length - 1] === 'clear' && fake.calls.filter((c) => c === 'clear').length === 2, fake.calls.join(' > '))
}

{
  const fake = createFakeGateway({
    generate: () =>
      Promise.resolve({
        ok: false,
        timeout: false,
        ms: 900,
        value: '',
        chatAfter: 4,
        lastMes: '',
        toasts: ['模型不可用：余额不足'],
        error: 'Server unreachable'
      })
  })
  const driver = newDriver(fake.gateway)
  const detail = await driver.runTurn({ sessionId: 's3', messages: HISTORY })
  check(
    '16 · reject → error，且把页面 toast 的原因带出来',
    detail.result.status === 'error' && /Server unreachable/.test(String(detail.result.error)) && /余额不足/.test(String(detail.result.error)),
    String(detail.result.error)
  )
}

{
  const fake = createFakeGateway({
    generate: () => Promise.resolve({ ok: false, timeout: true, ms: 180000, value: '', chatAfter: 4, lastMes: '', toasts: [], error: 'timeout' })
  })
  const driver = newDriver(fake.gateway)
  const detail = await driver.runTurn({ sessionId: 's4', messages: HISTORY })
  check('17 · 超时 → error 且文案带上限毫秒', detail.result.status === 'error' && /超时/.test(String(detail.result.error)) && /180000/.test(String(detail.result.error)), String(detail.result.error))
}

{
  const fake = createFakeGateway({ generate: () => Promise.resolve(okOutcome('半截')) })
  const driver = newDriver(fake.gateway)
  const controller = new AbortController()
  controller.abort()
  const detail = await driver.runTurn({ sessionId: 's5', messages: HISTORY, signal: controller.signal })
  check(
    '18 · 取消 → aborted，且页面收到过 stopGeneration',
    detail.result.status === 'aborted' && fake.calls.includes('stop') && detail.trace.steps.includes('abort'),
    detail.result.status + ' / ' + fake.calls.join(' > ')
  )
}

{
  const fake = createFakeGateway()
  const driver = newDriver(fake.gateway)
  const detail = await driver.runTurn({ sessionId: 's6', messages: [{ role: 'system', content: '只有 system' }] })
  check(
    '19 · 全是 system → 直接失败，且一次页面调用都没有（不许开窗）',
    detail.result.status === 'error' && fake.calls.length === 0 && /没有可注入的历史/.test(String(detail.result.error)),
    fake.calls.join(' > ') || '(无调用)'
  )
}

{
  const fake = createFakeGateway({ exposure: { missing: ['generate'], characters: 3, chat: 0, metadata: 0, prompts: 0 } })
  const driver = newDriver(fake.gateway)
  const detail = await driver.runTurn({ sessionId: 's7', messages: HISTORY })
  check(
    '20 · 暴露面缺字段 → 停止条件 1，绝不继续 generate',
    detail.result.status === 'error' && /停止条件 1/.test(String(detail.result.error)) && !fake.calls.includes('generate'),
    fake.calls.join(' > ')
  )
}

{
  const fake = createFakeGateway({ injectEqual: false })
  const driver = newDriver(fake.gateway)
  const detail = await driver.runTurn({ sessionId: 's8', messages: HISTORY })
  check(
    '21 · 注入自检不一致 → 失败，且不 generate',
    detail.result.status === 'error' && /注入自检失败/.test(String(detail.result.error)) && !fake.calls.includes('generate'),
    fake.calls.join(' > ')
  )
}

/* ───────────────── 22–25 · 排队：全局串行 + 同会话最小间隔 ───────────────── */

{
  const fake = createFakeGateway({
    generate: () => new Promise((resolve) => setTimeout(() => resolve(okOutcome('慢一点')), 30))
  })
  const driver = newDriver(fake.gateway, { minIntervalMs: 0 })
  await Promise.all([
    driver.run({ sessionId: 'a', messages: HISTORY }),
    driver.run({ sessionId: 'b', messages: HISTORY }),
    driver.run({ sessionId: 'c', messages: HISTORY })
  ])
  check('22 · 三个会话并发调用在页面侧从不同时进行（全局串行）', fake.maxConcurrent() === 1, 'max=' + String(fake.maxConcurrent()))
  check(
    '23 · 三轮各自清场两次（进入 + 退出），共 6 次 clear',
    fake.calls.filter((c) => c === 'clear').length === 6,
    fake.calls.join(' > ')
  )
}

{
  const fake = createFakeGateway()
  const sleeps = []
  let clock = 1000
  const driver = new BridgeDriver({
    gateway: fake.gateway,
    disk: fake.gateway.disk,
    config: { ...BRIDGE_DEFAULT_CONFIG, minIntervalMs: 800 },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    }
  })
  await driver.run({ sessionId: 'same', messages: HISTORY })
  await driver.run({ sessionId: 'same', messages: HISTORY })
  check(
    '24 · 同会话第二轮会补足最小间隔（第一轮不等、第二轮等 800ms）',
    sleeps.length === 1 && sleeps[0] === 800,
    JSON.stringify(sleeps)
  )

  const sleeps2 = []
  let clock2 = 5000
  const driver2 = new BridgeDriver({
    ...(() => { const gateway = createFakeGateway().gateway; return { gateway, disk: gateway.disk } })(),
    config: { ...BRIDGE_DEFAULT_CONFIG, minIntervalMs: 800 },
    now: () => clock2,
    sleep: async (ms) => {
      sleeps2.push(ms)
      clock2 += ms
    }
  })
  await driver2.run({ sessionId: 'x', messages: HISTORY })
  await driver2.run({ sessionId: 'y', messages: HISTORY })
  check('25 · 不同会话之间不补间隔（间隔是「同会话」的约束）', sleeps2.length === 0, JSON.stringify(sleeps2))
}

/* ─────────────────── 26–30 · 拦截判据（J-07）与 preload 契约 ─────────────────── */

const hostSource = fs.readFileSync(p('src/main/features/bridge/host.ts'), 'utf8')
check('26 · P2 写盘与外网拦截链已移除', !/CANCEL_PATTERNS|classifyRequest|wireInterception|onBeforeRequest/.test(hostSource))
check('27 · P2 导航、弹窗与权限恒拒已移除', !/will-navigate|setWindowOpenHandler|setPermission(Request|Check)Handler/.test(hostSource))
check('28 · P2 可见窗口保留独立分区与无 Node 页面', /show: true/.test(hostSource) && /electronSession.fromPartition\(this.config.partition\)/.test(hostSource) && /nodeIntegration: false/.test(hostSource) && fs.readFileSync(p('src/main/index.ts'), 'utf8').includes('contents.session === electronSession.fromPartition(BRIDGE_DEFAULT_CONFIG.partition)'))
check(
  '29 · 桥接频道名与 ST 事件名与共享契约一致（preload 打的就是这条）',
  BRIDGE_IPC.event === 'bridge:event' && BRIDGE_EVENT.streamToken === 'stream_token_received' && CLEAR_EXPR.includes('ctx.chat.length = 0') && EXPOSURE_EXPR.includes('setExtensionPrompt'),
  BRIDGE_IPC.event + ' / ' + BRIDGE_EVENT.streamToken
)
const genExpr = generateExpr(180000)
check(
  '30 · 生成表达式三件套在位：超时 stop、流式 ncEmit、toast 捕获',
  genExpr.includes('stopGeneration') && genExpr.includes('window.ncEmit') && genExpr.includes('toast-message') && genExpr.includes('STREAM_TOKEN_RECEIVED'),
  'generate expression'
)

/* ───────────────── 31–34 · 预设正则读取（J-08 的 P4 半边） ───────────────── */

const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bridge-st-'))
fs.mkdirSync(path.join(stDir, 'OpenAI Settings'), { recursive: true })
fs.writeFileSync(
  path.join(stDir, 'settings.json'),
  JSON.stringify({ oai_settings: { preset_settings_openai: '我的预设' } }),
  'utf8'
)
fs.writeFileSync(
  path.join(stDir, 'OpenAI Settings', '我的预设.json'),
  JSON.stringify({
    regex_scripts: [
      { id: 'r1', scriptName: '成品清理', findRegex: '/<wave_plan>[\\s\\S]*?<\\/wave_plan>/g', replaceString: '', placement: [2], markdownOnly: true },
      { id: 'r2', scriptName: '输入改写', findRegex: '/x/g', replaceString: 'y', placement: [1], promptOnly: true },
      { scriptName: '没有 id 也算', findRegex: '/a/g', placement: [2], markdownOnly: true },
      { id: 'bad', scriptName: '没有 findRegex 的行被丢', placement: [2] }
    ]
  }),
  'utf8'
)

const presetScripts = readPresetRegexScripts(stDir)
check(
  '31 · 从当前预设读脚本（3 条有效，无 findRegex 的被丢）',
  presetScripts.length === 3 && presetScripts.filter((s) => s.markdownOnly).length === 2,
  presetScripts.map((s) => s.scriptName).join(' | ')
)
check(
  '32 · 与全局脚本合并时按 id 去重（先到先得）',
  mergeRegexScripts([{ id: 'r1', scriptName: '全局同名', findRegex: '/g/', replaceString: '', trimStrings: [], placement: [2], substituteRegex: 0, minDepth: null, maxDepth: null, disabled: false, runOnEdit: false, markdownOnly: true, promptOnly: false }], presetScripts).filter((s) => s.id === 'r1').length === 1,
  'dedupe by id'
)
check(
  '33 · 预设名含路径分隔符一律拒读（防穿越）',
  isPresetName('../evil') === false && isPresetName('a/b') === false && isPresetName('..') === false && isPresetName('我的预设 (1)') === true,
  'traversal guard'
)
check(
  '34 · 目录不存在 / JSON 坏掉都返回空数组（不抛）',
  readPresetRegexScripts(path.join(stDir, 'nope')).length === 0 && readPresetRegexScripts('D:/definitely-not-here').length === 0,
  'fail-soft'
)

{
  const fake = createFakeGateway({ diskContent: '  磁盘权威正文 🌱  ', generate: async () => okOutcome('generate 非权威正文') })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'disk-authority', messages: HISTORY })
  check('35 · P4 正文只认 disk，generate 与 disk 不同仍逐字保留磁盘正文', detail.result.status === 'done' && detail.result.content === '  磁盘权威正文 🌱  ' && detail.result.raw === detail.result.content)
  check('36 · P4 finally 严格 restore → clear → delete', detail.trace.steps.slice(-3).join('>') === 'chat:restore>clear:after>chat:delete' && detail.trace.disk.deleted === true)
}
{
  const fake = createFakeGateway({ diskContent: '', powerUserSettings: { auto_continue: true }, generate: async () => okOutcome('generate 看似成功') })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'disk-empty-hard', messages: HISTORY })
  check('37 · P4 disk 空正文是硬失败，generate 非空也不得救回', detail.result.status === 'error' && detail.result.content === '' && /空回复/.test(detail.result.error))
  check('38 · 硬失败 finally 仍严格 switch restore → chat restore → clear → delete', detail.trace.steps.slice(-4).join('>') === 'switch:restore>chat:restore>clear:after>chat:delete' && detail.trace.disk.deleted === true)
}

{
  const fake = createFakeGateway({ diskError: Object.assign(new Error('落盘行数不符'), { actualLines: 8, expectedLines: 6 }) })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'disk-count-hard', messages: HISTORY })
  check('39 · P4 行数硬失败仍记录 injected/expected/actual，不丢真实错误证据', detail.result.status === 'error' && detail.trace.disk.injected === 4 && detail.trace.disk.expectedLines === 6 && detail.trace.disk.actualLines === 8, JSON.stringify(detail.trace.disk))
  check('40 · 行数硬失败仍 restore → clear → delete', detail.trace.steps.slice(-3).join('>') === 'chat:restore>clear:after>chat:delete' && detail.trace.disk.deleted === true)
}

{
  const tokens = []
  let beforeDiskEmpty = false
  const fake = createFakeGateway({ diskContent: '最终落盘正文', beforeDisk: () => { beforeDiskEmpty = tokens.length === 0 } })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'disk-stream-gate', messages: HISTORY, onToken: text => tokens.push(text) })
  check('41 · M20 流片段仅计数，稳定落盘前零正文，成功后仅回调磁盘raw一次', beforeDiskEmpty && detail.trace.tokens === 1 && tokens.length === 1 && tokens[0] === '最终落盘正文')
}
{
  const tokens = []
  const fake = createFakeGateway({ diskError: Object.assign(new Error('落盘行数不符'), { actualLines: 0 }) })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'disk-stream-hard', messages: HISTORY, onToken: text => tokens.push(text) })
  check('42 · M20 硬失败即使收到原始流也保持零正文回调', detail.result.status === 'error' && detail.trace.tokens === 1 && tokens.length === 0)
}

done()
