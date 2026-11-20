import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BridgeLogPipe } from './logpipe'

const CHANNEL = 'bridge:log-lines'
/** 独立本地页；主进程 send 推送，preload 只写 textContent，不解释日志 HTML。 */
export class BridgeLogWindow {
  private win: BrowserWindow | null = null
  private unsubscribe: (() => void) | null = null
  private epoch = 0
  close(): void {
    this.epoch++
    this.unsubscribe?.()
    this.unsubscribe = null
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }
  async open(log: BridgeLogPipe, directory: string, parent?: BrowserWindow): Promise<void> {
    if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus(); return }
    const epoch = ++this.epoch
    mkdirSync(directory, { recursive: true })
    const html = join(directory, 'log.html')
    const preload = join(directory, 'log-preload.cjs')
    writeFileSync(preload, 'const {ipcRenderer}=require("electron"); ipcRenderer.on(' + JSON.stringify(CHANNEL) + ', (_event, items) => { const el=document.getElementById("log"); if(!el) return; const bottom=window.scrollY+window.innerHeight>=document.body.scrollHeight-40; el.appendChild(document.createTextNode(items.map(x=>"["+x.stream+"] "+x.text).join("\\n")+"\\n")); if(bottom) window.scrollTo(0,document.body.scrollHeight); });', 'utf8')
    writeFileSync(html, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>ST 桥接日志</title><style>body{font:14px monospace;margin:20px;color:CanvasText;background:Canvas;color-scheme:light dark}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>ST 桥接日志</h1><p>本次进程启动以来的 stdout / stderr（ANSI 已剥离）</p><pre id="log"></pre></html>', 'utf8')
    const win = new BrowserWindow({ show: true, width: 1000, height: 700, title: 'ST 桥接日志', ...(parent ? { parent } : {}), webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true } })
    this.win = win
    win.once('close', () => { if (this.win === win) { this.unsubscribe?.(); this.unsubscribe = null; this.win = null; this.epoch++ } })
    try {
      await win.loadFile(html)
      if (epoch !== this.epoch || win.isDestroyed()) return
      win.webContents.send(CHANNEL, log.snapshot())
      this.unsubscribe = log.subscribe(line => { if (!win.isDestroyed()) win.webContents.send(CHANNEL, [line]) })
    } catch (error) { this.close(); throw error }
  }
}
