import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import type { Readable } from 'node:stream'

export const LOG_MAX_BYTES = 32 * 1024 * 1024
export interface StLogLine { seq: number; stream: 'stdout' | 'stderr' | 'host'; text: string; at: number }
export const stripAnsi = (text: string): string => stripVTControlCharacters(text)

/** 追加顺序与主进程事件循环一致；磁盘只保留一个 .1，窗口保留本次启动全量。 */
export class BridgeLogPipe {
  private bytes = 0
  private sequence = 0
  private history: StLogLine[] = []
  private readonly listeners = new Set<(line: StLogLine) => void>()
  private detach: (() => void)[] = []
  constructor(readonly path: string, private readonly maxBytes = LOG_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('日志轮转阈值必须为正整数')
    mkdirSync(dirname(path), { recursive: true })
    this.bytes = existsSync(path) ? statSync(path).size : 0
  }
  get logBytes(): number { return this.bytes }
  snapshot(): StLogLine[] { return this.history.slice() }
  subscribe(listener: (line: StLogLine) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  write(stream: StLogLine['stream'], text: string): void {
    const clean = stripAnsi(text)
    const data = Buffer.from(clean + '\n', 'utf8')
    let offset = 0
    while (offset < data.length) {
      if (this.bytes >= this.maxBytes) {
        rmSync(this.path + '.1', { force: true })
        if (existsSync(this.path)) renameSync(this.path, this.path + '.1')
        this.bytes = 0
      }
      const end = Math.min(data.length, offset + this.maxBytes - this.bytes)
      appendFileSync(this.path, data.subarray(offset, end))
      this.bytes += end - offset
      offset = end
    }
    const line: StLogLine = { seq: ++this.sequence, stream, text: clean, at: Date.now() }
    this.history.push(line)
    for (const listener of this.listeners) { try { listener(line) } catch { /* 独立消费者 */ } }
  }
  attach(source: Readable, stream: 'stdout' | 'stderr', onError: (error: Error) => void): void {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let ended = false
    const flush = (final = false): void => {
      const lines = pending.split(/\r\n|\n|\r(?!$)/)
      pending = lines.pop() ?? ''
      for (const line of lines) this.write(stream, line)
      if (final && pending) { this.write(stream, pending.replace(/\r$/, '')); pending = '' }
    }
    const finish = (): void => {
      if (ended) return
      ended = true
      try { pending += decoder.end(); flush(true) } catch (error) { onError(error as Error) }
    }
    const onData = (chunk: Buffer | string): void => {
      try { pending += typeof chunk === 'string' ? chunk : decoder.write(chunk); flush() }
      catch (error) { onError(error as Error) }
    }
    source.on('data', onData)
    source.once('end', finish)
    source.on('error', onError)
    this.detach.push(() => { finish(); source.off('data', onData); source.off('end', finish); source.off('error', onError) })
  }
  close(): void { for (const detach of this.detach.splice(0)) detach() }
}
