/**
 * 旁听库（P8 G9）：只增不清 / 分片轮转 / 路径穿越边界 / 尾部读取。
 *
 * 🔴 全部用临时目录 new ObserveStore(tmpDir)，**禁止**碰真实 userData（§九 K8）。
 *    断言里不出现 app.getPath —— 出现了就说明测到了用户的数据。
 *
 * 跑法：node scripts/test/observe-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const stubUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-observe-test-'))
installElectronStub(stubUserData)

const mod = await bundleModule('observe', [
  `export { ObserveStore, parseLine, makeRecord } from '${p('src/main/features/observe/store.ts')}'`,
  `export { OBSERVE_SEGMENT_BYTES, OBSERVE_DIR_NAME, isSafeSegment, safeSegment } from '${p('src/shared/observe.ts')}'`
].join('\n'))
const { ObserveStore, parseLine, makeRecord, OBSERVE_SEGMENT_BYTES, OBSERVE_DIR_NAME, isSafeSegment, safeSegment } = mod

const UIN = '10001'
const GROUP = '88888'
const PRIVATE = '20002'

/** 每个用例一个全新库目录，互不污染 */
function freshStore(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-observe-lib-'))
  return { store: new ObserveStore({ root, ...options }), root }
}

function record(patch = {}) {
  return makeRecord({ uin: UIN, chatType: 'group', chatId: GROUP, text: '在吗', at: 1, ...patch })
}

function fileOf(root, uin, chatType, name) {
  return path.join(root, 'qq', uin, chatType, name)
}

/* ── 1-2：空库 ─────────────────────────────────────────────────────────── */

console.log('空库')
{
  const { store } = freshStore()
  const status = store.status()
  check('1 空库 status：conversations=0', status.conversations === 0, status.conversations)
  check('1 空库 status：files=0', status.files === 0, status.files)
  check('1 空库 status：totalBytes=0', status.totalBytes === 0, status.totalBytes)
  check('1 空库 status：warn=false', status.warn === false, status.warn)
  const empty = store.listConversations()
  check('2 空库 listConversations 为 []', Array.isArray(empty) && empty.length === 0, empty.length)
}

/* ── 3-6：写入与形状 ──────────────────────────────────────────────────── */

console.log('写入')
{
  const { store, root } = freshStore()
  store.append(record())
  const file = fileOf(root, UIN, 'group', GROUP + '.jsonl')
  check('3 文件落在 qq/<uin>/<chatType>/<chatId>.jsonl', fs.existsSync(file), file.replace(root, '<root>'))
  const text = fs.readFileSync(file, 'utf8')
  check('3 内容恰好一行', text.split('\n').filter((line) => line.trim()).length === 1, text.length)
  const parsed = JSON.parse(text.trim())
  check('4 行是合法 JSON', Boolean(parsed) && typeof parsed === 'object')
  check('4 v===1', parsed.v === 1, parsed.v)
  check(
    '4 uin/chatType/chatId/text 对',
    parsed.uin === UIN && parsed.chatType === 'group' && parsed.chatId === GROUP && parsed.text === '在吗',
    [parsed.uin, parsed.chatType, parsed.chatId, parsed.text].join('/')
  )
}
{
  const { store, root } = freshStore()
  store.append(record({ text: '今天天气不错，出去走走吧' }))
  const text = fs.readFileSync(fileOf(root, UIN, 'group', GROUP + '.jsonl'), 'utf8')
  check('5 中文不转义（文件里能直接搜到原文）', text.includes('今天天气不错，出去走走吧'), text.length)
}
{
  const { store, root } = freshStore()
  store.append(record({ text: '第一条', at: 1 }))
  const file = fileOf(root, UIN, 'group', GROUP + '.jsonl')
  const firstLine = fs.readFileSync(file, 'utf8')
  const firstBytes = fs.statSync(file).size
  store.append(record({ text: '第二条', at: 2 }))
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  check('6 追加两条 → 两行', lines.length === 2, lines.length)
  check('6 第一行原样保留（前缀字节不变）', fs.readFileSync(file, 'utf8').startsWith(firstLine) && firstBytes > 0, firstBytes)
}

/* ── 7-12：readTail ───────────────────────────────────────────────────── */

