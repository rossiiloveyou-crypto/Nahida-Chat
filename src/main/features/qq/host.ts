import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import {
  QQ_HOST_MESSAGE,
  QQ_HOST_RPC,
  type QqActionResult,
  type QqHostEventMessage,
  type QqHostState,
  type QqHostStatus,
  type QqHostToMain,
  type QqHostRpcMethod,
  type QqProcessSnapshot
} from '@shared/qqHost'

/** ready 握手硬上限。冷启动 5–15 s 是常态，30 s 只是最后通牒（PHASE-2 §六）。 */
const READY_TIMEOUT_MS = 30_000
/** 单条 RPC 的默认超时。listProcesses 要枚举进程 + 读账号库，20 s 够宽。 */
const RPC_TIMEOUT_MS = 20_000
/** 退出时等待宿主体面关闭的上限；超时强杀，不留孤儿 node.exe。 */
const SHUTDOWN_TIMEOUT_MS = 5_000
/** 连续启动失败上限；到了就转 degraded，不再无限重启（否则刷屏且掩盖真错）。 */
const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** 日志环形缓冲；P3 的日志面板直接消费，不需要再回读文件。 */
const LOG_BUFFER_MAX = 300

export interface QqHostLogLine {
  level: string
  scope: string
  time: string
  line: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.message ?? String(error)) : String(error)
}

/**
 * 产物目录解析。
 *
 * 开发态 `__dirname` = `<repo>/out/main`，产物在 `<repo>/out/snowluma-host`。
 * `NC_SL_HOST_DIR` 可覆盖（测试与将来的打包部署都靠它，不去猜 asar 布局）。
 */
export function resolveHostDir(): string {
  const override = process.env['NC_SL_HOST_DIR']
  if (override && override.trim()) return resolve(override.trim())
  return resolve(__dirname, '..', 'snowluma-host')
}

/**
 * QQ 协议运行时宿主（snowluma-host）的进程桥。
 *
 * 只做四件事：起进程、握手、RPC 转发、崩溃重启。**不含任何 QQ 业务逻辑** ——
 * 入站消息、出站切段都是 P3/P4 的事。也**绝不自动注入**（总蓝图 M2 / D2）：
 * `loadProcess` 只有被显式调用才会触发。
 */
export class QqHost extends EventEmitter {
  private child: ChildProcess | null = null
  private state: QqHostState = 'stopped'
  private readyMs: number | null = null
  private failures = 0
  private lastError: string | null = null
  private nodeVersion: string | null = null
  private napiVersion: string | null = null
  private home: string | null = null
  private spawnedAt = 0
  /** 最近一次子进程退出（code/signal）；测试与排障用来断言"是不是干净退出"。 */
  private lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private becameReady = false
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly logs: QqHostLogLine[] = []

  get hostDir(): string {
    return resolveHostDir()
  }

  get dataHome(): string {
    return join(app.getPath('userData'), 'snowluma')
  }

  /** 最近 N 条宿主日志（P3 接面板时直接读这个）。 */
  recentLogs(limit = 100): QqHostLogLine[] {
    return this.logs.slice(-Math.max(1, limit))
  }

