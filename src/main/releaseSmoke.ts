/** 发布包自检：隔离 userData，加载真实 renderer/preload，并握手随包宿主。 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { QqHost, resolveHostDir } from './features/qq/host'
import { registerIpcHandlers } from './ipc'
import { registerBuiltinTools } from './features/tools/builtin'
import { promptStore } from './features/prompt/promptStore'

export function startReleaseSmoke(): void {
  const output = process.env['NAHIDA_RELEASE_SMOKE_RESULT']
  const home = mkdtempSync(join(tmpdir(), 'nahida-release-user-'))
  app.setPath('userData', home)
  app.setName('Nahida Chat Release Smoke')
  void app.whenReady().then(async () => {
    const host = new QqHost()
    let window: BrowserWindow | null = null
    const result: Record<string, unknown> = { packaged: app.isPackaged, resources: process.resourcesPath, userData: home, hostDir: resolveHostDir(), promptRoot: promptStore.root() }
    let code = 0
    try {
      if (!app.isPackaged) throw Error('发布自检必须运行真正的打包程序')
      registerBuiltinTools()
      registerIpcHandlers()
      host.start()
      const deadline = Date.now() + 30000
      while (host.status().state !== 'ready' && Date.now() < deadline) {
        if (host.status().state === 'degraded') throw Error(String(host.status().lastError))
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (host.status().state !== 'ready') throw Error('随包宿主握手超时')
      result.host = await host.hostStatus()
      result.processes = (await host.listProcesses()).length
      window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await window.loadFile(join(__dirname, '../renderer/index.html'))
      const renderDeadline = Date.now() + 15000
      let renderer = { api: false, mounted: false }
      while (Date.now() < renderDeadline) {
        renderer = await window.webContents.executeJavaScript('({ api: !!(window.nahida && window.nahida.chat && window.nahida.bridge), mounted: !!(document.getElementById("root")?.textContent?.trim()) })')
        if (renderer.api && renderer.mounted) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!renderer.api || !renderer.mounted) throw Error('发布包 renderer/preload 未就绪')
      result.renderer = renderer
      result.ok = true
    } catch (error) {
      code = 1
      result.ok = false
      result.error = error instanceof Error ? error.stack : String(error)
    } finally {
      window?.destroy()
      await host.stop()
      result.hostStopped = host.status().state === 'stopped'
      result.hostExit = host.exitInfo
      if (!result.hostStopped || host.exitInfo?.code !== 0) { result.ok = false; code = 1 }
      if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2)) }
      console.log('[release-smoke] ' + JSON.stringify(result))
      app.exit(code)
    }
  }).catch(error => { console.error(error); app.exit(1) })
}