console.log('读尾部')
{
  const { store } = freshStore()
  store.append(record({ text: 'a', at: 1 }))
  store.append(record({ text: 'b', at: 2 }))
  const one = store.readTail(UIN, 'group', GROUP, 1)
  check('7 readTail limit=1 返回最后一条', one.length === 1 && one[0].text === 'b', one.map((r) => r.text).join(','))
}
{
  const { store } = freshStore()
  const texts = ['x', 'y', 'z']
  texts.forEach((text, i) => store.append(record({ text, at: i + 1 })))
  const all = store.readTail(UIN, 'group', GROUP, 100)
  check('8 只有 3 行时 limit=100 返回 3 条', all.length === 3, all.length)
  check('8 顺序为写入顺序', all.map((r) => r.text).join('') === 'xyz', all.map((r) => r.text).join(','))
}
{
  const { store } = freshStore({ tailBytes: 4096 })
  for (let i = 0; i < 5; i += 1) store.append(record({ text: '小文件' + String(i), at: i }))
  const rows = store.readTail(UIN, 'group', GROUP, 5)
  check('9 文件小于 tailBytes 时不丢第一行', rows.length === 5, rows.length)
}
{
  const { store } = freshStore({ tailBytes: 8 * 1024 })
  const filler = 'x'.repeat(180)
  for (let i = 0; i < 200; i += 1) store.append(record({ text: filler + '-' + String(i), at: i }))
  const rows = store.readTail(UIN, 'group', GROUP, 10)
  check('10 大文件只返回尾部 limit 条', rows.length === 10, rows.length)
  check('10 末条是最新一条（说明尾部窗口对齐正确）', rows[rows.length - 1].text.endsWith('-199'), rows[rows.length - 1].text.slice(-6))
  check('10 没有半行混进来（每条 text 长度一致）', rows.every((row) => row.text.length === filler.length + 4), rows.map((r) => r.text.length).join(','))
}
{
  const { store, root } = freshStore()
  const texts = ['ok1', 'ok2', 'ok3']
  texts.forEach((text, i) => store.append(record({ text, at: i })))
  const file = fileOf(root, UIN, 'group', GROUP + '.jsonl')
  const before = fs.statSync(file).size
  fs.appendFileSync(file, '{"坏\n', 'utf8')
  const afterBad = fs.statSync(file).size
  const rows = store.readTail(UIN, 'group', GROUP, 10)
  check('11 坏行被跳过，其余照常返回', rows.length === 3 && rows.map((r) => r.text).join(',') === 'ok1,ok2,ok3', rows.map((r) => r.text).join(','))
  check('12 坏行不被修复（文件只增不减）', fs.statSync(file).size === afterBad && afterBad > before, String(before) + '→' + String(afterBad))
  check('12 parseLine 对坏行返回 null', parseLine('{"坏') === null)
}

/* ── 13-16：路径穿越边界 ──────────────────────────────────────────────── */

console.log('路径边界')
{
  check('13 isSafeSegment("../x") === false', isSafeSegment('../x') === false)
  check('13 isSafeSegment("") === false', isSafeSegment('') === false)
  check('13 isSafeSegment("a/b") === false', isSafeSegment('a/b') === false)
  check('13 isSafeSegment("中文") === false', isSafeSegment('中文') === false)
  check('13 isSafeSegment 65 字符 === false', isSafeSegment('a'.repeat(65)) === false)
  check('13 isSafeSegment("123456") === true', isSafeSegment('123456') === true)
  check('13 safeSegment 把冒号换成下划线', safeSegment('qq:1:private:1') === 'qq_1_private_1', safeSegment('qq:1:private:1'))

  const { store } = freshStore()
  let uinError = ''
  try {
    store.append(record({ uin: '..' }))
  } catch (error) {
    uinError = error.message
  }
  check('14 append({uin:".."}) 抛「非法 uin」', uinError.includes('非法 uin'), uinError)

  let chatError = ''
  try {
    store.append(record({ chatId: 'a/b' }))
  } catch (error) {
    chatError = error.message
  }
  check('15 append({chatId:"a/b"}) 抛「非法 chatId」', chatError.includes('非法 chatId'), chatError)

  let cnError = ''
  try {
    store.append(record({ chatId: '中文' }))
  } catch (error) {
    cnError = error.message
  }
  check('16 append({chatId:"中文"}) 抛「非法 chatId」', cnError.includes('非法 chatId'), cnError)
}

/* ── 17-19：分片轮转（只增不清） ──────────────────────────────────────── */

console.log('分片')
{
  const { store, root } = freshStore({ segmentBytes: 200 })
  for (let i = 0; i < 10; i += 1) store.append(record({ text: '分片测试内容' + String(i), at: i }))
  const dir = path.join(root, 'qq', UIN, 'group')
  const files = fs.readdirSync(dir).sort()
  check('17 出现 .jsonl 与 .2.jsonl', files.includes(GROUP + '.jsonl') && files.includes(GROUP + '.2.jsonl'), files.join(','))
  const first = fileOf(root, UIN, 'group', GROUP + '.jsonl')
  const firstSize = fs.statSync(first).size
  // 阈值 200 字节 < 单行 426 字节 ⇒ 每片只放一行，**绝不把一行拆到两个文件**
  const firstLines = fs.readFileSync(first, 'utf8').trim().split('\n').length
  check('17 单片只放 1 行（行比阈值大时也不拆行）', firstLines === 1 && firstSize > 200, String(firstLines) + '行/' + String(firstSize) + 'B')
  for (let i = 10; i < 20; i += 1) store.append(record({ text: '继续写' + String(i), at: i }))
  check('18 后续写入不改变第一片字节数', fs.statSync(first).size === firstSize, String(firstSize) + '→' + String(fs.statSync(first).size))
  const tail = store.readTail(UIN, 'group', GROUP, 3)
  check('19 跨分片 readTail 顺序正确', tail.length === 3 && tail[2].text === '继续写19', tail.map((r) => r.text).join('|'))
}
{
  const { store } = freshStore({ segmentBytes: 200 })
  for (let i = 0; i < 12; i += 1) store.append(record({ text: '内容' + String(i), at: i }))
  const all = store.readTail(UIN, 'group', GROUP, 200)
  check('19 跨分片能读回全部行', all.length === 12, all.length)
  check('19 跨分片顺序 = 写入顺序', all.every((row, i) => row.text === '内容' + String(i)), all.length)
}

