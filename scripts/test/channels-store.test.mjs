/**
 * P6 G2 渠道白名单落盘（channels/store.ts）——24 项 + 1 项迁移 = 25 项。
 *
 * 判据的重心不是「能读能写」，而是三件容易做错的事：
 *  1. **没有缓存**（T-CACHE #20）：外部改文件 + 本进程再写 → 外部那条必须还在（J-23/J-28）
 *  2. **损坏不清空**（#14/#15）：备份成 .bad-* 后返回 []，原内容一个字节都不丢
 *  3. **缺省方向相反**（#18）：respond 缺省 true（老文件还能用）、tool 缺省 false（高危位 fail-closed）
 *
 * 跑法：node scripts/test/channels-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-channels-store-'))
installElectronStub(userData)

const mod = await bundleModule(
  'channels-store',
  [
    `export { ChannelAccessStore, migrateFromBindings } from '${p('src/main/features/channels/store.ts')}'`,
    `export { channelKeyOf, parseChannelKey, isChannelSessionId } from '${p('src/shared/channels.ts')}'`
  ].join('\n')
)
const { ChannelAccessStore, migrateFromBindings, channelKeyOf, parseChannelKey, isChannelSessionId } = mod

const dir = path.join(userData, 'channels')
const file = path.join(dir, 'access.json')
const store = new ChannelAccessStore(dir)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readFileJson = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const throws = (fn, needle) => {
  try {
    fn()
    return false
  } catch (error) {
    return String(error && error.message).includes(needle)
  }
}

console.log('1 · 文件不存在')
const empty = store.entries()
check('entries() 返回 []', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty))
check('并且不创建 channels 目录（读没有副作用）', !fs.existsSync(dir), fs.existsSync(dir))

console.log('2-4 · upsert 语义')
const first = store.upsert({ uin: '10001', chatType: 'group', chatId: '88888', label: '测试群' })
check('新建条目 respond=true / tool=false / lastAt=0', first.permissions.respond === true && first.permissions.tool === false && first.lastAt === 0, JSON.stringify(first))
check('文件 version === 1', readFileJson().version === 1, readFileJson().version)
const created = first.createdAt
await sleep(5)
const second = store.upsert({ uin: '10001', chatType: 'group', chatId: '88888', label: '测试群改名' })
check('同 key 二次 upsert：条数不变', store.entries().length === 1, store.entries().length)
check('createdAt 不变', second.createdAt === created, second.createdAt + ' vs ' + created)
check('updatedAt 变大', second.updatedAt > second.createdAt, second.updatedAt + ' vs ' + second.createdAt)
const partial = store.upsert({ uin: '10001', chatType: 'group', chatId: '88888', permissions: { tool: true } })
check('部分权限：只传 tool → respond 保持 true，tool 变 true', partial.permissions.respond === true && partial.permissions.tool === true, JSON.stringify(partial.permissions))

console.log('5-9 · 校验')
check('空 uin 被拒', throws(() => store.upsert({ uin: ' ', chatType: 'group', chatId: '1' }), 'QQ 号不能为空'))
check('空 chatId 被拒', throws(() => store.upsert({ uin: '1', chatType: 'group', chatId: ' ' }), '会话号不能为空'))
check('私聊 chatId≠uin 被拒', throws(() => store.upsert({ uin: '1', chatType: 'private', chatId: '2' }), '私聊的会话号必须等于 QQ 号'))
check('群聊 chatId≠uin 正常通过', store.upsert({ uin: '1', chatType: 'group', chatId: '2' }).key === 'qq:1:group:2')
check('chatType 非法被拒', throws(() => store.upsert({ uin: '1', chatType: 'room', chatId: '2' }), '会话类型只能是 private / group'))

console.log('10-13 · remove / touch')
check('remove 已存在 → true', store.remove('qq:1:group:2') === true)
check('remove 后条数 -1', store.entries().length === 1, store.entries().length)
const beforeStat = fs.statSync(file).mtimeMs
await sleep(15)
check('remove 不存在 → false', store.remove('qq:404:nope') === false)
check('remove 不存在：文件不被重写（mtime 不变）', fs.statSync(file).mtimeMs === beforeStat)
const beforeTouch = store.get('qq:10001:group:88888')
store.touch('qq:10001:group:88888', 123456789)
const afterTouch = store.get('qq:10001:group:88888')
check('touch 已存在：lastAt 变', afterTouch.lastAt === 123456789, afterTouch.lastAt)
check('touch 已存在：updatedAt 不变', afterTouch.updatedAt === beforeTouch.updatedAt, afterTouch.updatedAt + ' vs ' + beforeTouch.updatedAt)
const ghostDir = path.join(userData, 'channels-ghost')
new ChannelAccessStore(ghostDir).touch('qq:1:private:1')
check('touch 不存在：不创建文件', !fs.existsSync(path.join(ghostDir, 'access.json')))

console.log('14-15 · 损坏文件：备份而不是清空')
fs.writeFileSync(file, '{{{', 'utf8')
const broken = store.entries()
const badFiles = fs.readdirSync(dir).filter((name) => name.startsWith('access.json.bad-'))
check('损坏 JSON → 返回 []', broken.length === 0, JSON.stringify(broken))
check('出现 access.json.bad-*', badFiles.length === 1, badFiles.join(','))
check('bad 文件内容仍是原文 "{{{"', fs.readFileSync(path.join(dir, badFiles[0]), 'utf8') === '{{{', badFiles[0])
fs.writeFileSync(file, JSON.stringify([1, 2, 3]), 'utf8')
const noEntries = store.entries()
check('顶层不是对象 / 没有 entries 数组 → 同样备份 + []', noEntries.length === 0 && fs.readdirSync(dir).filter((n) => n.startsWith('access.json.bad-')).length === 2, fs.readdirSync(dir).join(','))

console.log('16-18 · 归一化')
fs.writeFileSync(
  file,
  JSON.stringify({
    version: 1,
    entries: [
      { key: 'qq:1:group:88', label: 'A', createdAt: 1 },
      { key: '不是键', label: 'B' },
      { key: 'qq:1:group:99', label: 'C' },
      { key: 'qq:1:group:88', label: 'D' }
    ]
  }),
  'utf8'
)
const normalized = store.entries()
check('非法 key 被丢弃，其余保留', normalized.length === 2 && normalized.map((e) => e.key).join(',') === 'qq:1:group:88,qq:1:group:99', normalized.map((e) => e.key).join(','))
check('重复 key 只认第一条', normalized[0].label === 'A', normalized[0].label)
check('缺 permissions 的老文件：respond=true / tool=false', normalized[0].permissions.respond === true && normalized[0].permissions.tool === false, JSON.stringify(normalized[0].permissions))

console.log('19 · has() 不看权限位')
store.upsert({ uin: '1', chatType: 'group', chatId: '88', permissions: { respond: false } })
check('respond=false 的条目 has() === true', store.has('qq:1:group:88') === true)
check('不存在的 key has() === false', store.has('qq:2:group:88') === false)

console.log('20 · T-CACHE（J-23/J-28）：外部写入不能被本进程覆盖')
store.upsert({ uin: '7', chatType: 'group', chatId: '700' })
const outside = readFileJson()
outside.entries.push({
  key: 'qq:8:group:800',
  channel: 'qq',
  uin: '8',
  chatType: 'group',
  chatId: '800',
  label: '外部加的',
  permissions: { respond: true, tool: false },
  lastAt: 0,
  createdAt: 9,
  updatedAt: 9
})
fs.writeFileSync(file, JSON.stringify(outside, null, 2), 'utf8')
store.upsert({ uin: '9', chatType: 'group', chatId: '900' })
const afterExternal = readFileJson().entries.map((item) => item.key)
check('A、B（外部）、C 三条都在', ['qq:7:group:700', 'qq:8:group:800', 'qq:9:group:900'].every((key) => afterExternal.includes(key)), afterExternal.join(','))

console.log('21-24 · 落盘细节')
check('upsert 后没有 .tmp 残留', !fs.existsSync(file + '.tmp'), fs.readdirSync(dir).join(','))
store.upsert({ uin: '11', chatType: 'group', chatId: '1100', label: '中文群名 · 带标点' })
check('中文 label 落盘再读回一致', store.get('qq:11:group:1100').label === '中文群名 · 带标点', store.get('qq:11:group:1100').label)

const perfDir = path.join(userData, 'channels-perf')
const perfStore = new ChannelAccessStore(perfDir)
const started = Date.now()
for (let i = 0; i < 1000; i += 1) perfStore.upsert({ uin: String(20000 + i), chatType: 'group', chatId: String(80000 + i) })
const elapsed = Date.now() - started
check('1000 条 upsert < 2000 ms', elapsed < 2000, elapsed + ' ms（实测值）')

fs.writeFileSync(path.join(dir, 'migration.log'), 'old\n', 'utf8')
store.remove('qq:11:group:1100')
check('remove 只删条目，不删 migration.log / .bad-*', fs.existsSync(path.join(dir, 'migration.log')) && fs.readdirSync(dir).some((n) => n.startsWith('access.json.bad-')))

console.log('25 · 旧绑定迁移（§4.9）')
const legacyDir = path.join(userData, 'qq')
fs.mkdirSync(legacyDir, { recursive: true })
fs.writeFileSync(
  path.join(legacyDir, 'bindings.json'),
  JSON.stringify({ version: 1, bindings: [{ uin: '5', chatType: 'group', chatId: '600', displayName: '旧群' }] }),
  'utf8'
)
const migrateStore = new ChannelAccessStore(path.join(userData, 'channels-migrate'))
const added = migrateFromBindings(migrateStore)
check('迁移补进 1 条，label 来自 displayName', added === 1 && migrateStore.get('qq:5:group:600').label === '旧群', added + '/' + JSON.stringify(migrateStore.entries()))
check('迁移写了 migration.log，旧文件原样保留', fs.existsSync(path.join(migrateStore.dir, 'migration.log')) && fs.existsSync(path.join(legacyDir, 'bindings.json')))

console.log('附 · key 与解析')
check('channelKeyOf 产出的键可被 parseChannelKey 反解', JSON.stringify(parseChannelKey(channelKeyOf('1', 'private', '1'))) === JSON.stringify({ channel: 'qq', uin: '1', chatType: 'private', chatId: '1' }))
check('isChannelSessionId 正例/反例', isChannelSessionId('qq:1:private:1') === true && isChannelSessionId('3f2a9c1e-0000-4000-8000-000000000000') === false && isChannelSessionId('qq::private:') === false)

done()
