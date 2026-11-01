/**
 * QQ 宿主进程桥（src/main/features/qq/host.ts）行为测试。
 *
 * 测的是**真实边界**，不是"再实现一遍"：
 *  - 真起 `out/snowluma-host/node.exe index.mjs`（真产物、真 IPC、真原生模块枚举 QQ 进程）
 *  - 真发 RPC（listProcesses / status）并按 id 关联
 *  - 真 shutdown 并断言退出码 0
 *  - 真 taskkill 子进程，断言父进程（本测试）仍在且宿主自动重启
 *  - 真断言"从没注入过任何 QQ 进程"（hookAutoLoad=false / injected=false）
 *
 * 跑法：pnpm test:qq-host
 * 依赖：先 `pnpm build:snowluma-host`（缺产物会明确 skip，不伪装通过）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')
const hostDir = process.env.NC_SL_HOST_DIR || path.join(projectRoot, 'out', 'snowluma-host')

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/* ── 被测对象：把 host.ts 用 esbuild 打成 CJS，electron 换成桩 ─────────────── */

function loadEsbuild() {
  const pnpmDir = path.join(projectRoot, 'node_modules/.pnpm')
  const candidates = fs.existsSync(pnpmDir)
    ? fs.readdirSync(pnpmDir).filter((name) => name.startsWith('esbuild@'))
    : []
  for (const name of candidates) {
    const entry = path.join(pnpmDir, name, 'node_modules/esbuild/lib/main.js')
    if (fs.existsSync(entry)) return require(entry)
  }
  return require('esbuild')
}

const require = (await import('node:module')).createRequire(import.meta.url)
const esbuild = loadEsbuild()

const sandbox = path.join(os.tmpdir(), 'nahida-qqhost-test-' + process.pid + '-' + Date.now())
fs.mkdirSync(sandbox, { recursive: true })
const userData = path.join(sandbox, 'userData')
fs.mkdirSync(userData, { recursive: true })

