import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { MEMORY_MODEL_ID, MEMORY_MODEL_RELATIVE_DIR } from '@shared/constants'
import { InlineEmbedder, type Extractor } from './embedWorker'
import { embedClient } from './embedClient'

/** Compatible facade: only the explicitly selected fallback executes ONNX in main. */
export class Embedder {
  private readonly inline = new InlineEmbedder(() => this.modelRoot())
  private inlineLogged = false
  /** 模型目录：打包后从 resources 走，开发态从项目根走 */
  modelRoot(): string {
    if (app.isPackaged && process.resourcesPath) {
      const packaged = join(process.resourcesPath, MEMORY_MODEL_RELATIVE_DIR)
      if (existsSync(packaged)) return packaged
    }
    // 一键下载的模型落在 userData：优先它（可写、升级不丢），再退回内置目录。
    const userDir = join(app.getPath('userData'), MEMORY_MODEL_RELATIVE_DIR)
    if (existsSync(join(userDir, ...MEMORY_MODEL_ID.split('/'), 'config.json'))) return userDir
    return join(app.getAppPath(), MEMORY_MODEL_RELATIVE_DIR)
  }


  /** 模型是否已在磁盘上（不加载，只查文件） */
  modelInstalled(): boolean {
    const dir = join(this.modelRoot(), ...MEMORY_MODEL_ID.split('/'))
    return (
      existsSync(join(dir, 'config.json')) &&
      existsSync(join(dir, 'tokenizer.json')) &&
      existsSync(join(dir, 'onnx', 'model_quantized.onnx'))
    )
  }


  status(): { ready: boolean; dimensions: number; modelPath: string; lastError: string | null } {
    const client = embedClient.status()
    if (embedClient.available()) return { ...client, modelPath: join(this.modelRoot(), ...MEMORY_MODEL_ID.split('/')) }
    const inline = this.inline.status()
    return { ...inline, lastError: client.lastError ?? inline.lastError }
  }

  reset(): void {
    this.inline.reset()
    embedClient.reset(this.modelRoot())
  }

  private logInline(): void {
    if (!this.inlineLogged) { console.info('[embedder] inline backend'); this.inlineLogged = true }
  }

  async ensure(): Promise<Extractor | null> {
    if (embedClient.isDisposed()) return null
    if (embedClient.available()) {
      const reply = await embedClient.request('ensure', this.modelRoot())
      if (embedClient.isDisposed()) return null
      if (reply.ok) {
        // Preserve the callable Extractor contract without exposing a remote pipeline.
        return async (texts) => {
          const vectors = await this.embed(texts)
          if (!vectors) throw new Error(this.status().lastError ?? 'Embedding unavailable')
          return { dims: [texts.length, this.status().dimensions], data: Float32Array.from(vectors.flatMap(v => Array.from(v))) }
        }
      }
      if (!reply.fallback) return null
    }
    this.logInline()
    return this.inline.ensure()
  }

  async embed(texts: string[]): Promise<Float32Array[] | null> {
    if (embedClient.isDisposed()) return null
    if (texts.length === 0) return []
    if (embedClient.available()) {
      const reply = await embedClient.request('embed', this.modelRoot(), texts)
      if (embedClient.isDisposed()) return null
      if (reply.ok) return reply.vectors ?? null
      if (!reply.fallback) return null
    }
    this.logInline()
    return this.inline.embed(texts)
  }

  async embedOne(text: string): Promise<Float32Array | null> {
    const batch = await this.embed([text])
    return batch && batch.length > 0 ? batch[0] : null
  }

  async probe(): Promise<{ ok: boolean; dimensions: number; latencyMs: number; error: string | null }> {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = Symbol('timeout')
    try {
      const vec = await Promise.race([
        this.embedOne('记忆检索自检'),
        new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), 30_000) })
      ])
      if (vec === timeout) return { ok: false, dimensions: 0, latencyMs: Date.now() - started, error: '向量模型响应超时' }
      return { ok: vec !== null, dimensions: vec?.length ?? 0, latencyMs: Date.now() - started, error: vec ? null : (this.status().lastError ?? '模型不可用') }
    } finally { clearTimeout(timer) }
  }
}

export const embedder = new Embedder()
