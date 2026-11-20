/** 可见 ST 页面、独立分区与托管 ST 进程。轮次注入/清场仍由 driver 负责。 */
import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BRIDGE_GENERATE_TIMEOUT_RANGE, BRIDGE_DEFAULT_CONFIG, BRIDGE_IPC } from '@shared/bridge'
import type { BridgeConfig, BridgeHealth } from '@shared/bridge'
import { ensurePreloadFile } from './preload'
import { StProcess, ONBOARDING_ERROR } from './spawn'
import { BridgeLogWindow } from './logWindow'
import { BridgeLogPipe } from './logpipe'
import { findCard, selectCharacter } from './character'
import { ensureOverrideFile } from './override'
import { sweepOrphans, readOrphans } from './chats'

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

export interface BridgeHostStats { boots: number }

export class BridgeHost implements BridgePage {
  readonly config: BridgeConfig
  private win: BrowserWindow | null = null
  private booting: Promise<void> | null = null
  private orphanSweep: Promise<number> = Promise.resolve(0)
  private healthy = false
  private lastError: string | null = null
  private needsOnboarding = false
  private connected = false
  private loadedConfig = false
  private epoch = 0
  private readonly st = new StProcess()
  private readonly logWindow = new BridgeLogWindow()
  private readonly listeners = new Set<(event: BridgePageEvent) => void>()
  private eventChannelWired = false
  private readonly stats: BridgeHostStats = { boots: 0 }

