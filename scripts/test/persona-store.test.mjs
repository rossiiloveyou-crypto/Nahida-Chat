/**
 * P1 数据模型：用户 × 人设 租户化 + 旧库重建 + 向量保留。
 *
 * 本套件只测**数据层**（MemoryStore），不测检索公式、不测模型质量。
 * embedder 不参与：向量用一串确定的 Float32 直接塞进去，测的是「能不能原样读回」。
 *
 * 跑法：node scripts/test/persona-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-persona-store-'))
installElectronStub(userData)

const mod = await bundleModule(
  'persona-store',
  [`export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`].join('\n')
)
const { MemoryStore } = mod

const DIM = 1024
const ROOT = 'root'
const DEFAULT = 'default'

/** 旧结构：P5 时代的 memories（含 scope_id + source_message_index） */
const LEGACY_SCHEMA = [
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

function buildLegacyDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  for (const statement of LEGACY_SCHEMA) db.exec(statement)
  const insert = db.prepare(
    "INSERT INTO memories (id, content, seg_text, created_at, hit_count, scope_id) VALUES (?, ?, ?, ?, 0, 'zone:root')"
  )
  for (const row of rows) insert.run(row.id, row.content, row.content, Date.now())
  db.close()
}

function columnsOf(file, table) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name)
  } finally {
    db.close()
  }
}

function tablesOf(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare("select name from sqlite_master where type='table' order by name").all().map((row) => row.name)
  } finally {
    db.close()
  }
}

/* ═══════════════ 1–3：全新库的结构 ═══════════════ */
console.log('1 · 全新库：三张表都建出来')
const freshFile = path.join(userData, 'fresh', 'memory.db')
const fresh = new MemoryStore(freshFile)
check('MemoryStore 可用（打开成功）', fresh.healthy())
const freshTables = tablesOf(freshFile)
check(
  'user_personas / memories / persona_chat_history 三表存在',
  ['user_personas', 'memories', 'persona_chat_history'].every((name) => freshTables.includes(name)),
  freshTables.join(',')
)
fresh.close()

console.log('2 · 向量列必须保留（J-02）')
const freshCols = columnsOf(freshFile, 'memories')
check('memories 含 embedding 列', freshCols.includes('embedding'), freshCols.join(','))

console.log('3 · 旧 scope 列必须消失')
check('memories **不含** scope_id 列（等值断言）', freshCols.filter((name) => name === 'scope_id').length === 0, freshCols.join(','))

/* ═══════════════ 4–6：旧库重建 ═══════════════ */
console.log('4 · 旧库（带 scope_id）打开后自动重建')
const legacyFile = path.join(userData, 'legacy', 'memory.db')
buildLegacyDb(legacyFile, [
  { id: 'old-1', content: '旧记忆一' },
  { id: 'old-2', content: '旧记忆二' },
  { id: 'old-3', content: '旧记忆三' }
])
check('前置：旧库确实带 scope_id', columnsOf(legacyFile, 'memories').includes('scope_id'))

// 抓 console.info，断言日志真打出来了
const logged = []
const originalInfo = console.info
console.info = (...args) => {
  logged.push(args.map(String).join(' '))
  originalInfo.apply(console, args)
}
const rebuilt = new MemoryStore(legacyFile)
const rebuiltOk = rebuilt.healthy()
console.info = originalInfo
check('旧库重建后仍可用', rebuiltOk)
check(
  '日志含「已按用户决定重建」',
  logged.some((line) => line.includes('已按用户决定重建')),
  logged.join(' | ') || '(无日志)'
)

console.log('5 · 旧库重建后 memories 为空（旧数据丢弃）')
check('重建后 0 条', rebuilt.count() === 0, rebuilt.count())
check('重建后无 scope_id 列', !columnsOf(legacyFile, 'memories').includes('scope_id'))

console.log('6 · 第二次打开不重复重建、不报错')
rebuilt.close()
const again = new MemoryStore(legacyFile)
check('第二次打开仍可用', again.healthy())
check('第二次打开仍是 0 条（没有凭空重建出数据）', again.count() === 0, again.count())
again.close()

/* ═══════════════ 7–12：人设注册表 ═══════════════ */
const tenantDb = path.join(userData, 'tenant', 'memory.db')
const store = new MemoryStore(tenantDb)

console.log('7 · 新用户无记录 → activePersona 返回 null')
check('activePersona(null 用户) === null', store.activePersona('u-never-seen') === null)

console.log('8 · 注册并激活 default')
store.upsertPersona('u1', DEFAULT, true)
check("activePersona('u1') === 'default'", store.activePersona('u1') === DEFAULT, store.activePersona('u1'))

