#!/usr/bin/env node
/**
 * p6-wire.probe.mjs —— P6 真机探针：**从 chatService 的生成位**跑一轮，真的走 ST。
 *
 * 用法（一条命令，零新增依赖；ST 必须在 127.0.0.1:8000）：
 *   node scripts/probe/p6-wire.probe.mjs
 *
 * 环境变量（全部可选）：
 *   NC_PROBE_ST_URL          默认 http://127.0.0.1:8000（必须 127.0.0.1）
 *   NC_PROBE_ST_DATA         默认 D:/ST/SillyTavern/data/default-user
 *   NC_PROBE_GEN_TIMEOUT_MS  默认 180000
 *
 * 它证明的是 PHASE-6 §3 的 A9，而且证的是**接线之后**的链路：
 *  - chatService 的三条件与真的把这一轮交给了桥接（而不是 provider.stream）；
 *  - 一轮结束 status=done 且 content.length > 0（原稿真的回来了）；
 *  - ST 侧零残留：chat / metadata / prompts 三项全 0，characters 不变；
 *  - 磁盘无残留：chats / backups / characters 文件数差全 0，settings.json mtime 不变；
 *  - J-07 的拦截确实触发过（写盘面 / 外网面各 >= 1），否则「零残留」可能只是「压根没请求」；
 *  - message.warnings 是数组（F-06 的落点），且没有混进正文。
 *
 * 🔴 不重新发明驱动：这里 require 的是 src/ 下**同一份**代码，探针自己只负责断言与记账。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const SELF = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const PROJECT_ROOT = path.resolve(path.dirname(SELF), '..', '..')

const ST_URL = process.env.NC_PROBE_ST_URL || 'http://127.0.0.1:8000'
const ST_DATA = process.env.NC_PROBE_ST_DATA || 'D:/ST/SillyTavern/data/default-user'
const GEN_TIMEOUT_MS = Number(process.env.NC_PROBE_GEN_TIMEOUT_MS || 180000)

function log(line) {
  try {
    process.stderr.write('[p6-wire] ' + line + '\n')
  } catch {
    /* ignore */
  }
}

function countFiles(dir) {
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) n += 1
    }
  }
  return n
}

function countDisk() {
  const out = { chats: 0, backups: 0, characters: 0 }
  for (const dir of Object.keys(out)) {
    try {
      out[dir] = countFiles(path.join(ST_DATA, dir))
    } catch {
      out[dir] = -1
    }
  }
  return out
}

function settingsMtime() {
  try {
    return fs.statSync(path.join(ST_DATA, 'settings.json')).mtimeMs
  } catch {
    return 0
  }
}

if (!process.versions.electron) {
  let electronBin
  try {
    electronBin = require('electron')
  } catch (error) {
    console.error('[p6-wire] 找不到 electron 依赖：' + String(error && error.message))
    process.exit(2)
  }
  if (typeof electronBin !== 'string') {
    console.error('[p6-wire] require("electron") 未返回可执行文件路径')
    process.exit(2)
  }
  // 本机全局存在 ELECTRON_RUN_AS_NODE=1：不剔除的话 electron.exe 退化成纯 node，拿不到 BrowserWindow
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronBin, [SELF], { stdio: 'inherit', env })
  child.on('exit', (code) => process.exit(code === null ? 1 : code))
  child.on('error', (error) => {
    console.error('[p6-wire] 拉起 electron 失败：' + String(error && error.message))
    process.exit(2)
  })
} else {
  // 绝不顶层 await：ESM 顶层 await 会拖住模块求值，app.whenReady() 永不 resolve（P0 实测）
  runInElectron().catch((error) => {
    log('fatal: ' + String(error && error.stack ? error.stack : error))
    process.exit(1)
  })
}

