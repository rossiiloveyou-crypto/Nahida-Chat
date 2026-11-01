import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { MEMORY_MODEL_DIMENSIONS, MEMORY_MODEL_ID, MEMORY_MODEL_RELATIVE_DIR } from '@shared/constants'
import { normalize } from './vector'

/**
 * embedding 提供者。
 *
 * 设计要点：
 * 1. 模型懒加载 —— 用户从没点过「记忆」就完全不占内存。
 * 2. 失败即禁用 —— 模型没装/加载崩了，只记一次日志并把 ready 置 false，
 *    之后所有调用返回 null，对话侧静默降级为「关键词检索」或「无记忆」。
 * 3. CJS 里 import ESM —— transformers.js v4 是纯 ESM，主进程是 CJS，
 *    必须用 Function 构造的动态 import 绕过 TS 的 CJS 降级。
 */

const importEsm = new Function('moduleName', 'return import(moduleName)') as (
  moduleName: string
) => Promise<Record<string, unknown>>

interface Extractor {
  (texts: string[], options: Record<string, unknown>): Promise<{ dims: number[]; data: Float32Array | number[] }>
  dispose?: () => Promise<void>
}

export class Embedder {
  private extractor: Extractor | null = null
  private loading: Promise<Extractor | null> | null = null
  private ready = false
  private lastError: string | null = null
  private dims = MEMORY_MODEL_DIMENSIONS

  /** 模型目录：打包后从 resources 走，开发态从项目根走 */
  modelRoot(): string {
    if (app.isPackaged && process.resourcesPath) {
      const packaged = join(process.resourcesPath, MEMORY_MODEL_RELATIVE_DIR)
      if (existsSync(packaged)) return packaged
    }
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
    return {
      ready: this.ready,
      dimensions: this.dims,
      modelPath: join(this.modelRoot(), ...MEMORY_MODEL_ID.split('/')),
      lastError: this.lastError
    }
  }

  /**
   * 确保模型已加载。并发调用会共享同一次加载。
   * 返回 null 表示不可用——调用方必须容忍。
   */
  async ensure(): Promise<Extractor | null> {
    if (this.extractor) return this.extractor
    if (this.loading) return this.loading

    this.loading = (async (): Promise<Extractor | null> => {
      if (!this.modelInstalled()) {
        this.lastError = '模型文件缺失：' + this.status().modelPath
        return null
      }
      try {
        const mod = await importEsm('@huggingface/transformers')
        const pipeline = mod.pipeline as (
          task: string,
          model: string,
          options: Record<string, unknown>
        ) => Promise<Extractor>
        const env = mod.env as Record<string, unknown>
        // 强制离线：绝不允许运行期偷偷去 huggingface 拉模型
        env.allowRemoteModels = false
        env.allowLocalModels = true
        env.localModelPath = this.modelRoot()
        env.useBrowserCache = false

        const extractor = await pipeline('feature-extraction', MEMORY_MODEL_ID, { dtype: 'q8' })
        this.extractor = extractor
        this.ready = true
        this.lastError = null
        return extractor
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        console.error('[memory] embedding 模型加载失败，记忆功能降级', this.lastError)
        return null
      } finally {
        this.loading = null
      }
    })()

    return this.loading
  }

  /**
   * 批量算向量。返回 null 表示不可用。
   * 单条失败不影响其它：整批失败才返回 null。
   */
  async embed(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    const extractor = await this.ensure()
    if (!extractor) return null
    try {
      const output = await extractor(texts, { pooling: 'cls', normalize: true })
      this.dims = output.dims[output.dims.length - 1] ?? this.dims
      const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data)
      const count = texts.length
      const size = flat.length / count
      const result: Float32Array[] = []
      for (let i = 0; i < count; i += 1) {
        result.push(normalize(flat.slice(i * size, (i + 1) * size)))
      }
      return result
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      console.warn('[memory] 向量计算失败', this.lastError)
      return null
    }
  }

  async embedOne(text: string): Promise<Float32Array | null> {
    const batch = await this.embed([text])
    return batch && batch.length > 0 ? batch[0] : null
  }

  /** 设置页「测试」按钮用：真跑一次，把耗时也报出来 */
  async probe(): Promise<{ ok: boolean; dimensions: number; latencyMs: number; error: string | null }> {
    const started = Date.now()
    const vec = await this.embedOne('记忆检索自检')
    return {
      ok: vec !== null,
      dimensions: vec ? vec.length : 0,
      latencyMs: Date.now() - started,
      error: vec ? null : (this.lastError ?? '模型不可用')
    }
  }
}

export const embedder = new Embedder()