console.log('9 · 再激活 work → 只有 work 激活（守恒）')
store.upsertPersona('u1', 'work', true)
const activeCount = store.listPersonas('u1').filter((row) => row.isActive).length
check('切换后 SUM(is_active) = 1', activeCount === 1, activeCount)
check("activePersona('u1') === 'work'", store.activePersona('u1') === 'work', store.activePersona('u1'))
check('default 仍存在但未激活', store.listPersonas('u1').some((row) => row.personaId === DEFAULT && !row.isActive))

console.log('10 · listPersonas 返回 2 条，按创建时间升序')
const personas = store.listPersonas('u1')
check('2 条', personas.length === 2, personas.map((row) => row.personaId).join(','))
check(
  '顺序为 default → work',
  personas.map((row) => row.personaId).join(',') === DEFAULT + ',work',
  personas.map((row) => row.personaId).join(',')
)

console.log('11 · 拒绝删 default')
check("deletePersona('u1','default') === false", store.deletePersona('u1', DEFAULT) === false)

console.log('12 · 拒绝删当前激活人设')
check("deletePersona('u1','work') === false（它是激活项）", store.deletePersona('u1', 'work') === false)
check('两个保护都没把行删掉', store.listPersonas('u1').length === 2, store.listPersonas('u1').length)

/* ═══════════════ 13–15：租户隔离与聚合 ═══════════════ */
console.log('13 · 写 3 条到 A、2 条到 B：listByTenant 各得 3 / 2')
const A = { userId: 'u1', personaId: DEFAULT }
const B = { userId: 'u1', personaId: 'work' }
store.upsert({ content: 'A 人设记忆一', ...A })
store.upsert({ content: 'A 人设记忆二', ...A })
store.upsert({ content: 'A 人设记忆三', ...A })
store.upsert({ content: 'B 人设记忆一', ...B })
store.upsert({ content: 'B 人设记忆二', ...B })
const aRows = store.listByTenant(A.userId, A.personaId)
const bRows = store.listByTenant(B.userId, B.personaId)
check('A 人设 3 条', aRows.length === 3, aRows.length)
check('B 人设 2 条', bRows.length === 2, bRows.length)
check('A 的列表里没有 B 的内容', aRows.every((row) => !row.content.startsWith('B ')), aRows.map((r) => r.content).join(','))
check('B 的列表里没有 A 的内容', bRows.every((row) => !row.content.startsWith('A ')), bRows.map((r) => r.content).join(','))
check('读回的条目带正确的租户字段', aRows.every((row) => row.userId === A.userId && row.personaId === A.personaId))

console.log('14 · countByUser 对同一用户返回 5，且不出现第二条用户记录')
const byUser = store.countByUser()
const u1Count = byUser.find((row) => row.userId === 'u1')
check('u1 计数 = 5', u1Count && u1Count.count === 5, JSON.stringify(byUser))
check('只有一条 u1 记录', byUser.filter((row) => row.userId === 'u1').length === 1, byUser.length)

console.log('15 · countByPersona 返回 default=3 / work=2')
const byPersona = store.countByPersona('u1')
const map = Object.fromEntries(byPersona.map((row) => [row.personaId, row.count]))
check('default 3 条', map[DEFAULT] === 3, JSON.stringify(map))
check('work 2 条', map.work === 2, JSON.stringify(map))

/* ═══════════════ 16：整人注销 + 对照 ═══════════════ */
console.log('16 · deleteByUser：三表清零，且不影响另一个用户')
const C = { userId: 'u2', personaId: DEFAULT }
store.upsertPersona('u2', DEFAULT, true)
store.upsert({ content: 'u2 自己的记忆', ...C })
store.appendHistory({
  id: 'h-u1-1',
  userId: 'u1',
  personaId: DEFAULT,
  role: 'user',
  content: 'u1 说的一句话',
  sessionId: 's-1',
  chatType: 'private',
  chatId: '10001',
  createdAt: Date.now()
})
store.appendHistory({
  id: 'h-u2-1',
  userId: 'u2',
  personaId: DEFAULT,
  role: 'user',
  content: 'u2 说的一句话',
  sessionId: 's-2',
  chatType: 'desktop',
  chatId: null,
  createdAt: Date.now()
})

const removed = store.deleteByUser('u1')
check('返回值 memories = 5', removed.memories === 5, JSON.stringify(removed))
check('返回值 personas = 2', removed.personas === 2, JSON.stringify(removed))
check('返回值 histories = 1', removed.histories === 1, JSON.stringify(removed))
check('u1 记忆已清零', store.listByTenant('u1', DEFAULT).length === 0 && store.listByTenant('u1', 'work').length === 0)
check('u1 人设表已清零', store.listPersonas('u1').length === 0)
check('u1 历史已清零', store.recentHistory('u1', DEFAULT, 10).length === 0)
check('对照：u2 的记忆还在', store.listByTenant('u2', DEFAULT).length === 1, store.listByTenant('u2', DEFAULT).length)
check('对照：u2 的人设还在', store.activePersona('u2') === DEFAULT, store.activePersona('u2'))
check('对照：u2 的历史还在', store.recentHistory('u2', DEFAULT, 10).length === 1)

