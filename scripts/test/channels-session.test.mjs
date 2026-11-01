/**
 * P6 G3/G4 渠道会话（chatService.ensureChannelSession / listDesktopSessions）——16 项。
 *
 * 判据重点是「会话身份可由外部键重建」（J-25）与「渠道会话不进用户视野但数据不丢」（J-26）：
 *  - id === 外部键，重启后仍是同一条（第 11 项用**第二个 bundle 实例**模拟重启）
 *  - 渠道会话不进侧栏（listDesktopSessions），但主进程内 listSessions 仍能看到
 *  - workspaceId 必须为 null：渠道会话没有「用户当前打开的目录」这回事（K1 实测的落地写法）
 *
 * 跑法：node scripts/test/channels-session.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-channels-session-'))
installElectronStub(userData)

const source = [
  `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
  `export { createQqBridge } from '${p('src/main/features/qq/bridge.ts')}'`,
  `export { sessionPolicy } from '${p('src/main/features/chat/sessionPolicy.ts')}'`,
  `export { isChannelSessionId } from '${p('src/shared/channels.ts')}'`,
  `export { DEFAULT_QQ_SETTINGS } from '${p('src/shared/qq.ts')}'`
].join('\n')
const mod = await bundleModule('channels-session', source)
const { chatService, createQqBridge, sessionPolicy, isChannelSessionId, DEFAULT_QQ_SETTINGS } = mod

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sessionsFile = path.join(userData, 'sessions.json')
const readSessions = () => JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
const KEY = 'qq:10001:private:20002'

// 真 bridge 里注册的策略（isMemoryIsolated = 是不是渠道会话）。
// 这里只借用它的注册动作，不启动宿主、不发消息。
createQqBridge({
  host: { on: () => () => {}, invokeAction: async () => ({ ok: true }) },
  chat: {
    sendAwait: async () => ({ status: 'done', sessionId: '', messageId: '', content: '', toolCalls: [], durationMs: 0 })
  },
  store: { access: () => [], settings: () => DEFAULT_QQ_SETTINGS },
  broadcast: () => {}
})

console.log('1-2 · 首次创建与幂等')
const first = chatService.ensureChannelSession(KEY, { title: '小明' })
check('sessions.json 多一条', readSessions().some((item) => item.id === KEY), readSessions().length)
check('id === 传入的外部键', first.id === KEY, first.id)
check('title === label', first.title === '小明', first.title)
const again = chatService.ensureChannelSession(KEY, { title: '小明' })
check('再次调用条数不变', readSessions().length === 1, readSessions().length)
check('返回同一条会话', again.id === first.id && again.createdAt === first.createdAt)

console.log('3-4 · label 变化')
chatService.ensureChannelSession(KEY, { title: '小明改名了' })
check('title 被补成新 label', chatService.listSessions().find((item) => item.id === KEY).title === '小明改名了')
chatService.ensureChannelSession(KEY, { title: '' })
check('label 变空时 title 保持不清空', chatService.listSessions().find((item) => item.id === KEY).title === '小明改名了')

console.log('5-6 · 侧栏可见性')
check('listDesktopSessions 不含渠道会话', !chatService.listDesktopSessions().some((item) => item.id === KEY))
check('listSessions 仍含渠道会话', chatService.listSessions().some((item) => item.id === KEY))

console.log('7-8 · 桌面新建不受影响')
const desktop = chatService.createSession()
check('桌面新建 id 仍是 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(desktop.id), desktop.id)
const explicit = chatService.createSession({ id: 'qq:1:private:1' })
check('createSession 显式指定 id 时 id 就是指定值', explicit.id === 'qq:1:private:1', explicit.id)

console.log('9-10 · 不污染既有字段')
const agentSession = chatService.ensureChannelSession('qq:2:group:300', { title: 'A 群', mode: 'agent' })
check('第一次可指定 mode=agent', agentSession.mode === 'agent', agentSession.mode)
const agentAgain = chatService.ensureChannelSession('qq:2:group:300')
check('再次 ensure 不改 mode', agentAgain.mode === 'agent', agentAgain.mode)
check('新建的渠道会话 workspaceId === null', first.workspaceId === null, String(first.workspaceId))

console.log('11 · 重启后仍在（第二个 bundle 实例 = 新的 chatService 单例）')
const reloaded = await bundleModule('channels-session-b', source)
const afterRestart = reloaded.chatService.listSessions().find((item) => item.id === KEY)
check('重新加载后同一条会话还在，title/createdAt 一致', Boolean(afterRestart) && afterRestart.title === '小明改名了' && afterRestart.createdAt === first.createdAt, JSON.stringify(afterRestart && { id: afterRestart.id, title: afterRestart.title }))
check('重新加载后渠道会话的 workspaceId 仍是 null', Boolean(afterRestart) && afterRestart.workspaceId === null, String(afterRestart && afterRestart.workspaceId))

console.log('12 · isMemoryIsolated 对齐')
check('渠道会话被标为隔离', sessionPolicy().isMemoryIsolated(KEY) === true)
check('桌面 UUID 会话不被隔离', sessionPolicy().isMemoryIsolated(desktop.id) === false)

console.log('13 · 非法 key（记录不一致）')
const invalid = 'qq::private:'
const invalidSession = chatService.ensureChannelSession(invalid)
check('ensureChannelSession 不拒绝非法 key（它不是校验层）', invalidSession.id === invalid, invalidSession.id)
check('但 isChannelSessionId 判定为 false ⇒ 域落 root', isChannelSessionId(invalid) === false)

console.log('14 · 并发 ensure')
const beforeConcurrent = readSessions().length
const results = [chatService.ensureChannelSession('qq:3:group:400', { title: '并发' }), chatService.ensureChannelSession('qq:3:group:400', { title: '并发' })]
check('两次 ensure 只产生一条', readSessions().length === beforeConcurrent + 1, readSessions().length - beforeConcurrent)
check('两次拿到同一条', results[0].id === results[1].id)

console.log('15 · updateSession 仍不能改 title')
const beforePatch = chatService.listSessions().find((item) => item.id === KEY).title
chatService.updateSession(KEY, { title: '想改标题' })
check('传 title 被忽略', chatService.listSessions().find((item) => item.id === KEY).title === beforePatch, beforePatch)

console.log('16 · 删除后重建')
const doomed = chatService.ensureChannelSession('qq:4:group:500', { title: '会被删' })
await sleep(5)
chatService.deleteSession('qq:4:group:500')
check('删除后列表里没有了', !chatService.listSessions().some((item) => item.id === 'qq:4:group:500'))
const rebuilt = chatService.ensureChannelSession('qq:4:group:500', { title: '重建' })
check('再次 ensure 会重建（新 createdAt）', rebuilt.id === doomed.id && rebuilt.createdAt > doomed.createdAt, rebuilt.createdAt + ' vs ' + doomed.createdAt)

done()
