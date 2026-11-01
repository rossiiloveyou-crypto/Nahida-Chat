/**
 * A3 记忆库迁移（P5 G4）：加 scope_id 不丢数据（J-20 / J-21）。
 *
 * ⚠️ 被测对象是**自建的旧 schema 库**，不是生产库：本机生产库是 0 条（E13），
 * 拿它验「不丢数据」无论实现对错都会绿（J-21）。
 * 生产库只做基线对照，见 A5。
 *
 * 跑法：node scripts/test/memory-scope-migration.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-migration-'))
installElectronStub(userData)

const mod = await bundleModule(
  'memory-migration',
  [
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`,
    `export { toIndexText, toMatchQuery } from '${p('src/main/features/rag/tokenize.ts')}'`
  ].join('\n')
)
const { MemoryStore, toIndexText, toMatchQuery } = mod

/** 旧 schema：与 P4 之前完全一致（10 列，没有 scope_id） */
const OLD_SCHEMA = [
  `CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    seg_text TEXT NOT NULL,
    source_session_id TEXT,
    source_message_id TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    embedding BLOB,
    created_at INTEGER NOT NULL,
    last_hit_at INTEGER,
    hit_count INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX idx_memories_created ON memories(created_at DESC)',
  "CREATE VIRTUAL TABLE memories_fts USING fts5(seg_text, content='memories', content_rowid='rowid', tokenize='unicode61')",
  `CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, seg_text) VALUES (new.rowid, new.seg_text);
  END`,
  `CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, seg_text) VALUES ('delete', old.rowid, old.seg_text);
  END`,
  `CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, seg_text) VALUES ('delete', old.rowid, old.seg_text);
    INSERT INTO memories_fts(rowid, seg_text) VALUES (new.rowid, new.seg_text);
  END`
]

function makeOldDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  for (const statement of OLD_SCHEMA) db.exec(statement)
  const insert = db.prepare(
    'INSERT INTO memories (id, content, seg_text, weight, created_at, hit_count) VALUES (?, ?, ?, 1, ?, 0)'
  )
  for (const row of rows) insert.run(row.id, row.content, toIndexText(row.content), Date.now())
  const count = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
  db.close()
  return count
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-old-'))
const file = path.join(dir, 'memory.db')
const rows = [
  { id: 'm-1', content: '我住在上海' },
  { id: 'm-2', content: '我对花生过敏' },
  { id: 'm-3', content: '我深夜工作' }
]
const beforeCount = makeOldDb(file, rows)
check('自建旧库：迁移前 3 条（不是拿空库自证）', beforeCount === 3, beforeCount)

console.log('1 · 迁移后 3 条仍在，scope 全部回落 zone:root')
const store = new MemoryStore(file)
const after = store.list()
check('条数不变', after.length === 3, after.length)
check(
  '每一条 scopeId 都是 zone:root',
  after.every((item) => item.scopeId === 'zone:root'),
  after.map((item) => item.scopeId).join(',')
)

console.log('2 · 同一库再打开一次不抛（判列存在生效）')
let reopened = null
let threw = false
try {
  reopened = new MemoryStore(file)
  reopened.list()
} catch (error) {
  threw = true
  console.log(String(error))
}
check('没有抛', threw === false)
check('第二次打开仍是 3 条', reopened.list().length === 3, reopened.list().length)

console.log('3 · 全新库打开后直接有 scope_id 列（CREATE 已带列）')
const freshFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-fresh-')), 'memory.db')
const fresh = new MemoryStore(freshFile)
fresh.list()
const freshDb = new DatabaseSync(freshFile, { readOnly: true })
const freshColumns = freshDb.prepare('PRAGMA table_info(memories)').all().map((row) => row.name)
freshDb.close()
check('全新库一开始就有 scope_id', freshColumns.includes('scope_id'), freshColumns.join(','))

console.log('4 · 迁移后 COUNT(memories) == COUNT(memories_fts)（S3）')
const raw = new DatabaseSync(file, { readOnly: true })
const counts = {
  memories: raw.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
  fts: raw.prepare('SELECT COUNT(*) AS n FROM memories_fts').get().n
}
raw.close()
check('两侧相等', counts.memories === counts.fts, counts.memories + ' vs ' + counts.fts)

console.log('5 · 旧条目仍能被检索（E5：必须走二元组 seg_text）')
const hits = store.keywordSearchIn(toMatchQuery('上海'), 10, ['zone:root'])
check('关键词检索命中迁移前的条目', hits.length > 0 && hits[0].id === 'm-1', JSON.stringify(hits))

console.log('6 · countByScope')
const groups = store.countByScope()
check(
  '只有 zone:root 一组，count=3',
  groups.length === 1 && groups[0].scopeId === 'zone:root' && groups[0].count === 3,
  JSON.stringify(groups)
)

console.log('7 · reassignScope 搬迁')
const moved = store.reassignScope('zone:root', 'zone:A')
const afterMove = store.countByScope().sort((a, b) => a.scopeId.localeCompare(b.scopeId))
check('搬了 3 条', moved === 3, moved)
check(
  '两个域的计数都对',
  afterMove.length === 1 && afterMove[0].scopeId === 'zone:A' && afterMove[0].count === 3,
  JSON.stringify(afterMove)
)

done()
