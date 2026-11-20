import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { MEMORY_STORE_MAX_CHARS } from '@shared/constants'
import { DEFAULT_PERSONA_ID } from '@shared/persona'
import type { PersonaIdentity, UserPersonaRow } from '@shared/persona'
import type { MemoryEntry, PersonaHistoryEntry } from '@shared/types'
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
 *
 * ── P1（数据模型重建）────────────────────────────────────────────────
 * 分区键从「域（scope_id）」换成两级租户「用户 × 人设」（user_id, persona_id）。
 * - 一个库文件承载**全部**用户：不按用户拆文件（M20）。所有查询强制带租户条件。
 * - 旧库**不迁移**：检测到 scope_id 列就整表重建（用户已批准丢弃旧数据，M6）。
 *   不可逆点靠 task-Memory/backup-<ts>/ 的物理备份兜底。
 * - `embedding BLOB` 必须保留（M2 / J-02）：向量检索是本任务的前提，不是可选项。
 */

/**
 * 建表语句。FTS5 用外部内容表，正文只存一份，避免两份数据不同步。
 *
 * 🔴 `content_rowid` 必须指向整数 rowid，不能指向 TEXT 主键，
 *    否则 INSERT 时报 `datatype mismatch`（本项目已经踩过一次）。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS user_personas (
    user_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, persona_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_personas_user ON user_personas(user_id, is_active)`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    content TEXT NOT NULL,
    seg_text TEXT NOT NULL,
    source_session_id TEXT,
    source_message_id TEXT,
    source_message_index INTEGER,
    weight REAL NOT NULL DEFAULT 1.0,
    embedding BLOB,
    created_at INTEGER NOT NULL,
    last_hit_at INTEGER,
    hit_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_tenant ON memories(user_id, persona_id, created_at DESC)`,
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
  END`,
  `CREATE TABLE IF NOT EXISTS persona_chat_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    session_id TEXT NOT NULL,
    chat_type TEXT NOT NULL,
    chat_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_persona_history
     ON persona_chat_history(user_id, persona_id, created_at DESC)`
]

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

/**
 * 旧结构 → 整表重建（P1，不可逆）。
 *
 * 为什么不是迁移：`CREATE TABLE IF NOT EXISTS` 对已存在的旧表**什么都不做**，
 * 所以不显式删表就永远留着一个旧表，新代码往里插入就报
 * `NOT NULL constraint failed: memories.user_id`。用户已批准直接丢弃旧数据（M6）。
 *
 * 🔴 判定必须比「有 scope_id」宽：本机实测存在**更老的库**（`memory.db.p5-backup`），
 *    它既没有 scope_id 也没有 user_id/persona_id。只认 scope_id 会让这种库
 *    绕过闸门，然后在第一条查询上 `no such column: user_id` 整个失能。
 *    判定口径改为「memories 存在，且缺少任一新结构列」。
 *
 * 🔴 顺序不可交换：先删虚拟表与触发器，再删主表。
 *    残留的 FTS 外部内容表指向一个不存在的表，会让下次建的触发器在
 *    INSERT 时报 `datatype mismatch`。
 */
function resetLegacySchema(db: DatabaseSync): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
    .all() as unknown as Array<{ name: string }>
  // 全新库：主表都不存在，交给 SCHEMA 建，不做任何破坏性动作。
  if (tables.length === 0) return

  const columns = (db.prepare('PRAGMA table_info(memories)').all() as unknown as Array<{ name: string }>).map(
    (row) => row.name
  )
  const isCurrent = columns.includes('user_id') && columns.includes('persona_id') && columns.includes('embedding')
  if (isCurrent) return

  console.info('[memory] 检测到旧 zone 结构，已按用户决定重建（旧记忆丢弃）')
  db.exec('DROP TRIGGER IF EXISTS memories_ai')
  db.exec('DROP TRIGGER IF EXISTS memories_ad')
  db.exec('DROP TRIGGER IF EXISTS memories_au')
  db.exec('DROP TABLE IF EXISTS memories_fts')
  db.exec('DROP TABLE IF EXISTS memories')
}