/* ═══════════════ 17：向量可读回 ═══════════════ */
console.log('17 · 带嵌入写入后能读回 Float32Array，长度 1024')
const vec = new Float32Array(DIM)
for (let i = 0; i < DIM; i += 1) vec[i] = (i % 17) / 17
const vecTenant = { userId: 'u3', personaId: DEFAULT }
store.upsert({ content: '带向量的记忆', ...vecTenant, embedding: vec })
const withVec = store.allWithEmbeddingInTenants([vecTenant])
check('读到 1 条带向量的行', withVec.length === 1, withVec.length)
const back = withVec[0] && withVec[0].embedding
check('读回的是 Float32Array', back instanceof Float32Array, back && back.constructor.name)
check('维度 1024', back && back.length === DIM, back && back.length)
check(
  '数值无损（逐元素比对）',
  Boolean(back) && back.every((value, index) => Math.abs(value - vec[index]) < 1e-6)
)
const emptyTenants = store.allWithEmbeddingInTenants([])
check('空租户数组 = 空结果（fail-closed，不是全库）', emptyTenants.length === 0, emptyTenants.length)

/* ═══════════════ 18：历史倒序 + limit ═══════════════ */
console.log('18 · appendHistory + recentHistory（倒序 + limit 截断）')
const histStore = new MemoryStore(path.join(userData, 'hist', 'memory.db'))
const base = Date.now()
for (let i = 0; i < 6; i += 1) {
  histStore.appendHistory({
    id: 'h-' + String(i),
    userId: 'u9',
    personaId: DEFAULT,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: '第 ' + String(i) + ' 条',
    sessionId: 's-9',
    chatType: 'group',
    chatId: '888',
    createdAt: base + i * 1000
  })
}
const recent = histStore.recentHistory('u9', DEFAULT, 5)
check('limit=5 时只返回 5 条', recent.length === 5, recent.length)
check(
  '顺序为时间倒序（第 5 条在最前）',
  recent[0].content === '第 5 条' && recent[4].content === '第 1 条',
  recent.map((row) => row.content).join(',')
)
check('role / chatType 原样读回', recent[0].role === 'assistant' && recent[0].chatType === 'group')
const other = histStore.recentHistory('u9', 'nobody', 5)
check('别的人设读不到这些历史', other.length === 0, other.length)
histStore.close()

/* ═══════════════ 附加：人设级删除与旧库重建的独立性（A-16） ═══════════════ */
console.log('附加 A-16 · 两个不同的旧库各自被重建（不是只动主库）')
const legacyA = path.join(userData, 'multi', 'a', 'memory.db')
const legacyB = path.join(userData, 'multi', 'b', 'memory.db')
buildLegacyDb(legacyA, [{ id: 'la-1', content: '故事A旧记忆' }])
buildLegacyDb(legacyB, [{ id: 'lb-1', content: '故事B旧记忆' }])
const sa = new MemoryStore(legacyA)
const sb = new MemoryStore(legacyB)
check('库A 可用且为空', sa.healthy() && sa.count() === 0, sa.count())
check('库B 可用且为空', sb.healthy() && sb.count() === 0, sb.count())
check('库A 无 scope_id', !columnsOf(legacyA, 'memories').includes('scope_id'))
check('库B 无 scope_id', !columnsOf(legacyB, 'memories').includes('scope_id'))
sa.close()
sb.close()

console.log('附加 · deleteByPersona 会连记忆带历史一起删')
const delStore = new MemoryStore(path.join(userData, 'del', 'memory.db'))
delStore.upsertPersona('u7', DEFAULT, true)
delStore.upsertPersona('u7', 'temp', false)
delStore.upsert({ content: 'temp 的记忆一', userId: 'u7', personaId: 'temp' })
delStore.upsert({ content: 'temp 的记忆二', userId: 'u7', personaId: 'temp' })
delStore.upsert({ content: 'default 的记忆', userId: 'u7', personaId: DEFAULT })
delStore.appendHistory({
  id: 'h-temp',
  userId: 'u7',
  personaId: 'temp',
  role: 'user',
  content: 'temp 的历史',
  sessionId: 's-7',
  chatType: 'desktop',
  chatId: null,
  createdAt: Date.now()
})
const removedCount = delStore.deleteByPersona('u7', 'temp')
check('deleteByPersona 返回删掉的记忆数 2', removedCount === 2, removedCount)
check('temp 的记忆没了', delStore.listByTenant('u7', 'temp').length === 0)
check('temp 的历史没了', delStore.recentHistory('u7', 'temp', 10).length === 0)
check('temp 的注册行没了', !delStore.listPersonas('u7').some((row) => row.personaId === 'temp'))
check('对照：default 的记忆还在', delStore.listByTenant('u7', DEFAULT).length === 1)
delStore.close()
store.close()

done()
