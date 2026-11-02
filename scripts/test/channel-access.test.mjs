/**
 * 渠道授权 v2（P9-R3）—— 按「人」授权的纯判定 + 迁移。目标 26 项（R3-A1…A26）。
 *
 * 测的是**真实边界**，不是「再实现一遍 normalize」：
 *  - 判定函数用内存数据直接调，不碰 userData
 *  - 迁移用真文件（临时目录），断言**迁移后行为与迁移前完全一致**
 *  - 「同一个群里两个人不同待遇」（R3-A12）是本节的立身之本：A 有 tool、B 没有
 *
 * 跑法：node scripts/test/channel-access.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-channel-access-'))
installElectronStub(userData)

const mod = await bundleModule('channel-access', [
  `export * from '${p('src/shared/channelAccess.ts')}'`,
  `export { ChannelAccessStore, normalizeConfig } from '${p('src/main/features/channels/store.ts')}'`
].join('\n'))
const {
  DEFAULT_ACCOUNT_PERMISSIONS,
  findAccount,
  findGroup,
  resolveMessageAccess,
  resolveToolAccess,
  isQqNumber,
  ChannelAccessStore,
  normalizeConfig
} = mod

/* ── 构造器 ─────────────────────────────────────────────────────────────── */

const account = (userId, permissions = {}, extra = {}) => ({
  channel: 'qq',
  userId,
  label: '',
  addedAt: 1,
  lastAt: 0,
  permissions: { ...DEFAULT_ACCOUNT_PERMISSIONS, ...permissions },
  ...extra
})

const group = (chatId, extra = {}) => ({
  channel: 'qq',
  chatId,
  label: '',
  addedAt: 1,
  lastAt: 0,
  ...extra
})

const config = (patch = {}) => ({
  version: 2,
  groupMemberGate: false,
  toolGate: true,
  accounts: [],
  groups: [],
  uins: [],
  ...patch
})

const priv = (accounts, senderId, extra = {}) =>
  resolveMessageAccess(config({ accounts, ...extra }), { channel: 'qq', chatType: 'private', senderId })

const grp = (accounts, senderId, extra = {}) =>
  resolveMessageAccess(config({ accounts, ...extra }), { channel: 'qq', chatType: 'group', senderId })

const tool = (accounts, senderId, extra = {}) =>
  resolveToolAccess(config({ accounts, ...extra }), { channel: 'qq', chatType: 'group', senderId })

/* ── A1–A3：消息准入（私聊始终校验） ──────────────────────────────────────── */

console.log('A1-A3 · 私聊准入')
check(
  'A1 私聊 + 在白名单 + private=true → 放行',
  (() => { const d = priv([account('20002', { private: true })], '20002'); return d.guarded === true && d.blocked === false })(),
  JSON.stringify(priv([account('20002', { private: true })], '20002'))
)
check(
  'A2 私聊 + 不在白名单 → 拦，理由含该号',
  (() => { const d = priv([], '20002'); return d.blocked === true && d.reason.includes('20002') && d.guarded === true })(),
  priv([], '20002').reason
)
check(
  'A3 私聊 + 在白名单但 private=false → 拦，理由含「私聊」',
  (() => { const d = priv([account('20002', { private: false })], '20002'); return d.blocked === true && d.reason.includes('私聊') })(),
  priv([account('20002', { private: false })], '20002').reason
)

/* ── A4–A7：群聊（groupMemberGate） ──────────────────────────────────────── */

console.log('A4-A7 · 群聊成员鉴权')
check(
  'A4 群聊 + groupMemberGate=false → 恒放行（guarded:false），不看白名单',
  (() => { const d = grp([], '99999', { groupMemberGate: false }); return d.guarded === false && d.blocked === false })(),
  JSON.stringify(grp([], '99999'))
)
check(
  'A5 群聊 + gate=true + 不在白名单 → 拦',
  (() => { const d = grp([], '99999', { groupMemberGate: true }); return d.blocked === true && d.reason.includes('99999') })(),
  grp([], '99999', { groupMemberGate: true }).reason
)
check(
  'A6 群聊 + gate=true + 在名单但 group=false → 拦',
  (() => { const d = grp([account('20002', { group: false })], '20002', { groupMemberGate: true }); return d.blocked === true && d.reason.includes('群聊') })(),
  grp([account('20002', { group: false })], '20002', { groupMemberGate: true }).reason
)
check(
  'A7 群聊 + gate=true + group=true → 放行',
  (() => { const d = grp([account('20002', { group: true })], '20002', { groupMemberGate: true }); return d.guarded === true && d.blocked === false })(),
  JSON.stringify(grp([account('20002', { group: true })], '20002', { groupMemberGate: true }))
)

