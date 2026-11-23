/** SUP-05: execute the production allocator and production token estimator. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'
const { allocateBridgeBudget: allocate, estimateBridgeTokens: estimate, estimateTokens } = await bundleModule('bridge-budget', [
  'export { allocateBridgeBudget, estimateBridgeTokens } from ' + JSON.stringify(p('src/main/features/bridge/budget.ts')),
  'export { estimateTokens } from ' + JSON.stringify(p('src/main/features/rag/tokenize.ts'))
].join('\n'))
const { check, done } = createChecker()
const test = (name, fn) => { try { fn(); check(name, true) } catch (error) { check(name, false, error.stack) } }
const base = { budgetTotal: 1000, stReserveTokens: 10, personaTokens: 20, fixedTokens: 30, storyTokens: 40, memoryTokens: 50, messages: [] }
const msg = (role, size, id = size) => ({ role, content: '中'.repeat(size), id })
const run = (changes) => allocate({ ...base, ...changes })

test('Q-03 ample budget preserves every original message and metadata', () => {
  const messages = [msg('user', 8, 1), msg('assistant', 9, 2), msg('user', 10, 3)]
  const result = run({ messages })
  assert.equal(result.ok, true)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.messages[1], messages[1])
  assert.equal(result.history, result.messages)
  assert.equal(result.historyDropped, 0)
  assert.equal(result.historySent, 3)
  assert.equal(result.budgetUsed, 150 + messages.reduce((sum, row) => sum + estimate(row.content), 0))
})
test('Q-04 only a contiguous oldest prefix is omitted; never hole-punch', () => {
  const messages = [msg('assistant', 1, 1), msg('assistant', 100, 2), msg('user', 10, 3)]
  const result = run({ budgetTotal: 170, messages })
  assert.deepEqual(result.messages, messages.slice(2))
  assert.equal(result.historyDropped, 2)
  assert.equal(result.storyTokens, 40)
  assert.equal(result.memoryTokens, 50)
})
test('latest user protects every following assistant/tool entry', () => {
  const messages = [msg('user', 80, 1), msg('user', 10, 2), msg('assistant', 10, 3), msg('tool', 10, 4)]
  const result = run({ budgetTotal: 170, messages })
  assert.equal(result.ok, true)
  assert.deepEqual(result.messages, messages.slice(1))
  assert.equal(result.protectedTokens, 33)
  assert.equal(result.storyTokens, 27)
  assert.equal(result.memoryTokens, 50)
})
test('Q-06 historical messages go before any RAG reduction', () => {
  const messages = [msg('assistant', 100), msg('user', 10)]
  const result = run({ budgetTotal: 161, messages })
  assert.equal(result.historyDropped, 1)
  assert.equal(result.storyTokens, 40)
  assert.equal(result.memoryTokens, 50)
  assert.equal(result.budgetUsed, 161)
})
test('Q-06 story shrinks partially while memory remains untouched', () => {
  const result = run({ budgetTotal: 141, messages: [msg('user', 10)] })
  assert.equal(result.storyTokens, 20)
  assert.equal(result.memoryTokens, 50)
  assert.equal(result.budgetUsed, 141)
})
test('Q-06 memory shrinks only after story reaches zero', () => {
  const result = run({ budgetTotal: 91, messages: [msg('user', 10)] })
  assert.equal(result.storyTokens, 0)
  assert.equal(result.memoryTokens, 20)
  assert.equal(result.budgetUsed, 91)
})
test('Q-07 protected suffix overflow is fail:budget with all diagnostics', () => {
  const messages = [msg('user', 10), msg('tool', 10)]
  const result = run({ budgetTotal: 81, messages })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'fail:budget')
  assert.equal(result.failKind, 'protected-tail')
  assert.deepEqual(result.messages, messages)
  assert.equal(result.budgetUsed, 82)
  for (const word of ['预算', '已用', '三项体积', '人格', '故事RAG', '记忆RAG']) assert.ok(result.message.includes(word))
})
test('oversized persona fails without trimming persona', () => {
  const result = run({ budgetTotal: 29 })
  assert.equal(result.reason, 'fail:budget')
  assert.equal(result.failKind, 'persona')
  assert.equal(result.personaTokens, 20)
  assert.match(result.message, /人格提示词过大/)
})
test('fixed summary/time overflow remains fixed and fails', () => {
  const result = run({ budgetTotal: 59 })
  assert.equal(result.failKind, 'fixed')
  assert.equal(result.fixedTokens, 30)
  assert.equal(result.storyTokens, 0)
  assert.equal(result.memoryTokens, 0)
})
test('empty input and zero budget have a valid zero allocation', () => {
  const result = run({ budgetTotal: 0, stReserveTokens: 0, personaTokens: 0, fixedTokens: 0, storyTokens: 0, memoryTokens: 0 })
  assert.equal(result.ok, true)
  assert.equal(result.historySent, 0)
  assert.equal(result.budgetUsed, 0)
})
test('without a user the newest message remains protected', () => {
  const result = run({ budgetTotal: 61, messages: [msg('assistant', 50), msg('tool', 1)] })
  assert.equal(result.ok, false)
  assert.equal(result.historySent, 1)
  assert.equal(result.messages[0].role, 'tool')
})
test('estimation reuses RAG estimator times 1.1 with upward rounding', () => {
  for (const text of ['', '中文abc xyz', 'hello world', '🙂', '中'.repeat(100)]) {
    assert.equal(estimate(text), Math.ceil(estimateTokens(text) * 1.1))
  }
})
test('fractional capacity rounds down; consumption rounds up', () => {
  const result = run({ budgetTotal: 4.9, stReserveTokens: 0.1, personaTokens: 0.1, fixedTokens: 0.1, storyTokens: 0, memoryTokens: 0 })
  assert.equal(result.budgetTotal, 4)
  assert.equal(result.budgetUsed, 3)
})
test('invalid numeric inputs fail closed rather than silently granting capacity', () => {
  for (const key of ['budgetTotal', 'stReserveTokens', 'personaTokens', 'fixedTokens', 'storyTokens', 'memoryTokens']) {
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => run({ [key]: value }), RangeError)
    }
  }
})
test('frozen input is unchanged and repeated allocations are deterministic', () => {
  const messages = Object.freeze([Object.freeze(msg('user', 20)), Object.freeze(msg('assistant', 10))])
  const input = Object.freeze({ ...base, messages, budgetTotal: 130 })
  assert.deepEqual(allocate(input), allocate(input))
  assert.equal(input.storyTokens, 40)
  assert.equal(input.messages.length, 2)
})
test('boundary sweep balances all sections and retains exact protected suffix', () => {
  const messages = [msg('user', 7, 1), msg('assistant', 13, 2), msg('user', 5, 3), msg('tool', 3, 4)]
  for (let budgetTotal = 0; budgetTotal <= 210; budgetTotal += 1) {
    const result = run({ budgetTotal, messages })
    assert.deepEqual(result.messages, messages.slice(result.historyDropped))
    assert.ok(result.historyDropped <= 2)
    assert.equal(result.historySent + result.historyDropped, messages.length)
    assert.equal(result.budgetUsed, 60 + result.storyTokens + result.memoryTokens + result.historyTokens)
    assert.equal(result.ok, result.budgetUsed <= budgetTotal)
    if (result.memoryTokens < 50) assert.equal(result.storyTokens, 0)
    if (result.storyTokens < 40) assert.equal(result.historyDropped, 2)
  }
})
// Run real page expressions and the real driver; only the external ST host/disk are fixtures.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-budget-integration-'))
installElectronStub(fixtureRoot)
const { BridgeDriver, readBudgetSource, BridgeFailure } = await bundleModule('budget-driver', [
  'export { BridgeDriver } from ' + JSON.stringify(p('src/main/features/bridge/driver.ts')),
  'export { readBudgetSource } from ' + JSON.stringify(p('src/main/features/bridge/session.ts')),
  'export { BridgeFailure } from ' + JSON.stringify(p('src/shared/bridge.ts'))
].join('\n'))
const asyncTest = async (name, fn) => { try { await fn(); check(name, true) } catch (error) { check(name, false, error.stack) } }
function gateway(settings = { openai_max_context: 200, openai_max_tokens: 30 }) {
  const context = {
    chat: [], chatMetadata: {}, extensionPrompts: {},
    characters: [{ name: 'test', avatar: 'test.png', chat: 'original-chat' }], characterId: 0,
    powerUserSettings: {}, chatCompletionSettings: settings,
    setExtensionPrompt(key, value, position, depth, scan = false, role = 0) { this.extensionPrompts[key] = { value, position, depth, scan, role } },
    eventTypes: {}, eventSource: {}, generate() {}, stopGeneration() {}
  }
  const labels = [], seen = [], diskCalls = [], records = []
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [1700000000000])) }
    static now() { return 1700000000000 }
  }
  const sandbox = { SillyTavern: { getContext: () => context }, Date: FixtureDate }
  sandbox.window = sandbox
  const world = vm.createContext(sandbox)
  const page = { alive: () => true, async eval(expr, label) {
    labels.push(label)
    if (label === 'character:assert') return { name: 'test', avatar: 'test.png' }
    if (label === 'chat:drain') return true
    if (label === 'generate') {
      seen.push(JSON.parse(JSON.stringify(context)))
      context.chat.push({ is_user: false, mes: 'fixture reply' })
      return { ok: true, ms: 1, value: 'fixture reply', lastMes: 'fixture reply', toasts: [] }
    }
    return vm.runInContext(expr, world)
  } }
  const disk = {
    target(_dir, name, avatar) { diskCalls.push('target'); return { name, avatar, directory: fixtureRoot, file: name + '.jsonl', path: path.join(fixtureRoot, name + '.jsonl') } },
    async wait(target, injected) {
      diskCalls.push('wait')
      assert.equal(context.chat.length, injected + 1)
      assert.equal(context.chat.at(-1).is_user, false)
      // One metadata line + actual injection + generated assistant line.
      return { content: context.chat.at(-1).mes, expectedLines: injected + 2, actualLines: context.chat.length + 1, file: target.file, waitMs: 0 }
    },
    async remove() { diskCalls.push('remove'); return true },
    async backups() { diskCalls.push('backups'); return [] }
  }
  return { context, labels, seen, diskCalls, records, page, disk, ensure: async () => page, onEvent: () => () => {} }
}
const driverFor = (gw, config = {}) => new BridgeDriver({
  gateway: gw, disk: gw.disk, config: { minIntervalMs: 0, stReserveTokens: 10, ...config },
  writeTrace: record => gw.records.push(record),
  readOverride: () => ({ text: '', active: false, truncated: false, warning: null })
})
function prepare(messages, sizes = {}) {
  return source => {
    if (source.budgetTotal === null) throw new BridgeFailure('fail:budget', '预算未知，请填写手动预算')
    const result = allocate({ ...base, ...sizes, budgetTotal: source.budgetTotal, stReserveTokens: source.stReserveTokens, messages })
    if (!result.ok) throw new BridgeFailure('fail:budget', result.message)
    return { ...result, systemPrompts: ['retained fixed context'] }
  }
}

await asyncTest('Q-01/Q-02 live expression reads settings on every call without writing', async () => {
  const settings = Object.freeze({ openai_max_context: 4096, openai_max_tokens: 512 })
  const gw = gateway(settings)
  let result = await readBudgetSource(gw.page, { manualBudgetTokens: 777, stReserveTokens: null })
  assert.equal(result.source, 'st')
  assert.equal(result.context, 4096)
  assert.equal(result.response, 512)
  assert.equal(result.budgetTotal, 3584)
  assert.equal(result.stReserveTokens, Math.ceil(3584 * 0.35))
  assert.equal(result.warning, undefined)
  gw.context.chatCompletionSettings = Object.freeze({ openai_max_context: 9000, openai_max_tokens: 1000 })
  result = await readBudgetSource(gw.page, { manualBudgetTokens: 777, stReserveTokens: 123 })
  assert.equal(result.budgetTotal, 8000)
  assert.equal(result.stReserveTokens, 123)
  assert.deepEqual(gw.labels, ['budget:read', 'budget:read'])
  assert.equal(settings.openai_max_context, 4096)
})
await asyncTest('Q-01 missing or invalid live settings use explicit fallback, never 128K', async () => {
  for (const settings of [undefined, {}, { openai_max_context: 100 }, { openai_max_context: NaN, openai_max_tokens: 0 }, { openai_max_context: 10, openai_max_tokens: 11 }]) {
    const gw = gateway(settings)
    gw.context.chatCompletionSettings = settings
    const manual = await readBudgetSource(gw.page, { manualBudgetTokens: 987, stReserveTokens: 20 })
    assert.equal(manual.source, 'manual')
    assert.equal(manual.budgetTotal, 987)
    assert.match(manual.warning, /手填值/)
    const missing = await readBudgetSource(gw.page, { manualBudgetTokens: null, stReserveTokens: null })
    assert.equal(missing.source, 'unavailable')
    assert.equal(missing.budgetTotal, null)
    assert.match(missing.warning, /手动预算/)
  }
})
await asyncTest('page evaluation failure falls back to explicit manual budget', async () => {
  const source = await readBudgetSource({ eval: async () => { throw Error('page unavailable') } }, { manualBudgetTokens: 123, stReserveTokens: 0 })
  assert.equal(source.source, 'manual')
  assert.equal(source.budgetTotal, 123)
  assert.equal(source.stReserveTokens, 0)
  assert.match(source.warning, /手填值/)
})
await asyncTest('Q-05/Q-08 driver injects trimmed suffix and reconciles persisted line count', async () => {
  const gw = gateway()
  const messages = [msg('user', 100, 1), msg('assistant', 100, 2), msg('user', 10, 3), msg('assistant', 5, 4)]
  const detail = await driverFor(gw).runTurn({ sessionId: 'budget-trim', messages, prepareBudget: prepare(messages) })
  assert.equal(detail.result.status, 'done', detail.result.error)
  assert.deepEqual(gw.seen[0].chat.map(row => row.mes), messages.slice(2).map(row => row.content))
  assert.equal(detail.trace.historySent, 2)
  assert.equal(detail.trace.historyDropped, 2)
  assert.equal(detail.trace.injected, 2)
  assert.equal(detail.trace.historyInChat, 2)
  assert.equal(detail.trace.disk.injected, 2)
  assert.equal(detail.trace.disk.expectedLines, 4)
  assert.equal(detail.trace.disk.actualLines, 4)
  assert.equal(detail.trace.budgetTotal, 170)
  assert.equal(detail.trace.budgetUsed, 167)
  assert.equal(gw.records[0].sent, 2)
  assert.equal(gw.records[0].historyDropped, 2)
  assert.equal(gw.records[0].budgetUsed, 167)
  assert.match(detail.result.warnings.join(' '), /省略了 2 条/)
  assert.ok(gw.labels.indexOf('budget:read') < gw.labels.indexOf('clear'))
})
await asyncTest('Q-07 over-budget fails before reset, injection, generation or chat disk operations', async () => {
  const gw = gateway({ openai_max_context: 100, openai_max_tokens: 30 })
  gw.context.chat.push({ mes: 'existing unrelated chat', is_user: true })
  gw.context.extensionPrompts.existing = { value: 'untouched' }
  const before = JSON.stringify(gw.context)
  const messages = [msg('user', 20)]
  const detail = await driverFor(gw).runTurn({ sessionId: 'budget-fail', messages, prepareBudget: prepare(messages) })
  assert.equal(detail.result.status, 'error')
  assert.ok(detail.trace.steps.includes('fail:budget'))
  for (const word of ['预算', '已用', '三项体积']) assert.ok(detail.result.error.includes(word), detail.result.error)
  assert.equal(gw.seen.length, 0)
  assert.deepEqual(gw.diskCalls, [])
  assert.equal(JSON.stringify(gw.context), before)
  assert.equal(gw.labels.includes('clear'), false)
  assert.equal(gw.labels.includes('inject'), false)
  assert.equal(detail.trace.historySent, 0)
})
await asyncTest('Q-10 disabled budget is byte-identical to legacy injection and skips callback/read', async () => {
  const messages = [msg('user', 100), msg('assistant', 100), msg('user', 10)]
  const legacy = gateway(), disabled = gateway()
  const first = await driverFor(legacy).runTurn({ sessionId: 'budget-legacy', messages, map: { now: 1700000000000 }, systemPrompts: ['original system'] })
  let called = false
  const second = await driverFor(disabled, { budgetEnabled: false }).runTurn({ sessionId: 'budget-disabled', messages, map: { now: 1700000000000 }, systemPrompts: ['original system'], prepareBudget: () => { called = true; throw Error('must not run') } })
  assert.equal(first.result.status, 'done', first.result.error)
  assert.equal(second.result.status, 'done', second.result.error)
  assert.equal(called, false)
  assert.equal(disabled.labels.includes('budget:read'), false)
  assert.deepEqual(disabled.seen[0].chat, legacy.seen[0].chat)
  assert.deepEqual(disabled.seen[0].extensionPrompts, legacy.seen[0].extensionPrompts)
  assert.equal(second.trace.historySent, messages.length)
})
await asyncTest('driver rejects holes or content edits before any side effects', async () => {
  for (const mutate of [rows => [rows[0], rows[2]], rows => [{ ...rows[2], content: 'edited' }], rows => []]) {
    const gw = gateway()
    const messages = [msg('user', 5), msg('assistant', 5), msg('user', 5)]
    const detail = await driverFor(gw).runTurn({ sessionId: 'budget-invalid', messages, prepareBudget: source => {
      const rows = mutate(messages)
      return { messages: rows, systemPrompts: [], historyDropped: messages.length - rows.length, budgetUsed: 10, budgetTotal: source.budgetTotal, stReserveTokens: source.stReserveTokens }
    } })
    assert.equal(detail.result.status, 'error')
    assert.ok(detail.trace.steps.includes('fail:budget'))
    assert.deepEqual(gw.diskCalls, [])
    assert.equal(gw.seen.length, 0)
  }
})
await asyncTest('real chatService callback rebuilds reduced RAG while preserving fixed summary and legacy payload', async () => {
  const api = await bundleModule('budget-chat', [
    ['chatService', 'chat/chatService'], ['setBridgeRunnerForTest', 'bridge/stream'],
    ['settingsStore', 'settings/settingsStore'], ['HeadlessSink', 'chat/sink'],
    ['createStory', 'story/service'], ['storyMemory, closeAllStoryMemory', 'story/memory'],
    ['summaryService', 'summary/service'], ['SummaryStore, summaryKeyOf', 'summary/store']
  ].map(([names, file]) => 'export { ' + names + ' } from ' + JSON.stringify(p('src/main/features/' + file + '.ts'))).join('\n'))
  api.settingsStore.save({ bridge: { enabled: true }, memory: { enabled: true, autoExtract: false, budgetTokens: 400 }, summary: { enabled: true }, storyRecall: { enabled: true } })
  const created = api.createStory({ title: 'budget callback fixture', background: '背景固定段', profile: '画像固定段', openingText: '已归档开场' })
  const session = api.chatService.listSessions().find(row => row.id === created.sessionId)
  new api.SummaryStore().save(new Map([[api.summaryKeyOf(session.id, 'default'), {
    sessionId: session.id, personaId: 'default', coveredCount: 1, anchorMessageId: session.messages[0].id,
    sections: { short_term: '摘要必须逐字保留', user_info: '', promises: '', long_term: '' },
    updatedAt: 1, lastAttemptAt: 0, lastError: null
  }]]))
  const memory = api.storyMemory(created.meta.storyId)
  const originalStory = memory.buildStoryContextBlock, originalMemory = memory.buildContextBlock
  const calls = []
  memory.buildStoryContextBlock = async (_session, config) => {
    calls.push(['story', config.budgetTokens])
    return config.budgetTokens > 0 ? '故事召回' + '故'.repeat(Math.min(config.budgetTokens - 4, 596)) : ''
  }
  memory.buildContextBlock = async (_query, config) => {
    calls.push(['memory', config.budgetTokens])
    return config.budgetTokens > 0 ? '记忆召回' + '忆'.repeat(Math.max(0, Math.min(config.budgetTokens - 8, 396))) : ''
  }
  let captured
  api.setBridgeRunnerForTest(async input => {
    captured = input
    await verifyCallback()
    return { result: { status: 'done', content: 'reply', raw: 'reply', error: null, ms: 1, warnings: [] }, trace: {} }
  })
  async function verifyCallback() {
    assert.equal(typeof captured.prepareBudget, 'function')
    const originalPayload = JSON.stringify({ messages: captured.messages, systemPrompts: captured.systemPrompts })
    const fixed = captured.systemPrompts.filter(text => !text.startsWith('故事召回') && !text.startsWith('记忆召回'))
    assert.ok(fixed.some(text => text.includes('摘要必须逐字保留')), JSON.stringify(fixed))
    assert.ok(fixed.some(text => text.includes('背景固定段')))
    const fixedCost = fixed.reduce((sum, text) => sum + estimate(text), 0)
    const historyCost = captured.messages.reduce((sum, row) => sum + estimate(row.content), 0)
    calls.length = 0
    const source = { context: 10000, response: 0, source: 'st', budgetTotal: fixedCost + historyCost + 220, stReserveTokens: 0, fixedPromptTokens: 0 }
    const reduced = await captured.prepareBudget(source)
    assert.ok(calls.some(([kind, budget]) => kind === 'story' && budget === 0), JSON.stringify(calls))
    assert.ok(calls.some(([kind, budget]) => kind === 'memory' && budget > 0 && budget < 400), JSON.stringify(calls))
    assert.ok(!reduced.systemPrompts.some(text => text.startsWith('故事召回')))
    const smallerMemory = reduced.systemPrompts.find(text => text.startsWith('记忆召回'))
    assert.ok(smallerMemory && smallerMemory.length < 400)
    assert.deepEqual(reduced.systemPrompts.filter(text => !text.startsWith('记忆召回')), fixed)
    assert.ok(reduced.budgetUsed <= source.budgetTotal)
    assert.deepEqual(reduced.messages, captured.messages)
    assert.equal(JSON.stringify({ messages: captured.messages, systemPrompts: captured.systemPrompts }), originalPayload)
    // Ample/disabled paths retain the original payload; the callback never mutates it.
    const ample = await captured.prepareBudget({ ...source, budgetTotal: 10000 })
    assert.deepEqual(ample.messages, captured.messages)
    assert.deepEqual(ample.systemPrompts, captured.systemPrompts)
    const gw = gateway()
    const disabled = await driverFor(gw, { budgetEnabled: false }).runTurn({ ...captured, sessionId: 'chat-budget-disabled', map: { now: 1700000000000 } })
    assert.equal(disabled.result.status, 'done', disabled.result.error)
    assert.deepEqual(gw.seen[0].chat.map(row => row.mes), captured.messages.map(row => row.content))
    assert.equal(gw.labels.includes('budget:read'), false)
  }
  try {
    const outcome = await api.chatService.sendAwait({ sessionId: session.id, content: '继续' }, new api.HeadlessSink())
    assert.equal(outcome.status, 'done', outcome.error)
  } finally {
    memory.buildStoryContextBlock = originalStory
    memory.buildContextBlock = originalMemory
    api.setBridgeRunnerForTest(null)
    api.closeAllStoryMemory()
  }
})
// SQLite/archive callbacks may still hold handles on Windows; OS temp cleanup owns this fixture.
done()
