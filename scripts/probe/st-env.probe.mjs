#!/usr/bin/env node
/** Phase 1: disposable ST lifecycle only; never changes production bridge code. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

export const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const BASELINE = path.resolve(PROJECT, '../DOC/agent--ST桥接重构/task-桥接重构/baseline')
export const stripAnsi = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
export const stamp = () => new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + process.pid
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export function artifact(name, value) {
  fs.mkdirSync(BASELINE, { recursive: true })
  const file = path.join(BASELINE, name)
  fs.writeFileSync(file, value, { flag: 'wx' })
  return file
}
export function topValue(text, key) {
  const value = text.match(new RegExp('^' + key + ':[ \t]*([^\\r\\n]*)', 'm'))?.[1]?.replace(/\s+#.*$/, '').trim()
  return value?.replace(/^(['"])(.*)\1$/, '$2')
}
export function ownedData(input = process.env.NC_ST_DATA) {
  if (!input) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-st-probe-'))
    fs.writeFileSync(path.join(parent, '.nc-st-probe-owner.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString() }))
    input = path.join(parent, 'data')
  }
  const data = path.resolve(input)
  const parent = path.dirname(data)
  if (path.basename(data) !== 'data' || !path.basename(parent).startsWith('nc-st-probe-') ||
      !fs.existsSync(path.join(parent, '.nc-st-probe-owner.json')) || fs.lstatSync(parent).isSymbolicLink() ||
      (fs.existsSync(data) && fs.lstatSync(data).isSymbolicLink())) {
    throw new Error('NC_ST_DATA must be the data child of a probe-owned nc-st-probe-* directory')
  }
  if (JSON.parse(fs.readFileSync(path.join(parent, '.nc-st-probe-owner.json'), 'utf8')).version !== 1) throw new Error('Invalid probe ownership marker')
  return data
}
export async function portCheck(port) {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error) => resolve({ ok: false, code: error.code }))
    server.listen({ port, host: '127.0.0.1' }, () => server.close(() => resolve({ ok: true })))
  })
}
export async function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((resolve) => child.once('close', resolve))
  if (process.platform === 'win32') {
    const killed = await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' })
      killer.once('error', reject)
      killer.once('close', resolve)
    })
    if (killed !== 0 && child.exitCode === null) throw new Error('taskkill failed: ' + killed)
  } else child.kill('SIGTERM')
  let timer
  try {
    await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ST process did not close')), 10000) })])
  } finally { clearTimeout(timer) }
}
export async function startSt({ onChunk = () => {}, keep = !!process.env.NC_ST_KEEP } = {}) {
  const root = path.resolve(process.env.NC_ST_ROOT || path.resolve(PROJECT, '../SillyTavern'))
  const port = Number(process.env.NC_ST_PORT || 8000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid NC_ST_PORT')
  const checks = []
  const check = (name, ok, actual) => {
    checks.push({ name, ok, actual })
    console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(actual))
  }
  check('server.js', fs.existsSync(path.join(root, 'server.js')), path.join(root, 'server.js'))
  let entries = 0
  try { entries = fs.readdirSync(path.join(root, 'node_modules')).length } catch {}
  check('node_modules', entries > 100, entries)
  let config = ''
  try { config = fs.readFileSync(path.join(root, 'config.yaml'), 'utf8') } catch {}
  const actualConfig = Object.fromEntries(['port', 'listen', 'dataRoot', 'global'].map((key) => [key, topValue(config, key) ?? null]))
  check('config.yaml', !!config, actualConfig)
  const globalValue = actualConfig.global
  check('global !== true', globalValue === null || /^(false|no|off|0)$/i.test(globalValue), globalValue ?? 'absent=false')
  const available = await portCheck(port)
  check('port', available.ok, { port, ...available })
  if (!available.ok) console.error('Address 127.0.0.1:' + port + ' is already in use. Another SillyTavern instance may already be running. Stop the other process or change "port" in config.yaml. [preflight; not child stderr]')
  const occupiedControl = process.env.NC_ST_PROBE_OCCUPIED === '1'
  if (checks.some((item) => !item.ok && !(item.name === 'port' && occupiedControl))) throw new Error('ST preflight failed')
  const data = ownedData()
  const parent = path.dirname(data)
  const configPath = path.join(parent, 'config.yaml')
  fs.writeFileSync(configPath, config)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [path.join(root, 'server.js'), '--port', String(port), '--dataRoot', data,
    '--configPath', configPath, '--global', 'false', '--listen', 'false', '--browserLaunchEnabled', 'false']
  const started = Date.now()
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const chunks = []
  const text = { out: '', err: '' }
  const timings = { listeningMs: null, goToMs: null, httpMs: null }
  let exit = null
  let spawnError = null
  let cleaned = false
  child.once('error', (error) => { spawnError = error })
  child.once('close', (code, signal) => { exit = { code, signal } })
  for (const [stream, pipe] of [['out', child.stdout], ['err', child.stderr]]) {
    pipe.on('data', (bytes) => {
      const item = { stream, ms: Date.now() - started, bytes: Buffer.from(bytes) }
      chunks.push(item)
      // Decode the accumulated bytes, not individual split UTF-8 chunks.
      text[stream] = Buffer.concat(chunks.filter((c) => c.stream === stream).map((c) => c.bytes)).toString('utf8')
      const plain = stripAnsi(text.out)
      if (timings.listeningMs === null && plain.includes('SillyTavern is listening')) timings.listeningMs = item.ms
      if (timings.goToMs === null && /Go to:/i.test(plain)) timings.goToMs = item.ms
      onChunk(item)
    })
  }
  const cleanup = async () => {
    if (cleaned) return
    await stopTree(child)
    if (!keep) fs.rmSync(parent, { recursive: true, force: true })
    cleaned = true
    console.log('CLEANUP ' + JSON.stringify({ pid: child.pid, stopped: true, dataKept: keep, data }))
  }
  const signals = ['SIGINT', 'SIGTERM']
  const onSignal = () => { cleanup().then(() => process.exit(130), (error) => { console.error(error); process.exit(1) }) }
  signals.forEach((signal) => process.once(signal, onSignal))
  const close = async () => {
    try { await cleanup() } finally { signals.forEach((signal) => process.removeListener(signal, onSignal)) }
  }
  const hold = (ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); child.removeListener('close', done); resolve() }
    const timer = setTimeout(done, ms)
    child.once('close', done)
    if (child.exitCode !== null || child.signalCode !== null) done()
  })
  const state = { root, port, data, pid: child.pid, child, args, started, chunks, text, timings, checks, close, hold }
  console.log('SPAWN ' + JSON.stringify({ pid: child.pid, data, root, port, args }))
  try {
    const deadline = started + Number(process.env.NC_ST_TIMEOUT_MS || 120000)
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (exit) throw new Error('ST exited before ready: ' + JSON.stringify(exit) + '\n' + text.err.slice(-3000))
      if (timings.listeningMs !== null && timings.goToMs !== null) {
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(2000) })
          await response.arrayBuffer()
          if (response.status === 200) {
            timings.httpMs = Date.now() - started
            console.log('READY http=200 ' + JSON.stringify({ port, data, ...timings }))
            return state
          }
        } catch {}
      }
      await delay(100)
    }
    throw new Error('ST readiness timeout; stdout tail=' + stripAnsi(text.out).slice(-1500))
  } catch (error) {
    try { await close() } catch (cleanupError) { console.error('CLEANUP_FAIL', cleanupError.message) }
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--cleanup-data')) {
  try {
    if (!process.env.NC_ST_DATA) throw new Error('NC_ST_DATA required for explicit cleanup')
    const data = ownedData(process.env.NC_ST_DATA)
    const port = Number(process.env.NC_ST_PORT)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !(await portCheck(port)).ok) throw new Error('Cleanup requires a verified free NC_ST_PORT')
    fs.rmSync(path.dirname(data), { recursive: true, force: true })
    console.log('CLEANUP_DATA ' + JSON.stringify({ data, removed: !fs.existsSync(path.dirname(data)) }))
  } catch (error) { console.error('FAIL ' + error.message); process.exitCode = 1 }
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let state
  try {
    state = await startSt()
    if (process.argv.includes('--serve')) await state.hold(Number(process.env.NC_ST_HOLD_MS || 600000))
  } catch (error) { console.error('FAIL ' + error.message); process.exitCode = 1 }
  finally { if (state) await state.close() }
}
