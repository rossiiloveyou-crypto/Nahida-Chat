/** Phase 5: real driver failure paths, host circuit state, and temporary-FS deletion boundaries.
 * Run: node scripts/test/bridge-resilience.test.mjs
 * Every filesystem fixture belongs to this suite; no installed ST/user data is opened.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bridge-resilience-'))
const userData = path.join(root, 'user-data')
fs.mkdirSync(userData, { recursive: true })
installElectronStub(userData)
const mod = await bundleModule('bridge-resilience', [
  "export { BridgeDriver } from '" + p('src/main/features/bridge/driver.ts') + "'",
  "export { BridgeHost } from '" + p('src/main/features/bridge/host.ts') + "'",
  "export { chatName, chatTarget, removeChat, recordOrphan, readOrphans, sweepOrphans } from '" + p('src/main/features/bridge/chats.ts') + "'",
  "export { BRIDGE_DEFAULT_CONFIG, BRIDGE_EVENT, bridgeFailure, isPageUnavailable } from '" + p('src/shared/bridge.ts') + "'"
].join('\n'))
const { BridgeDriver, BridgeHost, BRIDGE_DEFAULT_CONFIG, BRIDGE_EVENT,
  bridgeFailure, isPageUnavailable, chatName, chatTarget, removeChat,
  recordOrphan, readOrphans, sweepOrphans } = mod
const { check, done } = createChecker()
const history = [{ role: 'user', content: 'temporary fixture request' }]
const config = { ...BRIDGE_DEFAULT_CONFIG, cardName: 'Fixture', cardAvatar: 'Fixture.png',
  stDataDir: path.join(root, 'driver-data'), port: 18471, minIntervalMs: 0 }
const technical = /EPERM|ENOENT|EADDRINUSE|TokenBudgetExceeded|Error:|\n\s*at\s|node:internal/i
const ok = (value = 'validated fixture reply') => ({ ok: true, timeout: false, ms: 12,
  value, chatAfter: 2, lastMes: value, toasts: [], error: null })
const crash = () => new Error('Render frame was disposed: EPERM\n    at fixture (fixture.ts:7:1)')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function scenario(name, body) {
  let timer
  try {
    await Promise.race([body(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Scenario timed out: ' + name)), 10000)
    })])
  } catch (error) { check(name + ' completes', false, error?.stack ?? error) }
  finally { clearTimeout(timer) }
}

// Like bridge-driver.test.mjs, dispatch actual driver labels and parse its actual injection.
function fakeGateway(script = {}) {
  const calls = [], injected = [], notes = []
  const counts = { ensure: 0, generate: 0, recover: 0, success: 0, failed: 0, remove: 0 }
  let listener, diskContent = '', currentTarget
  const page = {
    alive: () => true,
    async eval(expr, label) {
      calls.push(label)
      if (script.eval) {
        const result = await script.eval(expr, label, counts)
        if (result !== undefined) return result
      }
      switch (label) {
        case 'ready': return true
        case 'exposure': return { missing: [], characters: 1, chat: 0, metadata: 0, prompts: 0 }
        case 'character:assert': return { name: 'Fixture', avatar: 'Fixture.png' }
        case 'clear': return { chat: 0, metadata: 0, prompts: 0, characters: 1 }
        case 'switch:mute': return { missingRoot: false, items: [], muted: [] }
        case 'switch:restore': return { ok: true, after: {} }
        case 'chat:prepare': return { index: 0, avatar: 'Fixture.png', previous: 'original', hadChat: true }
        case 'chat:drain': case 'chat:restore': case 'stop': return true
        case 'inject': {
          const marker = 'const input = '
          const start = expr.indexOf(marker)
          const end = expr.indexOf(';\n    const ctx = SillyTavern.getContext();', start)
          if (start < 0 || end < 0) throw new Error('Actual injection expression shape changed')
          const rows = JSON.parse(expr.slice(start + marker.length, end))
          injected.push(rows)
          return { equal: true, flagsEqual: true, actual: rows.map(row => row.mes), length: rows.length }
        }
        case 'generate': {
          counts.generate++
          listener?.({ name: BRIDGE_EVENT.streamToken, payload: { text: 'unvalidated partial token' } })
          const result = script.generate ? await script.generate(counts, listener) : ok()
          diskContent = result.value
          return result
        }
        default: throw new Error('Unknown fake page label: ' + label)
      }
    }
  }
  const disk = {
    target: (_data, name, avatar) => (currentTarget = { name, avatar, file: name + '.jsonl',
      directory: path.join(root, 'virtual'), path: path.join(root, 'virtual', name + '.jsonl') }),
    wait: async (target, injectedCount) => {
      calls.push('disk:wait')
      if (script.diskError) throw script.diskError
      return { content: script.diskContent ?? diskContent, actualLines: injectedCount + 2,
        expectedLines: injectedCount + 2, metadataLines: 1, file: target.file, waitMs: 2 }
    },
    remove: async () => {
      calls.push('disk:remove'); counts.remove++
      return script.remove ? await script.remove(counts, currentTarget) : true
    },
    backups: async () => []
  }
  const gateway = {
    config, disk,
    assertAvailable: () => { script.assertAvailable?.() },
    ensure: async () => { calls.push('ensure'); counts.ensure++; if (script.ensureError) throw script.ensureError; return page },
    onEvent: next => { listener = next; return () => { listener = undefined } },
    recover: async () => { calls.push('recover'); counts.recover++; await script.recover?.(counts); return page },
    recoverySucceeded: () => { counts.success++ },
    recoveryFailed: error => { counts.failed++; script.recoveryFailed?.(error) },
    noteFailure: step => notes.push(step)
  }
  return { gateway, disk, counts, calls, injected, notes, emit: event => listener?.(event) }
}
function driver(fake) {
  return new BridgeDriver({ gateway: fake.gateway, disk: fake.disk, config,
    readOverride: () => ({ text: '', active: false, truncated: false, warning: null }) })
}
function traceRows(sessionId) {
  const file = path.join(userData, 'nc-bridge', 'bridge-trace.jsonl')
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.sessionId === sessionId)
}
async function failingCase(key, script) {
  const fake = fakeGateway(script), tokens = [], sessionId = 'failure-' + key
  const detail = await driver(fake).runTurn({ sessionId, messages: history, onToken: text => tokens.push(text) })
  check(key + ': returns error with no stored or raw partial text', detail.result.status === 'error' && detail.result.content === '' && detail.result.raw === '', JSON.stringify(detail.result))
  check(key + ': emits no token before failed cleanup/validation', tokens.length === 0, JSON.stringify(tokens))
  check(key + ': human error omits technical codes and stack', typeof detail.result.error === 'string' && detail.result.error.length > 0 && !technical.test(detail.result.error), detail.result.error)
  const rows = traceRows(sessionId)
  check(key + ': one persisted JSONL trace contains fail:' + key, rows.length === 1 && rows[0].steps.includes('fail:' + key), JSON.stringify(rows.map(row => row.steps)))
  check(key + ': host receives stable failure step', fake.notes.includes('fail:' + key), fake.notes.join(','))
  if (key === 'preflight') check('diagnostics: original technical code and stack remain in persisted trace', rows[0].failures?.some(failure => failure.step === 'fail:preflight' && failure.detail.includes('ENOENT') && failure.detail.includes('at startup')))
  if (key !== 'crash') check(key + ': non-page failure never retries', fake.counts.recover === 0)
  return { fake, detail }
}

try {
  // All 17 specification rows exercise driver paths, rather than only the error classifier.
  const cases = [
    ['preflight', { ensureError: new Error('server.js ENOENT\n    at startup (fixture.ts:1:1)') }],
    ['port', { ensureError: new Error('listen EADDRINUSE: address already in use') }],
    ['node', { ensureError: new Error('spawn node ENOENT') }],
    ['ready', { ensureError: new Error('ST 服务启动超时 EPERM') }],
    ['exposure', { eval: (_expr, label) => label === 'exposure' ? { missing: ['generate'], characters: 1 } : undefined }],
    ['role-empty', { ensureError: new Error('请填写桥接角色后再打开 ST') }],
    ['role-missing', { ensureError: new Error('未找到角色 Fixture ENOENT') }],
    ['role-ambiguous', { ensureError: new Error('多张同名角色卡 Fixture EPERM') }],
    ['role-switched', { eval: (_expr, label) => { if (label === 'character:assert') throw new Error('ST 当前角色是「Other」，请切回「Fixture」') } }],
    ['inject', { eval: (_expr, label) => label === 'inject' ? { equal: false, flagsEqual: false, length: 1 } : undefined }],
    ['timeout', { generate: async () => ({ ...ok(), ok: false, timeout: true, error: 'EPERM' }) }],
    ['budget', { generate: async () => ({ ...ok(), ok: false, error: 'TokenBudgetExceeded EPERM\n    at generate (fixture.ts:8:1)' }) }],
    ['empty', { diskContent: ' \n ' }],
    ['disk-count', { diskError: new Error('落盘行数不符：expected=3 actual=4 EPERM') }],
    ['disk-timeout', { diskError: new Error('等待 ST 落盘超时：ENOENT') }],
    ['delete', { remove: async () => false }],
    ['crash', { generate: async () => { throw crash() } }]
  ]
  for (const [key, script] of cases) await scenario('failure ' + key, () => failingCase(key, script))
  await scenario('port context', async () => {
    const failure = bridgeFailure(new Error('EADDRINUSE'), { port: config.port })
    check('port: exact configured port and next action', failure.step === 'fail:port' && failure.message.includes('端口 ' + config.port + ' 已被占用') && /换.*端口/.test(failure.message))
    check('classifier: unavailable frame recognized without treating disk error as crash', isPageUnavailable(crash()) && !isPageUnavailable(new Error('EPERM unlink fixture.jsonl')))
  })

  await scenario('one recovery succeeds', async () => {
    const fake = fakeGateway({ generate: async counts => { if (counts.generate === 1) throw crash(); return ok('recovered reply') } })
    const tokens = []
    const detail = await driver(fake).runTurn({ sessionId: 'recovery-success', messages: history,
      onToken: text => { fake.calls.push('onToken'); tokens.push(text) } })
    check('recovery: same attempt chain succeeds after one restart', detail.result.status === 'done' && detail.result.content === 'recovered reply', JSON.stringify(detail.result))
    check('recovery: at most one restart and two generations', fake.counts.recover === 1 && fake.counts.generate === 2)
    check('recovery: exposure, character and injection rerun', fake.calls.filter(x => x === 'exposure').length === 2 && fake.injected.length === 2 && JSON.stringify(fake.injected[0].map(row => [row.mes, row.is_user, row.is_system])) === JSON.stringify(fake.injected[1].map(row => [row.mes, row.is_user, row.is_system])))
    check('recovery: old owned chat removed before restart', fake.calls.indexOf('disk:remove') < fake.calls.indexOf('recover') && fake.counts.remove === 2, fake.calls.join(' > '))
    check('recovery: raw callback occurs once after last cleanup', tokens.join('|') === 'recovered reply' && fake.calls.lastIndexOf('onToken') > fake.calls.lastIndexOf('disk:remove'))
    check('recovery: host success hook and persisted retry marker', fake.counts.success === 1 && traceRows('recovery-success')[0].steps.includes('retry:1'))
  })
  await scenario('successful generation then cleanup page crash recovers', async () => {
    let crashed = false
    const tokens = []
    const fake = fakeGateway({
      eval: (_expr, label, counts) => {
        if (label === 'clear' && counts.generate === 1 && !crashed) { crashed = true; throw crash() }
      },
      generate: async counts => ok(counts.generate === 1 ? 'obsolete first reply' : 'cleanup recovered reply')
    })
    const detail = await driver(fake).runTurn({ sessionId: 'cleanup-page-crash', messages: history, onToken: text => tokens.push(text) })
    check('cleanup crash: successful generation restarts exactly once before emission', detail.result.status === 'done' && fake.counts.generate === 2 && fake.counts.recover === 1 && fake.counts.success === 1 && tokens.join('|') === 'cleanup recovered reply')
    check('cleanup crash: persisted trace retains crash and single retry marker', traceRows('cleanup-page-crash')[0].steps.includes('fail:crash') && traceRows('cleanup-page-crash')[0].steps.filter(step => step === 'retry:1').length === 1)
  })
  await scenario('open circuit rejects while another turn holds gate', async () => {
    const running = deferred(), reached = deferred()
    let circuitOpen = false, rejectedBeforeRelease = false
    const paused = bridgeFailure(crash())
    paused.message = 'ST 反复崩溃，已暂停自动重试；请等待 60 秒或重新打开 ST'
    const fake = fakeGateway({ assertAvailable: () => { if (circuitOpen) throw paused },
      generate: async () => { reached.resolve(); return running.promise } })
    const instance = driver(fake)
    const first = instance.runTurn({ sessionId: 'busy-circuit-first', messages: history })
    await reached.promise
    circuitOpen = true
    const second = instance.runTurn({ sessionId: 'busy-circuit-rejected', messages: history }).then(detail => { rejectedBeforeRelease = true; return detail })
    try {
      await tick()
      check('circuit: rejection settles immediately while existing gate stays busy', rejectedBeforeRelease && fake.counts.ensure === 1 && fake.counts.generate === 1 && fake.counts.recover === 0)
    } finally { circuitOpen = false; running.resolve(ok()) }
    const outcomes = await Promise.all([first, second])
    check('circuit: fast rejection persists human failure without interrupting active turn', outcomes[0].result.status === 'done' && outcomes[1].result.status === 'error' && /已暂停自动重试/.test(outcomes[1].result.error ?? '') && outcomes[1].result.content === '' && outcomes[1].result.raw === '' && traceRows('busy-circuit-rejected')[0].steps.includes('fail:crash'))
  })
  await scenario('recovery bounded on second crash', async () => {
    const fake = fakeGateway({ generate: async () => { throw crash() } })
    const result = await driver(fake).runTurn({ sessionId: 'second-crash', messages: history })
    check('recovery: repeated crash stops after exactly one restart', result.result.status === 'error' && fake.counts.recover === 1 && fake.counts.generate === 2 && fake.counts.failed === 1)
  })
  await scenario('global gate spans cleanup and recovery', async () => {
    const gate = deferred(), reached = deferred()
    const fake = fakeGateway({ generate: async counts => { if (counts.generate === 1) throw crash(); return ok() },
      recover: async () => { reached.resolve(); await gate.promise } })
    const instance = driver(fake)
    const first = instance.runTurn({ sessionId: 'gate-first', messages: history })
    await reached.promise
    const second = instance.runTurn({ sessionId: 'gate-second', messages: history })
    await tick()
    check('gate: queued turn cannot ensure while recovery is pending', fake.counts.ensure === 1 && fake.counts.generate === 1)
    gate.resolve()
    const outcomes = await Promise.all([first, second])
    check('gate: recovered turn completes before queued turn enters', outcomes.every(x => x.result.status === 'done') && fake.counts.generate === 3 && fake.calls.indexOf('recover') < fake.calls.lastIndexOf('ensure'))
  })
  await scenario('gate and callback wait for disk cleanup', async () => {
    const cleanup = deferred(), reached = deferred(), tokens = []
    const fake = fakeGateway({ remove: async counts => {
      if (counts.remove === 1) { reached.resolve(); await cleanup.promise }
      return true
    } })
    const instance = driver(fake)
    const first = instance.runTurn({ sessionId: 'cleanup-gate-first', messages: history, onToken: text => tokens.push(text) })
    await reached.promise
    const second = instance.runTurn({ sessionId: 'cleanup-gate-second', messages: history })
    await tick()
    check('gate: pending cleanup prevents another turn entering and raw emission', fake.counts.ensure === 1 && fake.counts.generate === 1 && tokens.length === 0)
    cleanup.resolve()
    const outcomes = await Promise.all([first, second])
    check('gate: both turns finish after cleanup releases', outcomes.every(detail => detail.result.status === 'done') && fake.counts.remove === 2 && tokens.length === 1)
  })
  await scenario('cancel suppresses restart', async () => {
    const controller = new AbortController()
    const fake = fakeGateway({ generate: async () => { controller.abort(); throw crash() } })
    const tokens = []
    const result = await driver(fake).runTurn({ sessionId: 'canceled', messages: history, signal: controller.signal, onToken: text => tokens.push(text) })
    check('cancel: crash after cancellation stays aborted without retry or emission', result.result.status === 'aborted' && result.result.content === '' && result.result.raw === '' && fake.counts.recover === 0 && tokens.length === 0)
  })
  await scenario('failed deletion suppresses restart', async () => {
    const fake = fakeGateway({ generate: async () => { throw crash() }, remove: async () => false })
    const tokens = []
    const result = await driver(fake).runTurn({ sessionId: 'crash-delete-fails', messages: history, onToken: text => tokens.push(text) })
    check('cleanup: failed old-chat deletion blocks restart and emission', result.result.status === 'error' && fake.counts.recover === 0 && tokens.length === 0 && result.trace.steps.includes('fail:delete'))
  })
  await scenario('failed crash cleanup suppresses restart', async () => {
    const fake = fakeGateway({ generate: async () => { throw crash() },
      eval: (_expr, label) => label === 'chat:restore' ? false : undefined })
    const tokens = []
    const result = await driver(fake).runTurn({ sessionId: 'crash-restore-fails', messages: history, onToken: text => tokens.push(text) })
    check('cleanup: failed session restore blocks crash retry and emission', result.result.status === 'error' && fake.counts.recover === 0 && tokens.length === 0 && result.trace.steps.includes('fail:cleanup'))
  })
  await scenario('failed restore suppresses emission', async () => {
    const fake = fakeGateway({ eval: (_expr, label) => label === 'chat:restore' ? false : undefined })
    const tokens = []
    const result = await driver(fake).runTurn({ sessionId: 'restore-fails', messages: history, onToken: text => tokens.push(text) })
    check('cleanup: otherwise successful generation fails closed on restore failure', result.result.status === 'error' && result.result.content === '' && result.result.raw === '' && tokens.length === 0 && fake.counts.recover === 0)
  })

  await scenario('page event interrupts an unresolved generate', async () => {
    const pending = deferred()
    const fake = fakeGateway({ generate: async (counts, listener) => {
      if (counts.generate === 1) {
        setImmediate(() => listener({ name: 'bridge:page-unavailable', payload: {} }))
        return pending.promise
      }
      return ok('event recovered reply')
    } })
    const tokens = []
    try {
      const detail = await driver(fake).runTurn({ sessionId: 'event-crash', messages: history, onToken: text => tokens.push(text) })
      check('event: unresolved page eval is interrupted and recovered once', detail.result.status === 'done' && fake.counts.recover === 1 && fake.counts.generate === 2)
      check('event: only the recovered reply reaches callback', tokens.join('|') === 'event recovered reply')
      check('event: persisted final trace retains crash and retry steps', traceRows('event-crash')[0].steps.includes('fail:crash') && traceRows('event-crash')[0].steps.includes('retry:1'))
    } finally { pending.resolve(ok('late obsolete reply')) }
  })

  // JS permits replacing TS-private runtime fields, without changing production APIs.
  await scenario('host circuit state machine', async () => {
    let now = 100000
    const host = new BridgeHost(config, () => now)
    await host.orphanSweep
    let starts = 0, stops = 0
    host.st = { running: () => true, stop: () => { stops++ }, pid: 42, log: null, info: null, lastError: null }
    host.logWindow = { close() {} }
    host.launch = async () => { starts++; throw crash() }
    host.noteFailure('fail:crash')
    for (let i = 0; i < 2; i++) {
      try { await host.recover() } catch (error) { host.recoveryFailed(error) }
    }
    let blocked
    try { host.assertAvailable() } catch (error) { blocked = error }
    const health = host.health()
    check('host: two failed recoveries open circuit and expose retry count', starts === 2 && health.circuitOpen === true && health.retryCount === 2 && health.lastFailStep === 'fail:crash', JSON.stringify(health))
    check('host: open circuit fails immediately with human pause action', /已暂停自动重试/.test(String(blocked?.message)) && !technical.test(String(blocked?.message)))
    try { await host.ensure() } catch {}
    check('host: circuit blocks new launch attempts', starts === 2)
    now += 59999
    check('host: cooldown stays open before sixty seconds', host.health().circuitOpen === true)
    now++
    host.assertAvailable()
    check('host: cooldown expiry clears circuit and retry counter', host.health().circuitOpen === false && host.health().retryCount === 0)
    host.recoveryFailed(crash()); host.recoveryFailed(crash())
    await host.stopSt()
    check('host: manual stop resets circuit immediately', host.health().circuitOpen === false && host.health().retryCount === 0 && stops >= 1)
    host.recoveryFailed(crash()); host.recoverySucceeded()
    check('host: successful recovery resets consecutive failure counter', host.health().retryCount === 0 && host.health().circuitOpen === false)
  })

  await scenario('host actual window event handlers', async () => {
    const electron = createRequire(import.meta.url)('electron')
    const previousWindow = electron.BrowserWindow, previousSession = electron.session
    class FakeWindow extends EventEmitter {
      destroyed = false
      webContents = new EventEmitter()
      isDestroyed() { return this.destroyed }
      destroy() { this.destroyed = true; this.emit('closed') }
      show() {}
      focus() {}
    }
    electron.BrowserWindow = FakeWindow
    electron.session = { fromPartition: () => ({}) }
    const host = new BridgeHost(config)
    await host.orphanSweep
    host.st = { running: () => true, stop() {}, pid: 42, log: null, info: null, lastError: null }
    const events = []
    const off = host.onEvent(event => events.push(event.name))
    try {
      const win = host.createWindow()
      host.win = win; host.healthy = true; host.connected = true
      win.webContents.emit('did-fail-load', {}, -3, 'aborted', 'fixture', true)
      win.webContents.emit('did-fail-load', {}, -2, 'subframe', 'fixture', false)
      check('host events: aborted loads and subframe failures are ignored', host.alive() && events.length === 0)
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
      check('host events: render-process-gone marks unavailable and notifies driver', !host.alive() && events.join(',') === 'bridge:page-unavailable' && host.health().lastFailStep === 'fail:crash')
      host.needsRecovery = false
      const next = host.createWindow()
      host.win = next; host.healthy = true; host.connected = true
      next.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'fixture', true)
      check('host events: non-aborted main load failure invalidates page', !host.alive() && events.length === 2 && host.health().lastFailStep === 'fail:crash')
    } finally {
      off(); host.destroy()
      electron.BrowserWindow = previousWindow; electron.session = previousSession
    }
  })
  await scenario('host orphan scan error and open reset', async () => {
    const ledger = path.join(userData, 'nc-bridge', 'orphans.json')
    const previous = fs.existsSync(ledger) ? fs.readFileSync(ledger) : undefined
    const host = new BridgeHost(config)
    await host.orphanSweep
    host.st = { running: () => true, stop() {}, pid: 42, log: null, info: null, lastError: null }
    host.launch = async () => { host.needsRecovery = false; host.healthy = true; host.connected = true }
    try {
      fs.writeFileSync(ledger, '{malformed temporary ledger')
      await host.scanOrphans()
      const unhealthy = host.health()
      check('host ledger: failed scan is health-visible with human action', /扫描失败/.test(unhealthy.orphanScanError ?? '') && !technical.test(unhealthy.orphanScanError ?? '') && unhealthy.lastFailStep === 'fail:delete')
      fs.writeFileSync(ledger, JSON.stringify({ version: 1, items: [] }))
      host.recoveryFailed(crash()); host.recoveryFailed(crash())
      await host.openSt()
      check('host ledger: manual open clears circuit and repeats successful scan', host.health().circuitOpen === false && host.health().retryCount === 0 && host.health().orphanScanError === null)
    } finally {
      host.destroy()
      if (previous) fs.writeFileSync(ledger, previous)
      else fs.rmSync(ledger, { force: true })
    }
  })

  function fixture(label) {
    const directory = fs.mkdtempSync(path.join(root, label + '-'))
    const ledgerRoot = path.join(directory, 'ledger')
    const dataDir = path.join(directory, 'data')
    fs.mkdirSync(path.join(ledgerRoot, 'nc-bridge'), { recursive: true })
    return { directory, ledgerRoot, dataDir, ledger: path.join(ledgerRoot, 'nc-bridge', 'orphans.json') }
  }
  function owned(dataDir, id) {
    const target = chatTarget(dataDir, chatName(id), 'Fixture.png')
    fs.mkdirSync(target.directory, { recursive: true })
    fs.writeFileSync(target.path, 'owned fixture')
    return target
  }
  function orphan(target, dataDir) {
    return { dataDir, avatar: target.avatar, at: new Date().toISOString(), sessionId: 'fixture',
      file: target.file, path: target.path, reason: 'fixture registration' }
  }
  await scenario('malformed ledger rows remain intact', async () => {
    const f = fixture('malformed'), target = owned(f.dataDir, 'malformed')
    const valid = orphan(target, f.dataDir)
    const rows = [null, 17, 'primitive', true, [], {}, { ...valid, dataDir: undefined },
      { ...valid, avatar: 17 }, { ...valid, dataDir: null }, { ...valid, path: [] },
      { ...valid, attempts: '1' }, { ...valid, attempts: -1 }]
    fs.writeFileSync(f.ledger, JSON.stringify({ version: 1, items: rows }))
    const before = JSON.parse(fs.readFileSync(f.ledger, 'utf8')).items
    const remaining = await sweepOrphans(f.ledgerRoot)
    check('ledger: null, primitive and malformed field shapes are all retained', remaining === before.length && JSON.stringify(readOrphans(f.ledgerRoot).items) === JSON.stringify(before))
    check('ledger: malformed entries never delete their referenced owned file', fs.readFileSync(target.path, 'utf8') === 'owned fixture')
  })
  await scenario('API-time junction swap is revalidated', async () => {
    const f = fixture('junction'), target = owned(f.dataDir, 'junction')
    const outside = path.join(f.directory, 'outside')
    fs.mkdirSync(outside)
    const outsideFile = path.join(outside, target.file)
    fs.writeFileSync(outsideFile, 'outside must survive')
    const moved = target.directory + '-original'
    const page = { eval: async (_expr, label) => {
      if (label !== 'chat:delete') throw new Error('Unexpected deletion label')
      fs.renameSync(target.directory, moved)
      fs.symlinkSync(outside, target.directory, 'junction')
      return true
    } }
    const result = await removeChat(page, target, 'junction-fixture')
    check('delete: directory swapped during API call fails closed', result === false)
    check('delete: outside file and moved original both remain untouched', fs.readFileSync(outsideFile, 'utf8') === 'outside must survive' && fs.readFileSync(path.join(moved, target.file), 'utf8') === 'owned fixture')
    const registered = readOrphans(userData).items.find(row => row?.path === target.path)
    check('delete: failed swap target is registered with trusted identity', registered?.dataDir === f.dataDir && registered?.avatar === target.avatar)
    await sweepOrphans(userData)
    check('sweep: junction target remains registered and outside file survives', readOrphans(userData).items.some(row => row?.path === target.path) && fs.readFileSync(outsideFile, 'utf8') === 'outside must survive')
  })
  await scenario('twenty concurrent registrations and sweeps serialize', async () => {
    const f = fixture('serialization'), targets = Array.from({ length: 20 }, (_, i) => owned(f.dataDir, 'concurrent-' + i))
    const outside = path.join(f.directory, 'unregistered.jsonl')
    fs.writeFileSync(outside, 'unregistered must survive')
    for (const target of targets) recordOrphan(orphan(target, f.dataDir), f.ledgerRoot)
    check('ledger: twenty registrations persist exactly twenty unique rows', readOrphans(f.ledgerRoot).items.length === 20 && new Set(readOrphans(f.ledgerRoot).items.map(row => row.path)).size === 20)
    const scans = []
    for (const target of targets) {
      recordOrphan(orphan(target, f.dataDir), f.ledgerRoot)
      scans.push(sweepOrphans(f.ledgerRoot))
    }
    await Promise.all(scans)
    const rows = readOrphans(f.ledgerRoot).items
    const retained = new Set(rows.map(row => row.path))
    check('ledger: twenty RMW registrations preserve every still-existing target', targets.every(target => !fs.existsSync(target.path) || retained.has(target.path)) && retained.size === rows.length, String(rows.length))
    check('ledger: concurrent scans leave valid versioned JSON without tmp residue', JSON.parse(fs.readFileSync(f.ledger, 'utf8')).version === 1 && !fs.existsSync(f.ledger + '.tmp'))
    await sweepOrphans(f.ledgerRoot)
    check('ledger: later sweep removes only registered owned files', readOrphans(f.ledgerRoot).items.length === 0 && targets.every(target => !fs.existsSync(target.path)))
    check('ledger: unregistered outside file is unaffected', fs.readFileSync(outside, 'utf8') === 'unregistered must survive')
  })
} finally {
  // Remove only this suite's unique temporary root, never a configured installation.
  fs.rmSync(root, { recursive: true, force: true })
}
done()
