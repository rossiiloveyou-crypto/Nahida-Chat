/**
 * RAG 向量模型一键安装器。
 *
 * 为什么自己下而不用 transformers 的远程模式：loader 必须严格离线
 * （embedder 里 allowRemoteModels=false），而 transformers 的缓存布局
 * （models--Xenova--bge-m3/snapshots/<hash>/…）与我们要求的
 * <models>/Xenova/bge-m3/onnx/model_quantized.onnx 不是一回事。
 * 直接拿文件落进 loader 认得的位置，行为可预期、可校验。
 *
 * 🔴 目标目录必须是 userData：程序目录在安装后是只读的，模型也不会随升级丢失。
 * 🔴 先写 .part 再改名：中途断网/取消不会留下"看起来装好了"的半截文件。
 */
import { createWriteStream, existsSync, mkdirSync, promises as fsp, statSync } from 'node:fs'
import { get } from 'node:https'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  MEMORY_MODEL_FILES,
  MEMORY_MODEL_ID,
  MEMORY_MODEL_MIN_BYTES,
  MEMORY_MODEL_MIRRORS
} from '@shared/constants'
import type { MemoryModelProgress } from '@shared/types'

/** userData 下的模型根（与 embedder 的解析顺序保持一致）。 */
export function userModelRoot(): string {
  return join(app.getPath('userData'), 'models')
}

export function userModelDir(): string {
  return join(userModelRoot(), ...MEMORY_MODEL_ID.split('/'))
}

/** 已装好（全部文件到位且体积达标）。 */
export function userModelInstalled(dir = userModelDir()): boolean {
  return MEMORY_MODEL_FILES.every((file) => {
    const target = join(dir, file)
    if (!existsSync(target)) return false
    return statSync(target).size >= (MEMORY_MODEL_MIN_BYTES[file] ?? 1)
  })
}

type Progress = (event: MemoryModelProgress) => void

/**
 * 只取响应头拿文件真实大小（跟着重定向走）。
 * 为什么不用 MEMORY_MODEL_MIN_BYTES 当分母：那只是"别把错误页当模型"的下限，
 * 与真实体积差一个数量级（onnx 下限 50 MB、实际约 570 MB），拿它算进度必然
 * 早早就 100%、还会出现 received > total 的荒谬读数。
 */
function probeSize(url: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const request = get(url, { headers: { 'user-agent': 'nahida-chat/0.1' }, signal }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        probeSize(new URL(response.headers.location, url).toString(), signal).then(resolve, () => resolve(0))
        return
      }
      const length = Number(response.headers['content-length'] ?? 0)
      response.destroy()
      resolve(Number.isFinite(length) && length > 0 ? length : 0)
    })
    request.on('error', () => resolve(0))
    signal.addEventListener('abort', () => { request.destroy(); resolve(0) }, { once: true })
  })
}

/** 依次尝试镜像探测体积；全失败返回 0（进度退化为"按文件数"）。 */
async function probeFileSize(file: string, signal: AbortSignal): Promise<number> {
  for (const host of MEMORY_MODEL_MIRRORS) {
    const size = await probeSize(host + '/' + MEMORY_MODEL_ID + '/resolve/main/' + file, signal)
    if (size > 0) return size
  }
  return 0
}

/** 单文件下载：跟随重定向、边下边报进度、可被 AbortSignal 中断。 */
function download(url: string, target: string, onBytes: (got: number, total: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { 'user-agent': 'nahida-chat/0.1' }, signal }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        download(new URL(response.headers.location, url).toString(), target, onBytes, signal).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error('HTTP ' + String(status)))
        return
      }
      const total = Number(response.headers['content-length'] ?? 0)
      let got = 0
      const part = target + '.part'
      const out = createWriteStream(part)
      response.on('data', (chunk: Buffer) => {
        got += chunk.length
        onBytes(got, total)
      })
      response.pipe(out)
      out.on('error', reject)
      out.on('finish', () => {
        out.close(() => {
          fsp.rename(part, target).then(() => resolve(), reject)
        })
      })
    })
    request.on('error', reject)
    signal.addEventListener('abort', () => request.destroy(new Error('已取消')), { once: true })
  })
}

/** 依次尝试镜像，全部失败才抛错。 */
async function fetchFile(file: string, target: string, onBytes: (got: number, total: number) => void, signal: AbortSignal): Promise<void> {
  const errors: string[] = []
  for (const host of MEMORY_MODEL_MIRRORS) {
    const url = host + '/' + MEMORY_MODEL_ID + '/resolve/main/' + file
    try {
      await download(url, target, onBytes, signal)
      const size = statSync(target).size
      const min = MEMORY_MODEL_MIN_BYTES[file] ?? 1
      if (size < min) throw new Error('文件体积异常（' + String(size) + ' < ' + String(min) + '）')
      return
    } catch (error) {
      errors.push(host + '：' + (error instanceof Error ? error.message : String(error)))
      await fsp.rm(target + '.part', { force: true })
      await fsp.rm(target, { force: true })
      if (signal.aborted) throw new Error('已取消')
    }
  }
  throw new Error('下载 ' + file + ' 失败：' + errors.join('；'))
}

/**
 * 安装（幂等）：已完整的文件跳过；全部到位后返回目录。
 * @param onProgress 进度回调（IPC 层直接转成事件）
 */
export async function installModel(onProgress: Progress, signal: AbortSignal): Promise<string> {
  const dir = userModelDir()
  mkdirSync(dir, { recursive: true })

  // 1) 真实体积（HEAD 探测）——进度条的分母只能是它
  const sizes: number[] = []
  for (const file of MEMORY_MODEL_FILES) sizes.push(await probeFileSize(file, signal))
  const known = sizes.reduce((sum, n) => sum + n, 0)
  const grandTotal = known > 0 ? known : MEMORY_MODEL_FILES.length
  let baseDone = 0

  for (const [index, file] of MEMORY_MODEL_FILES.entries()) {
    const target = join(dir, file)
    const min = MEMORY_MODEL_MIN_BYTES[file] ?? 1
    if (existsSync(target) && statSync(target).size >= min) {
      baseDone += statSync(target).size
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    onProgress({ phase: 'downloading', file, ratio: baseDone / grandTotal, receivedBytes: baseDone, totalBytes: grandTotal })
    let lastReport = 0
    await fetchFile(file, target, (got, total) => {
      const now = Date.now()
      // 大文件按 120ms 节流，避免 IPC 洪水
      if (now - lastReport < 120 && got < total) return
      lastReport = now
      // 服务器没给 content-length 时，用探测值兜底；两者都没有才退回"按文件数"
      const span = total > 0 ? total : sizes[index] || 1
      const received = baseDone + Math.min(got, span)
      onProgress({
        phase: 'downloading',
        file,
        ratio: known > 0 ? Math.min(0.999, received / grandTotal) : Math.min(0.999, (index + got / span) / MEMORY_MODEL_FILES.length),
        receivedBytes: received,
        totalBytes: grandTotal
      })
    }, signal)
    baseDone += statSync(target).size
  }

  onProgress({ phase: 'verifying', file: '', ratio: 1, receivedBytes: baseDone, totalBytes: grandTotal })
  if (!userModelInstalled(dir)) throw new Error('模型文件不完整：' + dir)
  onProgress({ phase: 'done', file: '', ratio: 1, receivedBytes: baseDone, totalBytes: grandTotal })
  return dir
}
