/**
 * A6 宿主真进程：invokeAction 链路通（**不需要 QQ**）。
 *
 * 判据故意用「账号不存在」当正向信号（J-07）：只证明"没报错"区分不了
 * 「方法没接上」和「真的走到了 OneBotManager」。
 *
 * 跑法：node scripts/test/qq-host-action.test.mjs
 * 依赖：先 pnpm build:snowluma-host（缺产物会明确 skip，不伪装通过）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadEsbuild, projectRoot, installElectronStub } from './qq-test-util.mjs'

const require = createRequire(import.meta.url)
const hostDir = process.env.NC_SL_HOST_DIR || path.join(projectRoot, 'out', 'snowluma-host')

const results = []
function check(label, ok, extra) {
  results.push({ label, ok: Boolean(ok) })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!fs.existsSync(path.join(hostDir, 'node.exe')) || !fs.existsSync(path.join(hostDir, 'index.mjs'))) {
  console.log('SKIP：缺 out/snowluma-host 产物（先跑 pnpm build:snowluma-host）')
  process.exit(0)
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-host-action-'))
const userData = path.join(sandbox, 'userData')
fs.mkdirSync(userData, { recursive: true })
installElectronStub(userData)
process.env.NC_SL_HOST_DIR = hostDir

const esbuild = loadEsbuild()
const bundle = path.join(sandbox, 'host.cjs')
await esbuild.build({
  entryPoints: [path.join(projectRoot, 'src/main/features/qq/host.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  external: ['electron'],
  alias: { '@shared': path.join(projectRoot, 'src/shared') },
  logLevel: 'silent'
})
const { QqHost } = require(bundle)

/* ── 1. 未就绪时的错误口径 ─────────────────────────────────────────────── */

console.log('未就绪')
{
  const cold = new QqHost()
  let error = null
  try {
    await cold.invokeAction('999999', 'send_private_msg', { user_id: 1, message: [] })
  } catch (cause) {
    error = cause
  }
  check(
    'state !== ready 时 reject 且 message 含 "not ready"',
    error instanceof Error && /not ready/.test(error.message),
    error && error.message
  )
}

/* ── 2. 真进程：ready + invokeAction ─────────────────────────────────── */

console.log('真进程')
const host = new QqHost()
const exits = []
host.on('exit', (info) => exits.push(info))
host.start()

const deadline = Date.now() + 30_000
while (host.status().state !== 'ready' && Date.now() < deadline) await sleep(100)
check('30 s 内 ready', host.status().state === 'ready', host.status().state + ' / ' + String(host.status().readyMs) + 'ms')
check('readyMs < 3000', host.status().readyMs !== null && host.status().readyMs < 3000, host.status().readyMs)

{
  let error = null
  try {
    await host.invokeAction('999999', 'send_private_msg', { user_id: 123, message: [] })
  } catch (cause) {
    error = cause
  }
  check(
    'invokeAction 对不存在的账号 reject（证明真的走进了 OneBotManager）',
    error instanceof Error && error.message.includes('account not ready: 999999'),
    error && error.message
  )
}

check('异常没有带走宿主（仍然 ready）', host.status().state === 'ready', host.status().state)

{
  let error = null
  try {
    await host.invokeAction('999999', 'not_an_action', {})
  } catch (cause) {
    error = cause
  }
  check('未知 action 也是被宿主拒绝，不是崩溃', error instanceof Error && error.message.includes('account not ready'), error && error.message)
}

/* ── 3. 优雅关闭（J-11 三条同时断言） ───────────────────────────────── */

console.log('优雅关闭')
const stoppingAt = Date.now()
await host.stop()
const elapsed = Date.now() - stoppingAt
check('exit code = 0', host.exitInfo !== null && host.exitInfo.code === 0, JSON.stringify(host.exitInfo))
check('耗时 < 5000 ms', elapsed < 5000, String(elapsed) + 'ms')
check('收到了 exit 事件', exits.length >= 1, exits.length)

const failed = results.filter((item) => !item.ok)
console.log('')
console.log('共 ' + String(results.length) + ' 项，通过 ' + String(results.length - failed.length) + ' 项')
if (failed.length > 0) {
  for (const item of failed) console.log('  - ' + item.label)
  process.exit(1)
}
