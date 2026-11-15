#!/usr/bin/env node
/**
 * bridge-rounds.probe.mjs —— P4 真机探针：用**真的桥接代码**连跑 3 轮。
 *
 * 用法（一条命令，零新增依赖；ST 必须在 127.0.0.1:8000）：
 *   node scripts/probe/bridge-rounds.probe.mjs
 *
 * 环境变量（全部可选）：
 *   NC_PROBE_ST_URL             默认 http://127.0.0.1:8000（必须 127.0.0.1）
 *   NC_PROBE_ST_DATA            默认 D:/ST/SillyTavern/data/default-user
 *   NC_PROBE_GEN_TIMEOUT_MS     默认 180000
 *   NC_PROBE_ROUNDS             默认 3
 *   NC_PROBE_BASELINE_DIR       默认 <workspace>/DOC/.../baseline
 *
 * 它证明的是 PHASE-4 §3 的 A2–A5，以及 J-07 的拦截在**真**页面上仍然生效：
 *  - A2 每轮结束 chat / metadata / prompts = 0、charactersDelta = 0
 *  - A3 chats / backups / characters 文件数差 = 0，settings.json mtime 不变
 *  - A4 三轮 resolve 均非空（并记录耗时）
 *  - A5 第 2 轮与第 1 轮间隔 < 30s 仍正常
 *
 * 🔴 不重新发明驱动逻辑：这里 require 的是 `src/main/features/bridge/` 打出来的**同一份代码**，
 *    没有「探针自己再写一遍」的分叉（PHASE-0 完成报告 §六 的复用纪律）。
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

function log(line) {
  try {
    process.stderr.write('[bridge-probe] ' + line + '\n')
  } catch {
    /* ignore */
  }
}

if (!process.versions.electron) {
  let electronBin
  try {
    electronBin = require('electron')
  } catch (error) {
    console.error('[bridge-probe] 找不到 electron 依赖：' + String(error && error.message))
    process.exit(2)
  }
  if (typeof electronBin !== 'string') {
    console.error('[bridge-probe] require("electron") 未返回可执行文件路径')
    process.exit(2)
  }
  // 本机全局存在 ELECTRON_RUN_AS_NODE=1：不剔除的话 electron.exe 退化成纯 node，拿不到 BrowserWindow
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronBin, [SELF], { stdio: 'inherit', env })
  child.on('exit', (code) => process.exit(code === null ? 1 : code))
  child.on('error', (error) => {
    console.error('[bridge-probe] 拉起 electron 失败：' + String(error && error.message))
    process.exit(2)
  })
} else {
  // 绝不顶层 await：ESM 顶层 await 会拖住模块求值，app.whenReady() 永不 resolve（P0 实测）
  runInElectron().catch((error) => {
    log('fatal: ' + String(error && error.stack ? error.stack : error))
    process.exit(1)
  })
}

const ST_URL = process.env.NC_PROBE_ST_URL || 'http://127.0.0.1:8000'
const ST_DATA = process.env.NC_PROBE_ST_DATA || 'D:/ST/SillyTavern/data/default-user'
const GEN_TIMEOUT_MS = Number(process.env.NC_PROBE_GEN_TIMEOUT_MS || 180000)
const ROUNDS = Number(process.env.NC_PROBE_ROUNDS || 3)

