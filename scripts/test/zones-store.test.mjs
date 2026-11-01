/**
 * A1 区块存储不变量（P5 G2）。
 *
 * 每条都对应一个会真实伤到用户的失效模式：
 * 两个 root → 桌面记忆分裂；先移除后校验 → 校验失败时成员凭空消失；
 * 坏 JSON → 面板炸掉；.tmp 残留 → 下次 rename 覆盖不干净。
 *
 * 跑法：node scripts/test/zones-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-zones-store-'))
installElectronStub(userData)

const mod = await bundleModule(
  'zones-store',
  [`export { ZoneStore, zoneStore } from '${p('src/main/features/zones/store.ts')}'`].join('\n')
)
const { ZoneStore } = mod

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-zones-data-'))
const file = path.join(dir, 'zones.json')
const fresh = () => new ZoneStore(dir)
const readFile = () => fs.readFileSync(file, 'utf8')
const writeFile = (value) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}
const member = (key, chatType, chatId) => ({ kind: 'external', key, channel: 'qq', chatType, chatId })

console.log('1 · 首次读取自动有且仅有 1 个 root')
const first = fresh().listZones()
check('只有一个区块', first.length === 1, first.length)
check('它叫 root 且 isRoot', first[0].zoneId === 'root' && first[0].isRoot === true, first[0].zoneId)

console.log('2 · 手写「两个 root」→ 重建为单 root')
writeFile({
  version: 1,
  zones: [
    { zoneId: 'root', zoneName: '主区块', isRoot: true, createdAt: 1, config: {}, members: [] },
    { zoneId: 'other', zoneName: '第二个根', isRoot: true, createdAt: 2, config: {}, members: [] }
  ]
})
const twoRoots = fresh().listZones()
check('重建后只有 1 个区块', twoRoots.length === 1, twoRoots.length)
check('重建后仍是 root', twoRoots[0].zoneId === 'root', twoRoots[0].zoneId)

console.log('3 · 手写「0 个 root」→ 重建为单 root')
writeFile({ version: 1, zones: [{ zoneId: 'a', zoneName: 'A', isRoot: false, createdAt: 1, config: {}, members: [] }] })
const noRoot = fresh().listZones()
check('重建后只有 1 个区块', noRoot.length === 1, noRoot.length)
check('重建后是 root（不留无根状态）', noRoot[0].zoneId === 'root' && noRoot[0].isRoot, noRoot[0].zoneId)

console.log('4 · root 不可删')
const store = fresh()
const before = readFile()
check('deleteZone(root) 返回 false', store.deleteZone('root') === false)
check('文件一个字节都没动', readFile() === before)

console.log('5 · root 不可改名')
const renamed = store.renameZone('root', '我改')
check('renameZone(root) 名字不变', renamed && renamed.zoneName === store.getRootZone().zoneName, renamed && renamed.zoneName)

console.log('6 · 一个 key 只属一个区块（移出旧区块）')
const a = store.createZone({ zoneName: '区块 A' })
const b = store.createZone({ zoneName: '区块 B' })
store.addMember({ zoneId: a.zoneId, key: 'qq:1:group:88', chatType: 'group', chatId: '88' })
check('加入了 A', store.getZone(a.zoneId).members.length === 1)
store.addMember({ zoneId: b.zoneId, key: 'qq:1:group:88', chatType: 'group', chatId: '88' })
check('A 里已经没有它', store.getZone(a.zoneId).members.length === 0)
check('B 里有它', store.getZone(b.zoneId).members.length === 1)
check('findZoneByExternalKey 指向 B', store.findZoneByExternalKey('qq:1:group:88').zoneId === b.zoneId)

console.log('7 · 上限校验失败时旧成员仍在原区块（E11 顺序）')
const store7 = new ZoneStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-zones-e11-')))
const zoneA = store7.createZone({ zoneName: 'A' })
store7.addMember({ zoneId: 'root', key: 'qq:1:private:111', chatType: 'private', chatId: '111' })
store7.addMember({ zoneId: zoneA.zoneId, key: 'qq:1:private:222', chatType: 'private', chatId: '222' })
let threw = false
try {
  store7.addMember({ zoneId: 'root', key: 'qq:1:private:222', chatType: 'private', chatId: '222' })
} catch {
  threw = true
}
check('第 2 个私聊撞上限 → throw', threw)
check('原来的私聊 111 还在 root', store7.getRootZone().members.some((item) => item.key === 'qq:1:private:111'))
check(
  '222 没有被「先移除」丢掉，仍在 A',
  store7.getZone(zoneA.zoneId).members.some((item) => item.key === 'qq:1:private:222'),
  JSON.stringify(store7.getZone(zoneA.zoneId).members)
)

console.log('8 · root 第 2 个私聊直接加也 throw，第 1 个仍在')
const store8 = new ZoneStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-zones-root-')))
store8.addMember({ zoneId: 'root', key: 'qq:1:private:111', chatType: 'private', chatId: '111' })
let threw8 = false
try {
  store8.addMember({ zoneId: 'root', key: 'qq:1:private:333', chatType: 'private', chatId: '333' })
} catch {
  threw8 = true
}
check('撞上限 throw', threw8)
check('第 1 个私聊仍在', store8.getRootZone().members.length === 1 && store8.getRootZone().members[0].chatId === '111')

console.log('9 · 坏 JSON → 回落默认，不抛')
const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-zones-bad-'))
fs.writeFileSync(path.join(badDir, 'zones.json'), '{ 这不是 json', 'utf8')
let badJson = null
let badThrew = false
try {
  badJson = new ZoneStore(badDir).listZones()
} catch {
  badThrew = true
}
check('没有抛', badThrew === false)
check('回落成单 root', badJson && badJson.length === 1 && badJson[0].zoneId === 'root', badJson && badJson.length)

console.log('10 · 没有 .tmp 残留')
const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
check('目录里没有 .tmp', leftovers.length === 0, leftovers.join(','))

console.log('G6 · 成员 key 原样保存（与渠道键同构，P6 不校验格式）')
// P6：绑定表下线后，区块成员的 key 直接就是渠道会话 id（qq:<uin>:<type>:<id>）。
// ZoneStore 只要求 key/chatType/chatId 齐全，不校验格式 —— 这正是「zones.json 一个字节都不用改」的前提。
const keyStore = new ZoneStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-zones-key-')))
const keyA = keyStore.createZone({ zoneName: 'K' })
keyStore.addMember({ zoneId: keyA.zoneId, key: 'qq:1:group:88', chatType: 'group', chatId: '88' })
check('成员 key 原样落盘', keyStore.findZoneByExternalKey('qq:1:group:88')?.zoneId === keyA.zoneId, String(keyStore.findZoneByExternalKey('qq:1:group:88')?.zoneId))
const keyB = keyStore.createZone({ zoneName: 'K2' })
keyStore.addMember({ zoneId: keyB.zoneId, key: 'qq:1:group:88', chatType: 'group', chatId: '88' })
check('同一 key 只属于一个区块（改归区会搬走）', keyStore.getZone(keyA.zoneId).members.length === 0 && keyStore.getZone(keyB.zoneId).members.length === 1)
check('成员 key 就是渠道会话 id（可直接当 sessionId 用）', keyStore.getZone(keyB.zoneId).members[0].key === 'qq:1:group:88')

done()
