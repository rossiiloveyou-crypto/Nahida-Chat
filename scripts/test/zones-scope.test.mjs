/**
 * 域解析（P5 G3 → P6 G6 改写：从「查绑定表」改成「解析会话 id」）。
 *
 * 原 13 项里删掉的绑定注入全部换成了真实渠道会话 id（qq:<uin>:<type>:<id>），
 * 断言的意图一条没少：
 *  - 未归区的 QQ 会话只读自己（solo）
 *  - 归区的群彼此共享、跨区读不到
 *  - 桌面对话永远 root
 * 并新增两条 P6 判据：
 *  - UUID 会话 → zone:root（解析式判定不会把桌面误判成渠道）
 *  - solo 域的 key 与 sessionId 同构（已有 solo:* 记忆不需要迁移）
 *
 * 跑法：node scripts/test/zones-scope.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-zones-scope-'))
installElectronStub(userData)

const mod = await bundleModule(
  'zones-scope',
  [
    `export { ZoneStore } from '${p('src/main/features/zones/store.ts')}'`,
    `export { createScopeResolver } from '${p('src/main/features/zones/scope.ts')}'`,
    `export { soloScope } from '${p('src/shared/zones.ts')}'`
  ].join('\n')
)
const { ZoneStore, createScopeResolver, soloScope } = mod

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-zones-scope-data-'))
const store = new ZoneStore(dir)
const resolver = createScopeResolver({ zones: store })

const GROUP = 'qq:1:group:88'
const GROUP2 = 'qq:1:group:99'
const UUID = '3f2a9c1e-0000-4000-8000-000000000000'

const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual))

console.log('1-3 · 桌面对话（UUID）')
eq('UUID 会话只读 root', resolver.resolveRecallScopes(UUID), ['zone:root'])
eq('UUID 会话 primary 也是 zone:root', resolver.resolvePrimaryScope(UUID), 'zone:root')
eq('形似但不是 4 段的 qq: 串（qq:1:group）→ root', resolver.resolveRecallScopes('qq:1:group'), ['zone:root'])

console.log('4-5 · 渠道会话，未归区')
eq('未归区 → 只读自己（solo）', resolver.resolveRecallScopes(GROUP), ['solo:' + GROUP])
check('solo 域 key 与 sessionId 同构（P6：已有 solo:* 记忆不用迁移）', soloScope(GROUP) === 'solo:' + GROUP, soloScope(GROUP))

console.log('6-8 · 归区与共享')
const zoneA = store.createZone({ zoneName: 'A 群区' })
store.addMember({ zoneId: zoneA.zoneId, key: GROUP, chatType: 'group', chatId: '88' })
eq('归区后读到 zone:A', resolver.resolveRecallScopes(GROUP), ['zone:' + zoneA.zoneId])
store.addMember({ zoneId: zoneA.zoneId, key: GROUP2, chatType: 'group', chatId: '99' })
eq('同区第二个群 → 也读 zone:A', resolver.resolveRecallScopes(GROUP2), ['zone:' + zoneA.zoneId])
store.removeMember(zoneA.zoneId, GROUP2)
eq('移出后回到 solo（不残留区块权限）', resolver.resolveRecallScopes(GROUP2), ['solo:' + GROUP2])

console.log('9-12 · owner 画像注入判定')
check('root 注入', resolver.shouldInjectOwnerProfile('zone:root') === true)
check('solo 不注入', resolver.shouldInjectOwnerProfile('solo:' + GROUP) === false)
check('自定义区块默认不注入', resolver.shouldInjectOwnerProfile('zone:' + zoneA.zoneId) === false)
store.updateZoneConfig(zoneA.zoneId, { injectOwnerProfile: true })
check('打开开关后注入', resolver.shouldInjectOwnerProfile('zone:' + zoneA.zoneId) === true)

console.log('13 · primary 与 recallScopes[0] 恒等（同一套判定）')
const mismatch = []
for (const sessionId of [UUID, GROUP, GROUP2, 'qq:9:private:9', 'qq::private:', 'desk-1']) {
  const primary = resolver.resolvePrimaryScope(sessionId)
  const scopes = resolver.resolveRecallScopes(sessionId)
  if (primary !== scopes[0] || scopes.length !== 1) mismatch.push(sessionId + ':' + primary + '/' + scopes.join('|'))
}
check('六个会话都恒等，且永远 1 个元素', mismatch.length === 0, mismatch.join(' '))

console.log('14 · 非法渠道 id 落 root（解析式判定的保守面）')
eq('qq::private: → zone:root', resolver.resolvePrimaryScope('qq::private:'), 'zone:root')

console.log('15-17 · 旁听判定（P8 的接口，P6 只验形状）')
check('归区块 A 的群 → 看区块配置（默认 true）', resolver.shouldObserveGroupMessages(GROUP) === true)
check('未归区的群 → false', resolver.shouldObserveGroupMessages('qq:1:group:77') === false)
store.updateZoneConfig(zoneA.zoneId, { observeGroupMessages: false })
check('关掉后 → false', resolver.shouldObserveGroupMessages(GROUP) === false)

done()
