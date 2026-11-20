/** P4.9 A: real React/jsdom, SettingsStore JSON, SQLite statistics and chat payload.
 * Run: node scripts/test/p49-recall-settings.test.mjs
 * Only preload transport is stubbed; production components, hooks, validators,
 * NumberField, archive, retriever and buildPayload execute unchanged.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { bundleModule, installElectronStub, p, projectRoot } from './qq-test-util.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p49-recall-settings-'))
installElectronStub(dir)
const settingsFile = path.join(dir, 'settings.json')
fs.writeFileSync(settingsFile, JSON.stringify({ provider: 'mock', bridge: { enabled: false },
  memory: { enabled: true, autoExtract: true, topK: 7, minScore: .61, budgetTokens: 2300 },
  summary: { enabled: true } }))
const api = await bundleModule('p49-recall-settings-main', [
  ['settingsStore', 'settings/settingsStore.ts'],
  ['storyRecallStatus', 'story/recallStatus.ts'],
  ['embedder', 'rag/embedder.ts'],
  ['memoryService', 'rag/index.ts'],
  ['MemoryStore', 'rag/store.ts'],
  ['splitRounds, sliceRound, contentVersion', 'rag/storyArchive.ts'],
  ['storyArchiveStore, closeAllStoryMemory', 'story/memory.ts'],
  ['branchStore', 'story/branches.ts'],
  ['chatService', 'chat/chatService.ts']
].map(([names, file]) => 'export { ' + names + ' } from ' + JSON.stringify(p('src/main/features/' + file))).join('\n'))
const newStore = () => new api.settingsStore.constructor()
const fresh = () => newStore().get()
const store = api.settingsStore
const initialMemory = JSON.stringify(store.get().memory)
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let requests = []
let failSave = false
let heldSave = null
let holdSave = false
let downloads = 0
let ensures = 0
let statusCalls = 0
const summaryCalls = { status: 0, forget: [], clear: 0 }
let summaryStatus = { sessionCount: 2, coveredMessages: 23, lastUpdatedAt: 0, file: 'fixture/summaries.json', lastError: null }
const memoryStatus = { modelReady: false, modelInstalled: false, modelId: 'fixture-offline', dimensions: 0,
  entryCount: 0, dbPath: 'fixture/main-memory.db', lastError: null }
const originalEnsure = api.embedder.ensure
api.embedder.ensure = async () => { ensures++; throw Error('status must never ensure/download a model') }
window.nahida = {
  settings: { get: async () => fresh(), save: async patch => {
    requests.push(structuredClone(patch))
    if (holdSave) await new Promise(resolve => { heldSave = resolve })
    if (failSave) throw Error('fixture disk failure')
    return store.save(patch)
  } },
  story: { recallStatus: async () => { statusCalls++; return api.storyRecallStatus() } },
  summary: {
    status: async () => { summaryCalls.status++; return { ...summaryStatus } },
    forget: async id => { summaryCalls.forget.push(id); return { ...summaryStatus, sessionCount: 1 } },
    clear: async () => { summaryCalls.clear++; summaryStatus = { ...summaryStatus, sessionCount: 0, coveredMessages: 0 }; return summaryStatus }
  },
  memory: { status: async () => memoryStatus, users: async () => [], recall: async () => [],
    downloadModel: async () => { downloads++; throw Error('unexpected download') }, onModelProgress: () => () => {} }
}

// Recover the PRE-P4.9 component from HEAD plus the frozen start diff. This is
// independent of today's component, and comparison below uses rendered DOM.
const componentPath = 'src/renderer/src/features/settings/sections/MemorySection.tsx'
const baselineDiff = path.resolve(projectRoot, '../DOC/agent--ST桥接重构/task-桥接重构/baseline/p49-start.diff')
function baselineSource() {
  const source = execFileSync('git', ['show', 'HEAD:' + componentPath], { cwd: projectRoot, encoding: 'utf8' }).replace(/\r\n/g, '\n')
  const diff = fs.readFileSync(baselineDiff, 'utf8').replace(/\r\n/g, '\n')
  const block = diff.split('diff --git ').find(part => part.startsWith('a/' + componentPath + ' b/' + componentPath + '\n'))
  if (!block) return source
  const old = source.split('\n'), result = []
  let cursor = 0, inHunk = false
  for (const line of block.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line)
    if (header) { const start = Number(header[1]) - 1; result.push(...old.slice(cursor, start)); cursor = start; inHunk = true; continue }
    if (!inHunk || line.startsWith('\\ No newline')) continue
    if (line.startsWith(' ') || line.startsWith('-')) {
      assert.equal(old[cursor], line.slice(1), 'frozen baseline patch context must match HEAD')
      if (line[0] === ' ') result.push(old[cursor])
      cursor++
    } else if (line.startsWith('+')) result.push(line.slice(1))
  }
  result.push(...old.slice(cursor))
  return result.join('\n')
}
const baseline = baselineSource()
const ui = await bundleModule('p49-recall-settings-dom', [
  'export { createElement, act } from ' + JSON.stringify(p('node_modules/react/index.js')),
  'export { createRoot } from ' + JSON.stringify(p('node_modules/react-dom/client.js')),
  'export { MemorySection } from ' + JSON.stringify(p(componentPath)),
  'export { MemorySection as BeforeMemorySection } from "p49-frozen-memory"',
  'export { useChatStore } from ' + JSON.stringify(p('src/renderer/src/features/chat/store.ts'))
].join('\n'), [{ name: 'frozen-memory', setup(build) {
  build.initialOptions.jsx = 'automatic'
  build.onResolve({ filter: /^p49-frozen-memory$/ }, () => ({ path: 'memory-before.tsx', namespace: 'p49-frozen' }))
  build.onLoad({ filter: /.*/, namespace: 'p49-frozen' }, () => ({ contents: baseline, loader: 'tsx', resolveDir: path.dirname(p(componentPath)) }))
} }])
const { createElement: h, act } = ui
const root = ui.createRoot(document.getElementById('root'))
ui.useChatStore.setState({ activeId: 'summary-active' })
const target = name => document.querySelector('[data-ui-target="' + name + '"]')
const field = name => target(name)?.querySelector('input')
const click = node => act(async () => { assert.ok(node, 'click target exists'); node.click() })
const mount = Component => act(async () => { root.render(h(Component)) })
const leave = () => act(async () => root.render(h('p', null, 'other settings tab')))
const edit = async (node, value) => {
  assert.ok(node, 'number input exists')
  await act(async () => { node.focus() })
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, String(value))
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { node.blur() })
}
const storySave = () => click(target('保存故事召回设置'))
const summarySection = () => target('对话摘要参数').closest('section')
const section = (container, title) => [...container.querySelectorAll('section')].find(n => n.querySelector('h3')?.textContent === title)
let checks = 0, failures = 0
async function test(label, run) {
  try { await run(); checks++; console.log('PASS ' + checks + ' - ' + label) }
  catch (error) { checks++; failures++; console.error('FAIL ' + checks + ' - ' + label + '\n' + error.stack) }
}
const rootDir = path.join(dir, 'stories')
const dbFiles = []
function database(id, rounds, vectors, nullChunks = 0) {
  const folder = path.join(rootDir, id)
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, 'memory.db')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE story_rounds(id TEXT PRIMARY KEY); CREATE TABLE story_chunks(round_id TEXT, embedding BLOB);')
    for (let i = 0; i < rounds; i++) db.prepare('INSERT INTO story_rounds VALUES(?)').run('r' + i)
    for (const id of vectors) db.prepare('INSERT INTO story_chunks VALUES(?, ?)').run(id, Buffer.from([1, 2, 3, 4]))
    for (let i = 0; i < nullChunks; i++) db.prepare('INSERT INTO story_chunks VALUES(?, NULL)').run('null' + i)
  } finally { db.close() }
  dbFiles.push(file)
  return file
}
const diskSnapshot = () => Object.fromEntries(dbFiles.map(file => [file, { bytes: fs.readFileSync(file).toString('base64'), mtime: fs.statSync(file).mtimeMs }]))