const output = path.join(sandbox, 'host.cjs')
await esbuild.build({
  entryPoints: [path.join(projectRoot, 'src/main/features/qq/host.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  external: ['electron'],
  alias: { '@shared': path.join(projectRoot, 'src/shared') },
  logLevel: 'silent'
})

const electronStub = path.join(sandbox, 'electron-stub.cjs')
fs.writeFileSync(
  electronStub,
  'module.exports = { app: { getPath: () => ' +
    JSON.stringify(userData) +
    ', on: () => {} } }',
  'utf8'
)

const Module = require('node:module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return electronStub
  return originalResolve.call(this, request, ...rest)
}

const hasArtifacts =
  fs.existsSync(path.join(hostDir, 'node.exe')) && fs.existsSync(path.join(hostDir, 'index.mjs'))

if (!hasArtifacts) {
  console.log('SKIP：缺 out/snowluma-host 产物（先跑 pnpm build:snowluma-host）')
  process.exit(0)
}

process.env.NC_SL_HOST_DIR = hostDir

const { QqHost } = require(output)

/* ── 1. 启动 + 握手 ─────────────────────────────────────────────────────── */

console.log('启动与握手')
const host = new QqHost()
const stateLog = []
const exitLog = []
host.on('state', (s) => stateLog.push(s.state))
host.on('exit', (info) => exitLog.push(info))

const t0 = Date.now()
host.start()

const readyDeadline = Date.now() + 30_000
while (host.status().state !== 'ready' && Date.now() < readyDeadline) {
  await sleep(100)
}
const status = host.status()
check('30 s 内进入 ready', status.state === 'ready', status.state + ' / ' + String(status.readyMs) + 'ms')
check('ready 带回了 node/napi', status.node === '24.22.1' && status.napi === '10', status.node + '/' + status.napi)
check('数据目录落在 userData 下', status.home === path.join(userData, 'snowluma'), status.home)
check('宿主 PID 是真实进程', typeof status.pid === 'number' && status.pid > 0, status.pid)
check('握手耗时 < 30 s', status.readyMs !== null && status.readyMs < 30_000, status.readyMs)

// 宿主自己的运行期目录必须落在 userData，不能污染构建产物（P1 复核 O-2）
check(
  'config/runtime.json 落在 host 数据目录',
  fs.existsSync(path.join(userData, 'snowluma', 'config', 'runtime.json'))
)
const runtimeJson = JSON.parse(
  fs.readFileSync(path.join(userData, 'snowluma', 'config', 'runtime.json'), 'utf8')
)
check('runtime.json 里 hookAutoLoad === false', runtimeJson.hookAutoLoad === false, runtimeJson.hookAutoLoad)
check(
  '构建产物目录没有被写入 config/',
  !fs.existsSync(path.join(hostDir, 'config')),
  path.join(hostDir, 'config')
)

/* ── 2. RPC 往返 ────────────────────────────────────────────────────────── */

console.log('RPC 往返')
const list = await host.listProcesses()
check('listProcesses 回数组', Array.isArray(list), Array.isArray(list) ? list.length + ' 条' : typeof list)
check(
  'listProcesses 里没有一个被注入（M2 / D2）',
  list.every((p) => p.injected === false),
  list.filter((p) => p.injected).map((p) => p.pid).join(',') || '全部 false'
)
check(
  '快照字段齐全（不残留 bigint 之类）',
  list.every(
    (p) =>
      typeof p.pid === 'number' &&
      typeof p.status === 'string' &&
      typeof p.error === 'string' &&
      (p.account === null || typeof p.account.uin === 'string')
  )
)

const detail = await host.hostStatus()
check('status 回包带 node 版本', detail.node === '24.22.1', detail.node)
check('status 里 accounts 是数组', Array.isArray(detail.accounts), JSON.stringify(detail.accounts))

// 并发 RPC 必须按 id 关联，不能串包（经验库 C17）
const concurrent = await Promise.all([host.hostStatus(), host.listProcesses(), host.hostStatus()])
check(
  '并发 RPC 按 id 关联、结果不串包',
  typeof concurrent[0].node === 'string' &&
    Array.isArray(concurrent[1]) &&
    typeof concurrent[2].home === 'string'
)

// 非法参数必须被宿主拒绝并原样回错误，而不是崩掉
let badPidError = ''
try {
  await host.loadProcess(0)
} catch (error) {
  badPidError = error instanceof Error ? error.message : String(error)
}
check('非法 pid 被拒绝且宿主存活', badPidError.includes('positive integer') && host.status().state === 'ready', badPidError.slice(0, 80))

/* ── 3. 崩溃隔离 + 自动重启 ─────────────────────────────────────────────── */

console.log('崩溃隔离')
const firstPid = host.status().pid
execKill(firstPid)

const restartDeadline = Date.now() + 20_000
while (Date.now() < restartDeadline) {
  const s = host.status()
  if (s.state === 'ready' && s.pid !== null && s.pid !== firstPid) break
  await sleep(100)
}
const afterKill = host.status()
check('被 taskkill 后宿主真的换了新 PID', afterKill.pid !== firstPid && afterKill.pid !== null, String(firstPid) + ' → ' + String(afterKill.pid))
check('宿主自动重启回 ready', afterKill.state === 'ready', afterKill.state)
check('测试进程自己没被杀掉（隔离成立）', true)

// 重启后 RPC 仍然可用（不是"起来了但通道断了"）
const listAfterRestart = await host.listProcesses()
check('重启后 RPC 仍可用', Array.isArray(listAfterRestart), listAfterRestart.length + ' 条')

/* ── 4. 优雅关闭 ────────────────────────────────────────────────────────── */

console.log('优雅关闭')
const lastPid = host.status().pid
const stopAt = Date.now()
await host.stop()
const stopMs = Date.now() - stopAt
check('stop() 后状态为 stopped', host.status().state === 'stopped', host.status().state)
check('5 s 内完成关闭', stopMs < 5_000, stopMs + 'ms')
check('宿主自己优雅退出（退出码 0，不是被强杀）', host.exitInfo?.code === 0, JSON.stringify(host.exitInfo))
check(
  'exit 事件里最后一次是 0（stop 前后各一次，都不是 taskkill 的那个）',
  exitLog.length >= 2 && exitLog[exitLog.length - 1].code === 0,
  JSON.stringify(exitLog)
)
if (host.exitInfo?.code !== 0) {
  console.log('  --- 宿主最后 20 条日志 ---')
  for (const entry of host.recentLogs(20)) console.log('  ' + entry.level + ' [' + entry.scope + '] ' + entry.line)
  const logDir = path.join(userData, 'snowluma', 'logs')
  if (fs.existsSync(logDir)) {
    for (const name of fs.readdirSync(logDir)) {
      const text = fs.readFileSync(path.join(logDir, name), 'utf8')
      console.log('  --- ' + name + ' ---')
      console.log(text.split('\n').slice(-25).join('\n'))
    }
  }
}
await sleep(500)
check('进程确实没了', !processAlive(lastPid), lastPid)

const listAfterStop = await host.listProcesses().then(
  () => 'resolved',
  (error) => 'rejected:' + error.message
)
check('关闭后 RPC 明确报错而不是挂起', String(listAfterStop).startsWith('rejected:'), String(listAfterStop).slice(0, 60))

function execKill(pid) {
  const { execFileSync } = require('node:child_process')
  execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
}

function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/* ── 5. 产物缺失 / 连续失败 → degraded ───────────────────────────────────── */

console.log('降级路径')
const bogus = new QqHost()
process.env.NC_SL_HOST_DIR = path.join(sandbox, 'no-such-host-dir')
bogus.start()
await sleep(300)
check('产物缺失时立刻 degraded，不无限重启', bogus.status().state === 'degraded', bogus.status().state)
check(
  '降级原因写清了缺什么',
  String(bogus.status().lastError).includes('snowluma-host') && String(bogus.status().lastError).includes('pnpm build'),
  String(bogus.status().lastError).slice(0, 80)
)
check('降级时没有留下子进程', bogus.status().pid === null, bogus.status().pid)
await bogus.stop()
process.env.NC_SL_HOST_DIR = hostDir

/* ── 汇总 ───────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok)
console.log('')
console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项')
console.log('state 迁移：' + [...new Set(stateLog)].join(' → '))
console.log('总耗时：' + (Date.now() - t0) + 'ms')
fs.rmSync(sandbox, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
