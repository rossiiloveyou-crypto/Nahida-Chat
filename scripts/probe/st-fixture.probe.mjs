#!/usr/bin/env node
/** Native ST initialization -> stop -> minimal patch -> native ST restart. */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { startSt, ownedData, artifact, stamp, delay, PROJECT } from './st-env.probe.mjs'
import { startStub, selfTestStub } from './st-stub-llm.mjs'
const require = createRequire(import.meta.url)
const hash = value => createHash('sha256').update(value).digest('hex')
function inventory(root, relative = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Symlink in fixture: ' + rel)
    if (entry.isDirectory()) out.push(...inventory(root, rel))
    else if (entry.isFile()) { const bytes = fs.readFileSync(path.join(root, rel)); out.push({ path: rel.replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) }) }
  }
  return out
}
function diffKeys(a, b, prefix = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => diffKeys(a[key], b[key], prefix ? prefix + '.' + key : key))
  return [prefix]
}
export async function createFixture() {
  const id = stamp()
  const data = ownedData()
  const parent = path.dirname(data)
  const user = path.join(data, 'default-user')
  const settingsFile = path.join(user, 'settings.json')
  if (fs.existsSync(settingsFile)) throw new Error('Fixture creation requires a fresh probe-owned data root')
  const priorData = process.env.NC_ST_DATA
  process.env.NC_ST_DATA = data
  let state, stub
  const raw = { out: [], err: [] }
  const report = { probe: 'st-fixture', version: 1, id, data, user, startedAt: new Date().toISOString(),
    phases: [], changedKeys: [], checks: [], inventory: [], failure: null }
  const onChunk = item => raw[item.stream].push(Buffer.from(item.bytes))
  let logArtifact, fixtureArtifact, stubArtifact
  try {
    state = await startSt({ keep: true, onChunk })
    report.phases.push({ phase: 'native-init', pid: state.pid, args: state.args, timings: state.timings })
    await state.close(); state = null
    if (!fs.existsSync(settingsFile)) throw new Error('Native settings.json missing')
    const before = fs.readFileSync(settingsFile)
    const original = JSON.parse(before)
    const settings = JSON.parse(before)
    report.nativeInventory = inventory(data)
    const cards = report.nativeInventory.filter(row => /^default-user\/characters\/.*\.png$/i.test(row.path))
    if (!cards.length) throw new Error('S2: Native initialization produced no character cards')
    report.nativeCards = cards
    const port = Number(process.env.NC_STUB_PORT || 8129)
    const patch = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:' + port + '/v1', custom_model: 'nc-stub', preset_settings_openai: 'nc-probe' }
    // Two additional environment prerequisites demonstrated by native source + A-02 evidence.
    settings.firstRun = false
    settings.main_api = 'openai'
    Object.assign(settings.oai_settings, patch)
    const changedKeys = diffKeys(original, settings)
    const allowed = ['firstRun', 'main_api', ...Object.keys(patch).map(k => 'oai_settings.' + k)]
    if (changedKeys.some(k => !allowed.includes(k))) throw new Error('Unexpected settings diff')
    fs.writeFileSync(path.join(parent, 'settings.native-original.json'), before, { flag: 'wx' })
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4) + '\n')
    report.changedKeys = changedKeys
    report.patch = { firstRun: false, main_api: 'openai', oai_settings: patch }
    report.streaming = { before: original.oai_settings.stream_openai, after: settings.oai_settings.stream_openai, unchanged: original.oai_settings.stream_openai === settings.oai_settings.stream_openai }
    const preset = { regex_scripts: [{ id: 'nc-probe-1', scriptName: 'nc-probe-noop', findRegex: '/^$/', replaceString: '', placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false }] }
    const presetFile = path.join(user, 'OpenAI Settings/nc-probe.json')
    fs.writeFileSync(presetFile, JSON.stringify(preset, null, 2) + '\n', { flag: 'wx' })
    const { loadEsbuild } = await import('../test/qq-test-util.mjs')
    const bundle = path.join(parent, 'preset.cjs')
    await loadEsbuild().build({ stdin: { contents: `export { readCurrentPresetName, readPresetRegexScripts } from './src/main/features/bridge/presetRegex.ts'`, resolveDir: PROJECT, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, alias: { '@shared': path.join(PROJECT, 'src/shared') }, logLevel: 'silent' })
    const reader = require(bundle)
    report.presetName = reader.readCurrentPresetName(user)
    report.presetScripts = reader.readPresetRegexScripts(user).length
    report.settingsPatched = report.presetName === 'nc-probe' && report.presetScripts === 1
    report.inventory = inventory(data)
    const violations = []
    let credentialFieldsChecked = 0
    const inspectCredentials = (value, prefix) => {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        const p = prefix + '.' + key
        if (/(api.?key|password|secret|token)$/i.test(key)) {
          credentialFieldsChecked++
          if (typeof child === 'string' && child.length > 0 && !/^(none|disabled)$/i.test(child)) violations.push({ path: p, kind: 'nonempty-credential' })
        }
        inspectCredentials(child, p)
      }
    }
    inspectCredentials(settings, 'settings')
    for (const row of report.inventory) {
      const file = path.join(data, row.path)
      if (/secrets\.json$/i.test(row.path)) { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (Object.values(value).some(v => Array.isArray(v) ? v.length > 0 : v && Object.keys(v).length > 0)) violations.push({ path: row.path, kind: 'nonempty-secrets' }) }
      if (/\.(json|jsonl|txt|yaml|yml)$/i.test(row.path) && /D:[\\/]ST[\\/]/i.test(fs.readFileSync(file, 'utf8'))) violations.push({ path: row.path, kind: 'user-source-path' })
    }
    report.provenance = { sources: ['ST native initialization', 'synthetic nc-probe preset', 'allowlisted six-key settings patch'], copiedUserFiles: 0, credentialFieldsChecked, violations, originalSettingsSha256: hash(before), patchedSettingsSha256: hash(fs.readFileSync(settingsFile)) }
    if (violations.length || !report.settingsPatched || !report.streaming.unchanged) throw new Error('Fixture verification failed')
    console.log('PASS FIXTURE ' + JSON.stringify({ presetName: report.presetName, presetScripts: report.presetScripts, settingsPatched: report.settingsPatched, changedKeys }))
    stub = await startStub(port)
    await selfTestStub(stub)
    state = await startSt({ keep: true, onChunk })
    report.phases.push({ phase: 'patched-restart', pid: state.pid, args: state.args, timings: state.timings })
    // A-04: ST native HTTP generation, before exercising production bridge code.
    const base = 'http://127.0.0.1:' + state.port
    const cookies = new Map()
    const csrfResponse = await fetch(base + '/csrf-token')
    for (const cookie of csrfResponse.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const p = pair.indexOf('='); cookies.set(pair.slice(0, p), pair.slice(p + 1)) }
    const { token } = await csrfResponse.json()
    const generated = await fetch(base + '/api/backends/chat-completions/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; ') }, body: JSON.stringify({ chat_completion_source: 'custom', custom_url: patch.custom_url, model: 'nc-stub', messages: [{ role: 'user', content: 'fixture check' }], stream: false, max_tokens: 32 }), signal: AbortSignal.timeout(15000) })
    const result = await generated.json()
    const reply = result?.choices?.[0]?.message?.content
    report.nativeGeneration = { status: generated.status, reply, pass: generated.status === 200 && /^NC-STUB-REPLY-/.test(reply) }
    if (!report.nativeGeneration.pass) throw new Error('S4: Native ST generation failed')
    console.log('PASS ST_NATIVE_GENERATION ' + JSON.stringify(report.nativeGeneration))
    const stopFile = path.join(parent, 'stop-fixture')
    fixtureArtifact = artifact('st-fixture.' + id + '.json', JSON.stringify({ ...report, stopFile }, null, 2) + '\n')
    console.log('FIXTURE_READY ' + JSON.stringify({ data, user, pid: state.pid, port: state.port, stubPort: port, fixtureArtifact, stopFile }))
    return { data, user, state, report, fixtureArtifact, stopFile, async close() {
      await state.close()
      stubArtifact = await stub.close()
      logArtifact = artifact('st-log.' + id + '.fixture.json', JSON.stringify({ phases: report.phases, rawOut: 'st-log.' + id + '.out.raw.txt', rawErr: 'st-log.' + id + '.err.raw.txt' }, null, 2) + '\n')
      artifact('st-log.' + id + '.out.raw.txt', Buffer.concat(raw.out))
      artifact('st-log.' + id + '.err.raw.txt', Buffer.concat(raw.err))
      artifact('st-fixture.' + id + '.closed.json', JSON.stringify({ fixtureArtifact, logArtifact, stubArtifact, stopped: true, dataKept: true, finishedAt: new Date().toISOString() }, null, 2) + '\n')
    } }
  } catch (error) {
    report.failure = error.message
    await state?.close()
    await stub?.close()
    artifact('st-fixture.' + id + '.failed.json', JSON.stringify(report, null, 2) + '\n')
    throw error
  } finally { if (priorData === undefined) delete process.env.NC_ST_DATA; else process.env.NC_ST_DATA = priorData }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fixture
  try {
    fixture = await createFixture()
    if (process.argv.includes('--serve')) {
      let stop = false
      process.once('SIGINT', () => { stop = true }); process.once('SIGTERM', () => { stop = true })
      const deadline = Date.now() + Number(process.env.NC_ST_HOLD_MS || 600000)
      while (!stop && !fs.existsSync(fixture.stopFile) && Date.now() < deadline) await delay(250)
    }
  } catch (error) { console.error('FAIL ' + error.message); process.exitCode = 1 }
  finally { await fixture?.close() }
}