/** 用项目里的 esbuild 把**同一份**源码打成一个 CJS，供 Electron 主进程 require */
async function buildBundle() {
  const util = await import('../test/qq-test-util.mjs')
  const esbuild = util.loadEsbuild()
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p6-bundle-'))
  const entry = path.join(sandbox, 'entry.ts')
  const outfile = path.join(sandbox, 'bundle.cjs')
  const at = (rel) => path.join(PROJECT_ROOT, rel).replace(/\\/g, '/')
  fs.writeFileSync(
    entry,
    [
      "export { bridgeHost } from '" + at('src/main/features/bridge/host.ts') + "'",
      "export { bridgeDriver } from '" + at('src/main/features/bridge/driver.ts') + "'",
      "export { EXPOSURE_EXPR } from '" + at('src/main/features/bridge/session.ts') + "'",
      "export { chatService } from '" + at('src/main/features/chat/chatService.ts') + "'",
      "export { settingsStore } from '" + at('src/main/features/settings/settingsStore.ts') + "'",
      "export { HeadlessSink } from '" + at('src/main/features/chat/sink.ts') + "'",
      "export { bridgeEligible } from '" + at('src/main/features/bridge/router.ts') + "'"
    ].join('\n'),
    'utf8'
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron'],
    alias: { '@shared': path.join(PROJECT_ROOT, 'src/shared') },
    logLevel: 'silent'
  })
  return require(outfile)
}

async function runInElectron() {
  const { app } = require('electron')

  const userData = path.join(os.tmpdir(), 'nc-p6-wire-' + process.pid)
  fs.mkdirSync(userData, { recursive: true })
  // 桥接开关与 ST 地址：写在 settingsStore 第一次 get() 之前（它的缓存是懒加载的）
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ memory: { enabled: true, autoExtract: false }, bridge: { enabled: true } }),
    'utf8'
  )
  app.setPath('userData', userData)
  app.disableHardwareAcceleration()
  await app.whenReady()
  log('ready')

  const bundle = await buildBundle()
  const { bridgeHost, chatService, settingsStore, HeadlessSink, bridgeEligible, EXPOSURE_EXPR } = bundle
  // 单轮上限由探针控制（默认 180s 与部署值一致）
  bridgeHost.config.generateTimeoutMs = GEN_TIMEOUT_MS
  log('bundle ok')

  const before = countDisk()
  const mtimeBefore = settingsMtime()

  const settings = settingsStore.get()
  const session = chatService.createSession({ mode: 'story', title: 'P6 探针会话' })
  const eligible = bridgeEligible({ id: session.id, mode: 'story' }, settings)
  log('eligible=' + String(eligible))

  const sink = new HeadlessSink()
  const startedAt = Date.now()
  const outcome = await chatService.sendAwait(
    { sessionId: session.id, content: '只回一句话：你在吗？' },
    sink
  )
  const wallMs = Date.now() - startedAt

  let exposure = null
  try {
    exposure = await bridgeHost.eval(EXPOSURE_EXPR, 'probe:exposure')
  } catch (error) {
    exposure = { error: String(error && error.message ? error.message : error) }
  }
  const health = bridgeHost.health()
  const stats = bridgeHost.statsSnapshot()
  const trace = bridgeDriverTrace(bundle)

  const after = countDisk()
  const mtimeAfter = settingsMtime()
  const listed = chatService.listSessions().find((item) => item.id === session.id)
  const message = listed && listed.messages.length ? listed.messages[listed.messages.length - 1] : null

  bridgeHost.destroy()

  const diskDelta = {
    chats: after.chats - before.chats,
    backups: after.backups - before.backups,
    characters: after.characters - before.characters
  }
  const assertions = []
  const record = (id, ok, extra) => assertions.push(Object.assign({ id, ok: ok === true }, extra || {}))

  record('A9-1', eligible === true, { eligible })
  record('A9-2', outcome.status === 'done', { status: outcome.status, error: outcome.error || null })
  record('A9-3', outcome.content.length > 0, { length: outcome.content.length, head: outcome.content.slice(0, 120) })
  record(
    'A9-4',
    !!exposure && exposure.chat === 0 && exposure.metadata === 0 && exposure.prompts === 0,
    { exposure }
  )
  record('A9-5', diskDelta.chats === 0 && diskDelta.backups === 0 && diskDelta.characters === 0, diskDelta)
  record('A9-6', mtimeBefore === mtimeAfter, { before: mtimeBefore, after: mtimeAfter })
  record('A9-7', stats.cancelledWrites >= 1 && stats.blockedExternal >= 1, {
    cancelledWrites: stats.cancelledWrites,
    blockedExternal: stats.blockedExternal
  })
  record('A9-8', !!message && Array.isArray(message.warnings), {
    warnings: message ? message.warnings : null,
    contentHasWarning:
      !!message && Array.isArray(message.warnings) && message.warnings.some((w) => message.content.includes(w))
  })
  record('A9-9', !!health && typeof health.alive === 'boolean', { alive: health.alive, rebuilds: health.rebuilds })

  const report = {
    probe: 'p6-wire',
    version: 1,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    wallMs,
    env: {
      electron: process.versions.electron,
      node: process.versions.node,
      stUrl: ST_URL,
      stData: ST_DATA,
      genTimeoutMs: GEN_TIMEOUT_MS
    },
    sessionId: session.id,
    eligible,
    outcome: {
      status: outcome.status,
      contentLength: outcome.content.length,
      contentHead: outcome.content.slice(0, 200),
      error: outcome.error || null,
      durationMs: outcome.durationMs
    },
    message: message
      ? { status: message.status, warnings: message.warnings || [], contentLength: message.content.length }
      : null,
    exposure,
    health,
    stats: { cancelledWrites: stats.cancelledWrites, blockedExternal: stats.blockedExternal, cancelledUrls: stats.cancelledUrls },
    trace,
    disk: { before, after, diskDelta, mtimeBefore, mtimeAfter },
    assertions: {
      total: assertions.length,
      passed: assertions.filter((item) => item.ok).length,
      failed: assertions.filter((item) => !item.ok).length,
      failedIds: assertions.filter((item) => !item.ok).map((item) => item.id),
      items: assertions
    }
  }

  writeBaseline(report)
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  const verdict = report.assertions.failed === 0 ? 'PASS' : 'FAIL'
  log('SUMMARY: ' + verdict + ' ' + String(report.assertions.passed) + '/' + String(report.assertions.total))
  process.exit(report.assertions.failed === 0 ? 0 : 1)
}