/** 用项目里的 esbuild 把桥接模块打成一个 CJS，供 Electron 主进程 require */
async function buildBridgeBundle() {
  const util = await import('../test/qq-test-util.mjs')
  const esbuild = util.loadEsbuild()
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bridge-bundle-'))
  const entry = path.join(sandbox, 'entry.ts')
  const outfile = path.join(sandbox, 'bundle.cjs')
  const at = (rel) => path.join(PROJECT_ROOT, rel).replace(/\\/g, '/')
  fs.writeFileSync(
    entry,
    [
      "export { bridgeHost, classifyRequest, CANCEL_PATTERNS } from '" + at('src/main/features/bridge/host.ts') + "'",
      "export { bridgeDriver, BridgeDriver } from '" + at('src/main/features/bridge/driver.ts') + "'",
      "export { EXPOSURE_EXPR, CLEAR_EXPR } from '" + at('src/main/features/bridge/session.ts') + "'",
      "export { readPresetRegexScripts } from '" + at('src/main/features/bridge/presetRegex.ts') + "'",
      "export { BRIDGE_DEFAULT_CONFIG } from '" + at('src/shared/bridge.ts') + "'"
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

function stampNow() {
  const d = new Date()
  const pad = (v) => String(v).padStart(2, '0')
  return pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
}

/** 三条历史刻意内容不同（经验库 H6/P17：两条一样的分支历史会让「不串味」恒通过） */
const ROUND_SCRIPT = [
  {
    sessionId: 'branch-A',
    label: 'A-1',
    messages: [
      { role: 'user', content: '【分支A·第1轮】暗号 ALPHA-ONE。' },
      { role: 'assistant', content: '【分支A·第1轮回复】记住了，暗号是 ALPHA-ONE。' },
      { role: 'user', content: '只回一句话：你刚才记下的暗号是什么？' }
    ]
  },
  {
    sessionId: 'branch-B',
    label: 'B-1',
    messages: [
      { role: 'user', content: '【分支B·第1轮】暗号 BETA-TWO。' },
      { role: 'assistant', content: '【分支B·第1轮回复】记住了，暗号是 BETA-TWO。' },
      { role: 'user', content: '只回一句话：你刚才记下的暗号是什么？' }
    ]
  },
  {
    sessionId: 'branch-A',
    label: 'A-2',
    messages: [
      { role: 'user', content: '【分支A·第1轮】暗号 ALPHA-ONE。' },
      { role: 'assistant', content: '【分支A·第1轮回复】记住了，暗号是 ALPHA-ONE。' },
      { role: 'user', content: '只回一句话：你刚才记下的暗号是什么？' },
      { role: 'assistant', content: '【分支A·第2轮回复】ALPHA-ONE。' },
      { role: 'user', content: '再确认一次：刚才那个暗号，原样说出来。' }
    ]
  }
]

async function runInElectron() {
  const electronApi = require('electron')
  const { app } = electronApi

  // 独立 userData：共默认 profile 时，被强杀的前一实例会把后一实例卡在 ready 之前（P0 §三 第 5 条）
  app.setPath('userData', path.join(os.tmpdir(), 'nc-bridge-probe-' + process.pid))
  app.disableHardwareAcceleration()
  await app.whenReady()
  log('ready')

  const bridge = await buildBridgeBundle()
  const { bridgeHost, bridgeDriver, EXPOSURE_EXPR, readPresetRegexScripts, BRIDGE_DEFAULT_CONFIG } = bridge
  log('bundle ok')

  const startedAt = new Date()
  const report = {
    probe: 'bridge-driver',
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    env: {
      electron: process.versions.electron,
      node: process.versions.node,
      stUrl: ST_URL,
      stData: ST_DATA,
      partition: BRIDGE_DEFAULT_CONFIG.partition,
      genTimeoutMs: GEN_TIMEOUT_MS,
      rounds: ROUNDS
    },
    disk: { before: countDisk(), after: null, settingsMtimeBefore: settingsMtime(), settingsMtimeAfter: null },
    preset: null,
    rounds: [],
    health: null,
    assertions: { total: 0, passed: 0, failed: 0, skipped: 0, items: [] },
    stopped: null
  }
  const record = (id, ok, extra) => {
    report.assertions.items.push(Object.assign({ id, ok }, extra || {}))
  }

  // 预设正则（J-08 的 P4 半边）：只记录，不拿来判死 —— ST 的预设是用户资产
  try {
    const scripts = readPresetRegexScripts(ST_DATA)
    report.preset = {
      count: scripts.length,
      markdownOnly: scripts.filter((s) => s.markdownOnly).length,
      promptOnly: scripts.filter((s) => s.promptOnly).length,
      names: scripts.map((s) => s.scriptName).slice(0, 20)
    }
  } catch (error) {
    report.preset = { count: 0, error: String(error && error.message ? error.message : error) }
  }
  record('B6', report.preset.count > 0, { presetScripts: report.preset.count, md: report.preset.markdownOnly })

  const charactersRef = { value: null }
  try {
    for (let index = 0; index < ROUNDS; index += 1) {
      const script = ROUND_SCRIPT[index % ROUND_SCRIPT.length]
      const roundStart = Date.now()
      log('round ' + String(index + 1) + ' ' + script.label + ' start')

      const detail = await bridgeDriver.runTurn({ sessionId: script.sessionId, messages: script.messages })
      const roundEnd = Date.now()
      const exposure = await bridgeHost.eval(EXPOSURE_EXPR, 'probe:exposure')

      if (charactersRef.value === null) charactersRef.value = exposure.characters
      const round = {
        index: index + 1,
        label: script.label,
        sessionId: script.sessionId,
        status: detail.result.status,
        contentLength: detail.result.content.length,
        contentHead: detail.result.content.slice(0, 200),
        error: detail.result.error,
        ms: detail.result.ms,
        wallMs: roundEnd - roundStart,
        startedAt: roundStart,
        endedAt: roundEnd,
        trace: detail.trace,
        after: {
          chat: exposure.chat,
          metadata: exposure.metadata,
          prompts: exposure.prompts,
          characters: exposure.characters
        }
      }
      report.rounds.push(round)
      log('round ' + String(index + 1) + ' ' + detail.result.status + ' ' + String(round.ms) + 'ms len=' + String(round.contentLength))

      record('A2-' + String(round.index), exposure.chat === 0 && exposure.metadata === 0 && exposure.prompts === 0, {
        chat: exposure.chat,
        metadata: exposure.metadata,
        prompts: exposure.prompts
      })
      record('A2b-' + String(round.index), exposure.characters === charactersRef.value, {
        characters: exposure.characters,
        expected: charactersRef.value
      })
      record('A4-' + String(round.index), detail.result.status === 'done' && detail.result.content.length > 0, {
        status: detail.result.status,
        length: detail.result.content.length,
        error: detail.result.error
      })
    }

    // A5：第 1 轮**结束**到第 2 轮**开始**的真实间隔必须 < 30s（tavern_helper 的窗口）
    if (report.rounds.length >= 2) {
      const gap = report.rounds[1].startedAt - report.rounds[0].endedAt
      record('A5', gap >= 0 && gap < 30000, { gapMs: gap, round1WallMs: report.rounds[0].wallMs })
    }
  } catch (error) {
    report.stopped = { reason: 'probe_exception', error: String(error && error.stack ? error.stack : error) }
    record('EXC', false, { error: String(error && error.message ? error.message : error) })
  } finally {
    report.health = bridgeHost.health()
    const stats = bridgeHost.statsSnapshot()
    report.cancelledWrites = stats.cancelledWrites
    report.blockedExternal = stats.blockedExternal
    report.cancelledUrls = stats.cancelledUrls
    bridgeHost.destroy()
    report.disk.after = countDisk()
    report.disk.settingsMtimeAfter = settingsMtime()
  }

  // A3：磁盘差集全 0 + settings.json mtime 不变
  const delta = {
    chats: report.disk.after.chats - report.disk.before.chats,
    backups: report.disk.after.backups - report.disk.before.backups,
    characters: report.disk.after.characters - report.disk.before.characters
  }
  report.diskDelta = delta
  record('A3', delta.chats === 0 && delta.backups === 0 && delta.characters === 0, delta)
  record('A3b', report.disk.settingsMtimeBefore === report.disk.settingsMtimeAfter, {
    before: report.disk.settingsMtimeBefore,
    after: report.disk.settingsMtimeAfter
  })
  // J-07：拦截确实触发过（写盘面 / 外网面），否则「零残留」可能只是「压根没请求」
  record('J7-write', report.cancelledWrites >= 1, { cancelled: report.cancelledWrites })
  record('J7-external', report.blockedExternal >= 1, { blocked: report.blockedExternal })

  const items = report.assertions.items
  report.assertions.total = items.length
  report.assertions.failed = items.filter((i) => i.ok !== true).length
  report.assertions.passed = items.filter((i) => i.ok === true).length
  report.assertions.failedIds = items.filter((i) => i.ok !== true).map((i) => i.id)
  report.finishedAt = new Date().toISOString()
  report.durationMs = Date.now() - startedAt.getTime()

  writeBaseline(report)
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  const verdict = report.assertions.failed === 0 ? 'PASS' : 'FAIL'
  process.stderr.write('SUMMARY: ' + verdict + ' ' + String(report.assertions.passed) + '/' + String(report.assertions.total) + '\n')
  app.exit(report.assertions.failed === 0 ? 0 : 1)
}

function baselineDir() {
  if (process.env.NC_PROBE_BASELINE_DIR) return process.env.NC_PROBE_BASELINE_DIR
  return path.join(path.dirname(PROJECT_ROOT), 'DOC', 'agent--pojia架构', 'task-pojia 架构', 'baseline')
}

function writeBaseline(report) {
  try {
    const dir = baselineDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'st-drive.' + stampNow() + '.after.txt')
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8')
    process.stderr.write('BASELINE: ' + file + '\n')
  } catch (error) {
    process.stderr.write('BASELINE_WRITE_FAILED: ' + String(error && error.message ? error.message : error) + '\n')
  }
}