try {
  await test('A-07/A-08 empty state returns zero and creates no story root, db or model files', () => {
    const before = fs.readdirSync(dir).sort()
    const s = api.storyRecallStatus()
    assert.deepEqual([s.archivedRounds, s.vectorRounds, s.vectorReady], [0, 0, false])
    assert.deepEqual(s.databaseErrors, [])
    assert.equal(s.lastRecall, null)
    assert.deepEqual(fs.readdirSync(dir).sort(), before)
    assert.equal(ensures, 0)
  })
  await mount(ui.BeforeMemorySection)
  const oldSummaryDOM = summarySection().outerHTML
  const originalFactDOM = ['运行状态', '检索参数', '检索调试', '按人查看与清理'].map(title => section(document, title).outerHTML)
  await leave()
  await mount(ui.MemorySection)
  await test('A-01/A-10 real panel exposes six editable controls and read-only status, no hidden candidate/extraction controls', () => {
    const panel = target('故事区RAG召回')
    assert.ok(panel)
    assert.equal(panel.querySelectorAll('input').length, 6)
    const expected = [['故事召回轮数', '4', '1', '20'], ['故事召回预算', '8000', '1000', '32000'],
      ['故事召回阈值', '0.4', '0', '1'], ['故事关键词权重', '0.5', '0', '1'], ['故事补查深度', '32', '0', '64']]
    for (const [name, value, min, max] of expected) {
      assert.equal(field(name).value, value); assert.equal(field(name).min, min); assert.equal(field(name).max, max)
    }
    assert.equal(field('故事召回开关').checked, true)
    assert.ok(target('故事召回状态'))
    assert.doesNotMatch(panel.textContent, /抽取|提炼|candidateMultiplier|候选乘数/)
    assert.match(panel.textContent, /0 关闭补查/)
  })
  await test('A-06 rendered summary DOM exactly matches frozen pre-phase source', () => {
    assert.equal(summarySection().outerHTML, oldSummaryDOM)
    assert.equal(summarySection().closest('details'), null)
  })
  await test('A-05 all original fact sections remain verbatim inside a default-closed native details', async () => {
    const details = target('普通聊天事实记忆')
    assert.equal(details.tagName, 'DETAILS'); assert.equal(details.open, false)
    assert.match(details.querySelector('summary').textContent, /普通聊天使用/)
    for (const [i, title] of ['运行状态', '检索参数', '检索调试', '按人查看与清理'].entries()) {
      assert.equal(section(details, title).outerHTML, originalFactDOM[i], title + ' original rendered DOM preserved')
    }
    await click(details.querySelector('summary')); assert.equal(details.open, true)
    assert.equal(target('检索参数').querySelectorAll('input').length, 5)
    assert.ok(target('试召回输入').querySelector('button'))
    assert.ok(target('下载 RAG 模型'))
  })
  await test('A-02 UI blocks equal and lower keyword weights, exposes explanation and sends no save', async () => {
    const count = requests.length
    for (const weight of [.4, .2]) {
      await edit(field('故事关键词权重'), weight)
      assert.equal(target('保存故事召回设置').disabled, true)
      assert.match(target('故事召回校验').textContent, /关键词权重必须大于相似度阈值/)
      assert.match(target('故事召回校验').textContent, /纯关键词召回会全部被过滤掉/)
      await storySave(); assert.equal(requests.length, count)
    }
    await edit(field('故事关键词权重'), .85)
    assert.equal(target('保存故事召回设置').disabled, false)
  })
  await test('A-01/A-03 edit every story control, save once, reload real store and remount', async () => {
    const count = requests.length
    await click(field('故事召回开关'))
    await edit(field('故事召回轮数'), 9)
    await edit(field('故事召回预算'), 17000)
    await edit(field('故事召回阈值'), .3)
    await edit(field('故事补查深度'), 0)
    assert.equal(requests.length, count, 'explicit save keeps all edits local')
    await storySave()
    assert.deepEqual(Object.keys(requests.at(-1)), ['storyRecall'])
    const saved = fresh().storyRecall
    assert.deepEqual({ enabled: saved.enabled, n: saved.n, budgetTokens: saved.budgetTokens, minScore: saved.minScore,
      keywordWeight: saved.keywordWeight, recheckDepth: saved.recheckDepth },
    { enabled: false, n: 9, budgetTokens: 17000, minScore: .3, keywordWeight: .85, recheckDepth: 0 })
    assert.equal(JSON.stringify(fresh().memory), initialMemory)
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).memory), initialMemory)
    assert.match(target('故事区RAG召回').textContent, /已保存/)
    await leave(); await mount(ui.MemorySection)
    assert.equal(field('故事召回轮数').value, '9'); assert.equal(field('故事补查深度').value, '0')
    assert.equal(field('故事召回开关').checked, false)
  })
  await test('A-01 NumberField clamps N, token budget and recheck bounds on blur', async () => {
    for (const [name, low, high, min, max] of [['故事召回轮数', -3, 50, '1', '20'],
      ['故事召回预算', 0, 50000, '1000', '32000'], ['故事补查深度', -1, 99, '0', '64']]) {
      await edit(field(name), low); assert.equal(field(name).value, min)
      await edit(field(name), high); assert.equal(field(name).value, max)
    }
    await storySave()
    assert.deepEqual([fresh().storyRecall.n, fresh().storyRecall.budgetTokens, fresh().storyRecall.recheckDepth], [20, 32000, 64])
  })
  await test('A-02 save failure shows error, preserves draft and disk, and supports retry', async () => {
    await edit(field('故事召回轮数'), 6)
    const before = fs.readFileSync(settingsFile, 'utf8')
    failSave = true
    await storySave()
    assert.ok(target('故事区RAG召回').querySelector('[role="alert"]'))
    assert.equal(field('故事召回轮数').value, '6')
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), before)
    failSave = false
    await storySave()
    assert.equal(fresh().storyRecall.n, 6)
  })
  await test('A-01 pending save prevents duplicate submits and visibly disables the fieldset', async () => {
    holdSave = true
    await storySave()
    const count = requests.length
    assert.equal(target('保存故事召回设置').disabled, true)
    assert.equal(target('故事区RAG召回').querySelector('fieldset').disabled, true)
    await storySave(); assert.equal(requests.length, count)
    holdSave = false
    await act(async () => { assert.ok(heldSave); heldSave(); heldSave = null })
    assert.equal(target('保存故事召回设置').disabled, false)
  })
  await test('A-02 backend validates raw cross-fields and every range before touching cache or JSON', () => {
    const invalid = [
      { n: 0 }, { n: 21 }, { n: 1.5 }, { n: NaN }, { n: '4' },
      { budgetTokens: 999 }, { budgetTokens: 32001 }, { budgetTokens: 1000.1 },
      { minScore: -.01 }, { minScore: 1.01 }, { minScore: Infinity },
      { keywordWeight: -.01 }, { keywordWeight: 1.01 }, { keywordWeight: null },
      { recheckDepth: -1 }, { recheckDepth: 65 }, { recheckDepth: .5 }, { enabled: 'false' },
      { minScore: .4, keywordWeight: .4 }, { minScore: .8, keywordWeight: .2 }
    ]
    for (const patch of invalid) {
      const before = fs.readFileSync(settingsFile, 'utf8'), cached = structuredClone(store.get())
      assert.throws(() => store.save({ storyRecall: patch }), /故事召回|关键词权重/, JSON.stringify(patch))
      assert.equal(fs.readFileSync(settingsFile, 'utf8'), before)
      assert.deepEqual(store.get(), cached)
      assert.deepEqual(fresh().storyRecall, cached.storyRecall)
    }
  })
  await test('A-01 backend accepts inclusive bounds and partial patches with restart persistence', () => {
    for (const patch of [{ n: 1, budgetTokens: 1000, minScore: 0, keywordWeight: 1, recheckDepth: 0, enabled: true },
      { n: 20, budgetTokens: 32000, minScore: .99, keywordWeight: 1, recheckDepth: 64, enabled: false }]) {
      store.save({ storyRecall: patch })
      for (const key of Object.keys(patch)) assert.equal(fresh().storyRecall[key], patch[key])
      assert.equal(JSON.stringify(fresh().memory), initialMemory)
    }
  })
  await test('A-05 fact switches and number controls remain operable and never alter story settings', async () => {
    const before = structuredClone(fresh().storyRecall)
    const controls = target('检索参数').querySelectorAll('input')
    await click(controls[1]); assert.equal(fresh().memory.autoExtract, false)
    await edit(controls[2], 8); assert.equal(fresh().memory.topK, 8)
    await edit(controls[3], 3300); assert.equal(fresh().memory.budgetTokens, 3300)
    await edit(controls[4], .65); assert.equal(fresh().memory.minScore, .65)
    await click(controls[0]); assert.equal(fresh().memory.enabled, false)
    assert.deepEqual(fresh().storyRecall, before)
  })
  await test('A-06 original summary controls and refresh/forget/clear actions remain wired', async () => {
    const before = structuredClone(fresh().storyRecall)
    const input = target('对话摘要参数').querySelectorAll('input')
    assert.equal(input.length, 7)
    await edit(input[1], 45); assert.equal(fresh().summary.triggerCount, 45)
    await click(input[0]); assert.equal(fresh().summary.enabled, false)
    assert.equal(input[1].disabled, true)
    await click(input[0]); assert.equal(fresh().summary.enabled, true)
    const actions = target('对话摘要操作').querySelectorAll('button'), count = summaryCalls.status
    await click(actions[0]); assert.equal(summaryCalls.status, count + 1)
    await click(actions[1]); assert.deepEqual(summaryCalls.forget, ['summary-active'])
    await click(actions[2]); assert.equal(summaryCalls.clear, 1); assert.equal(actions[2].disabled, true)
    assert.deepEqual(fresh().storyRecall, before)
  })
  await test('A-07 SQLite aggregates all valid story directories and distinct embedded round ids only', () => {
    database('story_stats1_abcdef', 3, ['r0', 'r0', 'r1'], 2)
    database('story_stats2_123abc', 2, ['r0'], 1)
    database('not-a-story', 90, ['r0'])
    database('.trash', 80, ['r0'])
    fs.mkdirSync(path.join(rootDir, 'story_nodb_aabbcc'))
    const before = diskSnapshot(), files = fs.readdirSync(rootDir, { recursive: true }).sort()
    const s = api.storyRecallStatus()
    assert.deepEqual([s.archivedRounds, s.vectorRounds], [5, 3])
    assert.deepEqual(s.databaseErrors, [])
    assert.deepEqual(diskSnapshot(), before, 'read-only queries preserve bytes and mtimes')
    assert.deepEqual(fs.readdirSync(rootDir, { recursive: true }).sort(), files, 'no journal/db/schema artifacts created')
    assert.equal(fs.existsSync(path.join(rootDir, 'story_nodb_aabbcc/memory.db')), false)
  })
  await test('A-07/J-36 closed and active WAL statistics preserve every source file hash and mtime', () => {
    const closedDir = path.join(rootDir, 'story_walclosed_abcdef')
    const activeDir = path.join(rootDir, 'story_walactive_123abc')
    fs.mkdirSync(closedDir); fs.mkdirSync(activeDir)
    const closedFile = path.join(closedDir, 'memory.db')
    const activeFile = path.join(activeDir, 'memory.db')
    let closed, active
    const snapshot = folder => fs.readdirSync(folder).sort().map(name => {
      const file = path.join(folder, name), stat = fs.statSync(file, { bigint: true })
      return { name, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        bytes: String(stat.size), mtimeNs: String(stat.mtimeNs) }
    })
    const schema = 'CREATE TABLE story_rounds(id TEXT PRIMARY KEY); CREATE TABLE story_chunks(round_id TEXT, embedding BLOB);'
    try {
      closed = new DatabaseSync(closedFile)
      assert.equal(closed.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal')
      closed.exec(schema)
      closed.exec("INSERT INTO story_rounds VALUES('closed'); INSERT INTO story_chunks VALUES('closed', X'01020304')")
      closed.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      closed.close(); closed = null
      for (const suffix of ['-wal', '-shm']) fs.rmSync(closedFile + suffix, { force: true })
      assert.equal(fs.readFileSync(closedFile)[18], 2, 'main file retains WAL journal mode after close')
      assert.deepEqual(fs.readdirSync(closedDir), ['memory.db'])
      const closedBefore = snapshot(closedDir)
      let result = api.storyRecallStatus()
      assert.deepEqual(result.databaseErrors, [])
      assert.deepEqual([result.archivedRounds, result.vectorRounds], [6, 4])
      assert.deepEqual(snapshot(closedDir), closedBefore, 'status cannot create source WAL/SHM or change the main file')

      active = new DatabaseSync(activeFile)
      assert.equal(active.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal')
      active.exec('PRAGMA wal_autocheckpoint=0')
      active.exec(schema)
      active.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      active.exec("BEGIN; INSERT INTO story_rounds VALUES('live1'), ('live2'); INSERT INTO story_chunks VALUES('live1', X'01'), ('live1', X'02'), ('live2', NULL); COMMIT;")
      assert.ok(fs.statSync(activeFile + '-wal').size > 32, 'committed data is present in the live WAL')
      assert.ok(fs.existsSync(activeFile + '-shm'))
      // Prove these rows have NOT reached the main file without opening the source.
      const probeDir = fs.mkdtempSync(path.join(dir, 'wal-main-only-'))
      let probe
      try {
        const probeFile = path.join(probeDir, 'memory.db'); fs.copyFileSync(activeFile, probeFile)
        probe = new DatabaseSync(probeFile, { readOnly: true })
        assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM story_rounds').get().n, 0)
      } finally { probe?.close(); fs.rmSync(probeDir, { recursive: true, force: true }) }
      const activeBefore = snapshot(activeDir)
      result = api.storyRecallStatus()
      assert.deepEqual(result.databaseErrors, [])
      assert.deepEqual([result.archivedRounds, result.vectorRounds], [8, 5], 'aggregation includes uncheckpointed committed WAL rows and deduplicates vector rounds')
      assert.deepEqual(snapshot(activeDir), activeBefore, 'source main/WAL/SHM hashes, sizes and nanosecond mtimes remain exact')
      assert.deepEqual(snapshot(closedDir), closedBefore, 'other WAL-mode database still has no new sidecars')
    } finally {
      active?.close(); closed?.close()
      fs.rmSync(activeDir, { recursive: true, force: true })
      fs.rmSync(closedDir, { recursive: true, force: true })
    }
  })
  await test('A-07 malformed database remains visible as an error without hiding healthy counts', () => {
    const folder = path.join(rootDir, 'story_broken_998877'); fs.mkdirSync(folder)
    const file = path.join(folder, 'memory.db'); fs.writeFileSync(file, 'not sqlite')
    try {
      const s = api.storyRecallStatus()
      assert.deepEqual([s.archivedRounds, s.vectorRounds], [5, 3])
      assert.equal(s.databaseErrors.length, 1); assert.match(s.databaseErrors[0], /story_broken_998877/)
      assert.equal(fs.readFileSync(file, 'utf8'), 'not sqlite')
    } finally { fs.rmSync(folder, { recursive: true }) }
  })
  await test('A-07/A-08 refresh renders actual counts and conspicuous offline warning without downloading', async () => {
    await click(target('刷新故事召回状态'))
    const values = [...target('故事召回状态').querySelectorAll('dd')].map(n => n.textContent)
    assert.deepEqual(values.slice(0, 3), ['5', '3', '不可用（仅关键词召回，可能漏细节）'])
    assert.equal(values[3], '暂无记录')
    const warning = target('故事向量降级提示')
    assert.equal(warning.getAttribute('role'), 'status'); assert.ok(warning.querySelector('strong'))
    assert.match(warning.className, /hint-text--error/)
    assert.ok(statusCalls >= 2); assert.equal(downloads, 0); assert.equal(ensures, 0)
  })
  await test('A-08 vector availability follows embedder.ready, not mere model files', () => {
    const oldStatus = api.embedder.status, oldInstalled = api.embedder.modelInstalled
    try {
      api.embedder.modelInstalled = () => true
      api.embedder.status = () => ({ ready: false, dimensions: 2, modelPath: 'fixture', lastError: 'offline' })
      assert.equal(api.storyRecallStatus().vectorReady, false)
      api.embedder.status = () => ({ ready: true, dimensions: 2, modelPath: 'fixture', lastError: null })
      assert.equal(api.storyRecallStatus().vectorReady, true)
      assert.equal(ensures, 0)
    } finally { api.embedder.status = oldStatus; api.embedder.modelInstalled = oldInstalled }
  })
  await test('A-04/A-09 real archived SQLite and buildPayload honor story switch independently of main memory', async () => {
    const storyId = 'story_payload_abcdef'
    const created = api.chatService.createSession({ storyId, mode: 'story' })
    const msg = (id, role, content) => ({ id, role, content, createdAt: 1700000000000, status: 'done' })
    api.chatService.appendMessages(created.id, [msg('u0', 'user', '钥匙保存在蓝色柜子里 P49_ARCHIVED'),
      msg('a0', 'assistant', '钥匙已经妥善保管'), msg('u1', 'user', '现在寻找钥匙'), msg('a1', 'assistant', '正在寻找钥匙')])
    const live = api.chatService.sessions.find(s => s.id === created.id)
    const archive = api.storyArchiveStore(storyId)
    for (const round of api.splitRounds(live.messages).rounds) archive.upsertStoryRound({
      storyId, branchId: live.id, roundIndex: round.index, tenantUser: 'root', tenantPersona: 'default',
      firstMessageId: round.messages[0].id, lastMessageId: round.messages.at(-1).id,
      contentVersion: api.contentVersion(round.messages), roles: round.messages.map(m => m.role),
      startedAt: round.messages[0].createdAt, chunks: api.sliceRound(round)
    })
    api.branchStore.write(storyId, { version: 2, activeBranchId: live.id, branches: [{ branchId: live.id,
      title: 'fixture', createdAt: 1, forkedFrom: null, memoryBounds: [{ branchId: live.id, maxMessageIndex: null }] }] })
    const payload = () => api.chatService.buildPayload(live, '', '', false, null, 'default', false, [live.messages.at(-1)])
    for (const memoryEnabled of [false, true]) {
      store.save({ memory: { ...store.get().memory, enabled: memoryEnabled, autoExtract: false },
        storyRecall: { enabled: true, n: 4, budgetTokens: 8000, minScore: .4, keywordWeight: .5, recheckDepth: 0 } })
      const on = await payload()
      assert.ok(on.some(m => m.content.startsWith('【故事回顾') && m.content.includes('P49_ARCHIVED')), 'enabled story injects with memory=' + memoryEnabled)
      store.save({ storyRecall: { enabled: false } })
      const off = await payload()
      assert.ok(!off.some(m => m.content.includes('【故事回顾') || m.content.includes('P49_ARCHIVED')), 'disabled story removes actual payload block with memory=' + memoryEnabled)
      assert.equal(fresh().memory.enabled, memoryEnabled)
    }
  })
} finally {
  api.embedder.ensure = originalEnsure
  await act(async () => root.unmount())
  dom.window.close()
  // Same cleanup as message-edit: release React scheduler event-loop references.
  for (const handle of process._getActiveHandles()) if (handle.constructor.name === 'MessagePort') handle.unref()
  api.closeAllStoryMemory()
  api.memoryService.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log('P4.9 recall settings: 共 ' + checks + ' 项，通过 ' + (checks - failures) + ' 项，失败 ' + failures + ' 项，跳过 0 项')
console.log('共 ' + checks + ' 项，通过 ' + (checks - failures) + ' 项')
if (failures) process.exitCode = 1
