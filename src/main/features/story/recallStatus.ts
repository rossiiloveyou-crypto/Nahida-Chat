import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoryRecallStatus } from '@shared/types'
import { isStoryId, storiesRoot, storyDbPath } from './paths'
import { embedder } from '../rag/embedder'
import { embeddingProgress } from '../rag/embedPendings'

// Process-local metadata only: no query, content, credentials or database writes.
let lastRecall: StoryRecallStatus['lastRecall'] = null
export function recordStoryRecall(report: NonNullable<StoryRecallStatus['lastRecall']>): void {
  lastRecall = { ...report, top: report.top?.slice(0, 3).map(hit => ({ ...hit })) }
}

/** Never open the source DB: even readOnly can create WAL/SHM beside it (J-36). */
function snapshotDatabase(file: string, directory: string): string {
  const copy = join(directory, 'memory.db')
  const digest = (source: string): string | null => existsSync(source)
    ? createHash('sha256').update(readFileSync(source)).digest('hex') : null
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = [digest(file), digest(file + '-wal')]
    copyFileSync(file, copy)
    if (before[1] !== null) copyFileSync(file + '-wal', copy + '-wal')
    else rmSync(copy + '-wal', { force: true })
    const after = [digest(file), digest(file + '-wal')]
    if (before[0] === after[0] && before[1] === after[1] &&
        digest(copy) === before[0] && digest(copy + '-wal') === before[1]) return copy
  }
  throw new Error('归档数据库正在变化，请稍后刷新状态')
}

/** Read-only means no source writes, lazy MemoryStore.open(), schema or model download. */
export function storyRecallStatus(): StoryRecallStatus {
  const model = embedder.status()
  const result: StoryRecallStatus = {
    archivedRounds: 0, vectorRounds: 0, pendingRounds: 0, pendingChunks: 0,
    ...embeddingProgress(), vectorReady: model.ready,
    modelInstalled: embedder.modelInstalled(), lastError: model.lastError,
    databaseErrors: [], lastRecall: lastRecall ? { ...lastRecall, top: lastRecall.top?.map(hit => ({ ...hit })) } : null
  }
  const root = storiesRoot()
  if (!existsSync(root)) return result
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isStoryId(entry.name)) continue
    const file = storyDbPath(entry.name)
    if (!existsSync(file)) continue
    let db: DatabaseSync | undefined
    let directory: string | undefined
    try {
      directory = mkdtempSync(join(tmpdir(), 'nahida-recall-status-'))
      db = new DatabaseSync(snapshotDatabase(file, directory), { readOnly: true })
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('story_rounds','story_chunks')").all() as { name: string }[]
      const names = new Set(tables.map(row => row.name))
      let rounds = 0
      let vectors = 0
      if (names.has('story_rounds')) {
        rounds = Number((db.prepare('SELECT COUNT(*) AS n FROM story_rounds').get() as { n: number }).n)
      }
      if (names.has('story_chunks')) {
        vectors = Number((db.prepare('SELECT COUNT(DISTINCT round_id) AS n FROM story_chunks WHERE embedding IS NOT NULL').get() as { n: number }).n)
        const pending = db.prepare('SELECT COUNT(*) AS chunks, COUNT(DISTINCT round_id) AS rounds FROM story_chunks WHERE embedding IS NULL').get() as { chunks: number; rounds: number }
        result.pendingRounds += Number(pending.rounds)
        result.pendingChunks += Number(pending.chunks)
      }
      result.archivedRounds += rounds
      result.vectorRounds += vectors
    } catch (cause) {
      result.databaseErrors.push(entry.name + '：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      try { db?.close() } finally {
        if (directory) rmSync(directory, { recursive: true, force: true })
      }
    }
  }
  return result
}
