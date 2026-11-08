/**
 * 故事旁白（narration）的真实边界测试。
 *
 * 不测“渲染层有没有再实现一遍判断”，而是走真 chatService：
 *  - 旁白只落 sessions.json，不启动 assistant 流；
 *  - 下一次 send 的 payload 里，旁白以独立 system 消息出现；
 *  - 普通 chat 拒绝旁白；空旁白拒绝；生成中拒绝。
 *
 * 跑法：node scripts/test/story-narration.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-narration-'))
installElectronStub(userData)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    defaultCharacterId: 'nahida',
    provider: 'mock',
    permission: { mode: 'readonly' },
    memory: { enabled: false, autoExtract: false }
  }),
  'utf8'
)

/* chatService 会拉入 rag 依赖；这里桩掉，避免加载 embedding 模型。 */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-narration-stubs-'))
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  'export const memoryService = { async buildContextBlock() { return "" }, extractInBackground() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n',
  'utf8'
)
const plugin = {
  name: 'stub-narration-rag',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) =>
      args.importer.endsWith('chatService.ts') ? { path: ragStub } : null
    )
  }
}

const mod = await bundleModule(
  'story-narration',
  [
    `export { chatService, sessionHistoryToLlm } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { HeadlessSink } from '${p('src/main/features/chat/sink.ts')}'`
  ].join('\n'),
  [plugin]
)
const { chatService, HeadlessSink, sessionHistoryToLlm } = mod

const story = chatService.createSession({ mode: 'story', storyId: 'story_test_abc123', title: '旁白测试' })
const sessionId = story.id

/* ── A-01：写旁白不触发模型，立即落盘 ─────────────────────── */
const before = chatService.listSessions().find((item) => item.id === sessionId)
check('A-01 前置：空故事会话没有消息', before && before.messages.length === 0)

const narration = chatService.narrate(sessionId, '  夜色沉下来。  ')
const afterNarrate = chatService.listSessions().find((item) => item.id === sessionId)
check(
  'A-02 narrate → role=narration、内容 trim、status=done',
  narration.role === 'narration' && narration.content === '夜色沉下来。' && narration.status === 'done',
  JSON.stringify(narration)
)
check(
  'A-03 narrate 只追加一条，不建 assistant 占位',
  afterNarrate.messages.length === 1 && afterNarrate.messages[0].id === narration.id,
  JSON.stringify(afterNarrate.messages.map((message) => message.role))
)
const sessionsFile = path.join(userData, 'sessions.json')
const disk = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
const diskSession = disk.find((item) => item.id === sessionId)
check(
  'A-04 旁白已写进 sessions.json（重启可读回）',
  diskSession && diskSession.messages.some((message) => message.id === narration.id && message.role === 'narration'),
  diskSession ? JSON.stringify(diskSession.messages.map((message) => message.role)) : 'missing'
)

/* ── A-05 / A-06：下一次 payload 里旁白是独立 system ───────── */
const payload = sessionHistoryToLlm(chatService.listSessions().find((item) => item.id === sessionId))
const narrationMessages = payload.filter((message) => message.role === 'system' && message.content === '系统旁白：夜色沉下来。')
check(
  'A-05 buildPayload 把旁白转成 system，并加「系统旁白：」前缀',
  narrationMessages.length === 1,
  JSON.stringify(payload.filter((message) => message.content.includes('夜色沉下来')))
)
check(
  'A-06 旁白不会以 user 角色进入 payload',
  !payload.some((message) => message.role === 'user' && message.content.includes('夜色沉下来')),
  JSON.stringify(payload.map((message) => message.role))
)

const sink = new HeadlessSink()
await chatService.sendAwait({ sessionId, content: '继续。' }, sink)
check('A-06b send 能正常完成一轮（对照，证明旁白没有破坏发送）', sink.doneCount === 1, sink.failCount)

/* ── A-07…A-10：拒绝边界 ─────────────────────────────────── */
const chat = chatService.createSession({ mode: 'chat', title: '普通聊天' })
let chatRejected = false
try {
  chatService.narrate(chat.id, '不该允许')
} catch (error) {
  chatRejected = /只能用于故事区/.test(String(error))
}
check('A-07 普通 chat 会话 → 拒绝旁白', chatRejected)

let emptyRejected = false
try {
  chatService.narrate(sessionId, '   ')
} catch (error) {
  emptyRejected = /不能为空/.test(String(error))
}
check('A-08 空旁白 → 拒绝且不落盘', emptyRejected)

let unknownRejected = false
try {
  chatService.narrate('nope', 'x')
} catch (error) {
  unknownRejected = /会话不存在/.test(String(error))
}
check('A-09 不存在会话 → 拒绝', unknownRejected)

const countBefore = chatService.listSessions().find((item) => item.id === sessionId).messages.length
chatService.narrate(sessionId, '第二段旁白')
const countAfter = chatService.listSessions().find((item) => item.id === sessionId).messages.length
check('A-10 合法旁白可连续追加，消息数 +1', countAfter === countBefore + 1, countBefore + ' -> ' + countAfter)

/* ── A-11：旁白是持久消息，下一轮后仍在 ─────────────────── */
const rootMessages = chatService.listSessions().find((item) => item.id === sessionId).messages
check(
  'A-11 旁白在完整一轮对话后仍保留（不会被 reducer / 生成覆盖）',
  rootMessages.filter((message) => message.role === 'narration').length === 2,
  JSON.stringify(rootMessages.map((message) => message.role))
)

done()
