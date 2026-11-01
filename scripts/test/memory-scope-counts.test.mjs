/**
 * A5 计数守恒（P5 G4）：迁移不许丢行，也不许改 id。
 *
 * J-21：本机生产库是 **0 条**，所以「条数不变」在生产库上是**空转判据**。
 * 因此这里有两组：
 *  ① 自建 5 条 → 真断言「集合差为空」
 *  ② 生产库**副本** → 只报告实测数字（0 → 0 也照写），不拿它当唯一证据
 *
 * 跑法：node scripts/test/memory-scope-counts.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-counts-'))
installElectronStub(userData)

const mod = await bundleModule(
  'memory-counts',
  [
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`,
    `export { toIndexText } from '${p('src/main/features/rag/tokenize.ts')}'`
  ].join('\n')
)
const { MemoryStore, toIndexText } = mod

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

function buildOldDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  for (const statement of OLD_SCHEMA) db.exec(statement)
  const insert = db.prepare(
    'INSERT INTO memories (id, content, seg_text, weight, created_at, hit_count) VALUES (?, ?, ?, 1, ?, 0)'
  )
  for (const row of rows) insert.run(row.id, row.content, toIndexText(row.content), Date.now())
  const ids = db.prepare('SELECT id FROM memories ORDER BY id').all().map((item) => item.id)
  db.close()
  return ids
}

function idsOf(store) {
  return store.list().map((item) => item.id).sort()
}

console.log('① 自建 5 条：迁移前后集合差为空')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-counts-db-'))
const file = path.join(dir, 'memory.db')
const rows = [
  { id: 'c-1', content: '我住在上海' },
  { id: 'c-2', content: '我对花生过敏' },
  { id: 'c-3', content: '我深夜工作' },
  { id: 'c-4', content: '我养了一只猫' },
  { id: 'c-5', content: '我喜欢吃辣' }
]
const beforeIds = buildOldDb(file, rows)
const store = new MemoryStore(file)
const afterIds = idsOf(store)
check('迁移前 5 条', beforeIds.length === 5, beforeIds.length)
check('迁移后条数相等', afterIds.length === beforeIds.length, afterIds.length + ' vs ' + beforeIds.length)
const missing = beforeIds.filter((id) => !afterIds.includes(id))
const extra = afterIds.filter((id) => !beforeIds.includes(id))
check('旧 id 一个不少', missing.length === 0, missing.join(','))
check('没有凭空多出来的 id', extra.length === 0, extra.join(','))

console.log('② 生产库副本：只报告实测数字（J-21）')
const production = path.join(process.env.APPDATA ?? '', 'Nahida Chat', 'memory.db')
const backup = production + '.p5-backup'
let prodNote = '生产库不存在（首次运行）'
if (fs.existsSync(backup)) {
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-prod-'))
  const copy = path.join(copyDir, 'memory.db')
  fs.copyFileSync(backup, copy)
  const raw = new DatabaseSync(copy, { readOnly: true })
  const before = raw.prepare('SELECT COUNT(*) AS n FROM memories').get().n
  raw.close()
  const migrated = new MemoryStore(copy)
  const after = migrated.list().length
  prodNote = '生产库副本 ' + String(before) + ' → ' + String(after) + ' 条'
  check('生产库副本迁移前后条数相等（数字见左）', before === after, prodNote)
  check('生产库副本迁移后 scope 全部是 zone:root', migrated.list().every((item) => item.scopeId === 'zone:root'))
} else {
  check('生产库备份存在（P3 前置）', false, backup)
}
console.log('    实测：' + prodNote)

done()