/** driver 的上一轮轨迹（排障用；探针只读它，不改） */
function bridgeDriverTrace(bundle) {
  try {
    const driver = bundle.bridgeDriver
    const trace = driver.lastTurnTrace ? driver.lastTurnTrace() : null
    if (!trace) return null
    return {
      steps: trace.steps,
      injected: trace.injected,
      dropped: trace.dropped,
      tokens: trace.tokens,
      genMs: trace.genMs,
      totalMs: trace.totalMs,
      promptsWritten: trace.promptsWritten,
      switchesMuted: trace.switchesMuted,
      switchesRestored: trace.switchesRestored,
      warnings: trace.warnings
    }
  } catch {
    return null
  }
}

/** 行为快照落盘（经验库 V13）：与 P4 的 before/after 同一目录、同一命名口径 */
function writeBaseline(report) {
  const dir = path.join(PROJECT_ROOT, '..', 'DOC', 'agent--pojia架构', 'task-pojia 架构', 'baseline')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const d = new Date()
    const pad = (v) => String(v).padStart(2, '0')
    const stamp = pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    const file = path.join(dir, 'p6-wire.' + stamp + '.after.txt')
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
    log('baseline: ' + file)
  } catch (error) {
    log('baseline 写入失败（不影响判定）：' + String(error && error.message))
  }
}
