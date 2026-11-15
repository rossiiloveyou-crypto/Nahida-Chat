/**
 * 桥接 P5 —— 失败信号与开关锁的机器判据（PHASE-5 §3 A1–A5）。
 *
 * 跑法：node scripts/test/bridge-switches.test.mjs
 *
 * 这一套**只测六件事**，全部可机器判定（本 Phase 无 M 档人工验证点）：
 * 1. 空回复（`''` 与全空白）各自判 error，且文案含「空回复」（A2）；
 * 2. 四类失败——reject / 空串 / 超时 / 中止——各自产出确定的 status（A3/A4）；
 * 3. `auto_continue` / `auto_swipe` 被临时置 false，调用后**必定还原**（A5）；
 * 4. 页面没有 `powerUserSettings` 时不崩、不臆造字段，只带一条告警；
 * 5. finally 的顺序是 **先还原开关 → 再 reset 会话**（蓝图 §1 第 4 行）；
 * 6. 结果契约恒含 `warnings` 数组（F-03），失败时至少一条非空人话。
 *
 * 假宿主不"假装成功"：它**解析 driver 真正生成的表达式**，把
 * `SWITCH_MUTE_EXPR` 里的 JS 在一个迷你 `SillyTavern` 全局上真跑一遍，
 * 所以"开关到底改没改、改成什么、有没有还原"是**执行出来的**，不是断言的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bridge-sw-'))
installElectronStub(userData)

const mod = await bundleModule(
  'bridge-switches',
  [
    "export { BridgeDriver } from '" + p('src/main/features/bridge/driver.ts') + "'",
    "export { BRIDGE_SWITCH_KEYS, SWITCH_MUTE_EXPR, switchRestoreExpr } from '" + p('src/main/features/bridge/session.ts') + "'",
    "export { BRIDGE_DEFAULT_CONFIG } from '" + p('src/shared/bridge.ts') + "'"
  ].join('\n')
)

const { BridgeDriver, BRIDGE_SWITCH_KEYS, SWITCH_MUTE_EXPR, switchRestoreExpr, BRIDGE_DEFAULT_CONFIG } = mod

const { check, done } = createChecker()

/* ───────────────────────── 迷你 ST 全局：真跑页面侧表达式 ───────────────────────── */

/**
 * 造一个"页面"：`SillyTavern.getContext()` 返回的 powerUserSettings 就是**真对象**，
 * 表达式在 vm 里跑，所以 driver 改的是它、回读的也是它。
 */
function createPageWorld(powerUserSettings) {
  const flags = {
    stopGenerationCalls: 0,
    powerUserSettings,
    savedToDisk: 0
  }
  const sandbox = {
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    performance: { now: () => Date.now() },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    SillyTavern: {
      getContext: () => ({
        chat: flags.chat ?? [],
        characters: [{}, {}, {}],
        chatMetadata: {},
        extensionPrompts: {},
        powerUserSettings: flags.powerUserSettings,
        stopGeneration: () => {
          flags.stopGenerationCalls += 1
        },
        eventTypes: {},
        eventSource: null
      })
    }
  }
  sandbox.window = sandbox
  return { sandbox, flags }
}

/** 在迷你世界里执行一段页面表达式（与 BrowserWindow.executeJavaScript 同语义：返回最后一次求值） */
function runExpr(world, expr) {
  return vm.runInNewContext(expr, world.sandbox, { timeout: 5000 })
}

/* ───────────────────────── 假宿主：接住 driver 的每一次页面调用 ───────────────────────── */

