import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import type { StoryRecallStatus } from '@shared/types'
import { isStoryId, storiesRoot, storyDbPath } from '../story/paths'
import { embedder } from './embedder'
import { toBlob } from './vector'

type Progress = Pick<StoryRecallStatus, 'backfilling' | 'pendingError'>
type Row = { id: string; text: string | Uint8Array; content_version: string; branch_id: string; started_at: number }
type Priority = { storyId: string; branchId: string }
const yieldLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
/** Backfill cadence: smaller batches shorten bursts; gaps give the UI breathing room. */
const throttle = { batch: 4, gapMs: 150 }
export function configureEmbeddingThrottle(next: Partial<{ batch: number; gapMs: number }>): void {
  if (Number.isSafeInteger(next.batch) && next.batch! > 0) throttle.batch = next.batch!
  if (Number.isSafeInteger(next.gapMs) && next.gapMs! >= 0) throttle.gapMs = next.gapMs!
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const errors = new Map<string, string>()
const listeners = new Set<(state: Progress) => void>()
let progress: Progress['backfilling'] = null
let active: Promise<void> | null = null
let cancelled = false
let priority: Priority | undefined
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let queued: Promise<void> | null = null
let resolveQueued: (() => void) | null = null

function clearQueue(): void {
  if (timer) clearTimeout(timer)
  timer = null
  resolveQueued?.()
  resolveQueued = null
  queued = null
}

/** Merge archive bursts without putting inference on the archive/IPC path. */
export function requestEmbeddingBackfill(target?: Priority): void {
  if (target) priority = target
  const state = embedder.status()
  if (!state.ready && state.lastError) failure(target?.storyId ?? 'model', state.lastError)
  if (active) { dirty = true; return }
  if (timer) clearTimeout(timer)
  if (!queued) queued = new Promise(resolve => { resolveQueued = resolve })
  // Replies just finished and the UI is refreshing: leave IPC/rendering 1000 ms
  // before the ~370 ms inference work starts. This is debounce, not polling.
  timer = setTimeout(() => {
    timer = null
    startEmbeddingBackfill()
  }, 1000)
}

export function embeddingProgress(): Progress {
  return { backfilling: progress ? { ...progress } : null,
    pendingError: [...errors.values()].join('；') || null }
}
function publish(): void {
  for (const listener of listeners) {
    try { listener(embeddingProgress()) } catch { /* A closed renderer must not stop the writer. */ }
  }
}
export function onEmbeddingProgress(listener: (state: Progress) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function failure(storyId: string, reason: string): void {
  errors.set(storyId, storyId + '：' + reason)
  console.info('[story-embedding]', storyId, reason)
  publish()
}
function validVectors(vectors: Float32Array[] | null, count: number): vectors is Float32Array[] {
  const dimensions = embedder.status().dimensions
  return !!vectors && vectors.length === count && vectors.every(vector =>
    vector instanceof Float32Array && vector.length === dimensions && vector.length > 0 &&
    vector.every(Number.isFinite))
}
/** Archive failure is observable, but never prevents the round from being saved. */
export async function embedStoryChunks(storyId: string, texts: string[]): Promise<Float32Array[] | null> {
  try {
    const vectors = await embedder.embed(texts)
    if (!validVectors(vectors, texts.length)) {
      failure(storyId, embedder.status().lastError ?? '向量数量、维度或数值无效')
      return null
    }
    if (errors.delete(storyId)) publish()
    return vectors
  } catch {
    failure(storyId, '向量计算异常，原文已保留，可重试补算')
    return null
  }
}
function storyFiles(): Array<{ storyId: string; file: string }> {
  const root = storiesRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isStoryId(entry.name)) return []
    const file = storyDbPath(entry.name)
    return existsSync(file) && !lstatSync(file).isSymbolicLink() ? [{ storyId: entry.name, file }] : []
  })
}
/** Open only an existing DB. Close before every await so deletion never leaves an owned handle. */
function withDatabase<T>(file: string, action: (db: DatabaseSync) => T): T {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw new Error('故事库已移除')
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout=50')
    return action(db)
  } finally { db.close() }
}
function assertDimensions(db: DatabaseSync): void {
  const row = db.prepare('SELECT 1 FROM story_chunks WHERE embedding IS NOT NULL AND length(embedding) != ? LIMIT 1')
    .get(embedder.status().dimensions * Float32Array.BYTES_PER_ELEMENT)
  if (row) throw new Error('已有向量维度与当前模型不同，补算已停止')
}
async function run(): Promise<void> {
  try {
    await yieldLoop()
    if (cancelled) return
    if (!await embedder.ensure()) {
      failure('model', embedder.status().lastError ?? '向量模型未就绪')
      return
    }
    errors.delete('model')
    const preferred = priority
    const pending: Array<{ storyId: string; file: string; rows: Row[] }> = []
    for (const { storyId, file } of storyFiles().sort((a, b) => Number(b.storyId === preferred?.storyId) - Number(a.storyId === preferred?.storyId))) {
      if (cancelled) return
      let rows: Row[]
      try { rows = withDatabase(file, db => {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='story_chunks'").get()) return []
        assertDimensions(db)
        return (db.prepare(`SELECT c.id, c.text, c.content_version, r.branch_id, r.started_at
          FROM story_chunks c JOIN story_rounds r ON r.id = c.round_id
          WHERE c.embedding IS NULL`).all() as Row[]).sort((a, b) =>
          Number(storyId === preferred?.storyId && b.branch_id === preferred.branchId) -
          Number(storyId === preferred?.storyId && a.branch_id === preferred.branchId) ||
          b.started_at - a.started_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      }) } catch (error) {
        const reason = error instanceof Error ? error.message : '读取失败'
        if (reason.includes('维度')) throw error
        failure(storyId, reason)
        continue
      }
      pending.push({ storyId, file, rows })
      await yieldLoop()
    }
    progress = { done: 0, total: pending.reduce((sum, item) => sum + item.rows.length, 0) }
    publish()
    for (const { storyId, file, rows } of pending) {
      try {
      for (let offset = 0; offset < rows.length; offset += throttle.batch) {
        if (cancelled) return
        const batch = rows.slice(offset, offset + throttle.batch)
        const vectors = await embedStoryChunks(storyId, batch.map(row => typeof row.text === 'string'
          ? row.text : Buffer.from(row.text).toString('utf16le')))
        if (cancelled) return
        if (!vectors) {
          console.warn('[story-embedding-batch]', { storyId, size: batch.length, success: 0, skipped: 0, failed: batch.length })
          break
        }
        let success: number
        try { success = withDatabase(file, db => {
          assertDimensions(db)
          db.exec('BEGIN IMMEDIATE')
          try {
            const update = db.prepare('UPDATE story_chunks SET embedding=? WHERE id=? AND content_version=? AND embedding IS NULL')
            let count = 0
            for (const [index, row] of batch.entries()) count += Number(update.run(toBlob(vectors[index]), row.id, row.content_version).changes)
            db.exec('COMMIT')
            return count
          } catch (error) { db.exec('ROLLBACK'); throw error }
        }) } catch (error) {
          const reason = error instanceof Error ? error.message : '写入失败'
          if (reason.includes('维度')) throw error
          failure(storyId, reason)
          break
        }
        progress.done += batch.length
        const shouldLog = success !== 0 && (progress.done % 16 < throttle.batch)
        if (shouldLog) console.info('[story-embedding-batch]', { storyId, size: batch.length, success, skipped: batch.length - success, failed: 0 })
        publish()
        await (throttle.gapMs > 0 ? sleep(throttle.gapMs) : yieldLoop())
      }
      } finally {
        // No connection survives an await. Reopen only an existing story file.
        if (existsSync(file)) {
          try { withDatabase(file, db => {
            const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
            if (result.busy) console.info('[story-embedding-checkpoint]', storyId, 'busy')
          }) } catch { console.info('[story-embedding-checkpoint]', storyId, 'skipped') }
        }
      }
    }
  } catch (error) {
    failure('backfill', error instanceof Error ? error.message : '补算失败')
  } finally {
    progress = null
    active = null
    publish()
    if (dirty && !cancelled) {
      dirty = false
      requestEmbeddingBackfill()
    }
  }
}
export function startEmbeddingBackfill(): { started: boolean; reason?: string } {
  if (active) return { started: false, reason: '正在补算' }
  clearQueue()
  dirty = false
  cancelled = false
  errors.clear()
  progress = { done: 0, total: 0 }
  active = run()
  publish()
  return { started: true }
}
export function cancelEmbeddingBackfill(): void {
  cancelled = true
  dirty = false
  priority = undefined
  clearQueue()
}
/** Test/lifecycle drain; cancellation preserves every committed batch. */
export async function waitForEmbeddingBackfill(): Promise<void> {
  const draining = queued
  if (draining) await draining
  const running = active
  if (running) await running
}
/** One startup pass only; status reads never load a model or schedule writes. */
export async function autoEmbeddingBackfill(): Promise<void> {
  if (!embedder.modelInstalled()) return
  try {
    const pending = storyFiles().some(({ file }) => withDatabase(file, db =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='story_chunks'").get() &&
      !!db.prepare('SELECT 1 FROM story_chunks WHERE embedding IS NULL LIMIT 1').get()))
    if (!pending) return
    startEmbeddingBackfill()
    await waitForEmbeddingBackfill()
  } catch (error) {
    failure('startup', error instanceof Error ? error.message : '启动补算检查失败')
  }
}
