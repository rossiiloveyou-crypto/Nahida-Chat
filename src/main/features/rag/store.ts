import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { MEMORY_MAX_CHARS } from '@shared/constants'
import type { MemoryEntry } from '@shared/types'
import type { MemoryScopeId } from '@shared/zones'
import { rootScope } from '@shared/zones'
import { fromBlob, toBlob } from './vector'
import { toIndexText } from './tokenize'

/**
 * 记忆库（SQLite）。
 *
 * 为什么是 SQLite 而不是 JSON 文件：记忆条目和消息是多对一关系，
 * 且要按分数排序、按时间过滤。JSON 整文件重写在几百条以后就会变成
 * 每轮对话都 O(n) 写放大——这正是 ADR-0001 换掉 sessions.json 的理由。
 *
 * 为什么用 node:sqlite 而不是 better-sqlite3：内置、零原生模块、免 rebuild。
 */

/**
 * 建表语句。FTS5 用外部内容表，正文只存一份，避免两份数据不同步。
 *
 * P5：memories 直接带 scope_id（全新库一次到位）。**scope 索引不在 SCHEMA 里** ——
 * 旧库的 CREATE 是 IF NOT EXISTS 不会补列，索引必须先等迁移把列加上（见 open()）。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    seg_text TEXT NOT NULL,
    source_session_id TEXT,
    source_message_id TEXT,
    source_message_index INTEGER,
    weight REAL NOT NULL DEFAULT 1.0,
    embedding BLOB,
    created_at INTEGER NOT NULL,
    last_hit_at INTEGER,
    hit_count INTEGER NOT NULL DEFAULT 0,
    scope_id TEXT NOT NULL DEFAULT 'zone:root'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    seg_text,
    content='memories',
    content_rowid='rowid',
    tokenize='unicode61'
  )`,
  `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, seg_text) VALUES (new.rowid, new.seg_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, seg_text) VALUES ('delete', old.rowid, old.seg_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, seg_text) VALUES ('delete', old.rowid, old.seg_text);
    INSERT INTO memories_fts(rowid, seg_text) VALUES (new.rowid, new.seg_text);
  END`
]

/** 迁移之后才能建的索引（依赖 scope_id 列） */
const POST_MIGRATION = [`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope_id)`]

/**
 * 判列是否存在（J-20）。
 *
 * 🔴 必须写成这个形式，不能裸 `ALTER`：ALTER 不可重入，第二次启动会报
 * duplicate column name，而 open() 的 catch 会把 failed 置位 ⇒ 记忆功能整个
 * 静默失效且不报警。E4 已实测「旧库第 2 次跳过」与「全新库 CREATE 已带列时也判为存在」。
 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all() as unknown as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

/** 带向量的完整行，只在检索路径内部用 */
export interface StoredMemory extends MemoryEntry {
  embedding: Float32Array | null
}

interface MemoryRow {
  id: string
  content: string
  source_session_id: string | null
  source_message_id: string | null
  source_message_index: number | null
  weight: number
  embedding: Uint8Array | null
  created_at: number
  last_hit_at: number | null
  hit_count: number
  scope_id: string | null
}

export class MemoryStore {
  private db: DatabaseSync | null = null
  private failed = false
  /** 测试用：把库指到别处；缺省 userData/memory.db */
  private readonly explicitFile: string | null

  constructor(file?: string) {
    this.explicitFile = file ? file : null
  }

  get dbFile(): string {
    return this.explicitFile ?? join(app.getPath('userData'), 'memory.db')
  }

  /**
   * 惰性打开。任何异常都只记一次日志并把 failed 置位，
   * 之后所有调用静默返回空——记忆坏了不能把对话弄挂。
   */
  private open(): DatabaseSync | null {
    if (this.db) return this.db
    if (this.failed) return null
    try {
      const file = this.dbFile
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
      const db = new DatabaseSync(file)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      for (const statement of SCHEMA) db.exec(statement)
      // 迁移必须在 SCHEMA 之后：全新库的 CREATE 已经带了 scope_id，这里会判为已存在；
      // 旧库的 CREATE IF NOT EXISTS 不会补列，这里才执行 ALTER。
      if (!hasColumn(db, 'memories', 'scope_id')) {
        db.exec("ALTER TABLE memories ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'zone:root'")
        console.info('[memory] 迁移：memories 增加 scope_id，旧数据回落 zone:root')
      }
      // P6 / T12：分支记忆可见性的产生位置。旧数据为 NULL（对全部分支可见，fail-open）。
      if (!hasColumn(db, 'memories', 'source_message_index')) {
        db.exec('ALTER TABLE memories ADD COLUMN source_message_index INTEGER')
        console.info('[memory] 迁移：memories 增加 source_message_index，旧数据为 NULL（对全部分支可见）')
      }
      for (const statement of POST_MIGRATION) db.exec(statement)
      this.db = db
      return db
    } catch (error) {
      this.failed = true
      console.error('[memory] 记忆库打开失败，本次运行不启用记忆', error)
      return null
    }
  }

