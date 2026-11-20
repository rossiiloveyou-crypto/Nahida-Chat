/** P4：稳定 JSONL 为正文权威；只删除 owned chat，孤儿恢复与 trace 轮转使用真实临时文件系统。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p4-chats-'))
const userData = path.join(root, 'userData')
fs.mkdirSync(userData)
installElectronStub(userData)
const { chatName, chatTarget, validateChat, waitChat, removeChat, recordOrphan, readOrphans, sweepOrphans, chatDisk, appendBridgeTrace } = await bundleModule('bridge-chats', [
  "export * from '" + p('src/main/features/bridge/chats.ts') + "'",
  "export * from '" + p('src/main/features/bridge/trace.ts') + "'"
].join('\n'))
const { check, done } = createChecker()
async function test(label, action) {
  try { await action(); check(label, true) }
  catch (error) { check(label, false, error.stack) }
}
const metadata = { user_name: 'user', chat_metadata: {} }
const history = { is_user: true, mes: '历史 🌱' }
const assistant = { is_user: false, mes: '  落盘正文\n🌱  ' }
const bytes = (rows = [metadata, history, assistant]) => Buffer.from(rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
function target() {
  const value = chatTarget(root, chatName('p4'), 'card.png')
  fs.mkdirSync(value.directory, { recursive: true })
  return value
}
try {
  await test('1 · validateChat 严格 metadata+注入+assistant，正文逐字含空格换行', () => {
    assert.deepEqual(validateChat(bytes(), bytes(), 1), { content: assistant.mes, expectedLines: 3, actualLines: 3, metadataLines: 1 })
    const crlf = Buffer.from(bytes().toString().replace(/\n/g, '\r\n'))
    assert.equal(validateChat(crlf, crlf, 1).content, assistant.mes)
  })
  await test('1b · 现网修复：多段 metadata 头部按前导行计数，内容行仍严格相等', () => {
    const twice = bytes([metadata, metadata, history, assistant])
    assert.deepEqual(validateChat(twice, twice, 1), { content: assistant.mes, expectedLines: 4, actualLines: 4, metadataLines: 2 })
    const noMeta = bytes([history, assistant])
    assert.throws(() => validateChat(noMeta, noMeta, 1), /metadata/)
  })
  for (const [label, data, reason] of [
    ['多行', bytes([metadata, history, history, assistant]), /行数/],
    ['少行', bytes([metadata, assistant]), /行数/],
    ['空文件', Buffer.alloc(0), /行数/],
    ['坏JSON', bytes([metadata, history, '{bad']), /JSON|position|property/i],
    ['空正文', bytes([metadata, history, { is_user: false, mes: '' }]), /非空 assistant/],
    ['空白正文', bytes([metadata, history, { is_user: false, mes: ' \n\t ' }]), /非空 assistant/],
    ['用户末条', bytes([metadata, history, { is_user: true, mes: '错误' }]), /assistant/],
    ['坏metadata', bytes([{}, history, assistant]), /metadata/]
  ]) await test('validateChat 硬失败：' + label, () => assert.throws(() => validateChat(data, data, 1), reason))
  await test('不稳定：同长度不同字节和不同长度都硬失败', () => {
    assert.throws(() => validateChat(Buffer.from('abc'), Buffer.from('abd'), 0), /稳定/)
    assert.throws(() => validateChat(Buffer.from('a'), Buffer.from('ab'), 0), /稳定/)
  })
  await test('chatName 唯一且 chatTarget 挡住越界名称/头像', () => {
    const a = chatName('same'), b = chatName('same')
    assert.notEqual(a, b)
    assert.match(a, /^nc-[a-f0-9]{8}-[0-9]{13}$/)
    for (const avatar of ['../card.png', 'a/b.png', 'a\\b.png', 'card.jpg', '...png', '..png', 'CON.png', 'nul.png', 'COM1.png', 'LPT9.png', 'a:b.png', 'a?.png', 'a*.png', 'a<.png', 'a>.png', 'a|.png', 'a".png']) assert.throws(() => chatTarget(root, a, avatar))
    assert.throws(() => chatTarget(root, '../bad', 'card.png'))
  })
  await test('waitChat 真实文件两次稳定观察，严格回读正文与行数', async () => {
    const t = target(); fs.writeFileSync(t.path, bytes())
    const result = await waitChat(t, 1, 1000)
    assert.equal(result.content, assistant.mes); assert.equal(result.actualLines, 3); assert.equal(result.expectedLines, 3)
    assert.equal(result.file, t.file); assert.ok(result.waitMs >= 40)
  })
  await test('waitChat 文件尚未出现后落盘，可恢复并稳定回读', async () => {
    const t = target(); const timer = setTimeout(() => fs.writeFileSync(t.path, bytes()), 70)
    try { assert.equal((await waitChat(t, 1, 1000)).content, assistant.mes) } finally { clearTimeout(timer) }
  })
  await test('waitChat 变动后重新观察，最终只认稳定新正文', async () => {
    const t = target(); fs.writeFileSync(t.path, bytes())
    const changed = bytes([metadata, history, { is_user: false, mes: '新正文' }])
    const timer = setTimeout(() => fs.writeFileSync(t.path, changed), 20)
    try { assert.equal((await waitChat(t, 1, 1000)).content, '新正文') } finally { clearTimeout(timer) }
  })
  for (const [label, data] of [['多', bytes([metadata, history, history, assistant])], ['少', bytes([metadata, assistant])], ['空', Buffer.alloc(0)], ['坏JSON', bytes([metadata, history, '{bad'])]]) {
    await test('waitChat 稳定但' + label + '立即失败，不放宽行数或继续等', async () => {
      const t = target(); fs.writeFileSync(t.path, data)
      await assert.rejects(waitChat(t, 1, 1000))
    })
  }
  await test('waitChat 缺文件在有界时间超时', async () => {
    await assert.rejects(waitChat(target(), 1, 120), /超时/)
  })
  await test('removeChat API成功真实删除，payload精确指向owned文件', async () => {
    const t = target(); fs.writeFileSync(t.path, bytes()); let calls = 0
    const page = { async eval(expr, label) {
      calls++; assert.equal(label, 'chat:delete'); assert.ok(expr.includes(t.file)); assert.ok(expr.includes('card.png'))
      fs.rmSync(t.path); return true
    } }
    assert.equal(await removeChat(page, t, 'api-success'), true); assert.equal(calls, 1); assert.equal(fs.existsSync(t.path), false)
  })
  for (const mode of ['throw', 'false', 'success-with-file']) await test('removeChat API ' + mode + ' 使用fs兜底且不碰邻居/备份', async () => {
    const t = target(); fs.writeFileSync(t.path, bytes())
    const neighbor = path.join(t.directory, 'user-chat.jsonl'); fs.writeFileSync(neighbor, 'keep')
    const backupDir = path.join(root, 'backups'); fs.mkdirSync(backupDir, { recursive: true })
    const backup = path.join(backupDir, t.file); fs.writeFileSync(backup, 'backup')
    const page = { async eval() { if (mode === 'throw') throw new Error('API down'); return mode !== 'false' } }
    assert.equal(await removeChat(page, t, mode), true); assert.equal(fs.existsSync(t.path), false)
    assert.equal(fs.readFileSync(neighbor, 'utf8'), 'keep'); assert.equal(fs.readFileSync(backup, 'utf8'), 'backup')
    assert.ok((await chatDisk.backups(root)).includes(t.file))
  })
  await test('删除失败真实登记orphan，重试保留attempts，恢复后清空', async () => {
    const t = target(); fs.mkdirSync(t.path); fs.writeFileSync(path.join(t.path, 'blocker'), 'keep')
    assert.equal(await removeChat({ async eval() { throw new Error('API down') } }, t, 'orphan-session'), false)
    let ledger = readOrphans(userData); assert.equal(ledger.items.length, 1); assert.equal(ledger.items[0].sessionId, 'orphan-session')
    assert.equal(ledger.items[0].path, t.path)
    assert.equal(await sweepOrphans(userData), 1); ledger = readOrphans(userData); assert.equal(ledger.items[0].attempts, 1)
    fs.rmSync(t.path, { recursive: true }); fs.writeFileSync(t.path, bytes())
    assert.equal(await sweepOrphans(userData), 0); assert.equal(fs.existsSync(t.path), false); assert.equal(readOrphans(userData).items.length, 0)
  })
  await test('orphan去重、缺失文件恢复、越界条目保留且不删除', async () => {
    const t = target(); const item = { dataDir: root, avatar: 'card.png', at: new Date().toISOString(), sessionId: 's', file: t.file, path: t.path, reason: 'failed' }
    recordOrphan(item, userData); recordOrphan({ ...item, reason: 'new' }, userData)
    assert.equal(readOrphans(userData).items.length, 1); assert.equal(readOrphans(userData).items[0].reason, 'new')
    assert.equal(await sweepOrphans(userData), 0)
    const outside = path.join(root, t.file); fs.writeFileSync(outside, 'keep')
    recordOrphan({ ...item, path: outside }, userData)
    assert.equal(await sweepOrphans(userData), 1); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep')
  })
  await test('并发sweep共享任务且合并扫描期间新登记与同路径更新', async () => {
    const ledgerRoot = path.join(root, 'concurrent-ledger')
    const old = target(), fresh = target()
    fs.writeFileSync(old.path, bytes()); fs.writeFileSync(fresh.path, bytes())
    const row = t => ({ dataDir: root, avatar: 'card.png', at: 'old', sessionId: 's', file: t.file, path: t.path, reason: 'old' })
    recordOrphan(row(old), ledgerRoot)
    const running = sweepOrphans(ledgerRoot), same = sweepOrphans(ledgerRoot)
    assert.equal(running, same)
    recordOrphan({ ...row(fresh), at: 'fresh' }, ledgerRoot)
    recordOrphan({ ...row(old), at: 'updated', reason: 'new failure' }, ledgerRoot)
    assert.equal(await running, 2)
    const remaining = readOrphans(ledgerRoot).items
    assert.equal(remaining.length, 2); assert.ok(remaining.some(x => x.path === fresh.path)); assert.ok(remaining.some(x => x.at === 'updated'))
    assert.equal(fs.existsSync(fresh.path), true)
    assert.equal(await sweepOrphans(ledgerRoot), 0)
  })
  await test('另一root/chats同名文件受保护，缺可信身份条目也保留', async () => {
    const ledgerRoot = path.join(root, 'identity-ledger'), selected = target()
    const other = chatTarget(path.join(root, 'other-root'), selected.name, 'card.png')
    fs.mkdirSync(other.directory, { recursive: true }); fs.writeFileSync(other.path, 'keep')
    const row = { dataDir: root, avatar: 'card.png', at: 'identity', sessionId: 's', file: selected.file, path: other.path, reason: 'mismatch' }
    recordOrphan(row, ledgerRoot)
    assert.equal(await sweepOrphans(ledgerRoot), 1); assert.equal(fs.readFileSync(other.path, 'utf8'), 'keep')
    const missing = target(); fs.writeFileSync(missing.path, 'missing identity')
    recordOrphan({ at: 'legacy', sessionId: 's', file: missing.file, path: missing.path, reason: 'legacy' }, ledgerRoot)
    assert.equal(await sweepOrphans(ledgerRoot), 2); assert.equal(fs.readFileSync(missing.path, 'utf8'), 'missing identity')
  })
  await test('orphan坏JSON与错误版本硬失败，缺ledger返回空', () => {
    const other = path.join(root, 'bad-ledger'); assert.equal(readOrphans(other).items.length, 0)
    const dir = path.join(other, 'nc-bridge'); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'orphans.json'), '{bad'); assert.throws(() => readOrphans(other))
    fs.writeFileSync(path.join(dir, 'orphans.json'), JSON.stringify({ version: 2, items: [] })); assert.throws(() => readOrphans(other), /ledger/)
  })
  await test('trace真实2MiB边界与单备份rotation，旧备份替换、JSONL可解析', () => {
    const traceRoot = path.join(root, 'trace'); const dir = path.join(traceRoot, 'nc-bridge')
    const record = { at: '2026-01-01T00:00:00.000Z', sessionId: 's', before: 1, sent: 1, inChat: 1, inPrompt: 1, promptsWritten: 0, cardName: 'fixture', steps: ['chat:stable'] }
    appendBridgeTrace(record, traceRoot)
    const file = path.join(dir, 'bridge-trace.jsonl'), backup = path.join(dir, 'bridge-trace.1.jsonl')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record)
    const lineBytes = Buffer.byteLength(JSON.stringify(record) + '\n')
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 - lineBytes, 32)); appendBridgeTrace(record, traceRoot)
    assert.equal(fs.statSync(file).size, 2 * 1024 * 1024); assert.equal(fs.existsSync(backup), false)
    fs.writeFileSync(backup, 'stale'); appendBridgeTrace(record, traceRoot)
    assert.equal(fs.statSync(backup).size, 2 * 1024 * 1024); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record)
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 120)); appendBridgeTrace(record, traceRoot)
    assert.equal(fs.readFileSync(backup)[0], 120); assert.equal(fs.readdirSync(dir).length, 2)
  })
} finally { fs.rmSync(root, { recursive: true, force: true }) }
done()