/* ── 20-24：汇总与状态 ───────────────────────────────────────────────── */

console.log('汇总')
{
  const { store } = freshStore()
  store.append(record({ chatType: 'group', chatId: GROUP, at: 500 }))
  store.append(record({ chatType: 'private', chatId: PRIVATE, at: 900 }))
  const list = store.listConversations()
  check('20 两个会话', list.length === 2, list.length)
  check('20 按 lastAt 降序', list[0].lastAt === 900 && list[1].lastAt === 500, list.map((r) => r.lastAt).join(','))
}
{
  const { store } = freshStore()
  store.append(record({ text: 'a' }))
  store.append(record({ text: 'b' }))
  const item = store.listConversations()[0]
  check('21 lines 与实际行数一致', item.lines === 2, item.lines)
}
{
  const { store, root } = freshStore()
  store.append(record({ text: 'a' }))
  fs.writeFileSync(fileOf(root, UIN, 'group', 'readme.txt'), 'ignore me', 'utf8')
  const list = store.listConversations()
  check('22 忽略无关文件（readme.txt 不计入）', list.length === 1, list.map((r) => r.chatId).join(','))
}
{
  const { store } = freshStore()
  store.append(record({ chatId: GROUP, text: 'a' }))
  store.append(record({ chatId: PRIVATE, text: 'b' }))
  const status = store.status()
  const sum = store.listConversations().reduce((acc, item) => acc + item.bytes, 0)
  check('23 status.totalBytes === 各会话之和', status.totalBytes === sum && sum > 0, String(status.totalBytes) + '/' + String(sum))
}
{
  const { store } = freshStore()
  store.append(record({ text: 'a' }))
  check('24 totalBytes <= warnBytes 时 warn=false', store.status(1024 * 1024).warn === false)
  check('24 totalBytes > warnBytes 时 warn=true', store.status(1).warn === true)
}

/* ── 25：没有删除方法 ────────────────────────────────────────────────── */

console.log('只增不清守卫')
{
  const names = Object.getOwnPropertyNames(ObserveStore.prototype)
  const banned = ['remove', 'clear', 'truncate', 'archive', 'rewrite', 'unlink', 'prune']
  const hit = banned.filter((word) => names.some((name) => name.toLowerCase().includes(word)))
  check('25 原型上没有 remove/clear/truncate/archive', hit.length === 0, hit.join(',') || names.join(','))

  const source = fs.readFileSync(p('src/main/features/observe/store.ts'), 'utf8')
  const offenders = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .filter((line) => /unlinkSync|rmSync|truncateSync|writeFileSync/.test(line))
  check('I4 生产代码写入路径不含 unlink/rm/truncate/writeFile', offenders.length === 0, offenders.join(' | ').slice(0, 120))

  const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf8'))
  check('25 package.json 里有 test:observe-store', typeof pkg.scripts['test:observe-store'] === 'string')
  check('25 test 总脚本串了 test:observe-store', String(pkg.scripts.test).includes('test:observe-store'))
}

/* ── 26-28：并发 / 多账号 / 段类型 ───────────────────────────────────── */

console.log('边界')
{
  const { store, root } = freshStore()
  store.append(record({ text: '并发一', at: 1 }))
  store.append(record({ text: '并发二', at: 2 }))
  const lines = fs.readFileSync(fileOf(root, UIN, 'group', GROUP + '.jsonl'), 'utf8').trim().split('\n')
  check('26 连续两次 append 两行都在', lines.length === 2, lines.length)
  check('26 两次的 id 不同（不是复用同一行）', JSON.parse(lines[0]).id !== JSON.parse(lines[1]).id)
}
{
  const { store, root } = freshStore()
  store.append(record({ uin: '1', text: 'a' }))
  store.append(record({ uin: '2', text: 'b' }))
  check(
    '27 多账号隔离（两个不同目录）',
    fs.existsSync(path.join(root, 'qq', '1', 'group')) && fs.existsSync(path.join(root, 'qq', '2', 'group'))
  )
  check('27 常量没被改小（32 MiB / observe）', OBSERVE_DIR_NAME === 'observe' && OBSERVE_SEGMENT_BYTES === 32 * 1024 * 1024, OBSERVE_SEGMENT_BYTES)
}
{
  const { store } = freshStore()
  store.append(record({ text: 'a', segmentTypes: ['text', 'image'] }))
  const rows = store.readTail(UIN, 'group', GROUP, 1)
  check('28 segmentTypes 原样落库', JSON.stringify(rows[0].segmentTypes) === '["text","image"]', JSON.stringify(rows[0].segmentTypes))
  const types = mod.segmentTypesOf ? mod.segmentTypesOf([]) : []
  void types
}

done()
