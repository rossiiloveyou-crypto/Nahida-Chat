#!/usr/bin/env node
/** Observe the exact production host without changing its readiness or request policy. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROJECT, artifact, stamp, delay } from './st-env.probe.mjs'

const require = createRequire(import.meta.url)
const self = fileURLToPath(import.meta.url)
const profile = process.env.NC_DIAG_PROFILE
const inspectExpr = `(() => {
  const measure = (fn) => { try { return { value: fn() }; } catch (e) { return { error: String(e.message) }; } };
  const context = () => SillyTavern.getContext();
  const values = {
    document: measure(() => document.readyState),
    chat: measure(() => Array.isArray(context().chat)),
    characters: measure(() => ({ isArray: Array.isArray(context().characters), length: context().characters?.length ?? null })),
    headers: measure(() => {
      const ctx = context();
      const h = typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : null;
      const isPromise = !!(h && typeof h.then === 'function');
      if (isPromise) h.catch(() => {});
      return { isFunction: typeof ctx.getRequestHeaders === 'function', isPromise,
        keys: h && !isPromise ? Object.keys(h) : null,
        hasCsrf: !!(h && !isPromise && (h['X-CSRF-Token'] || h['x-csrf-token'])) };
    }),
    textarea: measure(() => !!document.querySelector('#send_textarea'))
  };
  const checks = [
    { id: 's1', name: 'document.readyState', ...values.document, pass: values.document.value === 'complete' },
    { id: 's2', name: 'Array.isArray(ctx.chat)', ...values.chat, pass: values.chat.value === true },
    { id: 's3', name: 'ctx.characters.length > 0', ...values.characters, pass: values.characters.value?.isArray === true && values.characters.value.length > 0 },
    { id: 's4', name: 'ctx.getRequestHeaders CSRF', ...values.headers, pass: values.headers.value?.hasCsrf === true },
    { id: 's5', name: '#send_textarea', ...values.textarea, pass: values.textarea.value === true }
  ];
  return { checks, all: checks.every(c => c.pass) };
})()`

if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-st-ready-diag-'))
  const env = { ...process.env, NC_DIAG_PROFILE: dir }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [self], { env, stdio: 'inherit', windowsHide: true })
  child.once('error', error => { console.error('LAUNCH_FAILED ' + error.message); process.exitCode = 2 })
  child.once('close', code => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    process.exitCode = code ?? 1
  })
} else {
  // Do not top-level await app.whenReady(): Electron needs module evaluation to finish.
  run().catch(error => { console.error(error.stack); process.exit(2) })
}

async function run() {
  const { app } = require('electron')
  app.setPath('userData', profile)
  app.disableHardwareAcceleration()
  await app.whenReady()
  let host
  const report = { probe: 'st-ready-diag', version: 1, startedAt: new Date().toISOString(),
    url: process.env.NC_DIAG_ST_URL || 'http://127.0.0.1:8000', timeoutMs: 60000,
    load: null, transitions: [], checks: [], readyExpr: null, __ncReadyElapsedMs: 'NEVER',
    headerCrossCheck: null, stats: null, failure: null, exit: 1 }
  try {
    const { loadEsbuild } = await import('../test/qq-test-util.mjs')
    const outfile = path.join(profile, 'bridge.cjs')
    await loadEsbuild().build({
      stdin: { contents: `export { BridgeHost, READY_EXPR } from './src/main/features/bridge/host.ts'`, resolveDir: PROJECT, loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', outfile, external: ['electron'],
      alias: { '@shared': path.join(PROJECT, 'src/shared') }, logLevel: 'silent'
    })
    const { BridgeHost, READY_EXPR } = require(outfile)
    host = new BridgeHost({ stUrl: report.url })
    // TS private is intentionally accessed only by this diagnostic: exact constructor, preload and interception.
    const win = host.createWindow()
    report.initialization = { requests: [], consoleErrors: [], page: null }
    const ses = win.webContents.session
    ses.webRequest.onCompleted({ urls: [report.url + '/api/*'] }, details => {
      if (report.initialization.requests.length < 100) report.initialization.requests.push({ path: new URL(details.url).pathname, method: details.method, status: details.statusCode })
    })
    win.webContents.on('console-message', (_event, level, message, line, source) => {
      if (level < 2 || report.initialization.consoleErrors.length >= 30) return
      const clean = String(message).replace(/(Bearer|token|api_key)[\s"':=]+[^\s,"}]+/gi, '$1 [REDACTED]').slice(0, 400)
      report.initialization.consoleErrors.push({ level, message: clean, line, source: String(source).split('?')[0] })
    })
    let domAt
    win.webContents.once('dom-ready', () => { domAt = Date.now() })
    try {
      await win.loadURL(report.url)
      report.load = { ok: true }
    } catch (error) {
      report.load = { ok: false, error: error.message }
      throw new Error('加载页面失败 / 连接被拒: ' + error.message)
    }
    domAt ??= Date.now()
    const start = Date.now()
    let previous
    while (Date.now() - start < report.timeoutMs) {
      const snapshot = await win.webContents.executeJavaScript(inspectExpr, true)
      const exact = await win.webContents.executeJavaScript(READY_EXPR, true)
      report.checks = snapshot.checks
      report.readyExpr = exact
      const signature = JSON.stringify({ checks: snapshot.checks, exact })
      if (signature !== previous) {
        report.transitions.push({ ms: Date.now() - domAt, checks: snapshot.checks, exact })
        previous = signature
      }
      if (snapshot.all) {
        report.__ncReadyElapsedMs = Date.now() - domAt
        await win.webContents.executeJavaScript('window.__ncReadyElapsedMs = ' + report.__ncReadyElapsedMs, true)
        report.exit = exact === true ? 0 : 1
        break
      }
      await delay(300)
    }
    // Independent same-page source export: report header names only, never header values.
    report.headerCrossCheck = await win.webContents.executeJavaScript(`(async () => {
      const ctx = SillyTavern.getContext();
      const module = await import('/script.js');
      const f = module.getRequestHeaders;
      const h = typeof f === 'function' ? await f() : null;
      return { contextType: typeof ctx.getRequestHeaders, moduleType: typeof f,
        keys: h ? Object.keys(h) : null, hasCsrf: !!(h && (h['X-CSRF-Token'] || h['x-csrf-token'])) };
    })()`, true).catch(error => ({ error: error.message }))
    report.initialization.page = await win.webContents.executeJavaScript(`(async () => {
      const ctx = SillyTavern.getContext();
      const response = await fetch('/api/characters/all', { method: 'POST', headers: ctx.getRequestHeaders(), body: '{}' });
      const cards = response.ok ? await response.json() : null;
      return { characterApiStatus: response.status, characterApiCount: Array.isArray(cards) ? cards.length : null,
        contextCharacters: ctx.characters.length, dialogs: Array.from(document.querySelectorAll('dialog[open]')).map(d => ({ id: d.id, text: d.textContent.trim().slice(0, 250) })),
        onboardingPresent: !!document.querySelector('dialog[open] .onboarding') };
    })()`, true).catch(error => ({ error: error.message }))
    report.stats = host.statsSnapshot()
    if (report.exit !== 0) report.failure = 'READY conditions not all satisfied within 60000ms'
    win.destroy()
  } catch (error) {
    report.failure = error.message
  } finally {
    host?.destroy()
    for (const win of require('electron').BrowserWindow.getAllWindows()) win.destroy()
    report.finishedAt = new Date().toISOString()
    for (const check of report.checks) console.log((check.pass ? 'PASS ' : 'FAIL ') + check.id + ' ' + check.name + ' ' + JSON.stringify(check.value ?? { error: check.error }))
    console.log('__ncReadyElapsedMs=' + report.__ncReadyElapsedMs)
    if (report.failure) console.error('FAIL ' + report.failure)
    const text = report.checks.map(c => (c.pass ? 'PASS ' : 'FAIL ') + c.id + ' ' + c.name + ' ' + JSON.stringify(c.value ?? { error: c.error })).join('\n')
    const file = artifact('st-ready-diag.' + stamp() + '.txt', text + '\n' + JSON.stringify(report, null, 2) + '\n')
    console.log('DIAG_ARTIFACT ' + file)
    app.exit(report.exit)
  }
}
