/**
 * 真 Electron 下的 QQ 宿主验收（PHASE-2 G3–G7 的"装到 NC 里还能不能跑"）。
 *
 * 纯 Node 的 qq-host.test.mjs 只证明"host.ts 这个类能驱动子进程"；
 * 它证明不了 main/index.ts 的接线是否真的生效、app.getPath('userData') 是否指向预期目录、
 * before-quit 是否真的把宿主关掉。这条链断在哪一环，单测都依然全绿。
 *
 * 跑法：pnpm test:qq-host:electron
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..', '..')
const userData = path.join(os.tmpdir(), 'nahida-qqhost-e2e-' + Date.now())
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setAppPath(projectRoot)
require(path.join(projectRoot, 'out', 'main', 'index.js'))

const results = []
const check = (label, ok, extra) => {
  results.push({ label, ok })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 用 WMIC 之外的方式枚举：直接查 node.exe 的命令行里有没有 snowluma-host。 */
function listHostProcesses() {
  const ps = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ],
    { encoding: 'utf8' }
  ).trim()
  if (!ps) return []
  const parsed = JSON.parse(ps)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.filter((row) => typeof row.CommandLine === 'string' && row.CommandLine.includes('snowluma-host'))
}

app.whenReady().then(async () => {
  try {
    const home = path.join(userData, 'snowluma')

    // 1) 宿主真的被 main/index.ts 拉起来了（不是"类写得好看"）
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (fs.existsSync(path.join(home, 'config', 'runtime.json'))) break
      await sleep(200)
    }
    check('NC 启动后宿主写出了 config/runtime.json', fs.existsSync(path.join(home, 'config', 'runtime.json')), home)

    const runtime = JSON.parse(fs.readFileSync(path.join(home, 'config', 'runtime.json'), 'utf8'))
    check('运行时 hookAutoLoad === false（M2）', runtime.hookAutoLoad === false, runtime.hookAutoLoad)

    // 2) H-08：任务管理器里应该看到一个 node.exe 跑 snowluma-host，且**没有** electron.exe 当宿主
    const hosts = listHostProcesses()
    check('系统里恰好有 1 个 snowluma-host 的 node.exe', hosts.length === 1, hosts.length + ' 个: ' + hosts.map((h) => h.ProcessId).join(','))
    const cmdline = hosts[0] ? hosts[0].CommandLine : ''
    check('该进程的可执行文件名是 node.exe', /node\.exe/i.test(cmdline), cmdline.slice(0, 60))
    check('该进程的入口是受控入口产物 index.mjs', cmdline.includes('index.mjs'), cmdline.slice(-40))
    check('没有用 electron.exe 当宿主', !/electron\.exe/i.test(cmdline), cmdline.slice(0, 60))

    // 3) 产物目录没被污染（运行期目录必须在 userData）
    check('out/snowluma-host 里没有 config/', !fs.existsSync(path.join(projectRoot, 'out', 'snowluma-host', 'config')))

    // 4) 窗口还活着 = NC 主进程没被子进程拖垮
    const win = BrowserWindow.getAllWindows()[0]
    check('NC 窗口仍在且可执行脚本', win !== undefined && !win.isDestroyed())
    const title = await win.webContents.executeJavaScript('document.title')
    check('渲染层能响应（executeJavaScript 有回值）', typeof title === 'string', title)

    // 5) G6：从外部 taskkill 宿主，NC 必须活着并自动重启
    const beforePid = hosts[0] ? hosts[0].ProcessId : null
    if (beforePid) execFileSync('taskkill', ['/PID', String(beforePid), '/F'], { stdio: 'ignore' })

    let afterPid = null
    const restartDeadline = Date.now() + 30_000
    while (Date.now() < restartDeadline) {
      const now = listHostProcesses()
      if (now.length === 1 && now[0].ProcessId !== beforePid) {
        afterPid = now[0].ProcessId
        break
      }
      await sleep(250)
    }
    check('taskkill 后宿主换了新 PID（自动重启）', afterPid !== null && afterPid !== beforePid, String(beforePid) + ' → ' + String(afterPid))
    check('NC 窗口在崩溃后仍然存活', !win.isDestroyed())

    const titleAfter = await win.webContents.executeJavaScript('document.title')
    check('崩溃后渲染层仍然响应', typeof titleAfter === 'string', titleAfter)

    // 6) 优雅关闭：before-quit 必须把宿主收掉，不留孤儿。
    //
    // 这里必须**拦住 will-quit**：直接 app.quit() 会让进程在断言跑完之前就退出，
    // 于是"没有孤儿"这条判据永远不执行、也永远不失败（本 Phase 自踩：第一版就是这样
    // 12 项全 ok 但没有汇总行 —— 判据根本没跑到）。
    // before-quit 已经先一步触发（qqHost.stop() 在里面），will-quit 时只需等它收尾。
    const finalPid = afterPid
    let finished = false

    app.on('will-quit', (event) => {
      if (finished) return
      event.preventDefault()

      void (async () => {
        const deadline = Date.now() + 10_000
        let leftover = listHostProcesses().filter((h) => h.ProcessId === finalPid)
        while (leftover.length > 0 && Date.now() < deadline) {
          await sleep(200)
          leftover = listHostProcesses().filter((h) => h.ProcessId === finalPid)
        }
        check('app.quit() 后没有留下孤儿宿主进程', leftover.length === 0, leftover.map((h) => h.ProcessId).join(',') || 'none')
        finish()
      })()
    })

    app.quit()
    return
  } catch (error) {
    check('未抛异常：' + (error && error.message ? error.message : String(error)), false)
    finish()
  }
})

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项')
  console.log('USERDATA=' + userData)
  app.exit(failed.length === 0 ? 0 : 1)
}
