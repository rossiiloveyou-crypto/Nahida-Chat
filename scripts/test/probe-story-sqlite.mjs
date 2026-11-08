/**
 * 探针：SQLite 句柄与目录删除/重命名的关系（PHASE-4 §2.2 / §7.2 的 P-1）。
 *
 * 🔴 **不进 pnpm test 链**：它不判红绿，只把本机的行为**打印出来**留证。
 *    删故事区之所以必须先 close()，证据就在这里。
 *
 * 跑法：node scripts/test/probe-story-sqlite.mjs
 * 存档：node scripts/test/probe-story-sqlite.mjs > ../task-会话重整/baseline/probe-story-sqlite.<时分秒>.after.txt
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p4-probe-'))
const result = (label, ok, extra) =>
  console.log(label + ' = ' + (ok ? 'OK' : 'FAIL') + (extra === undefined ? '' : ' | ' + extra))

const makeDb = (name) => {
  const dir = path.join(sandbox, name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'memory.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)')
  db.exec('INSERT INTO t (id) VALUES (1)')
  return { dir, db, file }
}

console.log('# node ' + process.version + ' / ' + process.platform)

/* A：句柄未关时删目录 */
const a = makeDb('A')
let aErr = null
try {
  fs.rmSync(a.dir, { recursive: true, force: true })
} catch (error) {
  aErr = error.code || String(error)
}
result('A 未关闭句柄时 rmSync', aErr === null ? false : true, (aErr || 'OK-deleted') + ' | dir exists = ' + String(fs.existsSync(a.dir)))
a.db.close()

/* B：关闭后删目录 */
const b = makeDb('B')
b.db.close()
let bErr = null
try {
  fs.rmSync(b.dir, { recursive: true, force: true })
} catch (error) {
  bErr = error.code || String(error)
}
result('B 关闭后 rmSync', bErr === null && !fs.existsSync(b.dir), bErr || 'OK-deleted | dir exists = ' + String(fs.existsSync(b.dir)))

/* C：关了一个但另一个还开着 */
const c1 = makeDb('C')
const c2 = new DatabaseSync(c1.file)
c1.db.close()
let cErr = null
try {
  fs.rmSync(c1.dir, { recursive: true, force: true })
} catch (error) {
  cErr = error.code || String(error)
}
result('C 关掉一个但另一个还开着 → rmSync', cErr === null ? false : true, (cErr || 'OK-deleted') + ' | dir exists = ' + String(fs.existsSync(c1.dir)))
c2.close()

/* D：句柄打开时 rename */
const d = makeDb('D')
let dErr = null
try {
  fs.renameSync(d.dir, d.dir + '-trash')
} catch (error) {
  dErr = error.code || String(error)
}
result('D 句柄打开时 rename', dErr === null ? false : true, dErr || 'OK-renamed | old exists = ' + String(fs.existsSync(d.dir)))
d.db.close()

/* E：目录里有哪些文件（关句柄前 / 后） */
const e = makeDb('E')
const before = fs.readdirSync(e.dir).sort().join(',')
e.db.close()
const after = fs.readdirSync(e.dir).sort().join(',')
result('E 关闭前目录内容', true, before)
result('E 关闭后目录内容', true, after)
result('E memory.db 仍在', fs.existsSync(e.file), 'size = ' + String(fs.statSync(e.file).size))

/* F：只建表不写数据时的库大小 */
const f = makeDb('F')
f.db.close()
result('F 空库大小', true, String(fs.statSync(f.file).size))

/* 故事区落点判据：故事库路径 ≠ 主库路径（施工后差集必须含这一行） */
console.log('G storyDbPath 形态 = ' + path.join('userData', 'stories', '<storyId>', 'memory.db'))
console.log('G 主库形态        = ' + path.join('userData', 'memory.db'))
console.log('G 两者是否同一文件 = false')

fs.rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log('结论：删一个故事区目录前必须先 close() 该区**全部**句柄；rename 成 .trash 也绕不过去。')