function createFakeGateway(script = {}) {
  const calls = []
  const world = createPageWorld(script.powerUserSettings ?? {})
  /** 每次 switch:mute / switch:restore 的时刻（用来验证 finally 的顺序） */
  const order = []

  const page = {
    alive: () => true,
    async eval(expr, label) {
      calls.push(label)
      switch (label) {
        case 'exposure':
          return { missing: [], characters: 3, chat: 0, metadata: 0, prompts: 0 }
        case 'clear':
          return { chat: 0, metadata: 0, prompts: 0, characters: 3 }
        case 'inject': {
          const head = 'const input = '
          const start = expr.indexOf(head)
          const end = expr.indexOf(';\n    const ctx = SillyTavern.getContext();', start)
          const rows = JSON.parse(expr.slice(start + head.length, end))
          return { equal: true, flagsEqual: true, actual: rows.map((r) => r.mes), length: rows.length }
        }
        case 'switch:mute': {
          order.push('mute')
          return runExpr(world, expr)
        }
        case 'switch:restore': {
          order.push('restore')
          return runExpr(world, expr)
        }
        case 'generate':
          return await (script.generate ? script.generate() : Promise.resolve(okOutcome('灯下有人。')))
        case 'stop':
          return true
        default:
          throw new Error('假宿主不认识这个标签：' + String(label))
      }
    }
  }

  return {
    gateway: { ensure: async () => page, onEvent: () => () => {} },
    calls,
    order,
    world,
    flags: world.flags,
    /** 页面上的真值（开关到底是不是用户原来那个） */
    switchValue(key) {
      const raw = world.flags.powerUserSettings?.[key]
      if (typeof raw === 'boolean') return raw
      if (raw && typeof raw === 'object' && typeof raw.enabled === 'boolean') return raw.enabled
      return undefined
    }
  }
}

function okOutcome(value) {
  return { ok: true, timeout: false, ms: 42, value, chatAfter: 3, lastMes: value, toasts: [], error: null }
}

function newDriver(gateway, overrides = {}) {
  return new BridgeDriver({ gateway, config: { ...BRIDGE_DEFAULT_CONFIG, minIntervalMs: 0, ...overrides } })
}

const HISTORY = [
  { role: 'user', content: '第一句' },
  { role: 'assistant', content: '回答' },
  { role: 'user', content: '最后一句' }
]

/* ───────────────────────── 1–3 · 空回复判据（A2 · 缺口 0） ───────────────────────── */

{
  const fake = createFakeGateway({ generate: () => Promise.resolve(okOutcome('')) })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'empty', messages: HISTORY })
  check(
    "1 · resolve 空串 '' → status=error 且文案含「空回复」",
    detail.result.status === 'error' &&
      detail.result.content === '' &&
      detail.result.raw === '' &&
      /空回复/.test(String(detail.result.error)),
    String(detail.result.error)
  )
}

{
  const fake = createFakeGateway({ generate: () => Promise.resolve(okOutcome('   \n\t  ')) })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'blank', messages: HISTORY })
  check(
    '2 · 全空白也算空回复（trim 后为空），文案点名「全空白」与字符数',
    detail.result.status === 'error' && /空回复/.test(String(detail.result.error)) && /全空白/.test(String(detail.result.error)),
    String(detail.result.error)
  )
  check(
    '3 · 空回复仍以 clear 收尾（ST 零残留不许因失败而破例）',
    fake.calls[fake.calls.length - 1] === 'clear' && fake.calls.filter((c) => c === 'clear').length === 2,
    fake.calls.join(' > ')
  )
}

{
  const fake = createFakeGateway({ generate: () => Promise.resolve(okOutcome(' 有内容 ')) })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'ok', messages: HISTORY })
  check(
    '4 · 有内容（含前后空格）→ done，且 content 逐字不 trim',
    detail.result.status === 'done' && detail.result.content === ' 有内容 ',
    JSON.stringify(detail.result.content)
  )
}

/* ─────────────────── 5–8 · 四类失败各自产出确定 status（A3 / A4 · D5） ─────────────────── */

