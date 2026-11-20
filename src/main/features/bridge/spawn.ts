import { accessSync, constants, mkdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFile, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { BridgeConfig } from '@shared/bridge'
import { BridgeLogPipe } from './logpipe'

export interface NodeRuntime { command: string; source: 'configured' | 'path' | 'electron'; version: string; env: NodeJS.ProcessEnv }
export interface StPreflight { root: string; dataRoot: string; url: string; logPath: string; runtime: NodeRuntime; checks: string[] }
export const ONBOARDING_ERROR = 'ST 首次启动，请在弹出的窗口里完成初始化向导后点「重试」'

function probe(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    try { execFile(command, ['--version'], { env, windowsHide: true, timeout: 5000, maxBuffer: 8192 }, (error, stdout) => {
      const version = stdout.trim()
      if (error || !/^v\d+\.\d+\.\d+$/.test(version)) reject(new Error('Node 运行时不可用：' + command + (error ? '（' + error.message + '）' : '')))
      else resolveVersion(version)
    }) } catch (error) { reject(new Error('Node 运行时不可用：' + command + '（' + (error as Error).message + '）')) }
  })
}
export async function resolveNode(nodePath = '', electronPath = process.execPath): Promise<NodeRuntime> {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (nodePath.trim()) return { command: nodePath.trim(), source: 'configured', version: await probe(nodePath.trim(), env), env }
  try { return { command: 'node', source: 'path', version: await probe('node', env), env } } catch { /* Electron fallback */ }
  const fallbackEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
  return { command: electronPath, source: 'electron', version: await probe(electronPath, fallbackEnv), env: fallbackEnv }
}
export function portError(port: number): string {
  return 'Address 127.0.0.1:' + port + ' is already in use. Another SillyTavern instance may already be running. Stop the other process or change "port" in config.yaml.'
}
export async function assertPortAvailable(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ST 端口须为 1–65535 的整数')
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => reject(new Error(error.code === 'EADDRINUSE' ? portError(port) : error.message)))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolvePort()))
  })
}
export async function preflight(config: BridgeConfig): Promise<StPreflight> {
  if (!config.stRoot.trim()) throw new Error('请先选择完整的 SillyTavern 源码目录（包含 server.js、node_modules、config.yaml）')
  const root = resolve(config.stRoot)
  const checks: string[] = []
  const file = (name: string, directory: boolean): void => {
    try {
      const target = join(root, name)
      if (directory ? !statSync(target).isDirectory() : !statSync(target).isFile()) throw new Error('类型错误')
      accessSync(target, constants.R_OK)
    } catch { throw new Error('ST 体检失败：' + name + (directory ? ' 目录不存在或不可读' : ' 文件不存在或不可读')) }
    checks.push(name)
  }
  file('server.js', false)
  file('node_modules', true)
  file('config.yaml', false)
  try {
    // 使用 ST 自己依赖的真实 YAML 解析器，支持 flow mapping、引号、锚点及合并键。
    const yaml = createRequire(join(root, 'package.json'))('yaml') as { parse: (text: string, options: object) => Record<string, unknown> | null }
    const parsed = yaml.parse(readFileSync(join(root, 'config.yaml'), 'utf8'), { merge: true })
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.yaml 须为对象')
    if (parsed.global === true) throw new Error('global: true 会忽略 --dataRoot；请先在 ST config.yaml 关闭 global 模式')
  } catch (error) { throw new Error('ST 配置体检失败：' + (error as Error).message) }
  checks.push('global !== true')
  await assertPortAvailable(config.port)
  checks.push('port')
  const runtime = await resolveNode(config.nodePath)
  checks.push('node ' + runtime.version)
  const dataRoot = join(root, 'data-nc')
  return { root, dataRoot, url: 'http://127.0.0.1:' + config.port, logPath: config.logPath || join(dataRoot, 'logs', 'st-bridge.log'), runtime, checks }
}
export function taskkillArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('ST PID 无效')
  return ['/PID', String(pid), '/T', '/F']
}
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') execFileSync('taskkill', taskkillArgs(pid), { windowsHide: true, stdio: 'pipe', timeout: 10000 })
  else process.kill(-pid, 'SIGKILL')
}