/** 带向量的完整行，只在检索路径内部用 */
export interface StoredMemory extends MemoryEntry {
  embedding: Float32Array | null
}

interface MemoryRow {
  id: string
  user_id: string
  persona_id: string
  content: string
  source_session_id: string | null
  source_message_id: string | null
  source_message_index: number | null
  weight: number
  embedding: Uint8Array | null
  created_at: number
  last_hit_at: number | null
  hit_count: number
}

interface PersonaRow {
  user_id: string
  persona_id: string
  is_active: number
  created_at: number
}

interface HistoryRow {
  id: string
  user_id: string
  persona_id: string
  role: string
  content: string
  session_id: string
  chat_type: string
  chat_id: string | null
  created_at: number
}

/** 把租户列表编成 `(a AND b) OR (c AND d)`；调用方必须先处理空数组（空 IN 是语法错误） */
function tenantClause(tenants: Array<{ userId: string; personaId: string }>, prefix = ''): {
  sql: string
  params: string[]
} {
  const parts: string[] = []
  const params: string[] = []
  for (const tenant of tenants) {
    parts.push('(' + prefix + 'user_id = ? AND ' + prefix + 'persona_id = ?)')
    params.push(tenant.userId, tenant.personaId)
  }
  return { sql: '(' + parts.join(' OR ') + ')', params }
}