/* ── A8–A14：工具授权 ────────────────────────────────────────────────────── */

console.log('A8-A14 · 工具授权')
check(
  'A8 toolGate=false → 恒放行（guarded:false）',
  (() => { const d = tool([], '20002', { toolGate: false }); return d.guarded === false && d.blocked === false })(),
  JSON.stringify(tool([], '20002', { toolGate: false }))
)
check(
  'A9 toolGate=true + 不在白名单 → 拦，理由含「不在 QQ 号白名单」',
  (() => { const d = tool([], '20002'); return d.blocked === true && d.reason.includes('不在 QQ 号白名单') })(),
  tool([], '20002').reason
)
check(
  'A10 toolGate=true + 在名单但 tool=false → 拦，理由含「未授予工具权限」',
  (() => { const d = tool([account('20002', { tool: false })], '20002'); return d.blocked === true && d.reason.includes('未授予工具权限') })(),
  tool([account('20002', { tool: false })], '20002').reason
)
check(
  'A11 toolGate=true + tool=true → 放行',
  tool([account('20002', { tool: true })], '20002').blocked === false
)

// 🔴 A12 是本节的立身之本：同一个群里两个人，一个能用工具一个不能。
{
  const accounts = [account('A111', { tool: true }), account('B222', { tool: false })]
  const a = tool(accounts, 'A111')
  const b = tool(accounts, 'B222')
  check('A12 同一群里两个人：A 有 tool 放行、B 没有 → 拦', a.blocked === false && b.blocked === true, a.blocked + '/' + b.blocked)
}

check(
  'A13 私聊与群聊的 tool 是**同一个位**：私聊有 tool 的人在群里也能用',
  (() => {
    const accounts = [account('20002', { tool: true })]
    const inPrivate = resolveToolAccess(config({ accounts }), { channel: 'qq', chatType: 'private', senderId: '20002' })
    const inGroup = resolveToolAccess(config({ accounts }), { channel: 'qq', chatType: 'group', senderId: '20002' })
    return inPrivate.blocked === false && inGroup.blocked === false
  })()
)

check(
  'A14 findAccount 只按 userId 匹配，**不匹配群号**',
  (() => {
    const accounts = [account('20002')]
    return findAccount(accounts, '20002') !== null && findAccount(accounts, '543627098') === null && findGroup([group('543627098')], '543627098') !== null
  })()
)

/* ── A15–A20：归一化 ─────────────────────────────────────────────────────── */

console.log('A15-A20 · 归一化')
check(
  'A15 缺 permissions → 落到 DEFAULT_ACCOUNT_PERMISSIONS',
  (() => {
    const conf = normalizeConfig({ version: 2, accounts: [{ userId: '20002' }], groups: [] })
    const perms = conf.accounts[0].permissions
    return JSON.stringify(perms) === JSON.stringify(DEFAULT_ACCOUNT_PERMISSIONS)
  })(),
  JSON.stringify(normalizeConfig({ version: 2, accounts: [{ userId: '20002' }] }).accounts[0].permissions)
)
check(
  'A16 非法的 private/group/tool 值 → 回默认，不抛',
  (() => {
    const conf = normalizeConfig({
      version: 2,
      accounts: [{ userId: '20002', permissions: { private: 'yes', group: 1, tool: null } }]
    })
    const perms = conf.accounts[0].permissions
    return perms.private === false && perms.group === true && perms.tool === false
  })()
)
check(
  'A17 空 userId / 非数字 → 丢弃该条',
  (() => {
    const conf = normalizeConfig({ version: 2, accounts: [{ userId: '' }, { userId: 'abc' }, { userId: '20002' }] })
    return conf.accounts.length === 1 && conf.accounts[0].userId === '20002'
  })(),
  JSON.stringify(normalizeConfig({ version: 2, accounts: [{ userId: '' }, { userId: 'abc' }, { userId: '20002' }] }).accounts)
)
check(
  'A18 重复 userId → 只留第一条',
  (() => {
    const conf = normalizeConfig({
      version: 2,
      accounts: [
        { userId: '20002', label: '第一次' },
        { userId: '20002', label: '第二次' }
      ]
    })
    return conf.accounts.length === 1 && conf.accounts[0].label === '第一次'
  })()
)
check(
  'A19 缺 groupMemberGate → **false**（默认关闭）',
  normalizeConfig({ version: 2 }).groupMemberGate === false
)
check(
  'A20 缺 toolGate → true',
  normalizeConfig({ version: 2 }).toolGate === true
)

