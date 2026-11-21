/** P4: only owned one-turn chats are read/deleted; backups are observed, never removed. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import type { BridgePageLike } from './session'

// ⚠️ 2026-11-20 现网修复：metadata 行数**不是常量**（ST 的 chat_metadata 非空才有，且部分保存路径
// 会带出多行头部）。保留此常量仅供历史引用，**validateChat 已不再使用它**。
export const METADATA_LINES = 1
export const DISK_TIMEOUT_MS = 3000
const OWNED = /^nc-[a-f0-9]{8}-[0-9]{13}\.jsonl$/
let lastStamp = 0
export function chatName(sessionId: string, now = Date.now()): string {
  lastStamp = Math.max(Math.trunc(now), lastStamp + 1)
  if (!/^[0-9]{13}$/.test(String(lastStamp))) throw new Error('Invalid chat timestamp')
  return 'nc-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 8) + '-' + lastStamp
}
export interface ChatTarget { name: string; avatar: string; directory: string; file: string; path: string }
export interface DiskRead { content: string; actualLines: number; expectedLines: number; metadataLines: number; file: string; waitMs: number }
export interface ChatDisk {
  backupWindowMs?: number
  target(dataDir: string, name: string, avatar: string): ChatTarget
  wait(target: ChatTarget, injected: number): Promise<DiskRead>
  remove(page: BridgePageLike, target: ChatTarget, sessionId: string): Promise<boolean>
  backups(dataDir: string): Promise<string[]>
}
export function chatTarget(dataDir: string, name: string, avatar: string): ChatTarget {
  if (!dataDir || !OWNED.test(name + '.jsonl') || basename(avatar) !== avatar || /[\\/]/.test(avatar) || !avatar.endsWith('.png')) throw new Error('Invalid owned chat path')
  const stem = avatar.slice(0, -4)
  if (!stem || stem === '.' || stem === '..' || /[<>:"|?*\x00-\x1f]/.test(stem) || /[. ]$/.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) throw new Error('Invalid avatar directory')
  const directory = join(resolve(dataDir), 'chats', stem)
  return { name, avatar, directory, file: name + '.jsonl', path: join(directory, name + '.jsonl') }
}
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
const isMetadataRow = (row: unknown): boolean => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const value = row as Record<string, unknown>
  return Object.hasOwn(value, 'chat_metadata') && Object.hasOwn(value, 'user_name')
}
export function validateChat(previous: Buffer, current: Buffer, injected: number): Omit<DiskRead, 'file' | 'waitMs'> {
  if (previous.length !== current.length || digest(previous) !== digest(current)) throw new Error('落盘内容尚未稳定')
  const text = current.toString('utf8').replace(/\r?\n$/, '')
  const lines = text ? text.split(/\r?\n/) : []
  const rows = lines.map(line => JSON.parse(line) as Record<string, unknown>)
  // 🔴 2026-11-20 现网修复：首行 metadata 的**行数不是常量**。
  //    ST 只在 chat_metadata 非空时写首行，且部分保存路径会带出不止一行头部；
  //    把它写死成 1 会在「上一轮空、这一轮非空」时误判为多一行（真实现场：expected=13 actual=14）。
  //    规则改为：**只认前导的 metadata 形状行**；中间与末尾仍必须逐行等于「注入 + 回复」，一条都不放宽。
  if (rows.length === 0) {
    const floor = injected + 2
    throw Object.assign(new Error('落盘行数不符：expected=' + floor + ' actual=0（空文件）'), { expectedLines: floor, actualLines: 0 })
  }
  if (!isMetadataRow(rows[0])) throw new Error('落盘 metadata 首行不符')
  let metadataLines = 1
  while (metadataLines < rows.length && isMetadataRow(rows[metadataLines])) metadataLines += 1
  const expectedLines = metadataLines + injected + 1
  if (lines.length !== expectedLines) throw Object.assign(new Error('落盘行数不符：expected=' + expectedLines + ' actual=' + lines.length + '（metadata ' + metadataLines + ' 行）'), { expectedLines, actualLines: lines.length })
  const last = rows[rows.length - 1]
  if (last.is_user !== false || typeof last.mes !== 'string' || !last.mes.trim()) throw new Error('落盘末条必须是非空 assistant 消息')
  return { content: last.mes, actualLines: lines.length, expectedLines, metadataLines }
}
const pathKey = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
function statOrMissing(file: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
// Walk from the root so a dangling ancestor junction is rejected, not mistaken for absence.
function confined(target: ChatTarget): boolean {
  const owned = chatTarget(dirname(dirname(target.directory)), target.name, target.avatar)
  if (target.file !== owned.file || pathKey(target.directory) !== pathKey(owned.directory) || pathKey(target.path) !== pathKey(owned.path)) throw new Error('Invalid owned chat target')
  const parents: string[] = []
  for (let current = resolve(target.directory); ; current = dirname(current)) {
    parents.unshift(current)
    if (dirname(current) === current) break
  }
  for (const directory of parents) {
    const stat = statOrMissing(directory)
    if (!stat) return false
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Owned chat directory is a link or not a directory')
    if (pathKey(realpathSync(directory)) !== pathKey(directory)) throw new Error('Owned chat directory redirects outside selected root')
  }
  const stat = statOrMissing(target.path)
  if (!stat) return false
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Owned chat is a link or not a regular file')
  if (pathKey(realpathSync(target.path)) !== pathKey(target.path)) throw new Error('Owned chat redirects outside selected root')
  return true
}
export async function waitChat(target: ChatTarget, injected: number, timeoutMs = DISK_TIMEOUT_MS): Promise<DiskRead> {
  const started = Date.now()
  let previous: Buffer | undefined
  let reason = '文件尚未出现'
  while (Date.now() - started < timeoutMs) {
    try {
      if (!confined(target)) throw Object.assign(new Error('文件尚未出现'), { code: 'ENOENT' })
      const observed = (await readdir(target.directory)).find(file => file === target.file)
      if (!observed) throw Object.assign(new Error('文件尚未出现'), { code: 'ENOENT' })
      target.file = observed; target.path = join(target.directory, observed)
      const current = await readFile(target.path)
      if (previous && previous.equals(current)) {
        // A stable invalid file is a hard failure, not a reason to loosen/retry the count.
        return { ...validateChat(previous, current, injected), file: observed, waitMs: Date.now() - started }
      }
      previous = current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      previous = undefined; reason = String(error)
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('等待 ST 落盘超时：' + reason)
}
interface Orphan { dataDir?: string; avatar?: string; at: string; sessionId: string; file: string; path: string; reason: string; attempts?: number }
interface Orphans { version: 1; items: unknown[] }
function isOrphan(value: unknown): value is Orphan & { dataDir: string; avatar: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return ['dataDir', 'avatar', 'file', 'path'].every(key => typeof row[key] === 'string' && (row[key] as string).length > 0)
    && ['at', 'sessionId', 'reason'].every(key => typeof row[key] === 'string')
    && (row.attempts === undefined || (typeof row.attempts === 'number' && Number.isSafeInteger(row.attempts) && row.attempts >= 0))
}
function orphanFile(userData: string): string { return join(userData, 'nc-bridge', 'orphans.json') }
export function readOrphans(userData = app.getPath('userData')): Orphans {
  let text: string
  try { text = readFileSync(orphanFile(userData), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: [] }; throw error }
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('version' in value) || value.version !== 1 || !('items' in value) || !Array.isArray(value.items)) throw new Error('Invalid orphan ledger')
  return { version: 1, items: value.items }
}
function saveOrphans(value: Orphans, userData: string): void {
  const file = orphanFile(userData); mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), 'utf8'); renameSync(file + '.tmp', file)
}
interface PendingSweep { task: Promise<number>; touched: Set<string> }
const sweeping = new Map<string, PendingSweep>()
export function recordOrphan(item: Orphan, userData = app.getPath('userData')): void {
  // No await in either RMW transaction: synchronous callers keep immediate persistence.
  const ledger = readOrphans(userData)
  ledger.items = ledger.items.filter(row => !isOrphan(row) || pathKey(row.path) !== pathKey(item.path))
  ledger.items.push(item); saveOrphans(ledger, userData)
  sweeping.get(pathKey(orphanFile(userData)))?.touched.add(pathKey(item.path))
}
export function sweepOrphans(userData = app.getPath('userData')): Promise<number> {
  const key = pathKey(orphanFile(userData))
  const active = sweeping.get(key)
  if (active) return active.task
  const touched = new Set<string>()
  // A pending synchronous registration is retained until the next scan, even if identical.
  const task = Promise.resolve().then(() => sweepLedger(userData, touched)).finally(() => sweeping.delete(key))
  sweeping.set(key, { task, touched })
  return task
}
function sweepLedger(userData: string, touched: Set<string>): number {
  // The complete read/validate/delete/write transaction runs without yielding.
  const ledger = readOrphans(userData)
  const remaining: unknown[] = []
  for (const item of ledger.items) {
    if (!isOrphan(item) || touched.has(pathKey(item.path))) { remaining.push(item); continue }
    try {
      if (!OWNED.test(item.file)) throw new Error('Invalid orphan filename')
      const owned = chatTarget(item.dataDir, item.file.slice(0, -6), item.avatar)
      if (pathKey(owned.path) !== pathKey(item.path)) throw new Error('Invalid orphan target')
      if (confined(owned)) rmSync(owned.path, { force: true })
    } catch (error) {
      remaining.push({ ...item, attempts: Math.min((item.attempts ?? 0) + 1, Number.MAX_SAFE_INTEGER), reason: String(error) })
    }
  }
  // A missing/empty ledger needs no rewrite; genuine read and write errors propagate.
  if (ledger.items.length > 0) saveOrphans({ version: 1, items: remaining }, userData)
  return remaining.length
}
export async function removeChat(page: BridgePageLike, target: ChatTarget, sessionId: string): Promise<boolean> {
  try {
    if (!confined(target)) return true
    await page.eval('(async()=>{const c=SillyTavern.getContext();const r=await fetch("/api/chats/delete",{method:"POST",headers:c.getRequestHeaders(),body:JSON.stringify(' + JSON.stringify({ chatfile: target.file, avatar_url: target.avatar }) + ')});return r.ok})()', 'chat:delete')
    if (!confined(target)) return true
  } catch { /* page/API failure falls back to a fresh owned path check */ }
  try {
    if (!confined(target)) return true
    rmSync(target.path, { force: true })
    if (confined(target)) throw new Error('Owned chat still exists after deletion')
    return true
  } catch (error) {
    recordOrphan({ dataDir: dirname(dirname(target.directory)), avatar: target.avatar, at: new Date().toISOString(), sessionId, file: target.file, path: target.path, reason: String(error) })
    return false
  }
}
export const chatDisk: ChatDisk = {
  backupWindowMs: 10500,
  target: chatTarget, wait: waitChat, remove: removeChat,
  async backups(dataDir) { try { return await readdir(join(dataDir, 'backups')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } }
}