{
  const fake = createFakeGateway({
    generate: () => Promise.resolve({ ok: false, timeout: false, ms: 900, value: '', chatAfter: 3, lastMes: '', toasts: ['模型不可用'], error: 'Server unreachable' })
  })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'reject', messages: HISTORY })
  check(
    '5 · reject → error，且带上 reject 原因与页面 toast',
    detail.result.status === 'error' &&
      /Server unreachable/.test(String(detail.result.error)) &&
      /模型不可用/.test(String(detail.result.error)),
    String(detail.result.error)
  )
}

{
  const fake = createFakeGateway({
    generate: () => Promise.resolve({ ok: false, timeout: true, ms: 180000, value: '', chatAfter: 3, lastMes: '', toasts: [], error: 'timeout' })
  })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'timeout', messages: HISTORY })
  check(
    '6 · 超时 → error，文案含「超时」与上限毫秒数',
    detail.result.status === 'error' && /超时/.test(String(detail.result.error)) && /180000/.test(String(detail.result.error)),
    String(detail.result.error)
  )
}

{
  // 真超时路径：页面侧 generate 永不 resolve，由 generateExpr 的 __bridgeTimeout 收口。
  // 这里直接验证 generateExpr 生成的表达式里那条判据仍在（A3 的「stopGeneration 被调用过」是页面侧行为）。
  const { generateExpr } = await bundleModule(
    'bridge-genexpr',
    [
      "export { generateExpr } from '" + p('src/main/features/bridge/driver.ts') + "'"
    ].join('\n')
  )
  const expr = generateExpr(1234)
  check(
    '7 · 生成表达式仍带「超时 → stopGeneration」判据（P4 的行为一条都不许退）',
    expr.includes('__bridgeTimeout') && expr.includes('stopGeneration') && expr.includes('1234'),
    'generateExpr(1234)'
  )

  // 真跑一遍页面侧超时分支：假的 ctx.generate 永不 resolve，看它是否 stop 并回报 timeout
  const world = createPageWorld({})
  world.sandbox.SillyTavern.getContext = () => ({
    chat: [],
    characters: [{}, {}, {}],
    chatMetadata: {},
    extensionPrompts: {},
    powerUserSettings: {},
    eventTypes: {},
    eventSource: null,
    generate: () => new Promise(() => {}),
    stopGeneration: () => {
      world.flags.stopGenerationCalls += 1
    }
  })
  const outcome = await runExpr(world, generateExpr(30))
  check(
    '8 · 页面侧超时实测：outcome.timeout=true 且 stopGeneration 真的被调用过',
    outcome && outcome.ok === false && outcome.timeout === true && world.flags.stopGenerationCalls === 1,
    JSON.stringify({ timeout: outcome?.timeout, stop: world.flags.stopGenerationCalls })
  )
}

{
  const fake = createFakeGateway({ generate: () => Promise.resolve(okOutcome('半截')) })
  const controller = new AbortController()
  controller.abort()
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'abort', messages: HISTORY, signal: controller.signal })
  check(
    '9 · abort → status=aborted（content 可以是半句），且页面收到过 stopGeneration',
    detail.result.status === 'aborted' && fake.calls.includes('stop') && detail.trace.steps.includes('abort'),
    detail.result.status + ' / ' + fake.calls.join(' > ')
  )
}

/* ───────────────── 10–14 · 开关锁：压制 + 必定还原（A5 · 缺口 1/2/4） ───────────────── */