/* ── A21–A26：迁移（v1 → v2） ────────────────────────────────────────────── */

console.log('A21-A26 · 迁移 v1 → v2')
const dir = path.join(userData, 'channels-migrate')
const file = path.join(dir, 'access.json')
const store = new ChannelAccessStore(dir)
fs.mkdirSync(dir, { recursive: true })
const V1 = {
  version: 1,
  entries: [
    {
      key: 'qq:3652864412:private:2914636187',
      channel: 'qq',
      uin: '3652864412',
      chatType: 'private',
      chatId: '2914636187',
      label: '小明',
      permissions: { respond: true, tool: true },
      lastAt: 5,
      createdAt: 3,
      updatedAt: 4
    },
    {
      key: 'qq:3652864412:group:543627098',
      channel: 'qq',
      uin: '3652864412',
      chatType: 'group',
      chatId: '543627098',
      label: '测试群',
      permissions: { respond: true, tool: true },
      lastAt: 8,
      createdAt: 6,
      updatedAt: 7
    }
  ]
}
fs.writeFileSync(file, JSON.stringify(V1, null, 2), 'utf8')
const result = store.migrateToV2()
const migrated = store.config()

check(
  'A21 v1 私聊条目 → 账号（chatId→userId，respond→private，tool 保留）',
  (() => {
    const item = migrated.accounts.find((entry) => entry.userId === '2914636187')
    return Boolean(item) && item.permissions.private === true && item.permissions.tool === true && item.permissions.group === true && item.label === '小明'
  })(),
  JSON.stringify(migrated.accounts)
)
check(
  'A22 v1 群条目 → groups[]（不产生账号条目）',
  migrated.groups.length === 1 && migrated.groups[0].chatId === '543627098' && migrated.groups[0].label === '测试群' && migrated.accounts.length === 1,
  JSON.stringify(migrated.groups)
)
check(
  'A23 v1 群条目的 tool **被丢弃**（群级工具权限没有意义）',
  !JSON.stringify(migrated.groups).includes('tool')
)
check(
  'A24 迁移幂等：跑两次结果相同',
  (() => {
    const again = store.migrateToV2()
    const second = store.config()
    return again.migrated === false && JSON.stringify(second) === JSON.stringify(migrated)
  })(),
  JSON.stringify(store.migrateToV2())
)
check(
  'A25 迁移写了 access.v1.backup.json，且内容仍是 v1 原文',
  (() => {
    const backup = path.join(dir, 'access.v1.backup.json')
    if (!fs.existsSync(backup)) return false
    return JSON.parse(fs.readFileSync(backup, 'utf8')).version === 1
  })(),
  result.backedUp
)
check(
  'A26 迁移后文件 version===2，且落盘里没有 entries',
  (() => {
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    return onDisk.version === 2 && Array.isArray(onDisk.accounts) && !('entries' in onDisk)
  })(),
  JSON.parse(fs.readFileSync(file, 'utf8')).version
)

console.log('附 · 迁移后行为与迁移前一致（§15.3.2 表）')
check(
  '私聊：2914636187 私聊她 → 回复（private=true）',
  priv(migrated.accounts, '2914636187').blocked === false
)
check(
  '私聊：陌生号私聊她 → 不回复（私聊始终校验）',
  priv(migrated.accounts, '999999999').blocked === true
)
check(
  '群：543627098 里任意人 @ 她 → 回复（groupMemberGate 默认关）',
  grp(migrated.accounts, '123123123', migrated).blocked === false
)
check(
  '工具：同一个人 tool=true → 放行；陌生人 → 拦',
  tool(migrated.accounts, '2914636187', migrated).blocked === false &&
    tool(migrated.accounts, '999999999', migrated).blocked === true
)
check('isQqNumber 只认纯数字', isQqNumber('123') === true && isQqNumber('12a') === false && isQqNumber('') === false)

done()
