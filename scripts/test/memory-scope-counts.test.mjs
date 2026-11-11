/**
 * A5 计数守恒（P1 起：用户 × 人设）。
 *
 * P1 判据集变更（T1）说明：
 * - 旧版测的是「加 scope_id 不丢数据」的迁移；用户已批准直接丢弃旧数据（M6），
 *   迁移语义不存在了，所以第一组换成「旧库被重建 → 0 条」的**推导式**断言。
 * - 旧版测 `countByScope`；P1 起接口是 `countByUser` / `countByPersona`。
 * - 生产库那一段（原 J-21）改成「旧库副本打开后为 0」：这才是 P1 的真实可观察结果。
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

/**
 * 旧结构（P5 时代）：**带 scope_id**。P1 的 store 打开它必须整表重建。
 * 这份 DDL 逐字取自改造前的 store.ts:29-70，不是凭记忆写的。
 */
const OLD_SCHEMA = [
  `CREATE TABLE memories (
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
    "INSERT INTO memories (id, content, seg_text, weight, created_at, hit_count, scope_id) VALUES (?, ?, ?, 1, ?, 0, 'zone:root')"
  )
  for (const row of rows) insert.run(row.id, row.content, toIndexText(row.content), Date.now())
  const ids = db.prepare('SELECT id FROM memories ORDER BY id').all().map((item) => item.id)
  db.close()
  return ids
}

function columnsOf(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name)
  } finally {
    db.close()
  }
}

console.log('① 自建 5 条旧记忆 → P1 打开后整表重建（旧数据按用户决定丢弃）')
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
check('前置：旧库确实有 5 条', beforeIds.length === 5, beforeIds.length)
check('前置：旧库确实带 scope_id', columnsOf(file).includes('scope_id'))

const store = new MemoryStore(file)
check('重建后条数 = 0（不是"迁移后相等"——语义已变）', store.count() === 0, store.count())
check('重建后 scope_id 列消失', !columnsOf(file).includes('scope_id'), columnsOf(file).join(','))
check('重建后 embedding 列仍在（J-02）', columnsOf(file).includes('embedding'))
const afterIds = store.list().map((item) => item.id).sort()
check('旧 id 一个都不在了（丢弃是彻底的）', beforeIds.filter((id) => afterIds.includes(id)).length === 0, afterIds.join(','))

console.log('② 新写入的计数：countByUser / countByPersona')
const A = { userId: 'u-1', personaId: 'default' }
const B = { userId: 'u-1', personaId: 'work' }
const C = { userId: 'u-2', personaId: 'default' }
store.upsert({ content: 'u1 default 一', ...A })
store.upsert({ content: 'u1 default 二', ...A })
store.upsert({ content: 'u1 work 一', ...B })
store.upsert({ content: 'u2 default 一', ...C })

const byUser = Object.fromEntries(store.countByUser().map((row) => [row.userId, row.count]))
check('countByUser: u-1 = 3', byUser['u-1'] === 3, JSON.stringify(byUser))
check('countByUser: u-2 = 1', byUser['u-2'] === 1, JSON.stringify(byUser))
const byPersona = Object.fromEntries(store.countByPersona('u-1').map((row) => [row.personaId, row.count]))
check('countByPersona: u-1/default = 2', byPersona.default === 2, JSON.stringify(byPersona))
check('countByPersona: u-1/work = 1', byPersona.work === 1, JSON.stringify(byPersona))
check('总数守恒：3 + 1 = 4', store.count() === 4, store.count())
store.close()

console.log('③ 生产库副本：只报告实测数字（原 J-21 的观察项，P1 变成"旧库副本打开后为 0"）')
const production = path.join(process.env.APPDATA ?? '', 'Nahida Chat', 'memory.db')
const backup = production + '.p5-backup'
let prodNote = '生产库备份不存在（首次运行）'
if (fs.existsSync(backup)) {
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-prod-'))
  const copy = path.join(copyDir, 'memory.db')
  fs.copyFileSync(backup, copy)
  const raw = new DatabaseSync(copy, { readOnly: true })
  const before = raw.prepare('SELECT COUNT(*) AS n FROM memories').get().n
  const colsBefore = raw.prepare('PRAGMA table_info(memories)').all().map((row) => row.name)
  raw.close()
  const opened = new MemoryStore(copy)
  const after = opened.count()
  prodNote =
    '生产库副本 ' +
    String(before) +
    ' → ' +
    String(after) +
    ' 条；旧列含 scope_id=' +
    String(colsBefore.includes('scope_id'))
  check('生产库副本打开后为 0 条（旧 zone 数据已按用户决定丢弃）', after === 0, prodNote)
  check('生产库副本打开后不再有 scope_id', !columnsOf(copy).includes('scope_id'))
  opened.close()
  console.log('    实测：' + prodNote)
} else {
  check('生产库备份存在（P3 前置）', false, backup)
}

done()
