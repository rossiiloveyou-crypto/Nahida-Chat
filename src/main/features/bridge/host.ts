/**
 * 隐藏 `BrowserWindow` 宿主（P4 §1 第 2 行）。
 *
 * 一个隐藏窗口、一个独立分区、一套拦截，跑在 NC 的主进程里，加载 ST 的前端页面。
 * 它只负责「窗口在这儿、能跑表达式、状态是干净的」，**不掺和**一轮怎么走（那是 driver 的事）。
 *
 * 复用 P0 探针的六件套（PHASE-0 完成报告 §六「不许重新发明」）：
 * 1. `CANCEL_PATTERNS` + `classifyRequest`（J-07 全套写盘面 + 外网）
 * 2. 独立 `session.fromPartition`（共默认 profile 会被上一实例的锁卡死在 ready 之前）
 * 3. 强就绪判据 `READY_EXPR`（弱判据得到的是「静默变笨」，不是报错）
 * 4. `CONNECT_EXPR` 点一次 Connect（不点则 `generate` 静默 resolve(undefined)）
 * 5. 崩溃/加载失败后可重建（`render-process-gone` / `did-fail-load`）
 * 6. preload 只暴露 `window.ncEmit`（见 preload.ts）
 */

import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron'
import type { Session as ElectronSession } from 'electron'
import { join } from 'node:path'
import { BRIDGE_DEFAULT_CONFIG, BRIDGE_IPC } from '@shared/bridge'
import type { BridgeConfig, BridgeHealth } from '@shared/bridge'
import { ensurePreloadFile } from './preload'
import { EVAL_LABEL } from './session'

/**
 * 必须拦掉的写盘 / 外网请求（J-07 的**完整**清单，P0 实测穷举）。
 *
 * 🔴 少一条的后果不是报错，是 ST 的 `data/` 里多出文件、`settings.json` 被重写 ——
 *    M2「ST 零持久化」当场不成立，而当时没人会知道。
 * 🔴 `settings/save` 与 `quick-replies/save` 是 P0 补进来的：页面加载与点 Connect **各会**触发一次。
 */
export const CANCEL_PATTERNS: RegExp[] = [
  /\/api\/chats\/save(\?|$)/,
  /\/api\/chats\/delete(\?|$)/,
  /\/api\/chats\/rename(\?|$)/,
  /\/api\/chats\/import(\?|$)/,
  /\/api\/backups\//,
  /\/api\/settings\/save(\?|$)/,
  /\/api\/quick-replies\/save(\?|$)/
]

/** 只有这三个主机名算「本地」。外网一律挡掉（P0 实测一跑 19 次外网请求） */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** 拦截分类：`write` = 写 ST 磁盘；`external` = 出网；null = 放行 */
export function classifyRequest(url: string): 'write' | 'external' | null {
  if (CANCEL_PATTERNS.some((re) => re.test(url))) return 'write'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!LOCAL_HOSTS.has(parsed.hostname)) return 'external'
  return null
}

/**
 * 强就绪判据（P0 §三 第 3 条）。
 *
 * 三件事**同时**成立才算就绪，缺一条都会得到「静默变笨」而不是报错：
 * 1. `characters` 已从 `/api/characters/all` 拉回（长度 > 0）；
 * 2. CSRF token 已就位（否则后续写请求 403 → `pingServer` 失败）；
 * 3. 输入框已挂上（DOM 初始化完成）。
 */
export const READY_EXPR = [
  '(() => {',
  '    try {',
  '        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) { return false; }',
  '        if (document.readyState !== "complete") { return false; }',
  '        const ctx = SillyTavern.getContext();',
  '        const h = typeof ctx.getRequestHeaders === "function" ? ctx.getRequestHeaders() : {};',
  '        return Array.isArray(ctx.chat)',
  '            && Array.isArray(ctx.characters)',
  '            && ctx.characters.length > 0',
  '            && !!(h["X-CSRF-Token"] || h["x-csrf-token"])',
  '            && !!document.querySelector("#send_textarea");',
  '    } catch (error) { return false; }',
  '})()'
].join('\n')

