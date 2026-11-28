/**
 * Q9: exercise production transport/facade; no real Electron process or model.
 * Existing embedding/archive suites replace facade methods and therefore do not
 * cover the init/reply/restart lifecycle. Keep those suites unchanged.
 * Run: node scripts/test/q9-embed-worker.test.mjs
 * Also: timeout 20s node scripts/test/q9-embed-worker.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const require = createRequire(import.meta.url)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-q9-'))
const originalResolve = require('node:module')._resolveFilename
const originalBackend = process.env.NC_EMBED_BACKEND
const cachedBefore = new Set(Object.keys(require.cache))
const clients = new Set()
let passed = 0, failed = 0
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const vector = (n = 1) => Float32Array.of(n, n + 1)

class Child extends EventEmitter {
  messages = []
  kills = 0
  onPost = null
  postMessage(message) { this.messages.push(message); this.onPost?.(message) }
  kill() { this.kills++; this.emit('exit', 0); return true }
  reply(message, extra = {}) {
    this.emit('message', { id: message.id, ok: true, ready: message.type !== 'init',
      dimensions: 1024, lastError: null, ...extra })
  }
  last(type) { return this.messages.filter(m => m.type === type).at(-1) }
}

// Only the clock is replaced: all lifecycle/reply/fallback logic remains production code.
function clock() {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  let now = 0, next = 0
  const timers = new Map(), delays = []
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++next; delays.push(ms); timers.set(id, { at: now + ms, fn: () => fn(...args) }); return id
  }
  globalThis.clearTimeout = id => timers.delete(id)
  return {
    now: () => now, delays, timers,
    async advance(ms) {
      const end = now + ms
      for (;;) {
        await flush()
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at; timers.delete(due[0]); due[1].fn()
      }
      now = end; await flush()
    },
    restore() { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear }
  }
}

let EmbedClient, facade, electron
function fixture(c, options = {}) {
  const children = [], launches = []
  const client = new EmbedClient({ now: c.now, initTimeoutMs: 50, requestTimeoutMs: 100,
    fork: (...args) => { launches.push(args); const child = new Child(); children.push(child); return child }, ...options })
  clients.add(client)
  return { client, children, launches }
}
async function initialize(f) {
  await flush()
  const child = f.children.at(-1)
  assert.ok(child?.last('init'), 'init must precede application requests')
  child.reply(child.last('init')); await flush(); return child
}
async function test(name, fn) {
  const c = clock()
  try { await fn(c); passed++; console.log('ok  ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack) }
  finally {
    for (const client of clients) client.dispose()
    clients.clear()
    const remainingTimers = c.timers.size
    c.restore()
    assert.equal(remainingTimers, 0, 'every test must clear all timers')
    delete process.env.NC_EMBED_BACKEND
  }
}

try {
  delete process.env.NC_EMBED_BACKEND
  installElectronStub(root)
  electron = require('electron')
  ;({ EmbedClient } = await bundleModule('q9-client', 'export { EmbedClient } from ' + JSON.stringify(p('src/main/features/rag/embedClient.ts'))))

  await test('01 capability detection and explicit inline opt-out never fork', async c => {
    const absent = new EmbedClient(); clients.add(absent)
    assert.equal(absent.available(), false)
    assert.equal((await absent.request('ensure', root)).fallback, true)
    const f = fixture(c)
    process.env.NC_EMBED_BACKEND = 'inline'
    assert.equal(f.client.available(), false)
    assert.equal((await f.client.request('embed', root, ['a'])).fallback, true)
    assert.equal(f.launches.length, 0)
  })

  await test('02 concurrent cold requests share one init and preserve launch contract', async c => {
    const f = fixture(c), a = f.client.request('ensure', root), b = f.client.request('embed', root, ['b'])
    await flush(); assert.equal(f.children.length, 1)
    const child = f.children[0]
    assert.deepEqual(child.messages.map(m => m.type), ['init'])
    assert.equal(child.last('init').modelRoot, root)
    assert.ok(f.launches[0][0].endsWith('embed-worker.js'))
    assert.deepEqual(f.launches[0].slice(1), [[], { serviceName: 'nahida-embedding' }])
    await initialize(f)
    child.reply(child.last('ensure')); child.reply(child.last('embed'), { vectors: [vector()] })
    assert.equal((await a).ok, true); assert.deepEqual((await b).vectors, [vector()])
  })

  await test('03 out-of-order replies are correlated by unique id', async c => {
    const f = fixture(c), a = f.client.request('embed', root, ['a']), b = f.client.request('embed', root, ['b'])
    const child = await initialize(f), messages = child.messages.filter(m => m.type === 'embed')
    assert.notEqual(messages[0].id, messages[1].id)
    child.reply(messages[1], { vectors: [vector(20)] }); child.reply(messages[0], { vectors: [vector(10)] })
    assert.deepEqual((await a).vectors, [vector(10)]); assert.deepEqual((await b).vectors, [vector(20)])
  })

  await test('04 model error updates synchronous status without transport fallback', async c => {
    const f = fixture(c), result = f.client.request('ensure', root), child = await initialize(f)
    child.reply(child.last('ensure'), { ok: false, ready: false, dimensions: 768, lastError: 'model missing', error: 'model missing' })
    assert.equal((await result).fallback, undefined)
    assert.deepEqual(f.client.status(), { ready: false, dimensions: 768, lastError: 'model missing' })
    assert.equal(f.client.available(), true)
  })

  await test('05 malformed, unknown and duplicate replies do not poison status', async c => {
    const f = fixture(c), result = f.client.request('embed', root, ['a']), child = await initialize(f)
    const message = child.last('embed'); let settled = false; result.then(() => { settled = true })
    child.emit('message', null); child.emit('message', { id: message.id, ok: true })
    child.reply({ id: 999999 }, { dimensions: 1 }); await flush()
    assert.equal(settled, false); assert.equal(f.client.status().dimensions, 1024)
    child.reply(message, { dimensions: 2, vectors: [vector()] }); assert.equal((await result).ok, true)
    child.reply(message, { dimensions: 7 }); assert.equal(f.client.status().dimensions, 2)
  })

  await test('06 production defaults are 5s init and 30s request, without real waiting', async c => {
    const f = fixture(c, { initTimeoutMs: undefined, requestTimeoutMs: undefined })
    const result = f.client.request('ensure', root)
    await flush(); assert.ok(c.delays.includes(5000)); await initialize(f)
    assert.ok(c.delays.includes(30000)); let settled = false; result.then(() => { settled = true })
    await c.advance(29999); assert.equal(settled, false)
    await c.advance(1); assert.equal((await result).ok, false)
    assert.equal(f.children[0].kills, 1)
  })

  await test('07 first timeout allows one retry; second failure permanently selects inline', async c => {
    const f = fixture(c), first = f.client.request('embed', root, ['a'])
    await initialize(f); await c.advance(100)
    const firstReply = await first
    assert.equal(firstReply.ok, false); assert.notEqual(firstReply.fallback, true)
    assert.match(f.client.status().lastError, /timed out/i); assert.equal(f.client.available(), true)
    const second = f.client.request('embed', root, ['b']); await initialize(f); await c.advance(100)
    assert.equal((await second).fallback, true); assert.equal(f.client.available(), false)
    assert.match(f.client.status().lastError, /inline/i)
    f.client.reset(root); await c.advance(600001)
    assert.equal((await f.client.request('ensure', root)).fallback, true)
    assert.equal(f.children.length, 2); assert.ok(f.children.every(child => child.kills === 1))
  })

  await test('08 fork exception becomes visible permanent fallback', async c => {
    let calls = 0
    const f = fixture(c, { fork: () => { calls++; throw new Error('fork fixture failure') } })
    const result = await f.client.request('ensure', root)
    assert.equal(result.fallback, true); assert.match(f.client.status().lastError, /fork fixture failure/)
    await f.client.request('ensure', root); assert.equal(calls, 1)
  })

  await test('09 stalled init settles all waiters with fallback and clears timers', async c => {
    const f = fixture(c), a = f.client.request('ensure', root), b = f.client.request('embed', root, ['b'])
    await flush(); await c.advance(50)
    assert.equal((await a).fallback, true); assert.equal((await b).fallback, true)
    assert.equal(f.children.length, 1); assert.equal(f.children[0].kills, 1)
    assert.match(f.client.status().lastError, /init.*timed out/i)
  })

  await test('10 exit settles concurrent requests; retry error consumes final restart', async c => {
    const f = fixture(c), a = f.client.request('ensure', root), b = f.client.request('embed', root, ['b'])
    const child = await initialize(f); child.emit('exit', 17)
    assert.equal((await a).ok, false); assert.equal((await b).ok, false)
    assert.equal(f.client.available(), true)
    const retry = f.client.request('ensure', root), replacement = await initialize(f)
    replacement.emit('error', new Error('worker crash'))
    assert.equal((await retry).fallback, true); assert.equal(f.client.available(), false)
    assert.equal(f.children.length, 2)
  })

  await test('11 reset settles pending generation and ignores its late ready reply', async c => {
    const f = fixture(c), pending = f.client.request('embed', root, ['old']), old = await initialize(f)
    const oldMessage = old.last('embed')
    assert.equal(f.client.reset(root + '-new'), undefined)
    assert.equal((await pending).ok, false); assert.equal(old.kills, 1)
    old.reply(oldMessage, { ready: true, dimensions: 7, vectors: [vector()] })
    assert.equal(f.client.status().ready, false); assert.equal(f.client.status().dimensions, 1024)
    const next = f.client.request('ensure', root + '-new'), child = await initialize(f)
    assert.equal(child.last('init').modelRoot, root + '-new')
    child.reply(child.last('ensure')); assert.equal((await next).ok, true)
  })

  await test('12 reset during init cancels old callers before a new root starts', async c => {
    const f = fixture(c), result = f.client.request('ensure', root)
    await flush(); const old = f.children[0], init = old.last('init')
    f.client.reset(root + '-changed'); old.reply(init, { ready: true })
    assert.equal((await result).ok, false); assert.equal(old.messages.length, 1)
    const next = f.client.request('ensure', root + '-changed'), child = await initialize(f)
    child.reply(child.last('ensure')); assert.equal((await next).ok, true)
  })

  await test('13 dispose is synchronous/idempotent, settles pending work and never restarts', async c => {
    const f = fixture(c), result = f.client.request('ensure', root), child = await initialize(f)
    assert.equal(f.client.dispose(), undefined); f.client.dispose(); f.client.reset(root)
    assert.equal((await result).ok, false); assert.equal(child.kills, 1)
    child.emit('exit', 1); child.reply(child.last('ensure'), { ready: true })
    assert.equal((await f.client.request('ensure', root)).ok, false)
    assert.equal(f.client.available(), false); assert.equal(f.client.status().ready, false)
    await c.advance(600001); assert.equal(f.children.length, 1)
  })

  await test('14 transport accepts 64 texts and rejects 65 before posting/forking', async c => {
    const f = fixture(c)
    assert.equal((await f.client.request('embed', root, Array(65).fill('x'))).ok, false)
    assert.equal(f.children.length, 0)
    const texts = Array.from({ length: 64 }, (_, i) => String(i))
    const result = f.client.request('embed', root, texts), child = await initialize(f)
    assert.deepEqual(child.last('embed').texts, texts)
    child.reply(child.last('embed'), { vectors: texts.map((_, i) => vector(i)) })
    assert.equal((await result).vectors.length, 64)
  })

  // The real facade and real client are bundled together. Only inline inference is stubbed.
  electron.utilityProcess = { fork() { throw new Error('facade fork fixture failure') } }
  facade = await bundleModule('q9-facade', [
    'export { Embedder } from ' + JSON.stringify(p('src/main/features/rag/embedder.ts')),
    'export { embedClient } from ' + JSON.stringify(p('src/main/features/rag/embedClient.ts'))
  ].join('\n'))

  await test('15 real facade fork failure returns actual inline vectors/ensure and visible reason', async () => {
    clients.add(facade.embedClient)
    const f = new facade.Embedder(), expected = [vector(9)]
    let embeds = 0, ensures = 0
    f.inline.embed = async texts => { embeds++; assert.deepEqual(texts, ['fixture']); return expected }
    const extractor = async () => ({ dims: [1, 2], data: vector(9) })
    f.inline.ensure = async () => { ensures++; return extractor }
    assert.deepEqual(await f.embed(['fixture']), expected)
    assert.equal(await f.ensure(), extractor)
    assert.equal(embeds, 1); assert.equal(ensures, 1)
    assert.match(f.status().lastError, /facade fork fixture failure/)
    assert.equal(facade.embedClient.available(), false)
    assert.deepEqual(await f.embed([]), []); assert.equal(embeds, 1)
  })

  const facadeChildren = []
  electron.utilityProcess = { fork() {
    const child = new Child()
    child.onPost = message => { if (message.type === 'init') child.reply(message) }
    facadeChildren.push(child); return child
  } }
  const timeoutFacade = await bundleModule('q9-facade-timeout', [
    'export { Embedder } from ' + JSON.stringify(p('src/main/features/rag/embedder.ts')),
    'export { embedClient } from ' + JSON.stringify(p('src/main/features/rag/embedClient.ts'))
  ].join('\n'))
  await test('16 real facade returns null on first timeout, inline vectors after second timeout', async c => {
    clients.add(timeoutFacade.embedClient)
    const f = new timeoutFacade.Embedder(), expected = [vector(99)]
    let calls = 0
    f.inline.embed = async () => { calls++; return expected }
    const first = f.embed(['first'])
    await flush(); assert.equal(facadeChildren.length, 1)
    await c.advance(30000)
    assert.equal(await first, null); assert.equal(calls, 0)
    assert.equal(timeoutFacade.embedClient.available(), true)
    const second = f.embed(['second'])
    await flush(); assert.equal(facadeChildren.length, 2)
    await c.advance(30000)
    assert.deepEqual(await second, expected); assert.equal(calls, 1)
    assert.equal(timeoutFacade.embedClient.available(), false)
    assert.match(f.status().lastError, /inline/i)
  })

  electron.utilityProcess = { fork() {
    const child = new Child()
    child.onPost = message => child.reply(message, message.type === 'embed'
      ? { dimensions: 2, vectors: message.texts.map((_, index) => vector(index + 3)) }
      : { dimensions: 2 })
    return child
  } }
  const liveFacade = await bundleModule('q9-facade-live', [
    'export { Embedder } from ' + JSON.stringify(p('src/main/features/rag/embedder.ts')),
    'export { embedClient } from ' + JSON.stringify(p('src/main/features/rag/embedClient.ts'))
  ].join('\n'))
  await test('17 facade worker ensure returns callable extractor with dims/data', async () => {
    clients.add(liveFacade.embedClient)
    const f = new liveFacade.Embedder()
    f.inline.ensure = async () => { throw new Error('unexpected inline ensure') }
    f.inline.embed = async () => { throw new Error('unexpected inline embed') }
    const extractor = await f.ensure()
    assert.equal(typeof extractor, 'function')
    const output = await extractor(['one', 'two'])
    assert.deepEqual(output.dims, [2, 2])
    assert.ok(output.data instanceof Float32Array)
    assert.deepEqual(Array.from(output.data), [3, 4, 4, 5])
  })
  await test('18 disposed singleton facade returns null without running inline', async () => {
    const f = new liveFacade.Embedder()
    let inlineCalls = 0
    f.inline.embed = async () => { inlineCalls++; return [vector()] }
    f.inline.ensure = async () => { inlineCalls++; return () => {} }
    liveFacade.embedClient.dispose()
    assert.equal(await f.embed(['after shutdown']), null)
    assert.equal(await f.ensure(), null)
    assert.equal(inlineCalls, 0)
  })

  await test('19 facade status/modelRoot/modelInstalled/reset preserve synchronous signatures', async () => {
    const f = new facade.Embedder()
    assert.equal(typeof f.modelRoot(), 'string'); assert.equal(typeof f.modelInstalled(), 'boolean')
    const status = f.status()
    assert.equal(typeof status.ready, 'boolean'); assert.equal(typeof status.modelPath, 'string')
    assert.equal(typeof status.then, 'undefined'); assert.equal(f.reset(), undefined)
  })

  for (const method of ['embed', 'ensure']) {
    await test('21 pending ' + method + ' fallback does not run inline after dispose', async () => {
      const saved = {
        request: liveFacade.embedClient.request,
        available: liveFacade.embedClient.available,
        isDisposed: liveFacade.embedClient.isDisposed
      }
      let disposed = false, resolveRequest, inlineCalls = 0
      liveFacade.embedClient.available = () => true
      liveFacade.embedClient.isDisposed = () => disposed
      liveFacade.embedClient.request = () => new Promise(resolve => { resolveRequest = resolve })
      try {
        const f = new liveFacade.Embedder()
        f.inline.embed = async () => { inlineCalls++; return [vector()] }
        f.inline.ensure = async () => { inlineCalls++; return () => {} }
        const pending = method === 'embed' ? f.embed(['race']) : f.ensure()
        resolveRequest({ ok: false, fallback: true })
        disposed = true
        assert.equal(await pending, null)
        assert.equal(inlineCalls, 0)
      } finally { Object.assign(liveFacade.embedClient, saved) }
    })
  }

  await test('22 production quit wiring preserves cancelled quit and disposes on final quit', async c => {
    // Execute the actual registration statement, not a duplicated lifecycle implementation.
    const source = fs.readFileSync(p('src/main/index.ts'), 'utf8')
    const wiring = source.split(/\r?\n/).filter(line => line.includes('embedClient.dispose()')).join('\n')
    assert.ok(wiring)
    const app = new EventEmitter(), f = fixture(c)
    vm.runInNewContext(wiring, { app, embedClient: f.client })
    const pending = f.client.request('ensure', root)
    const child = await initialize(f)
    child.reply(child.last('ensure')); assert.equal((await pending).ok, true)
    app.on('before-quit', event => event.preventDefault())
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    app.emit('before-quit', event)
    assert.equal(event.defaultPrevented, true)
    assert.equal(f.client.isDisposed(), false)
    const continued = f.client.request('ensure', root)
    await flush(); child.reply(child.last('ensure'))
    assert.equal((await continued).ok, true)
    app.emit('quit', {}, 0)
    assert.equal(f.client.isDisposed(), true)
    assert.equal(child.kills, 1)
  })

  await test('20 probe has exact 30s UI deadline and clears timer after success', async c => {
    const f = new facade.Embedder()
    f.embedOne = () => new Promise(() => {})
    const pending = f.probe(); let settled = false; pending.then(() => { settled = true })
    assert.ok(c.delays.includes(30000)); await c.advance(29999); assert.equal(settled, false)
    await c.advance(1)
    assert.deepEqual({ ...(await pending), latencyMs: 0 }, { ok: false, dimensions: 0, latencyMs: 0, error: '向量模型响应超时' })
    f.embedOne = async () => vector()
    const success = await f.probe()
    assert.equal(success.ok, true); assert.equal(success.dimensions, 2); assert.equal(success.error, null)
    assert.equal(c.timers.size, 0)
  })
} finally {
  for (const client of clients) client.dispose()
  facade?.embedClient.dispose()
  require('node:module')._resolveFilename = originalResolve
  if (originalBackend === undefined) delete process.env.NC_EMBED_BACKEND
  else process.env.NC_EMBED_BACKEND = originalBackend
  // qq-test-util owns temp bundles/stub; remove only entries created by this run.
  const directories = new Set([root])
  for (const file of Object.keys(require.cache)) {
    if (!cachedBefore.has(file) && /(?:nc-qq-q9-|nc-qq-stub-)/.test(file)) {
      directories.add(path.dirname(file)); delete require.cache[file]
    }
  }
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
}
console.log('\nQ9: ' + passed + '/' + (passed + failed) + ' passed')
if (failed) process.exitCode = 1