  /** 最近一次子进程退出码（优雅关闭应为 0）。 */
  get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.lastExit
  }

  status(): QqHostStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      readyMs: this.readyMs,
      failures: this.failures,
      lastError: this.lastError,
      home: this.home,
      hostDir: this.hostDir,
      node: this.nodeVersion,
      napi: this.napiVersion
    }
  }

  /* ── 生命周期 ────────────────────────────────────────────────────────── */

  start(): void {
    if (this.child || this.stopping) return
    this.spawnHost()
  }

  /** 优雅关闭：先 send shutdown，等 5 s，超时强杀。可重复调用。 */
  async stop(): Promise<void> {
    this.stopping = true
    this.clearRestartTimer()

    const child = this.child
    if (!child) {
      this.setState('stopped')
      return
    }

    this.setState('stopping')

    // 先礼貌地请它自己收尾（dispose → flush 日志 → process.exit(0)）
    try {
      if (child.connected) child.send({ kind: 'shutdown' })
    } catch (error) {
      console.warn('[qq-host] shutdown send failed:', errorMessage(error))
    }

    await this.waitForExit(child, SHUTDOWN_TIMEOUT_MS)
    if (this.child === child) {
      // 没在时限内退出：强杀，避免留孤儿 node.exe
      try {
        child.kill('SIGKILL')
      } catch (error) {
        console.warn('[qq-host] kill failed:', errorMessage(error))
      }
      this.child = null
    }
    this.setState('stopped')
  }

  /**
   * 手动重启（面板 degraded 时的自救按钮）。
   * 与 stop() 的区别：stop 之后 stopping 会一直为真（进程要退出了），restart 必须把它放回去。
   */
  async restart(): Promise<void> {
    this.clearRestartTimer()
    const child = this.child
    this.stopping = true
    if (child) {
      try {
        if (child.connected) child.send({ kind: 'shutdown' })
      } catch (error) {
        console.warn('[qq-host] restart shutdown send failed:', errorMessage(error))
      }
      await this.waitForExit(child, SHUTDOWN_TIMEOUT_MS)
      if (this.child === child) {
        try {
          child.kill('SIGKILL')
        } catch (error) {
          console.warn('[qq-host] restart kill failed:', errorMessage(error))
        }
        this.child = null
      }
    }
    this.failures = 0
    this.lastError = null
    this.readyMs = null
    this.stopping = false
    this.setState('stopped')
    this.spawnHost()
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit()
        return
      }

      const timer = setTimeout(() => {
        child.removeListener('exit', onExit)
        resolveExit()
      }, timeoutMs)

      const onExit = (): void => {
        clearTimeout(timer)
        resolveExit()
      }
      child.once('exit', onExit)
    })
  }

  private setState(next: QqHostState): void {
    if (this.state === next) return
    this.state = next
    this.emit('state', this.status())
  }

  private spawnHost(): void {
    const hostDir = this.hostDir
    const nodePath = join(hostDir, 'node.exe')
    const entryPath = join(hostDir, 'index.mjs')

    if (!existsSync(nodePath) || !existsSync(entryPath)) {
      this.fail(
        'snowluma-host 产物缺失：需要 ' +
          nodePath +
          ' 与 ' +
          entryPath +
          '（先跑 pnpm build:snowluma-host）'
      )
      this.setState('degraded')
      return
    }

    this.home = this.dataHome
    this.spawnedAt = Date.now()
    this.becameReady = false
    this.setState(this.failures > 0 ? 'restarting' : 'starting')

    const child = spawn(nodePath, [entryPath], {
      cwd: hostDir, // SL 的 config/ logs/ data/ 全按 cwd 相对路径创建
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], // 'ipc' 必须有
      env: {
        ...process.env,
        // 🔴 J-09：不设则 __PACKAGED__ 分支走 runApplication() 自重启，ready 在孙进程上，永远收不到
        SNOWLUMA_UPDATE_ROOT: hostDir,
        NC_SL_HOME: this.home,
        // 双保险（M2）：即便有人把 runtime.json 改回 true，宿主仍不自动注入
        SNOWLUMA_HOOK_AUTOLOAD: '0',
        // 诊断开关：默认 info。设成 debug 才能看到 MsgPush 的
        // 「no decoder for PkgType=X subType=Y」——那是消息没进管线的唯一现场。
        ...(process.env.NC_SL_LOG_LEVEL ? { SNOWLUMA_LOG_LEVEL: process.env.NC_SL_LOG_LEVEL } : {})
      },
      windowsHide: true
    })

    this.child = child

    child.on('message', (message: unknown) => this.onMessage(message))
    child.on('error', (error) => {
      this.lastError = errorMessage(error)
      this.pushLog({ level: 'error', scope: 'qq-host', time: new Date().toISOString(), line: this.lastError })
    })
    child.on('exit', (code, signal) => this.onExit(child, code, signal))

    this.attachStream(child.stdout, 'stdout')
    this.attachStream(child.stderr, 'stderr')

    this.readyTimer = setTimeout(() => {
      this.lastError = 'ready handshake timed out after ' + String(READY_TIMEOUT_MS) + 'ms'
      this.pushLog({
        level: 'error',
        scope: 'qq-host',
        time: new Date().toISOString(),
        line: this.lastError
      })
      try {
        child.kill('SIGKILL')
      } catch (error) {
        console.warn('[qq-host] kill after ready timeout failed:', errorMessage(error))
      }
    }, READY_TIMEOUT_MS)
  }

  /** 子进程 stdout/stderr 原样采集。P1 观测到 SL 异常会被 installProcessGuards 吞，stderr 是唯一线索。 */
  private attachStream(stream: NodeJS.ReadableStream | null, channel: 'stdout' | 'stderr'): void {
    if (!stream) return
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        this.pushLog({
          level: channel === 'stderr' ? 'error' : 'info',
          scope: 'host.' + channel,
          time: new Date().toISOString(),
          line
        })
      }
    })
  }

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const envelope = message as QqHostToMain

    switch (envelope.kind) {
      case QQ_HOST_MESSAGE.ready: {
        if (this.readyTimer) {
          clearTimeout(this.readyTimer)
          this.readyTimer = null
        }
        this.becameReady = true
        this.failures = 0
        this.readyMs = Date.now() - this.spawnedAt
        this.nodeVersion = envelope.node
        this.napiVersion = envelope.napi
        this.home = envelope.home
        this.setState('ready')
        break
      }
      case QQ_HOST_MESSAGE.log: {
        this.pushLog({
          level: envelope.level,
          scope: envelope.scope,
          time: envelope.time,
          line: envelope.line
        })
        break
      }
      case QQ_HOST_MESSAGE.response: {
        const pending = this.pending.get(envelope.id)
        if (!pending) return // 超时后迟到的回包：丢掉，不要当成新请求
        this.pending.delete(envelope.id)
        clearTimeout(pending.timer)
        if (envelope.ok) {
          pending.resolve(envelope.result)
        } else {
          // 错误原文逐字透传（总蓝图 D3：UI 上要看到 SL 自己那句话）
          pending.reject(new Error(envelope.error ?? 'unknown host error'))
        }
        break
      }
      case QQ_HOST_MESSAGE.event: {
        // 🔴 最容易漏的一行：现有分派对不认识的 kind 静默 return，
        // 漏掉这个分支 → 宿主日志正常、RPC 正常、注入正常，就是一条消息都收不到。
        this.emit('event', envelope as QqHostEventMessage)
        break
      }
      case QQ_HOST_MESSAGE.fatal: {
        this.lastError = envelope.message
        this.pushLog({
          level: 'error',
          scope: 'qq-host',
          time: new Date().toISOString(),
          line: envelope.message
        })
        break
      }
      default:
        break
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }

    // 所有在途 RPC 立即失败，免得 UI 一直转圈
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('snowluma-host exited (code=' + String(code) + ')'))
      this.pending.delete(id)
    }

    if (this.child === child) this.child = null

    // 先记账再分支：优雅关闭也必须能读到退出码（否则「退出码 0」这条判据永远拿不到值，
    // 本 Phase 自踩：早退分支在记账之前，导致测试读到的是上一次 taskkill 的 1）
    this.lastExit = { code, signal }
    this.emit('exit', { pid: child.pid, code, signal })
    const summary = 'snowluma-host exited (code=' + String(code) + ', signal=' + String(signal) + ')'
    this.pushLog({
      level: this.stopping ? 'info' : 'warn',
      scope: 'qq-host',
      time: new Date().toISOString(),
      line: summary
    })

    if (this.stopping) {
      this.setState('stopped')
      return
    }

    if (!this.becameReady) {
      this.failures += 1
    }

    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.lastError =
        'snowluma-host 连续 ' + String(this.failures) + ' 次启动失败，已停止自动重启：' + summary
      this.setState('degraded')
      return
    }

    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    this.setState('restarting')
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.failures), BACKOFF_MAX_MS)
    this.pushLog({
      level: 'warn',
      scope: 'qq-host',
      time: new Date().toISOString(),
      line: 'restarting in ' + String(delay) + 'ms (failures=' + String(this.failures) + ')'
    })
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping) this.spawnHost()
    }, delay)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private fail(message: string): void {
    this.lastError = message
    this.pushLog({ level: 'error', scope: 'qq-host', time: new Date().toISOString(), line: message })
  }

  private pushLog(entry: QqHostLogLine): void {
    this.logs.push(entry)
    if (this.logs.length > LOG_BUFFER_MAX) this.logs.splice(0, this.logs.length - LOG_BUFFER_MAX)
    this.emit('log', entry)
  }

  /* ── RPC ─────────────────────────────────────────────────────────────── */

  private request<T>(method: QqHostRpcMethod, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    const child = this.child
    if (!child || !child.connected || this.state !== 'ready') {
      return Promise.reject(new Error('snowluma-host is not ready (state=' + this.state + ')'))
    }

    const id = this.nextRequestId++
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error('RPC ' + method + ' timed out after ' + String(timeoutMs) + 'ms'))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer
      })

      try {
        child.send({ kind: 'request', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectRequest(error instanceof Error ? error : new Error(errorMessage(error)))
      }
    })
  }

  /** 列出本机 QQ 主进程。**只读，绝不注入**（D2）。 */
  listProcesses(): Promise<QqProcessSnapshot[]> {
    return this.request<QqProcessSnapshot[]>(QQ_HOST_RPC.listProcesses)
  }

  /** 注入指定 PID。只有用户点选才会走到这里（M2）。 */
  loadProcess(pid: number): Promise<QqProcessSnapshot> {
    return this.request<QqProcessSnapshot>(QQ_HOST_RPC.loadProcess, { pid })
  }

  unloadProcess(pid: number): Promise<QqProcessSnapshot> {
    return this.request<QqProcessSnapshot>(QQ_HOST_RPC.unloadProcess, { pid })
  }

  refreshProcess(pid: number): Promise<QqProcessSnapshot> {
    return this.request<QqProcessSnapshot>(QQ_HOST_RPC.refreshProcess, { pid })
  }

  /**
   * 发一个 OneBot 动作。
   *
   * 超时 30 s：send_* 要等 QQ 回执，比普通查询慢（普通查询 20 s）。
   * 结果已经由宿主投影成 QqActionResult，**不会**把 ApiResponse 原样透传过来。
   */
  invokeAction(
    uin: string,
    action: string,
    params?: Record<string, unknown>
  ): Promise<QqActionResult> {
    return this.request<QqActionResult>(
      QQ_HOST_RPC.invokeAction,
      { uin, action, params },
      30_000
    )
  }

  hostStatus(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(QQ_HOST_RPC.status)
  }
}

/** 单例：main 进程只允许一个宿主。 */
export const qqHost = new QqHost()

/** 在 `app.whenReady()` 之后调用。**不要**在 whenReady 之前起（那时 userData 还没就绪）。 */
export function startQqHost(): void {
  qqHost.start()
  app.on('before-quit', () => {
    void qqHost.stop()
  })
}
