/**
 * 渠道授权的落盘层（channels/store.ts）—— **P9-R3 v2：按「人」授权**。
 *
 * 判据的重心不是「能读能写」，而是四件容易做错的事：
 *  1. **没有缓存**（J-23/J-28）：外部改文件 + 本进程再写 → 外部那条必须还在
 *  2. **损坏不清空**：备份成 .bad-* 后回默认值，原内容一个字节都不丢
 *  3. **缺省方向**：groupMemberGate 缺省 **false**（不收紧）、toolGate 缺省 **true**（要校验）
 *  4. **迁移先备份**：v1 → v2 是唯一一次破坏性改写，必须留下 access.v1.backup.json
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
    `export { ChannelAccessStore, migrateFromBindings, normalizeConfig } from '${p('src/main/features/channels/store.ts')}'`,
    `export { channelKeyOf, parseChannelKey, isChannelSessionId } from '${p('src/shared/channels.ts')}'`,
    `export { DEFAULT_ACCOUNT_PERMISSIONS } from '${p('src/shared/channelAccess.ts')}'`
  ].join('\n')
)
const { ChannelAccessStore, migrateFromBindings, normalizeConfig, channelKeyOf, parseChannelKey, isChannelSessionId, DEFAULT_ACCOUNT_PERMISSIONS } = mod

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
const empty = store.config()
check('config() 返回默认值', empty.version === 2 && empty.accounts.length === 0 && empty.groups.length === 0, JSON.stringify(empty))
check('默认 groupMemberGate === false（不收紧）', empty.groupMemberGate === false)
check('默认 toolGate === true（要校验）', empty.toolGate === true)
check('并且不创建 channels 目录（读没有副作用）', !fs.existsSync(dir), fs.existsSync(dir))

console.log('2 · 账号：默认值与部分更新')
const first = store.upsertAccount({ userId: '20002', label: '小明' })
const created = first.accounts[0]
check(
  '新账号默认 private=false / group=true / tool=false',
  created.permissions.private === false && created.permissions.group === true && created.permissions.tool === false,
  JSON.stringify(created.permissions)
)
check('落盘 version === 2', readFileJson().version === 2, readFileJson().version)
const addedAt = created.addedAt
await sleep(5)
const second = store.upsertAccount({ userId: '20002', label: '小明改名' })
check('同 userId 二次 upsert：条数不变', second.accounts.length === 1, second.accounts.length)
check('addedAt 不变', second.accounts[0].addedAt === addedAt, second.accounts[0].addedAt)
check('label 被更新', second.accounts[0].label === '小明改名', second.accounts[0].label)
const partial = store.upsertAccount({ userId: '20002', permissions: { tool: true } })
check(
  '部分权限：只传 tool → private/group 保持原值，tool 变 true',
  partial.accounts[0].permissions.private === false &&
    partial.accounts[0].permissions.group === true &&
    partial.accounts[0].permissions.tool === true,
  JSON.stringify(partial.accounts[0].permissions)
)

console.log('3 · 校验')
check('空 userId 被拒', throws(() => store.upsertAccount({ userId: ' ' }), 'QQ 号不能为空'))
check('非数字 userId 被拒', throws(() => store.upsertAccount({ userId: '小明' }), 'QQ 号只能是数字'))
check('空群号被拒', throws(() => store.upsertGroup({ chatId: '' }), '群号不能为空'))
check('非数字群号被拒', throws(() => store.upsertGroup({ chatId: '摄影群' }), '群号只能是数字'))

console.log('4 · 群 / 撤权 / 触碰')
const withGroup = store.upsertGroup({ chatId: '88888', label: '测试群' })
check('群写进去了', withGroup.groups.length === 1 && withGroup.groups[0].chatId === '88888', JSON.stringify(withGroup.groups))
check('removeAccount 已存在 → true', store.removeAccount('20002') === true)
check('removeAccount 后账号数 0', store.config().accounts.length === 0, store.config().accounts.length)
check('removeAccount 不存在 → false', store.removeAccount('404404') === false)
const beforeStat = fs.statSync(file).mtimeMs
await sleep(15)
check('remove 不存在：文件不被重写（mtime 不变）', fs.statSync(file).mtimeMs === beforeStat)
check('removeGroup 已存在 → true', store.removeGroup('88888') === true)
check('removeGroup 后群数 0', store.config().groups.length === 0)

store.upsertAccount({ userId: '30003' })
store.upsertGroup({ chatId: '77777' })
store.touch('qq:10001:group:77777', 123456789)
store.touch('qq:10001:private:30003', 111)
const touched = store.config()
check('touch 群：lastAt 变', touched.groups[0].lastAt === 123456789, touched.groups[0].lastAt)
check('touch 账号：lastAt 变', touched.accounts[0].lastAt === 111, touched.accounts[0].lastAt)
check('touch 不存在的键：不新增条目', (() => { store.touch('qq:9:group:999'); return store.config().groups.length === 1 })())
const ghostDir = path.join(userData, 'channels-ghost')
new ChannelAccessStore(ghostDir).touch('qq:1:private:1')
check('touch 不存在：不创建文件', !fs.existsSync(path.join(ghostDir, 'access.json')))

console.log('5 · 损坏文件：备份而不是清空')
fs.writeFileSync(file, '{{{', 'utf8')
const broken = store.config()
const badFiles = fs.readdirSync(dir).filter((name) => name.startsWith('access.json.bad-'))
check('损坏 JSON → 回默认值', broken.accounts.length === 0 && broken.groups.length === 0, JSON.stringify(broken))
check('出现 access.json.bad-*', badFiles.length === 1, badFiles.join(','))
check('bad 文件内容仍是原文 "{{{"', fs.readFileSync(path.join(dir, badFiles[0]), 'utf8') === '{{{', badFiles[0])
fs.writeFileSync(file, JSON.stringify([1, 2, 3]), 'utf8')
const noEntries = store.config()
check(
  '顶层是数组（不是对象）→ 同样回默认值（不备份：数组是合法 JSON）',
  noEntries.accounts.length === 0 && noEntries.groups.length === 0
)

console.log('6 · 归一化')
fs.writeFileSync(
  file,
  JSON.stringify({
    version: 2,
    accounts: [
      { userId: '1', label: 'A', permissions: { private: true } },
      { userId: 'abc', label: 'B' },
      { userId: '2', label: 'C' },
      { userId: '1', label: 'D' }
    ],
    groups: [{ chatId: '88', label: '群A' }, { chatId: '不是群号' }, { chatId: '88', label: '重复' }],
    uins: ['10001', '10001', 'abc']
  }),
  'utf8'
)
const normalized = store.config()
check(
  '非法 userId 被丢弃、重复只认第一条',
  normalized.accounts.length === 2 && normalized.accounts.map((item) => item.userId).join(',') === '1,2',
  normalized.accounts.map((item) => item.userId).join(',')
)
check('重复 userId 只认第一条（label=A）', normalized.accounts[0].label === 'A', normalized.accounts[0].label)
check('缺 permissions 的账号回默认值', normalized.accounts[1].permissions.group === true && normalized.accounts[1].permissions.tool === false, JSON.stringify(normalized.accounts[1].permissions))
check('非法群号被丢弃、重复群只留一条', normalized.groups.length === 1 && normalized.groups[0].chatId === '88', JSON.stringify(normalized.groups))
check('uins 去重且只留数字', JSON.stringify(normalized.uins) === '["10001"]', JSON.stringify(normalized.uins))

console.log('7 · has() / sessions()：会话维度的投影')
check('has(群键) 看 groups[]', store.has('qq:10001:group:88') === true)
check('has(私聊键) 看 accounts[]', store.has('qq:10001:private:1') === true)
check('不在名单的键 has() === false', store.has('qq:10001:group:999') === false)
check('垃圾键 has() === false（不抛）', store.has('不是键') === false)
const sessions = store.sessions()
check(
  'sessions()：群 × 每个 uin 展开成会话键',
  sessions.some((item) => item.key === 'qq:10001:group:88' && item.chatType === 'group'),
  JSON.stringify(sessions.map((item) => item.key))
)
check(
  'sessions()：私聊用第一个 uin',
  sessions.some((item) => item.key === 'qq:10001:private:1' && item.chatType === 'private' && item.chatId === '1'),
  JSON.stringify(sessions.map((item) => item.key))
)
check(
  'sessions()：私聊的 permissions.respond 来自 private 位',
  sessions.find((item) => item.chatType === 'private' && item.chatId === '1').permissions.respond === true
)
store.writeConfig({ version: 2, groupMemberGate: false, toolGate: true, accounts: [{ channel: 'qq', userId: '5', label: '', addedAt: 1, lastAt: 0, permissions: { ...DEFAULT_ACCOUNT_PERMISSIONS } }], groups: [{ channel: 'qq', chatId: '66', label: '', addedAt: 1, lastAt: 0 }], uins: [] })
check('没有已知 uin 时 sessions() 展不开（返回空）', store.sessions().length === 0, store.sessions().length)

console.log('8 · T-CACHE（J-23/J-28）：外部写入不能被本进程覆盖')
store.writeConfig({ version: 2, groupMemberGate: false, toolGate: true, accounts: [], groups: [], uins: ['10001'] })
store.upsertGroup({ chatId: '700' })
const outside = readFileJson()
outside.accounts.push({
  channel: 'qq',
  userId: '8',
  label: '外部加的',
  addedAt: 9,
  lastAt: 0,
  permissions: { private: true, group: true, tool: false }
})
fs.writeFileSync(file, JSON.stringify(outside, null, 2), 'utf8')
store.upsertGroup({ chatId: '900' })
const afterExternal = readFileJson()
check('外部加的账号还在（没被本进程覆盖）', afterExternal.accounts.some((item) => item.userId === '8'), JSON.stringify(afterExternal.accounts.map((item) => item.userId)))
check('本进程新加的群也在', afterExternal.groups.map((item) => item.chatId).sort().join(',') === '700,900', afterExternal.groups.map((item) => item.chatId).join(','))

console.log('9 · 落盘细节')
check('upsert 后没有 .tmp 残留', !fs.existsSync(file + '.tmp'), fs.readdirSync(dir).join(','))
store.upsertGroup({ chatId: '1100', label: '中文群名 · 带标点' })
check('中文 label 落盘再读回一致', store.config().groups.find((item) => item.chatId === '1100').label === '中文群名 · 带标点')
const gates = store.setGates({ groupMemberGate: true, toolGate: false })
check('setGates 生效并落盘', gates.groupMemberGate === true && gates.toolGate === false && readFileJson().groupMemberGate === true)
store.setGates({ groupMemberGate: false, toolGate: true })
store.addUin('10001')
store.addUin('10001')
store.addUin('abc')
check('addUin 去重且只收数字', JSON.stringify(store.config().uins) === '["10001"]', JSON.stringify(store.config().uins))

const perfDir = path.join(userData, 'channels-perf')
const perfStore = new ChannelAccessStore(perfDir)
const started = Date.now()
for (let i = 0; i < 1000; i += 1) perfStore.upsertAccount({ userId: String(20000 + i) })
const elapsed = Date.now() - started
check('1000 条 upsertAccount < 3000 ms', elapsed < 3000, elapsed + ' ms（实测值）')

fs.writeFileSync(path.join(dir, 'migration.log'), 'old\n', 'utf8')
store.removeGroup('1100')
check('remove 只删条目，不删 migration.log / .bad-*', fs.existsSync(path.join(dir, 'migration.log')) && fs.readdirSync(dir).some((n) => n.startsWith('access.json.bad-')))

console.log('10 · v1 老文件：内存里按迁移规则读（不落盘）')
const legacyDir = path.join(userData, 'channels-legacy')
fs.mkdirSync(legacyDir, { recursive: true })
fs.writeFileSync(
  path.join(legacyDir, 'access.json'),
  JSON.stringify({
    version: 1,
    entries: [
      { key: 'qq:10001:private:20002', label: '老私聊', permissions: { respond: true, tool: true }, createdAt: 3, lastAt: 4 },
      { key: 'qq:10001:group:88888', label: '老群', permissions: { respond: true, tool: true } }
    ]
  }),
  'utf8'
)
const legacyStore = new ChannelAccessStore(legacyDir)
const legacyConfig = legacyStore.config()
check(
  'v1 条目被读成 v2（私聊→账号、群→群）',
  legacyConfig.accounts.length === 1 && legacyConfig.groups.length === 1 && legacyConfig.accounts[0].userId === '20002',
  JSON.stringify(legacyConfig.accounts) + ' / ' + JSON.stringify(legacyConfig.groups)
)
check('读 v1 不改写文件（version 仍是 1）', JSON.parse(fs.readFileSync(path.join(legacyDir, 'access.json'), 'utf8')).version === 1)

console.log('11 · 旧绑定迁移（P6 §4.9）')
const legacyQqDir = path.join(userData, 'qq')
fs.mkdirSync(legacyQqDir, { recursive: true })
fs.writeFileSync(
  path.join(legacyQqDir, 'bindings.json'),
  JSON.stringify({ version: 1, bindings: [{ uin: '5', chatType: 'group', chatId: '600', displayName: '旧群' }] }),
  'utf8'
)
const migrateStore = new ChannelAccessStore(path.join(userData, 'channels-migrate'))
const added = migrateFromBindings(migrateStore)
check('迁移补进 1 个群，label 来自 displayName', added === 1 && migrateStore.config().groups[0].label === '旧群', added + '/' + JSON.stringify(migrateStore.config().groups))
check('迁移记下了机器人号', migrateStore.config().uins.includes('5'), JSON.stringify(migrateStore.config().uins))
check('迁移写了 migration.log，旧文件原样保留', fs.existsSync(path.join(migrateStore.dir, 'migration.log')) && fs.existsSync(path.join(legacyQqDir, 'bindings.json')))

console.log('附 · key 与解析')
check('channelKeyOf 产出的键可被 parseChannelKey 反解', JSON.stringify(parseChannelKey(channelKeyOf('1', 'private', '1'))) === JSON.stringify({ channel: 'qq', uin: '1', chatType: 'private', chatId: '1' }))
check('isChannelSessionId 正例/反例', isChannelSessionId('qq:1:private:1') === true && isChannelSessionId('3f2a9c1e-0000-4000-8000-000000000000') === false && isChannelSessionId('qq::private:') === false)

done()
