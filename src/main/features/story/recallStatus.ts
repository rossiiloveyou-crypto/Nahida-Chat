import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoryRecallEntry, StoryRecallStatus } from '@shared/types'
import { storyStore } from './store'
import { branchStore } from './branches'
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
    stories: [], archivedRounds: 0, vectorRounds: 0, pendingRounds: 0, pendingChunks: 0,
    ...embeddingProgress(), vectorReady: model.ready,
    modelInstalled: embedder.modelInstalled(), lastError: model.lastError,
    databaseErrors: [], lastRecall: lastRecall ? { ...lastRecall, top: lastRecall.top?.map(hit => ({ ...hit })) } : null
  }
  const root = storiesRoot()
  if (!existsSync(root)) return result
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isStoryId(entry.name)) continue
    const file = storyDbPath(entry.name)
    const story: StoryRecallEntry = {
      storyId: entry.name, title: entry.name, branchLabel: '',
      archivedRounds: 0, vectorRounds: 0, pendingRounds: 0, pendingChunks: 0
    }
    let db: DatabaseSync | undefined
    let directory: string | undefined
    try {
      if (existsSync(file)) {
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
          story.pendingRounds = Number(pending.rounds)
          story.pendingChunks = Number(pending.chunks)
          result.pendingRounds += story.pendingRounds
          result.pendingChunks += story.pendingChunks
        }
        story.archivedRounds = rounds
        story.vectorRounds = vectors
        result.archivedRounds += rounds
        result.vectorRounds += vectors
      }
    } catch (cause) {
      result.databaseErrors.push(entry.name + '：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      try { db?.close() } finally {
        if (directory) rmSync(directory, { recursive: true, force: true })
      }
    }
    // Read metadata only after closing and removing the database snapshot.
    try { story.title = storyStore.get(entry.name)?.title || entry.name }
    catch (cause) { console.warn('[story-recall] 故事区标题读取失败：' + entry.name, cause) }
    try {
      const branches = branchStore.read(entry.name)
      story.branchLabel = branches?.branches.find(branch => branch.branchId === branches.activeBranchId)?.title ?? ''
    } catch (cause) { console.warn('[story-recall] 分支标题读取失败：' + entry.name, cause) }
    result.stories.push(story)
  }
  result.stories.sort((a, b) => a.title.localeCompare(b.title) || a.storyId.localeCompare(b.storyId))
  return result
}