/** 点一次 Connect（P0 §三 第 4 条：不点则 `generate` 静默 resolve(undefined)） */
export function connectExpr(timeoutMs: number): string {
  return [
    '(async () => {',
    '    const ctx = SillyTavern.getContext();',
    '    const t0 = performance.now();',
    '    const timeoutMs = ' + Number(timeoutMs) + ';',
    '    if (ctx.onlineStatus && ctx.onlineStatus !== "no_connection") {',
    '        return { attempted: false, ok: true, status: String(ctx.onlineStatus), ms: 0 };',
    '    }',
    '    const btn = document.querySelector("#api_button_openai");',
    '    if (!btn) { return { attempted: false, ok: false, error: "#api_button_openai not found", ms: 0 }; }',
    '    btn.click();',
    '    const deadline = Date.now() + timeoutMs;',
    '    while (Date.now() < deadline) {',
    '        const status = SillyTavern.getContext().onlineStatus;',
    '        if (status && status !== "no_connection") {',
    '            return { attempted: true, ok: true, status: String(status), ms: Math.round(performance.now() - t0) };',
    '        }',
    '        await new Promise(r => setTimeout(r, 250));',
    '    }',
    '    return { attempted: true, ok: false, status: String(SillyTavern.getContext().onlineStatus), ms: Math.round(performance.now() - t0), error: "online_status stayed no_connection" };',
    '})()'
  ].join('\n')
}

/** 页面上能跑表达式的最小接口面（单测里换成假宿主） */
export interface BridgePage {
  alive(): boolean
  eval<T>(expr: string, label?: string): Promise<T>
}

/** preload 回推的事件（`window.ncEmit(name, payload)`） */
export interface BridgePageEvent {
  name: string
  payload: unknown
  at: number
}

export interface BridgeHostStats {
  /** 建窗次数（>1 = 发生过重建） */
  boots: number
  /** 被拦下的写盘请求数 */
  cancelledWrites: number
  /** 被拦下的外网请求数 */
  blockedExternal: number
  /** 拦下的具体 URL（去重，排障用） */
  cancelledUrls: string[]
}

/**
 * 隐藏窗口宿主。**懒启动**：第一次 `ensure()` 才建窗口 —— 没开故事模式就不该有 ST 窗口。
 */
export class BridgeHost implements BridgePage {
  readonly config: BridgeConfig
  private win: BrowserWindow | null = null
  private booting: Promise<void> | null = null
  private healthy = false
  private lastError: string | null = null
  private readonly listeners = new Set<(event: BridgePageEvent) => void>()
  private readonly wiredPartitions = new Set<string>()
  private eventChannelWired = false
  private readonly stats: BridgeHostStats = { boots: 0, cancelledWrites: 0, blockedExternal: 0, cancelledUrls: [] }

  constructor(config: Partial<BridgeConfig> = {}) {
    this.config = { ...BRIDGE_DEFAULT_CONFIG, ...config }
  }

  alive(): boolean {
    return this.healthy && !!this.win && !this.win.isDestroyed()
  }

  /** 保证窗口可用（必要时重建）。并发的 ensure 共用同一次启动 */
  async ensure(): Promise<BridgePage> {
    if (this.alive()) return this
    if (!this.booting) {
      this.booting = this.boot().finally(() => {
        this.booting = null
      })
    }
    await this.booting
    return this
  }

  /**
   * 在页面里跑一段表达式。
   * 🔴 不在这里重试/重建：重建是 `ensure()` 的事，混在一起会让「谁的失败」说不清。
   */
  async eval<T>(expr: string, label = 'expr'): Promise<T> {
    const win = this.win
    if (!win || win.isDestroyed()) {
      this.healthy = false
      throw new Error('桥接窗口不可用（未就绪或已崩溃）')
    }
    try {
      return (await win.webContents.executeJavaScript(expr, true)) as T
    } catch (error) {
      this.lastError = label + '：' + messageOf(error)
      throw error
    }
  }