const STORY_ARCHIVE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS story_message_owners (
    story_id TEXT NOT NULL, branch_id TEXT NOT NULL, message_id TEXT NOT NULL,
    tenant_user TEXT NOT NULL, tenant_persona TEXT NOT NULL,
    PRIMARY KEY (story_id, branch_id, message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS story_rounds (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    round_index INTEGER NOT NULL,
    tenant_user TEXT NOT NULL,
    tenant_persona TEXT NOT NULL,
    first_message_id TEXT NOT NULL,
    last_message_id TEXT NOT NULL,
    content_version TEXT NOT NULL,
    roles TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    valid INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS story_chunks (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES story_rounds(id),
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    embedding BLOB,
    content_version TEXT NOT NULL,
    indexed_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_story_rounds_branch ON story_rounds(story_id, branch_id, round_index)',
  'CREATE INDEX IF NOT EXISTS idx_story_chunks_round ON story_chunks(round_id)',
  // Completion receipts contain no source text. Chat persists stopped replies as done, so status must survive restart.
  `CREATE TABLE IF NOT EXISTS story_archive_status (
    branch_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    content_version TEXT NOT NULL,
    interrupted INTEGER NOT NULL,
    PRIMARY KEY (branch_id, message_id)
  )`
]

export interface StoryRoundInput {
  storyId: string
  branchId: string
  roundIndex: number
  tenantUser: string
  tenantPersona: string
  firstMessageId: string
  lastMessageId: string
  messageIds?: string[]
  contentVersion: string
  roles: string[]
  startedAt: number
  chunks: Array<{ index: number; text: string; startOffset: number; endOffset: number }>
}

export interface StoryRoundRow {
  id: string
  story_id: string
  branch_id: string
  round_index: number
  tenant_user: string
  tenant_persona: string
  first_message_id: string
  last_message_id: string
  content_version: string
  roles: string
  started_at: number
  indexed_at: number
  valid: number
}

export interface StoryChunkRow {
  id: string
  round_id: string
  chunk_index: number
  text: string
  start_offset: number
  end_offset: number
  embedding: Uint8Array | null
  content_version: string
  indexed_at: number
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
      // 🔴 WAL 必须在任何 DDL 之前设置：resetLegacySchema 要删表。
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      // 旧结构闸门必须在 SCHEMA 之前：CREATE TABLE IF NOT EXISTS 不会重建旧表。
      resetLegacySchema(db)
      for (const statement of SCHEMA) db.exec(statement)
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

  /** 按创建时间倒序列出**全部**记忆（跨租户；设置页总览用） */
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

  /** 单人单设的全部记忆，按创建时间倒序 */
  listByTenant(userId: string, personaId: string): MemoryEntry[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare('SELECT * FROM memories WHERE user_id = ? AND persona_id = ? ORDER BY created_at DESC')
        .all(userId, personaId) as unknown as MemoryRow[]
      return rows.map(toEntry)
    } catch (error) {
      console.warn('[memory] 按租户读取失败', error)
      return []
    }
  }

  /** 按人聚合条数（设置页「按人」列表） */
  countByUser(): Array<{ userId: string; count: number }> {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare('SELECT user_id AS uid, COUNT(*) AS total FROM memories GROUP BY user_id ORDER BY uid')
        .all() as unknown as Array<{ uid: string; total: number }>
      return rows.map((row) => ({ userId: row.uid, count: row.total }))
    } catch (error) {
      console.warn('[memory] 按人统计失败', error)
      return []
    }
  }

  /** 有事实、人设注册或历史记录的用户并集，供面板避免遗漏空记忆租户。 */
  listUserIds(): string[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare(
          `SELECT user_id AS uid FROM memories
           UNION SELECT user_id AS uid FROM user_personas
           UNION SELECT user_id AS uid FROM persona_chat_history
           ORDER BY uid`
        )
        .all() as unknown as Array<{ uid: string }>
      return rows.map((row) => row.uid)
    } catch (error) {
      console.warn('[memory] 用户列表读取失败', error)
      return []
    }
  }

  /** 一个人下面各人设的条数（用户详情页） */
  countByPersona(userId: string): Array<{ personaId: string; count: number }> {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare(
          'SELECT persona_id AS pid, COUNT(*) AS total FROM memories WHERE user_id = ? GROUP BY persona_id ORDER BY pid'
        )
        .all(userId) as unknown as Array<{ pid: string; total: number }>
      return rows.map((row) => ({ personaId: row.pid, count: row.total }))
    } catch (error) {
      console.warn('[memory] 按人设统计失败', error)
      return []
    }
  }

  /** 该用户该人设的人设历史条数。 */
  countHistory(userId: string, personaId: string): number {
    const db = this.open()
    if (!db) return 0
    try {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM persona_chat_history WHERE user_id = ? AND persona_id = ?')
        .get(userId, personaId) as unknown as { n?: number } | undefined
      return Number(row?.n ?? 0)
    } catch (error) {
      console.warn('[memory] 人设历史计数失败', error)
      return 0
    }
  }

  /**
   * 带向量的行，限定在一组租户内。空数组 = 空结果（fail-closed），不是"不过滤"。
   * 这条 fail-closed 是隐私边界：把配置错误变成"退回全库"等于跨用户泄漏。
   */
  allWithEmbeddingInTenants(tenants: Array<{ userId: string; personaId: string }>): StoredMemory[] {
    if (tenants.length === 0) return []
    const db = this.open()
    if (!db) return []
    try {
      const clause = tenantClause(tenants)
      const rows = db
        .prepare('SELECT * FROM memories WHERE embedding IS NOT NULL AND ' + clause.sql)
        .all(...clause.params) as unknown as MemoryRow[]
      return rows.map((row) => ({ ...toEntry(row), embedding: row.embedding ? fromBlob(row.embedding) : null }))
    } catch (error) {
      console.warn('[memory] 按租户读取向量失败', error)
      return []
    }
  }

  /** FTS5 关键词检索，限定在租户内。空 tenants = 空结果。 */
  keywordSearchInTenants(
    matchQuery: string,
    tenants: Array<{ userId: string; personaId: string }>,
    limit: number
  ): Array<{ id: string; score: number }> {
    if (!matchQuery || tenants.length === 0) return []
    const db = this.open()
    if (!db) return []
    try {
      const clause = tenantClause(tenants, 'm.')
      const rows = db
        .prepare(
          `SELECT m.id AS id, bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ? AND ` +
            clause.sql +
            `
           ORDER BY rank
           LIMIT ?`
        )
        .all(matchQuery, ...clause.params, limit) as unknown as Array<{ id: string; rank: number }>
      return rows.map((row) => ({ id: row.id, score: -row.rank }))
    } catch (error) {
      console.warn('[memory] 按租户关键词检索失败', error)
      return []
    }
  }

  /** 取带向量的全部行（跨租户）。**只服务"未指定租户"的兼容路径**，生产必须传租户。 */
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
   * FTS5 关键词检索（跨租户），返回 [id, 原始 bm25 分数]。
   * bm25() 越小越相关（SQLite 返回负值），这里取负转成越大越好。
   * 同上：只服务"未指定租户"的兼容路径。
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

  /** 新增或更新一条记忆；embedding 由调用方算好传入。租户必填（忘了赋值 = 跨用户串数据） */
  upsert(input: {
    id?: string
    content: string
    userId: string
    personaId: string
    weight?: number
    sourceSessionId?: string | null
    sourceMessageId?: string | null
    /** 产生这条记忆时，它在自己那条分支里的消息下标（P6 / T12）；缺省 null */
    sourceMessageIndex?: number | null
    embedding?: Float32Array | null
  }): MemoryEntry | null {
    const db = this.open()
    if (!db) return null
    const content = input.content.trim().slice(0, MEMORY_STORE_MAX_CHARS)
    if (!content) return null

    try {
      const id = input.id?.trim() || randomUUID()
      const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id)
      const embedding = input.embedding ?? null

      if (existing) {
        // 更新：没给新 embedding 就保留旧的，避免"改个错别字就丢向量"。
        if (embedding) {
          db.prepare(
            'UPDATE memories SET content = ?, seg_text = ?, weight = COALESCE(?, weight), embedding = ?, user_id = ?, persona_id = ?, source_message_index = COALESCE(?, source_message_index) WHERE id = ?'
          ).run(
            content,
            toIndexText(content),
            input.weight ?? null,
            toBlob(embedding),
            input.userId,
            input.personaId,
            input.sourceMessageIndex ?? null,
            id
          )
        } else {
          db.prepare(
            'UPDATE memories SET content = ?, seg_text = ?, weight = COALESCE(?, weight), user_id = ?, persona_id = ?, source_message_index = COALESCE(?, source_message_index) WHERE id = ?'
          ).run(
            content,
            toIndexText(content),
            input.weight ?? null,
            input.userId,
            input.personaId,
            input.sourceMessageIndex ?? null,
            id
          )
        }
      } else {
        db.prepare(
          `INSERT INTO memories
            (id, user_id, persona_id, content, seg_text, source_session_id, source_message_id, source_message_index, weight, embedding, created_at, hit_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        ).run(
          id,
          input.userId,
          input.personaId,
          content,
          toIndexText(content),
          input.sourceSessionId ?? null,
          input.sourceMessageId ?? null,
          input.sourceMessageIndex ?? null,
          input.weight ?? 1,
          embedding ? toBlob(embedding) : null,
          Date.now()
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

  /** 清空本库的全部记忆（含所有租户）；人设注册表保留。故事库 / 主库都可用。 */
  clearAll(): void {
    const db = this.open()
    if (!db) return
    try {
      db.exec('DELETE FROM memories')
    } catch (error) {
      console.warn('[memory] 清空失败', error)
    }
  }

  /**
   * P7（M13）：清空本库的**全部租户数据** —— 三张表一起删，单事务。
   *
   * 🔴 为什么不能复用 clearAll()：它只 DELETE FROM memories，
   *    persona_chat_history（人设历史 / 剧情原文）与 user_personas（人设注册表）会原样留着。
   *    用户点「清空全部数据」之后还能 //list 看到人设、还能翻到旧对话 —— 那叫没清干净。
   * 🔴 顺序照 deleteByUser 的既有约定：历史 → 记忆 → 人设。单事务，失败回滚。
   */
  wipeAllTenants(): { histories: number; memories: number; personas: number } {
    const db = this.open()
    if (!db) return { histories: 0, memories: 0, personas: 0 }
    try {
      db.exec('BEGIN')
      const histories = Number(
        (db.prepare('DELETE FROM persona_chat_history').run() as unknown as { changes?: number })
          .changes ?? 0
      )
      const memories = Number(
        (db.prepare('DELETE FROM memories').run() as unknown as { changes?: number }).changes ?? 0
      )
      const personas = Number(
        (db.prepare('DELETE FROM user_personas').run() as unknown as { changes?: number }).changes ?? 0
      )
      db.exec('COMMIT')
      return { histories, memories, personas }
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 回滚失败时事务已被 SQLite 自动终止
      }
      console.warn('[memory] 清空全部租户失败，已回滚', error)
      return { histories: 0, memories: 0, personas: 0 }
    }
  }

  /**
   * 整人注销：该用户的**全部人设 + 全部历史 + 全部记忆**（M9）。
   * 🔴 必须在单个事务内完成，顺序：历史 → 记忆 → 人设表。
   *    中途失败回滚并返回全 0，绝不留下"人设没了但记忆还在"的孤儿。
   */
  deleteByUser(userId: string): { histories: number; memories: number; personas: number } {
    const db = this.open()
    if (!db) return { histories: 0, memories: 0, personas: 0 }
    let histories = 0
    let memories = 0
    let personas = 0
    try {
      db.exec('BEGIN')
      histories = Number(
        (db.prepare('DELETE FROM persona_chat_history WHERE user_id = ?').run(userId) as unknown as {
          changes?: number
        }).changes ?? 0
      )
      memories = Number(
        (db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId) as unknown as {
          changes?: number
        }).changes ?? 0
      )
      personas = Number(
        (db.prepare('DELETE FROM user_personas WHERE user_id = ?').run(userId) as unknown as {
          changes?: number
        }).changes ?? 0
      )
      db.exec('COMMIT')
      return { histories, memories, personas }
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 回滚失败时事务已被 SQLite 自动终止，无需处理
      }
      console.warn('[memory] 整人注销失败，已回滚', error)
      return { histories: 0, memories: 0, personas: 0 }
    }
  }

  /** 删掉一个人设的全部记忆 + 历史 + 注册表行。返回删掉的记忆条数。 */
  deleteByPersona(userId: string, personaId: string): number {
    const db = this.open()
    if (!db) return 0
    try {
      db.exec('BEGIN')
      db.prepare('DELETE FROM persona_chat_history WHERE user_id = ? AND persona_id = ?').run(userId, personaId)
      const removed = Number(
        (db.prepare('DELETE FROM memories WHERE user_id = ? AND persona_id = ?').run(userId, personaId) as unknown as {
          changes?: number
        }).changes ?? 0
      )
      db.prepare('DELETE FROM user_personas WHERE user_id = ? AND persona_id = ?').run(userId, personaId)
      db.exec('COMMIT')
      return removed
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 同上
      }
      console.warn('[memory] 人设删除失败，已回滚', error)
      return 0
    }
  }

  /**
   * 注册人设。`activate = true` 时先清零该用户全部 is_active，再置 1 ——
   * 🔴 两条语句必须在**同一事务**内，否则崩溃会留下 0 个或 2 个激活人设。
   */
  upsertPersona(userId: string, personaId: string, activate?: boolean): void {
    const db = this.open()
    if (!db) return
    try {
      db.exec('BEGIN')
      if (activate) {
        db.prepare('UPDATE user_personas SET is_active = 0 WHERE user_id = ? AND is_active = 1').run(userId)
        db.prepare(
          `INSERT INTO user_personas(user_id, persona_id, is_active, created_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(user_id, persona_id) DO UPDATE SET is_active = 1`
        ).run(userId, personaId, Date.now())
      } else {
        db.prepare(
          `INSERT INTO user_personas(user_id, persona_id, is_active, created_at)
           VALUES (?, ?, 0, ?)
           ON CONFLICT(user_id, persona_id) DO NOTHING`
        ).run(userId, personaId, Date.now())
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 同上
      }
      console.warn('[memory] 人设注册失败', error)
    }
  }

  /** 该用户的全部人设，按创建时间升序 */
  listPersonas(userId: string): UserPersonaRow[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare(
          'SELECT user_id, persona_id, is_active, created_at FROM user_personas WHERE user_id = ? ORDER BY created_at ASC, persona_id ASC'
        )
        .all(userId) as unknown as PersonaRow[]
      return rows.map((row) => ({
        userId: row.user_id,
        personaId: row.persona_id,
        isActive: row.is_active === 1,
        createdAt: row.created_at
      }))
    } catch (error) {
      console.warn('[memory] 人设列表失败', error)
      return []
    }
  }

  /** 当前激活人设；无记录返回 null（**调用方负责自动注册 default**） */
  activePersona(userId: string): string | null {
    const db = this.open()
    if (!db) return null
    try {
      const row = db
        .prepare('SELECT persona_id FROM user_personas WHERE user_id = ? AND is_active = 1 LIMIT 1')
        .get(userId) as unknown as { persona_id: string } | undefined
      return row ? row.persona_id : null
    } catch (error) {
      console.warn('[memory] 激活人设读取失败', error)
      return null
    }
  }

  /**
   * 删除人设。**拒绝删 default，也拒绝删当前激活的那个** ——
   * 删掉激活人设会让该用户下一次消息无处可写。
   */
  deletePersona(userId: string, personaId: string): boolean {
    if (personaId === DEFAULT_PERSONA_ID) return false
    if (this.activePersona(userId) === personaId) return false
    const db = this.open()
    if (!db) return false
    try {
      db.prepare('DELETE FROM user_personas WHERE user_id = ? AND persona_id = ?').run(userId, personaId)
      return true
    } catch (error) {
      console.warn('[memory] 人设删除失败', error)
      return false
    }
  }

  /** 写一条「该用户在该人设下」的往来 */
  appendHistory(entry: PersonaHistoryEntry): void {
    const db = this.open()
    if (!db) return
    try {
      db.prepare(
        `INSERT OR REPLACE INTO persona_chat_history
          (id, user_id, persona_id, role, content, session_id, chat_type, chat_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.id,
        entry.userId,
        entry.personaId,
        entry.role,
        entry.content,
        entry.sessionId,
        entry.chatType,
        entry.chatId ?? null,
        entry.createdAt
      )
    } catch (error) {
      console.warn('[memory] 人设历史写入失败', error)
    }
  }

  /** 该用户该人设的近期聊天，按时间倒序 */
  recentHistory(userId: string, personaId: string, limit: number): PersonaHistoryEntry[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare(
          `SELECT * FROM persona_chat_history
           WHERE user_id = ? AND persona_id = ?
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(userId, personaId, limit) as unknown as HistoryRow[]
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        personaId: row.persona_id,
        role: row.role === 'assistant' ? 'assistant' : 'user',
        content: row.content,
        sessionId: row.session_id,
        chatType: row.chat_type === 'private' || row.chat_type === 'group' ? row.chat_type : 'desktop',
        chatId: row.chat_id,
        createdAt: row.created_at
      }))
    } catch (error) {
      console.warn('[memory] 人设历史读取失败', error)
      return []
    }
  }

  /** Archive failures propagate only to the background scheduler, never the chat path. */
  private archiveDb(): DatabaseSync {
    // Fact calls retain their original fail-once semantics; an archive attempt may retry next turn.
    if (!this.db) this.failed = false
    const db = this.open()
    if (!db) throw new Error('故事归档数据库不可用')
    // Lazy and repeatable: main memory.db never gets story tables; old story DBs gain them on first archive.
    for (const statement of STORY_ARCHIVE_SCHEMA) db.exec(statement)
    return db
  }

  setStoryMessageState(branchId: string, messageId: string, version: string, interrupted: boolean): void {
    this.archiveDb().prepare(`INSERT INTO story_archive_status
      (branch_id, message_id, content_version, interrupted) VALUES (?, ?, ?, ?)
      ON CONFLICT(branch_id, message_id) DO UPDATE SET
        content_version=excluded.content_version, interrupted=excluded.interrupted`)
      .run(branchId, messageId, version, interrupted ? 1 : 0)
  }

  getStoryMessageState(branchId: string, messageId: string, version: string): boolean | null {
    if (!branchId || !messageId || !version) return null
    const row = this.archiveDb().prepare(`SELECT interrupted FROM story_archive_status
      WHERE branch_id = ? AND message_id = ? AND content_version = ?`)
      .get(branchId, messageId, version) as { interrupted: number } | undefined
    return row ? row.interrupted === 1 : null
  }

  isStoryMessageInterrupted(branchId: string, messageId: string, version: string): boolean {
    return this.getStoryMessageState(branchId, messageId, version) === true
  }

  getStoryRound(storyId: string, branchId: string, roundIndex: number): StoryRoundRow | null {
    if (!storyId || !branchId) return null
    return this.archiveDb().prepare(
      'SELECT * FROM story_rounds WHERE story_id = ? AND branch_id = ? AND round_index = ?'
    ).get(storyId, branchId, roundIndex) as unknown as StoryRoundRow ?? null
  }

  /** Stable ownership evidence includes legacy round endpoints; never infer ownership from a round slot. */
  getStoryMessageOwners(storyId: string, branchId: string, messageIds: string[]):
    Array<{ message_id: string; tenant_user: string; tenant_persona: string }> {
    if (!storyId || !branchId || messageIds.length === 0 || messageIds.some((id) => !id)) return []
    const db = this.archiveDb()
    const legacy = db.prepare(`SELECT first_message_id AS message_id, tenant_user, tenant_persona
      FROM story_rounds WHERE story_id = ? AND branch_id = ?
      UNION SELECT last_message_id AS message_id, tenant_user, tenant_persona
      FROM story_rounds WHERE story_id = ? AND branch_id = ?`)
      .all(storyId, branchId, storyId, branchId) as unknown as
        Array<{ message_id: string; tenant_user: string; tenant_persona: string }>
    const insert = db.prepare(`INSERT OR IGNORE INTO story_message_owners
      (story_id, branch_id, message_id, tenant_user, tenant_persona) VALUES (?, ?, ?, ?, ?)`)
    for (const row of legacy) insert.run(storyId, branchId, row.message_id, row.tenant_user, row.tenant_persona)
    const owners = db.prepare(`SELECT message_id, tenant_user, tenant_persona FROM story_message_owners
      WHERE story_id = ? AND branch_id = ?`).all(storyId, branchId) as unknown as typeof legacy
    const selected = new Set(messageIds)
    return [...owners, ...legacy].filter((row) => selected.has(row.message_id))
  }

  /** Metadata only; source text must still be decoded through listStoryChunks. */
  listStoryRounds(storyId: string, tenants: PersonaIdentity[], branches: string[]): StoryRoundRow[] {
    if (typeof storyId !== 'string' || !storyId.trim() || !Array.isArray(tenants) ||
        tenants.length === 0 || !Array.isArray(branches) || branches.length === 0 ||
        tenants.some((tenant) => !tenant || typeof tenant.userId !== 'string' ||
          !tenant.userId.trim() || typeof tenant.personaId !== 'string' || !tenant.personaId.trim()) ||
        branches.some((branch) => typeof branch !== 'string' || !branch.trim())) return []
    const tenantSql = tenants.map(() => '(tenant_user = ? AND tenant_persona = ?)').join(' OR ')
    return this.archiveDb().prepare(`SELECT * FROM story_rounds
      WHERE story_id = ? AND valid = 1 AND (${tenantSql})
        AND branch_id IN (${branches.map(() => '?').join(',')})
        AND length(trim(branch_id)) > 0 AND length(trim(first_message_id)) > 0
        AND length(trim(last_message_id)) > 0 AND length(trim(content_version)) > 0
        AND round_index >= 0 AND round_index = CAST(round_index AS INTEGER)
      ORDER BY round_index ASC, branch_id ASC, id ASC`)
      .all(storyId, ...tenants.flatMap((tenant) => [tenant.userId, tenant.personaId]),
        ...branches) as unknown as StoryRoundRow[]
  }

  listStoryChunks(roundId: string): StoryChunkRow[] {
    const rows = this.archiveDb().prepare(
      'SELECT * FROM story_chunks WHERE round_id = ? ORDER BY chunk_index'
    ).all(roundId) as unknown as Array<Omit<StoryChunkRow, 'text'> & { text: string | Uint8Array }>
    // SQLite TEXT is UTF-8. Only malformed UTF-16 uses its BLOB storage class to avoid U+FFFD replacement.
    return rows.map((row) => {
      if (typeof row.text !== 'string') row.text = Buffer.from(row.text).toString('utf16le')
      return row as StoryChunkRow
    })
  }

  /** Unchanged versions are strict no-ops, including timestamps and existing embeddings. */
  upsertStoryRound(input: StoryRoundInput): boolean {
    if (!input.storyId.trim() || !input.branchId.trim() || !input.tenantUser.trim() ||
        !input.tenantPersona.trim() || !input.firstMessageId || !input.lastMessageId ||
        !Number.isSafeInteger(input.roundIndex) || input.roundIndex < 0 || !input.contentVersion) {
      throw new Error('故事归档标识缺失或非法')
    }
    const db = this.archiveDb()
    const id = input.storyId + ':' + input.branchId + ':' + input.roundIndex
    db.exec('BEGIN IMMEDIATE')
    try {
      const previous = db.prepare('SELECT * FROM story_rounds WHERE id = ?').get(id) as unknown as StoryRoundRow | undefined
      const messageIds = [...new Set([input.firstMessageId, input.lastMessageId, ...(input.messageIds ?? [])])]
      const owners = this.getStoryMessageOwners(input.storyId, input.branchId, messageIds)
      if (owners.some((owner) => owner.tenant_user !== input.tenantUser || owner.tenant_persona !== input.tenantPersona) ||
          (previous && (previous.tenant_user !== input.tenantUser || previous.tenant_persona !== input.tenantPersona) &&
            (owners.length === 0 || messageIds.includes(previous.first_message_id) || messageIds.includes(previous.last_message_id)))) {
        throw new Error('故事归档租户不匹配')
      }
      const rememberOwner = db.prepare(`INSERT OR IGNORE INTO story_message_owners
        (story_id, branch_id, message_id, tenant_user, tenant_persona) VALUES (?, ?, ?, ?, ?)`)
      for (const messageId of messageIds) {
        if (!messageId) throw new Error('故事归档消息标识缺失')
        rememberOwner.run(input.storyId, input.branchId, messageId, input.tenantUser, input.tenantPersona)
      }
      if (previous?.content_version === input.contentVersion && previous.valid === 1) {
        db.exec('COMMIT')
        return false
      }
      db.prepare('DELETE FROM story_chunks WHERE round_id = ?').run(id)
      const now = Date.now()
      db.prepare(`INSERT INTO story_rounds
        (id, story_id, branch_id, round_index, tenant_user, tenant_persona, first_message_id,
         last_message_id, content_version, roles, started_at, indexed_at, valid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET tenant_user=excluded.tenant_user, tenant_persona=excluded.tenant_persona,
          first_message_id=excluded.first_message_id,
          last_message_id=excluded.last_message_id, content_version=excluded.content_version,
          roles=excluded.roles, started_at=excluded.started_at, indexed_at=excluded.indexed_at, valid=1`)
        .run(id, input.storyId, input.branchId, input.roundIndex, input.tenantUser, input.tenantPersona,
          input.firstMessageId, input.lastMessageId, input.contentVersion, JSON.stringify(input.roles), input.startedAt, now)
      const insert = db.prepare(`INSERT INTO story_chunks
        (id, round_id, chunk_index, text, start_offset, end_offset, embedding, content_version, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      for (const chunk of input.chunks) {
        insert.run(id + ':' + chunk.index, id, chunk.index, Buffer.from(chunk.text, 'utf8').toString('utf8') === chunk.text
          ? chunk.text : Buffer.from(chunk.text, 'utf16le'), chunk.startOffset,
          chunk.endOffset, input.contentVersion, now)
      }
      db.exec('COMMIT')
      return true
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
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
    userId: row.user_id,
    personaId: row.persona_id,
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