  constructor(config: Partial<BridgeConfig> = {}) {
    this.config = { ...BRIDGE_DEFAULT_CONFIG, ...config }
    this.loadedConfig = Object.keys(config).length > 0
    app.on('before-quit', (event) => {
      try { this.destroy() } catch (error) { event.preventDefault(); this.lastError = 'ST 停止失败：' + messageOf(error) }
    })
    this.orphanSweep = app.whenReady().then(() => sweepOrphans()).catch(error => { this.lastError = '孤儿扫描失败：' + messageOf(error); return 0 })
    app.on('will-quit', () => { try { this.st.stop() } catch { /* before-quit 已保留错误 */ } })
  }
  private configFile(): string { return join(app.getPath('userData'), 'nc-bridge', 'config.json') }
  private configure(input?: Partial<BridgeConfig>): void {
    ensureOverrideFile()
    if (!this.loadedConfig) {
      this.loadedConfig = true
      const file = this.configFile()
      if (existsSync(file)) {
        try { this.applyConfig(JSON.parse(readFileSync(file, 'utf8'))) }
        catch (error) { this.lastError = 'ST 配置读取失败：' + messageOf(error) }
      }
    }
    if (input) {
      this.applyConfig(input)
      const file = this.configFile()
      mkdirSync(join(app.getPath('userData'), 'nc-bridge'), { recursive: true })
      writeFileSync(file + '.tmp', JSON.stringify({ stRoot: this.config.stRoot, port: this.config.port, nodePath: this.config.nodePath, generateTimeoutMs: this.config.generateTimeoutMs, cardPath: this.config.cardPath, cardName: this.config.cardName, cardAvatar: this.config.cardAvatar }, null, 2), 'utf8')
      renameSync(file + '.tmp', file)
    }
    this.config.stUrl = 'http://127.0.0.1:' + this.config.port
    this.config.stDataDir = this.config.stRoot ? join(resolve(this.config.stRoot), 'data-nc', 'default-user') : ''
  }
  private applyConfig(input: Partial<BridgeConfig>): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ST 配置须为对象')
    const next = { stRoot: this.config.stRoot, port: this.config.port, nodePath: this.config.nodePath, generateTimeoutMs: this.config.generateTimeoutMs, cardPath: this.config.cardPath, cardName: this.config.cardName, cardAvatar: this.config.cardAvatar }
    for (const key of ['stRoot', 'nodePath', 'cardPath', 'cardName', 'cardAvatar'] as const) {
      if (input[key] === undefined) continue
      if (typeof input[key] !== 'string' || input[key]!.length > 32768 || input[key]!.includes('\0')) throw new Error(key + ' 须为有效路径字符串')
      next[key] = input[key]!.trim()
    }
    if (input.port !== undefined) {
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('ST 端口须为 1–65535 的整数')
      next.port = input.port
    }
    if (input.generateTimeoutMs !== undefined) {
      const ms = input.generateTimeoutMs
      if (!Number.isInteger(ms) || ms < BRIDGE_GENERATE_TIMEOUT_RANGE.minMs || ms > BRIDGE_GENERATE_TIMEOUT_RANGE.maxMs) {
        throw new Error('单轮上限须为 10–3600 秒的整数')
      }
      next.generateTimeoutMs = ms
    }
    const changed = next.cardName !== this.config.cardName || next.cardAvatar !== this.config.cardAvatar || next.stRoot !== this.config.stRoot || next.port !== this.config.port || next.nodePath !== this.config.nodePath || next.generateTimeoutMs !== this.config.generateTimeoutMs
    if (changed && (this.st.running() || this.booting)) throw new Error('请先停止 ST，再修改目录、桥接角色、端口、Node 路径或单轮上限')
    Object.assign(this.config, next)
  }
  alive(): boolean { return this.healthy && this.st.running() && !!this.win && !this.win.isDestroyed() }
  private launch(): Promise<void> {
    if (!this.booting) this.booting = this.boot().finally(() => { this.booting = null })
    return this.booting
  }
  async ensure(): Promise<BridgePage> {
    await this.orphanSweep
    this.configure()
    if (!this.config.cardName) throw new Error('请填写桥接角色后再打开 ST')
    if (!this.alive()) await this.launch()
    if (!this.connected) {
      const win = this.win
      if (!win || win.isDestroyed()) throw new Error('ST 窗口已关闭')
      await this.connect(win)
      this.connected = true
    }
    return this
  }
  async openSt(config?: Partial<BridgeConfig>): Promise<BridgeHealth> {
    try {
      if (typeof config?.cardName === 'string' && !config.cardName.trim()) throw new Error('请填写桥接角色后再打开 ST')
      this.configure(config)
      if (!this.config.cardName) throw new Error('请填写桥接角色后再打开 ST')
      await this.orphanSweep
      this.orphanSweep = sweepOrphans()
      await this.orphanSweep
      if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus() }
      if (!this.alive()) await this.launch()
      else await this.ensureCard()
      return this.health()
    } catch (error) { this.lastError = messageOf(error); throw error }
  }
  async stopSt(): Promise<BridgeHealth> {
    this.destroy()
    // 取消尚在体检/就绪阶段的启动，等待其退出后再向 UI 报告停止完成。
    await this.booting?.catch(() => {})
    return this.health()
  }
  async openLog(): Promise<void> {
    this.configure()
    if (!this.st.log) {
      const path = this.config.logPath || (this.config.stRoot ? join(this.config.stRoot, 'data-nc', 'logs', 'st-bridge.log') : join(app.getPath('userData'), 'nc-bridge', 'st-bridge.log'))
      this.st.log = new BridgeLogPipe(path)
      if (this.lastError) this.st.log.write('host', this.lastError)
    }
    await this.logWindow.open(this.st.log, join(app.getPath('userData'), 'nc-bridge'), this.win ?? undefined)
  }
  async eval<T>(expr: string, label = 'expr'): Promise<T> {
    const win = this.win
    if (!win || win.isDestroyed()) { this.healthy = false; throw new Error('桥接窗口不可用（未就绪或已崩溃）') }
    try {
      // Electron otherwise replaces page rejections with an unhelpful generic error.
      const result = await win.webContents.executeJavaScript(
        '(async () => { try { return { ok: true, value: await (' + expr + ') }; } catch (error) { return { ok: false, error: error && error.message ? String(error.message) : String(error) }; } })()', true
      ) as { ok: boolean; value?: T; error?: string }
      if (!result.ok) throw new Error(result.error || 'ST 页面执行失败')
      return result.value as T
    } catch (error) { this.lastError = label + '：' + messageOf(error); throw error }
  }
  onEvent(listener: (event: BridgePageEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  health(): BridgeHealth {
    this.configure()
    let orphanCount = 0
    try { orphanCount = readOrphans().items.length } catch (error) { this.lastError = '孤儿清单读取失败：' + messageOf(error) }
    return {
      alive: this.alive(), busy: this.booting !== null,
      rebuilds: Math.max(0, this.stats.boots - 1),
      stRunning: this.st.running(), stPid: this.st.pid, port: this.config.port,
      logBytes: this.st.log?.logBytes ?? 0, orphans: orphanCount,
      nodeSource: this.st.info?.runtime.source ?? null, needsOnboarding: this.needsOnboarding,
      cardAvatar: this.config.cardAvatar, cardName: this.config.cardName,
      cancelledWrites: 0, blockedExternal: 0,
      lastError: this.st.lastError ?? this.lastError,
      config: { ...this.config, logPath: this.st.log?.path ?? this.config.logPath }
    }
  }
  statsSnapshot(): BridgeHostStats { return { ...this.stats } }
  resetStats(): void { /* 保留旧探针方法，P2 不再维护拦截计数 */ }
  private closePage(): void {
    this.healthy = false
    this.connected = false
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }
  destroy(): void {
    this.epoch++
    this.closePage()
    this.logWindow.close()
    this.st.stop()
    this.needsOnboarding = false
  }
  private async boot(): Promise<void> {
    const epoch = this.epoch
    await app.whenReady()
    if (epoch !== this.epoch) throw new Error('ST 启动已取消')
    this.wireEventChannel()
    try {
      const oldLog = this.st.log
      await this.st.start(this.config)
      if (oldLog !== this.st.log) { this.logWindow.close(); this.closePage() }
      if (epoch !== this.epoch) throw new Error('ST 启动已取消')
      if (!this.win || this.win.isDestroyed()) {
        const win = this.createWindow()
        this.stats.boots++
        this.win = win
        await win.loadURL(this.config.stUrl)
      }
      const win = this.win
      win.show()
      await this.waitReady(win, epoch)
      await this.ensureCard()
      if (epoch !== this.epoch || !this.st.running()) throw new Error('ST 启动已取消或进程已退出')
      this.healthy = true
      this.needsOnboarding = false
      this.lastError = null
    } catch (error) {
      this.healthy = false
      this.lastError = messageOf(error)
      try {
        this.st.log ??= new BridgeLogPipe(join(app.getPath('userData'), 'nc-bridge', 'st-bridge.log'))
        this.st.log.write('host', this.lastError)
      } catch { /* 日志故障保留原错误 */ }
      // 向导超时保留窗口与进程；用户完成初始化后仍在同一个页面重试。
      throw new Error('ST 启动失败：' + this.lastError)
    }
  }
  private async ensureCard(): Promise<void> {
    const card = await findCard(this, this.config.cardName, this.config.cardAvatar)
    await selectCharacter(this, card, this.config.readyTimeoutMs)
    this.config.cardAvatar = card.avatar
    // 选择已回读确认，持久化其身份；这里不经过运行中配置修改闸。
    const file = this.configFile()
    mkdirSync(join(app.getPath('userData'), 'nc-bridge'), { recursive: true })
    writeFileSync(file + '.tmp', JSON.stringify({ stRoot: this.config.stRoot, port: this.config.port, nodePath: this.config.nodePath, generateTimeoutMs: this.config.generateTimeoutMs, cardPath: this.config.cardPath, cardName: this.config.cardName, cardAvatar: card.avatar }, null, 2), 'utf8')
    renameSync(file + '.tmp', file)
  }
  private createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      show: true, width: 1280, height: 900,
      webPreferences: {
        contextIsolation: false, nodeIntegration: false, sandbox: false,
        session: electronSession.fromPartition(this.config.partition),
        backgroundThrottling: false, spellcheck: false,
        preload: ensurePreloadFile(join(app.getPath('userData'), 'nc-bridge'))
      }
    })
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      this.lastError = 'did-fail-load ' + code + ' ' + description + ' ' + url
      this.healthy = false
      this.connected = false
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.lastError = 'render-process-gone ' + details.reason
      if (this.win === win) this.closePage()
    })
    win.on('closed', () => { if (this.win === win) { this.win = null; this.healthy = false; this.connected = false } })
    return win
  }
  private wireEventChannel(): void {
    if (this.eventChannelWired) return
    this.eventChannelWired = true
    ipcMain.on(BRIDGE_IPC.event, (source, message: unknown) => {
      if (!this.win || source.sender !== this.win.webContents || !message || typeof message !== 'object') return
      const record = message as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name : ''
      if (!name) return
      const event: BridgePageEvent = { name, payload: record.payload, at: typeof record.at === 'number' ? record.at : Date.now() }
      for (const listener of this.listeners) { try { listener(event) } catch { /* 独立消费者 */ } }
    })
  }
  private async waitReady(win: BrowserWindow, epoch: number): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < this.config.readyTimeoutMs) {
      if (epoch !== this.epoch || win.isDestroyed() || !this.st.running()) throw new Error('ST 窗口或进程已停止')
      try { if (await win.webContents.executeJavaScript(READY_EXPR, true) === true) return } catch { /* 页面初始化中 */ }
      await sleep(300)
    }
    this.needsOnboarding = true
    throw new Error(ONBOARDING_ERROR + '；若已完成向导，请确认角色列表已加载')
  }
  private async connect(win: BrowserWindow): Promise<void> {
    const result = await win.webContents.executeJavaScript(connectExpr(this.config.connectTimeoutMs), true) as { ok?: boolean; error?: string }
    if (result?.ok === false) throw new Error('Connect 失败：' + (result.error ?? 'online_status 没抬起来'))
  }
}

export const bridgeHost = new BridgeHost()
function sleep(ms: number): Promise<void> { return new Promise(resolveWait => setTimeout(resolveWait, ms)) }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }