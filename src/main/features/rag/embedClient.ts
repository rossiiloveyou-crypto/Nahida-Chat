import { join } from 'node:path'
import { MEMORY_MODEL_DIMENSIONS } from '@shared/constants'
import type { WorkerRequest } from './embedWorker'

export interface EmbedResult {
  ok: boolean
  vectors?: Float32Array[]
  error?: string
  /** The facade may execute this request inline only when this is true. */
  fallback?: boolean
}

interface WorkerReply extends EmbedResult {
  id: number
  ready: boolean
  dimensions: number
  lastError: string | null
}

type WorkerMessage = WorkerRequest

/** Structural subset of Electron.UtilityProcess; also usable by test doubles. */
export interface EmbedWorker {
  postMessage(message: WorkerMessage): void
  kill(): boolean | void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type EmbedFork = (
  modulePath: string,
  args: string[],
  options: { serviceName: string }
) => EmbedWorker

export interface EmbedClientOptions {
  fork?: EmbedFork
  initTimeoutMs?: number
  requestTimeoutMs?: number
  now?: () => number
}

interface Pending {
  generation: number
  timer: ReturnType<typeof setTimeout>
  resolve: (result: EmbedResult) => void
}

function discoverFork(): EmbedFork | null {
  try {
    // require is deliberate: node-only tests may expose no utilityProcess at all.
    const electron = require('electron') as { utilityProcess?: { fork?: EmbedFork } }
    const utility = electron.utilityProcess
    return typeof utility?.fork === 'function'
      ? (path, args, options) => utility.fork!(path, args, options)
      : null
  } catch {
    return null
  }
}

function isReply(value: unknown): value is WorkerReply {
  if (typeof value !== 'object' || value === null) return false
  const reply = value as Record<string, unknown>
  return Number.isSafeInteger(reply.id) && typeof reply.ok === 'boolean' &&
    typeof reply.ready === 'boolean' && typeof reply.dimensions === 'number' &&
    Number.isFinite(reply.dimensions) && reply.dimensions > 0 &&
    (reply.lastError === null || typeof reply.lastError === 'string') &&
    (reply.error === undefined || typeof reply.error === 'string') &&
    (reply.vectors === undefined || (Array.isArray(reply.vectors) &&
      reply.vectors.every((vector: unknown) => vector instanceof Float32Array)))
}

/** Owns transport only; model loading and inference live exclusively in the worker. */
export class EmbedClient {
  private readonly fork: EmbedFork | null
  private readonly initTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly now: () => number
  private child: EmbedWorker | null = null
  private generation = 0
  private nextId = 1
  private modelRoot: string | null = null
  private starting: { generation: number; promise: Promise<EmbedResult> } | null = null
  private readonly pending = new Map<number, Pending>()
  private ready = false
  private dimensions = MEMORY_MODEL_DIMENSIONS
  private lastError: string | null = null
  private fallbackReason: string | null = null
  private disposed = false
  private initialized = false
  private transportFailures = 0
  private restartNeeded = false
  private lastRestartAt: number | null = null

  constructor(options: EmbedClientOptions = {}) {
    this.fork = options.fork ?? discoverFork()
    this.initTimeoutMs = options.initTimeoutMs ?? 5_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  isDisposed(): boolean {
    return this.disposed
  }

  available(): boolean {
    return !this.disposed && this.fork !== null && this.fallbackReason === null &&
      process.env.NC_EMBED_BACKEND !== 'inline'
  }

  status(): { ready: boolean; dimensions: number; lastError: string | null } {
    return { ready: this.ready, dimensions: this.dimensions,
      lastError: this.fallbackReason ?? this.lastError }
  }

  async request(type: 'ensure' | 'embed', modelRoot: string, texts?: string[]): Promise<EmbedResult> {
    if (this.disposed) return { ok: false, error: 'Embedding client disposed' }
    if (!this.available()) return this.unavailable()
    if (type === 'embed' && (!texts || texts.length > 64)) {
      return { ok: false, error: 'Embedding batch must contain at most 64 texts' }
    }
    if (this.modelRoot !== null && this.modelRoot !== modelRoot) this.reset(modelRoot)
    this.modelRoot = modelRoot
    const generation = this.generation
    const started = await this.start(modelRoot)
    // A reset/dispose during init cancels its callers, even if init already resolved.
    if (this.disposed) return { ok: false, error: 'Embedding client disposed' }
    if (generation !== this.generation) {
      // Transport failure already provides its own fallback policy in started.
      return started.ok ? { ok: false, error: 'Embedding worker replaced' } : started
    }
    if (!started.ok) return started
    if (!this.available()) return this.unavailable()
    return this.send(type === 'embed'
      ? { id: this.nextId++, type, texts: texts! }
      : { id: this.nextId++, type }, this.requestTimeoutMs, false)
  }

  /** Invalidate the old generation before killing it; late ready replies are ignored. */
  reset(modelRoot: string): void {
    if (this.disposed) return
    this.modelRoot = modelRoot
    this.retire({ ok: false, error: 'Embedding worker reset' })
    this.dimensions = MEMORY_MODEL_DIMENSIONS
    if (this.fallbackReason === null && this.transportFailures === 0) this.lastError = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.retire({ ok: false, error: 'Embedding client disposed' })
  }

  private unavailable(): EmbedResult {
    const error = this.fallbackReason ?? (process.env.NC_EMBED_BACKEND === 'inline'
      ? 'NC_EMBED_BACKEND=inline' : 'Electron utilityProcess.fork unavailable')
    this.lastError = error
    return { ok: false, error, fallback: true }
  }

  private start(modelRoot: string): Promise<EmbedResult> {
    if (this.starting) return this.starting.promise
    if (this.child) return Promise.resolve({ ok: true })
    const generation = this.generation
    // Defer launch until the shared promise is installed, including synchronous mocks.
    const promise = Promise.resolve().then(async (): Promise<EmbedResult> => {
      if (this.disposed || generation !== this.generation) {
        return { ok: false, error: 'Embedding worker start cancelled' }
      }
      if (this.restartNeeded) {
        const now = this.now()
        if (this.lastRestartAt !== null && now - this.lastRestartAt < 600_000) {
          return this.failTransport('Embedding restart limit reached', true)
        }
        this.lastRestartAt = now
        this.restartNeeded = false
      }
      try {
        if (!this.fork) return this.unavailable()
        const child = this.fork(join(__dirname, 'embed-worker.js'), [], { serviceName: 'nahida-embedding' })
        this.child = child
        child.on('message', (message) => this.receive(message, generation))
        child.on('exit', (code) => {
          if (generation === this.generation && this.child === child) {
            this.failTransport('Embedding worker exited: ' + code, !this.initialized)
          }
        })
        child.on('error', (error) => {
          if (generation === this.generation && this.child === child) {
            this.failTransport('Embedding worker error: ' + error.message, !this.initialized)
          }
        })
        const result = await this.send({ id: this.nextId++, type: 'init', modelRoot }, this.initTimeoutMs, true)
        if (generation !== this.generation || this.disposed) return result
        if (!result.ok) return this.failTransport(result.error ?? 'Embedding init failed', true)
        this.initialized = true
        return result
      } catch (error) {
        if (generation !== this.generation || this.disposed) {
          return { ok: false, error: 'Embedding worker start cancelled' }
        }
        return this.failTransport('Embedding fork failed: ' +
          (error instanceof Error ? error.message : String(error)), true)
      }
    })
    this.starting = { generation, promise }
    // Both branches consume settlement; no detached rejecting finally promise.
    void promise.then(() => {
      if (this.starting?.promise === promise) this.starting = null
    }, () => {
      if (this.starting?.promise === promise) this.starting = null
    })
    return promise
  }

  private send(message: WorkerMessage, timeoutMs: number, initializing: boolean): Promise<EmbedResult> {
    const child = this.child
    if (!child || this.disposed) return Promise.resolve({ ok: false, error: 'Embedding worker stopped' })
    const generation = this.generation
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (generation === this.generation && this.pending.has(message.id)) {
          this.failTransport(initializing ? 'Embedding init timed out' : 'Embedding request timed out', initializing)
        }
      }, timeoutMs)
      this.pending.set(message.id, { generation, timer, resolve })
      try {
        child.postMessage(message)
      } catch (error) {
        this.failTransport('Embedding postMessage failed: ' +
          (error instanceof Error ? error.message : String(error)), initializing)
      }
    })
  }

  private receive(message: unknown, generation: number): void {
    if (this.disposed || generation !== this.generation || !isReply(message)) return
    const pending = this.pending.get(message.id)
    if (!pending || pending.generation !== generation) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    this.ready = message.ready
    this.dimensions = message.dimensions
    // Keep infrastructure degradation visible even after a successful retry.
    if (this.transportFailures === 0 || message.lastError !== null) this.lastError = message.lastError
    pending.resolve({ ok: message.ok, ...(message.vectors ? { vectors: message.vectors } : {}),
      ...(message.error ? { error: message.error } : {}) })
  }

  private failTransport(reason: string, initializing: boolean): EmbedResult {
    this.transportFailures += 1
    const permanent = initializing || this.transportFailures >= 2
    this.lastError = reason
    if (permanent) this.fallbackReason = reason + '; falling back to inline embedding'
    else this.restartNeeded = true
    const result: EmbedResult = { ok: false, error: this.fallbackReason ?? reason,
      ...(permanent ? { fallback: true } : {}) }
    this.retire(result)
    return result
  }

  /** Always advance before kill: kill may synchronously emit exit in a test double. */
  private retire(result: EmbedResult): void {
    this.generation += 1
    const child = this.child
    this.child = null
    this.starting = null
    this.initialized = false
    this.ready = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(result)
    }
    this.pending.clear()
    try { child?.kill() } catch { /* Already gone; pending callers have been settled. */ }
  }
}

export const embedClient = new EmbedClient()