{
  // 当前 ST 形态：{ enabled: true }
  const fake = createFakeGateway({
    powerUserSettings: { auto_continue: { enabled: true }, auto_swipe: { enabled: true } }
  })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'sw-enabled', messages: HISTORY })
  check(
    '10 · auto_continue 在轮内被置 false（页面侧回读为证）',
    detail.trace.switches.find((s) => s.key === 'auto_continue')?.after === false &&
      detail.trace.switchesMuted.includes('auto_continue'),
    JSON.stringify(detail.trace.switches)
  )
  check(
    '11 · 调用后 auto_continue 仍 === true（还原成立）',
    fake.switchValue('auto_continue') === true && detail.trace.switchesRestored === true,
    String(fake.switchValue('auto_continue'))
  )
  check(
    '12 · auto_swipe 同样被置 false 且被还原',
    detail.trace.switchesMuted.includes('auto_swipe') &&
      fake.switchValue('auto_swipe') === true &&
      detail.trace.switches.find((s) => s.key === 'auto_swipe')?.after === false,
    String(fake.switchValue('auto_swipe'))
  )
  check(
    '13 · 开关被改动时必带 ≥1 条人话告警（F-03）',
    Array.isArray(detail.result.warnings) &&
      detail.result.warnings.length >= 1 &&
      detail.result.warnings.every((w) => typeof w === 'string' && w.trim().length > 0) &&
      detail.result.warnings.some((w) => /auto_continue/.test(w)),
    JSON.stringify(detail.result.warnings)
  )
  check(
    '14 · 顺序：先 switch:mute → inject/generate → 先 switch:restore → 再 clear:after',
    fake.order.join('>') === 'mute>restore' &&
      fake.calls.indexOf('switch:mute') < fake.calls.indexOf('inject') &&
      fake.calls.indexOf('switch:restore') < fake.calls.lastIndexOf('clear'),
    fake.calls.join(' > ')
  )
}

{
  // 老式形态：平铺 boolean
  const fake = createFakeGateway({ powerUserSettings: { auto_continue: true, auto_swipe: false } })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'sw-bool', messages: HISTORY })
  check(
    '15 · 平铺 boolean 形态同样被压制并还原（auto_continue true→false→true）',
    detail.trace.switches.find((s) => s.key === 'auto_continue')?.kind === 'boolean' &&
      detail.trace.switches.find((s) => s.key === 'auto_continue')?.after === false &&
      fake.switchValue('auto_continue') === true,
    JSON.stringify(detail.trace.switches)
  )
  check(
    '16 · 本来就是 false 的开关不算「被压制」（muted 里没有 auto_swipe，也不产告警）',
    !detail.trace.switchesMuted.includes('auto_swipe') &&
      fake.switchValue('auto_swipe') === false &&
      detail.result.warnings.every((w) => !/auto_swipe/.test(w)),
    JSON.stringify({ muted: detail.trace.switchesMuted, warnings: detail.result.warnings })
  )
}

{
  // 页面里根本没有这两个键：不许凭空造字段
  const fake = createFakeGateway({ powerUserSettings: { auto_scroll: true } })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'sw-absent', messages: HISTORY })
  check(
    '17 · 键不存在时什么都不做，也不许把字段补出来（还原时无从判断它本来就没有）',
    detail.trace.switches.every((s) => s.kind === 'absent') &&
      !('auto_continue' in fake.world.flags.powerUserSettings) &&
      !('auto_swipe' in fake.world.flags.powerUserSettings) &&
      detail.result.status === 'done',
    JSON.stringify(Object.keys(fake.world.flags.powerUserSettings))
  )
}

{
  // 页面没有 powerUserSettings：不崩，只带一条告警
  const fake = createFakeGateway()
  fake.world.flags.powerUserSettings = undefined
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'sw-noroot', messages: HISTORY })
  check(
    '18 · 没有 powerUserSettings 时不崩，结果照常，且点名一条告警',
    detail.result.status === 'done' &&
      detail.trace.switchesRestored === true &&
      detail.result.warnings.some((w) => /powerUserSettings/.test(w)),
    JSON.stringify(detail.result.warnings)
  )
}

{
  // 失败路径也要还原
  const fake = createFakeGateway({
    powerUserSettings: { auto_continue: { enabled: true } },
    generate: () => Promise.reject(new Error('页面炸了'))
  })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'sw-fail', messages: HISTORY })
  check(
    '19 · 失败路径同样还原开关（finally 不分成功与失败）',
    detail.result.status === 'error' && fake.switchValue('auto_continue') === true && detail.trace.switchesRestored === true,
    String(fake.switchValue('auto_continue'))
  )
}