/** 仅管理自己 spawn 的进程；既不接管端口上已有的实例，也不修改 ST 配置。 */
export class StProcess {
  child: ChildProcess | null = null
  log: BridgeLogPipe | null = null
  info: StPreflight | null = null
  lastError: string | null = null
  private starting: Promise<void> | null = null
  private stopping = false
  private epoch = 0
  running(): boolean { return !!this.child?.pid && this.child.exitCode === null && this.child.signalCode === null }
  get pid(): number | null { return this.running() ? this.child!.pid! : null }
  async start(config: BridgeConfig): Promise<void> {
    if (this.starting) return this.starting
    if (this.running()) return
    const epoch = this.epoch
    this.starting = this.boot(config, epoch).finally(() => { this.starting = null })
    return this.starting
  }
  private async boot(config: BridgeConfig, epoch: number): Promise<void> {
    try {
      const info = await preflight(config)
      if (epoch !== this.epoch) throw new Error('ST 启动已取消')
      this.info = info
      mkdirSync(info.dataRoot, { recursive: true })
      this.log?.close()
      const log = this.log = new BridgeLogPipe(info.logPath)
      this.lastError = null
      log.write('host', 'ST 体检通过：' + info.checks.join(' / ') + '；nodeSource=' + info.runtime.source)
      const child = spawn(info.runtime.command, [join(info.root, 'server.js'), '--port', String(config.port), '--dataRoot', info.dataRoot, '--global', 'false', '--listen', 'false', '--enableIPv4', 'true', '--enableIPv6', 'false', '--browserLaunchEnabled', 'false', '--browserLaunchHostname', '127.0.0.1', '--browserLaunchPort', String(config.port)], {
        cwd: info.root, env: info.runtime.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'
      })
      this.child = child
      const logError = (error: Error): void => { this.lastError = 'ST 日志写入失败：' + error.message; try { this.stop() } catch { /* 保留错误并由退出钩子重试 */ } }
      if (child.stdout) log.attach(child.stdout, 'stdout', logError)
      if (child.stderr) log.attach(child.stderr, 'stderr', logError)
      child.once('error', error => { this.lastError = 'ST 启动失败：' + error.message })
      child.once('exit', (code, signal) => {
        if (!this.stopping && this.child === child) this.lastError ||= 'ST 进程已退出（' + (signal ?? code) + '）'
      })
      child.once('close', () => { log.close(); if (this.child === child) this.child = null })
      const deadline = Date.now() + Math.max(60000, config.readyTimeoutMs)
      while (Date.now() < deadline) {
        if (epoch !== this.epoch) throw new Error('ST 启动已取消')
        if (this.lastError) throw new Error(this.lastError)
        if (!this.running()) throw new Error('ST 进程已退出；请打开日志查看原因')
        const banner = log.snapshot().some(line => line.text.includes('Go to: ' + info.url))
        if (banner) {
          try { const response = await fetch(info.url, { signal: AbortSignal.timeout(1000), redirect: 'manual' }); await response.body?.cancel(); if (response.status === 200) return } catch { /* 等待 HTTP */ }
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      }
      throw new Error('ST 服务启动超时：未同时收到 Go to: 日志与 HTTP 200，请打开日志检查配置')
    } catch (error) {
      this.lastError = (error as Error).message
      try { this.log?.write('host', this.lastError) } catch { /* 原始错误优先 */ }
      try { this.stop() } catch (stopError) { this.lastError += '；停止失败：' + (stopError as Error).message }
      throw new Error(this.lastError)
    }
  }
  stop(): void {
    this.epoch++
    const child = this.child
    if (!child) return
    this.stopping = true
    try {
      if (child.pid) {
        try { killProcessTree(child.pid) } catch (error) {
          try { process.kill(child.pid, 0) } catch { this.child = null; return }
          throw error
        }
      }
      if (this.child === child) this.child = null
    } finally { this.stopping = false }
  }
}