  /** 订阅页面回推事件（preload → ipcMain → 这里）。返回退订函数 */
  onEvent(listener: (event: BridgePageEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  health(): BridgeHealth {
    return {
      alive: this.alive(),
      busy: this.booting !== null,
      rebuilds: Math.max(0, this.stats.boots - 1),
      cancelledWrites: this.stats.cancelledWrites,
      blockedExternal: this.stats.blockedExternal,
      lastError: this.lastError,
      config: { ...this.config }
    }
  }

  statsSnapshot(): BridgeHostStats {
    return { ...this.stats, cancelledUrls: this.stats.cancelledUrls.slice() }
  }

  resetStats(): void {
    this.stats.cancelledWrites = 0
    this.stats.blockedExternal = 0
    this.stats.cancelledUrls = []
  }

  /** 关窗（回退/退出时用）。不删 profile：分区数据留给下次复用 */
  destroy(): void {
    this.healthy = false
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) {
      try {
        win.destroy()
      } catch {
        // 已经没了就算了
      }
    }
  }

  private async boot(): Promise<void> {
    try {
      await app.whenReady()
    } catch {
      // 已经 ready 的进程里 whenReady 会直接 resolve；这里挡的是异常环境
    }
    this.wireEventChannel()
    const win = this.createWindow()
    this.stats.boots += 1
    this.win = win
    try {
      await this.load(win)
      await this.waitReady(win)
      await this.connect(win)
      this.healthy = true
      this.lastError = null
    } catch (error) {
      this.healthy = false
      this.lastError = messageOf(error)
      this.destroy()
      throw new Error('桥接隐藏窗口启动失败：' + messageOf(error))
    }
  }

  private createWindow(): BrowserWindow {
    const partition = this.config.partition
    const ses = electronSession.fromPartition(partition)
    this.wireInterception(ses, partition)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      backgroundColor: '#000000',
      webPreferences: {
        // 🔴 contextIsolation:false 是 ST 页面的要求（隔离下拿不到 getContext 的可用引用）
        contextIsolation: false,
        nodeIntegration: false,
        // preload 要用 require('electron') 的 ipcRenderer，所以不能开 sandbox
        sandbox: false,
        session: ses,
        // 隐藏窗口没有焦点，默认会被降频：不关掉的话流式增量会成批到达（看起来像「顿一下」）
        backgroundThrottling: false,
        spellcheck: false,
        preload: ensurePreloadFile(join(app.getPath('userData'), 'nc-bridge'))
      }
    })

    win.webContents.setBackgroundThrottling(false)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    // 只许留在 ST 自己的源上：ST 的脚本会尝试跳转到别处（P0 挡过外网）
    win.webContents.on('will-navigate', (event, url) => {
      if (!isSameOrigin(url, this.config.stUrl)) event.preventDefault()
    })

    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      this.lastError = 'did-fail-load ' + code + ' ' + description + ' ' + url
      this.healthy = false
    })

    // 崩溃就是不可用：下一次 ensure() 重建，不在原地重试
    win.webContents.on('render-process-gone', (_event, details) => {
      this.lastError = 'render-process-gone ' + details.reason
      this.healthy = false
      if (this.win === win) this.destroy()
    })

    return win
  }

  private wireInterception(ses: ElectronSession, partition: string): void {
    // 每个分区只挂一次：重复 onBeforeRequest 会互相覆盖，拦截面会悄悄变窄
    if (this.wiredPartitions.has(partition)) return
    this.wiredPartitions.add(partition)
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const url = details.url || ''
      const kind = classifyRequest(url)
      if (!kind) {
        callback({})
        return
      }
      if (kind === 'write') this.stats.cancelledWrites += 1
      else this.stats.blockedExternal += 1
      if (this.stats.cancelledUrls.length < 64 && !this.stats.cancelledUrls.includes(url)) {
        this.stats.cancelledUrls.push(url)
      }
      callback({ cancel: true })
    })
  }

  private wireEventChannel(): void {
    if (this.eventChannelWired) return
    this.eventChannelWired = true
    ipcMain.on(BRIDGE_IPC.event, (_event, message: unknown) => {
      if (!message || typeof message !== 'object') return
      const record = message as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name : ''
      if (!name) return
      const event: BridgePageEvent = {
        name,
        payload: record.payload,
        at: typeof record.at === 'number' ? record.at : Date.now()
      }
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch {
          // 订阅方自己的异常不许打断别的订阅方
        }
      }
    })
  }

  private async load(win: BrowserWindow): Promise<void> {
    try {
      await win.loadURL(this.config.stUrl)
    } catch (error) {
      throw new Error('加载 ' + this.config.stUrl + ' 失败：' + messageOf(error))
    }
  }

  private async waitReady(win: BrowserWindow): Promise<void> {
    const started = Date.now()
    let lastError: string | null = null
    while (Date.now() - started < this.config.readyTimeoutMs) {
      try {
        const ok = (await win.webContents.executeJavaScript(READY_EXPR, true)) as boolean
        if (ok === true) return
      } catch (error) {
        lastError = messageOf(error)
      }
      await sleep(300)
    }
    throw new Error(
      'READY_TIMEOUT ' + this.config.readyTimeoutMs + 'ms' + (lastError ? '（' + lastError + '）' : '')
    )
  }

  private async connect(win: BrowserWindow): Promise<void> {
    const result = (await win.webContents.executeJavaScript(
      connectExpr(this.config.connectTimeoutMs),
      true
    )) as { ok?: boolean; error?: string }
    if (result?.ok === false) {
      throw new Error('Connect 失败：' + (result.error ?? 'online_status 没抬起来'))
    }
  }
}

/** 单例：P6 接线后 `chatService` 直接用它 */
export const bridgeHost = new BridgeHost()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isSameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}