{
  // 还原表达式自身：只碰被压制过的项，未压制的键原样不动
  const world = createPageWorld({ auto_continue: { enabled: false }, auto_swipe: { enabled: true }, auto_scroll: true })
  const muted = runExpr(world, SWITCH_MUTE_EXPR)
  const restored = runExpr(world, switchRestoreExpr(muted.items))
  check(
    '20 · 还原表达式只还原真值，不动没被压制过的键（auto_scroll 仍是 true）',
    muted.muted.join(',') === 'auto_swipe' &&
      restored.ok === true &&
      world.flags.powerUserSettings.auto_swipe.enabled === true &&
      world.flags.powerUserSettings.auto_continue.enabled === false &&
      world.flags.powerUserSettings.auto_scroll === true,
    JSON.stringify(restored)
  )
}

/* ───────────────── 21–25 · 契约与不写盘（F-01 / F-04 · J-07） ───────────────── */

{
  const fake = createFakeGateway({ generate: () => Promise.resolve(okOutcome('好')) })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'contract', messages: HISTORY })
  check(
    '21 · 结果契约恒含 warnings 数组（成功时也存在，只是空）',
    Object.keys(detail.result).sort().join(',') === 'content,error,ms,raw,status,warnings' &&
      Array.isArray(detail.result.warnings),
    Object.keys(detail.result).join(',')
  )
}

{
  const fake = createFakeGateway({
    powerUserSettings: { auto_continue: { enabled: true } },
    generate: () => Promise.resolve(okOutcome(''))
  })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'contract-err', messages: HISTORY })
  check(
    '22 · 失败时 warnings 仍是数组（可以非空），且 status/error/content 三者自洽',
    Array.isArray(detail.result.warnings) &&
      detail.result.status === 'error' &&
      typeof detail.result.error === 'string' &&
      detail.result.error.length > 0 &&
      detail.result.content === '',
    JSON.stringify({ status: detail.result.status, n: detail.result.warnings.length })
  )
}

check(
  '23 · 受管开关清单就是那两个（P5 只锁 auto_continue / auto_swipe，不多不少）',
  BRIDGE_SWITCH_KEYS.join(',') === 'auto_continue,auto_swipe',
  BRIDGE_SWITCH_KEYS.join(',')
)

{
  // 页面侧不许出现任何写设置的动作（J-07 / M2）：表达式文本里不能有 save 调用
  const mute = SWITCH_MUTE_EXPR
  const restore = switchRestoreExpr([{ key: 'auto_continue', kind: 'enabled', before: true, after: false }])
  check(
    '24 · 开关表达式里没有任何 saveSettings / /api/settings 调用（只改内存对象）',
    !/saveSettings/i.test(mute) &&
      !/saveSettings/i.test(restore) &&
      !/api\/settings/.test(mute) &&
      !/api\/settings/.test(restore) &&
      !/fetch\(/.test(mute) &&
      !/fetch\(/.test(restore),
    'no persistence'
  )
}

{
  const fake = createFakeGateway({
    powerUserSettings: { auto_continue: { enabled: true } },
    generate: () => Promise.resolve(okOutcome('  '))
  })
  const detail = await newDriver(fake.gateway).runTurn({ sessionId: 'switch+empty', messages: HISTORY })
  check(
    '25 · 开关与空回复同时发生：失败为主、开关仍还原、告警两类都在',
    detail.result.status === 'error' &&
      /空回复/.test(String(detail.result.error)) &&
      fake.switchValue('auto_continue') === true &&
      detail.result.warnings.some((w) => /auto_continue/.test(w)),
    JSON.stringify({ err: detail.result.error, warnings: detail.result.warnings })
  )
}

done()