  /** 状态探测：能让设置页知道"库是好的还是坏了" */
  healthy(): boolean {
    const db = this.open()
    if (!db) return false
    try {
      db.prepare('SELECT 1 AS ok').get()
      return true
    } catch {
      return false
    }
  }

  count(): number {
    const db = this.open()
    if (!db) return 0
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number } | undefined
      return row ? row.n : 0
    } catch {
      return 0
    }
  }

  /** 按创建时间倒序列出全部记忆（设置页用） */
  list(): MemoryEntry[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare('SELECT * FROM memories ORDER BY created_at DESC')
        .all() as unknown as MemoryRow[]
      return rows.map(toEntry)
    } catch (error) {
      console.warn('[memory] 列表读取失败', error)
      return []
    }
  }

  /** 按域列出（设置页按域筛选 / 面板统计） */
  listByScope(scope: MemoryScopeId): MemoryEntry[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare('SELECT * FROM memories WHERE scope_id = ? ORDER BY created_at DESC')
        .all(scope) as unknown as MemoryRow[]
      return rows.map(toEntry)
    } catch (error) {
      console.warn('[memory] 按域读取失败', error)
      return []
    }
  }

  /** 各域条数：面板上「这个区块有多少条记忆」 */
  countByScope(): Array<{ scopeId: MemoryScopeId; count: number }> {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare('SELECT scope_id AS scope, COUNT(*) AS total FROM memories GROUP BY scope_id')
        .all() as unknown as Array<{ scope: string | null; total: number }>
      return rows.map((row) => ({ scopeId: row.scope ?? rootScope(), count: row.total }))
    } catch (error) {
      console.warn('[memory] 按域统计失败', error)
      return []
    }
  }

  /** 带向量的行，限定在一个或多个域内。空数组 = 不检索（不是"不过滤"）。 */
  allWithEmbeddingIn(scopes: MemoryScopeId[]): StoredMemory[] {
    if (scopes.length === 0) return []
    const db = this.open()
    if (!db) return []
    try {
      // 🔴 空 IN 子句是 SQL 语法错误，所以上面必须先 return（本 Phase 新坑 3）
      const placeholders = scopes.map(() => '?').join(',')
      const rows = db
        .prepare('SELECT * FROM memories WHERE embedding IS NOT NULL AND scope_id IN (' + placeholders + ')')
        .all(...scopes) as unknown as MemoryRow[]
      return rows.map((row) => ({ ...toEntry(row), embedding: row.embedding ? fromBlob(row.embedding) : null }))
    } catch (error) {
      console.warn('[memory] 按域读取向量失败', error)
      return []
    }
  }

  /** FTS5 关键词检索，限定在域内。空 scopes = 空结果。 */
  keywordSearchIn(
    matchQuery: string,
    limit: number,
    scopes: MemoryScopeId[]
  ): Array<{ id: string; score: number }> {
    if (!matchQuery || scopes.length === 0) return []
    const db = this.open()
    if (!db) return []
    try {
      const placeholders = scopes.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT m.id AS id, bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ? AND m.scope_id IN (` +
            placeholders +
            `)
           ORDER BY rank
           LIMIT ?`
        )
        .all(matchQuery, ...scopes, limit) as unknown as Array<{ id: string; rank: number }>
      return rows.map((row) => ({ id: row.id, score: -row.rank }))
    } catch (error) {
      console.warn('[memory] 按域关键词检索失败', error)
      return []
    }
  }

  /** 把一个域的全部记忆搬到另一个域（删区块时用）。返回搬迁条数。 */
  reassignScope(from: MemoryScopeId, to: MemoryScopeId): number {
    const db = this.open()
    if (!db) return 0
    try {
      const result = db.prepare('UPDATE memories SET scope_id = ? WHERE scope_id = ?').run(to, from) as unknown as {
        changes?: number
      }
      return Number(result.changes ?? 0)
    } catch (error) {
      console.warn('[memory] 域搬迁失败', error)
      return 0
    }
  }

  /** 新增或更新一条记忆；embedding 由调用方算好传入 */
  upsert(input: {
    id?: string
    content: string
    weight?: number
    sourceSessionId?: string | null
    sourceMessageId?: string | null
    /** 产生这条记忆时，它在自己那条分支里的消息下标（P6 / T12）；缺省 null */
    sourceMessageIndex?: number | null
    embedding?: Float32Array | null
    /** 所属记忆域；缺省 zone:root（兼容 P4 及以前的调用方） */
    scopeId?: MemoryScopeId
  }): MemoryEntry | null {
    const db = this.open()
    if (!db) return null
    const content = input.content.trim().slice(0, MEMORY_MAX_CHARS)
    if (!content) return null

    try {
      const id = input.id?.trim() || randomUUID()
      const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id)
      const embedding = input.embedding ?? null

      if (existing) {
        // 更新：没给新 embedding 就保留旧的，避免"改个错别字就丢向量"；
        // 没给 scopeId 就保留原域（手工改一条群记忆不该把它搬到 root）。
        if (embedding) {
          db.prepare(
            'UPDATE memories SET content = ?, seg_text = ?, weight = COALESCE(?, weight), embedding = ?, scope_id = COALESCE(?, scope_id), source_message_index = COALESCE(?, source_message_index) WHERE id = ?'
          ).run(
            content,
            toIndexText(content),
            input.weight ?? null,
            toBlob(embedding),
            input.scopeId ?? null,
            input.sourceMessageIndex ?? null,
            id
          )
        } else {
          db.prepare(
            'UPDATE memories SET content = ?, seg_text = ?, weight = COALESCE(?, weight), scope_id = COALESCE(?, scope_id), source_message_index = COALESCE(?, source_message_index) WHERE id = ?'
          ).run(
            content,
            toIndexText(content),
            input.weight ?? null,
            input.scopeId ?? null,
            input.sourceMessageIndex ?? null,
            id
          )
        }
      } else {
        db.prepare(
          `INSERT INTO memories
            (id, content, seg_text, source_session_id, source_message_id, source_message_index, weight, embedding, created_at, hit_count, scope_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
        ).run(
          id,
          content,
          toIndexText(content),
          input.sourceSessionId ?? null,
          input.sourceMessageId ?? null,
          input.sourceMessageIndex ?? null,
          input.weight ?? 1,
          embedding ? toBlob(embedding) : null,
          Date.now(),
          input.scopeId ?? rootScope()
        )
      }

      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow | undefined
      return row ? toEntry(row) : null
    } catch (error) {
      console.warn('[memory] 写入失败', error)
      return null
    }
  }

  /** 按 id 批量取（检索收尾时补正文用） */
  getByIds(ids: string[]): MemoryEntry[] {
    if (ids.length === 0) return []
    const db = this.open()
    if (!db) return []
    try {
      const placeholders = ids.map(() => '?').join(',')
      const rows = db
        .prepare('SELECT * FROM memories WHERE id IN (' + placeholders + ')')
        .all(...ids) as unknown as MemoryRow[]
      return rows.map(toEntry)
    } catch {
      return []
    }
  }

  remove(id: string): boolean {
    const db = this.open()
    if (!db) return false
    try {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      return true
    } catch {
      return false
    }
  }

  clear(): void {
    const db = this.open()
    if (!db) return
    try {
      db.exec('DELETE FROM memories')
    } catch (error) {
      console.warn('[memory] 清空失败', error)
    }
  }

  /** 取带向量的全部行，用于暴力余弦扫描 */
  allWithEmbedding(): StoredMemory[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare('SELECT * FROM memories WHERE embedding IS NOT NULL')
        .all() as unknown as MemoryRow[]
      return rows.map((row) => ({ ...toEntry(row), embedding: row.embedding ? fromBlob(row.embedding) : null }))
    } catch {
      return []
    }
  }

  /**
   * FTS5 关键词检索，返回 [id, 原始 bm25 分数]。
   * bm25() 越小越相关（SQLite 返回负值），这里取负转成越大越好。
   */
  keywordSearch(matchQuery: string, limit: number): Array<{ id: string; score: number }> {
    if (!matchQuery) return []
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare(
          `SELECT m.id AS id, bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(matchQuery, limit) as unknown as Array<{ id: string; rank: number }>
      return rows.map((row) => ({ id: row.id, score: -row.rank }))
    } catch (error) {
      // FTS 查询语法错误（极端输入）不该影响向量检索，静默降级
      console.warn('[memory] 关键词检索失败', error)
      return []
    }
  }

  /** 召回后回写命中统计，用于权重衰减/排序 */
  touch(ids: string[]): void {
    if (ids.length === 0) return
    const db = this.open()
    if (!db) return
    try {
      const statement = db.prepare(
        'UPDATE memories SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?'
      )
      const now = Date.now()
      for (const id of ids) statement.run(now, id)
    } catch {
      // 回写统计失败不影响对话
    }
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // 关闭失败无需处理
    }
    this.db = null
  }
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    scopeId: row.scope_id ?? rootScope(),
    content: row.content,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id,
    sourceMessageIndex: row.source_message_index ?? null,
    weight: row.weight,
    createdAt: row.created_at,
    lastHitAt: row.last_hit_at,
    hitCount: row.hit_count
  }
}
