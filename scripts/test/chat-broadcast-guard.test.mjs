/**
 * A0a 广播归属守卫（X-01 / J-19）。
 *
 * 测的不是「再实现一遍」：这里导入的就是 store.ts 里那四个 reducer，
 * store.ts 的四个 handler 也各自只调它们一次（A8 的 grep 判据）。
 *
 * 为什么必须有第 5/6 条对照物（D33）：只断言「QQ 不污染」的话，
 * 一个「什么都不做」的坏实现也能全绿。
 *
 * 跑法：node scripts/test/chat-broadcast-guard.test.mjs
 */
import { bundleModule, createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const mod = await bundleModule(
  'chat-broadcast-guard',
  `export { reduceDelta, reduceDone, reduceError, reduceApproval, ownedByWindow } from '${p('src/renderer/src/features/chat/store.ts')}'`
)
const { reduceDelta, reduceDone, reduceError, reduceApproval, ownedByWindow } = mod

const desktopSession = {
  id: 'D',
  title: '桌面会话',
  mode: 'chat',
  messages: [{ id: 'm-d', role: 'assistant', content: '已有内容', status: 'streaming' }]
}
const qqSession = {
  id: 'Q',
  title: 'QQ 会话',
  mode: 'chat',
  messages: [{ id: 'm-q', role: 'assistant', content: 'QQ', status: 'streaming' }]
}

// 桌面正在生成 + 桌面的审批票据已在等
const base = () => ({
  sessions: [desktopSession],
  streamingId: 'D',
  approval: { requestId: 'req-desktop', sessionId: 'D', messageId: 'm-d', call: {}, reason: 'x' },
  error: null
})

check('归属判定：本窗口会话 = true', ownedByWindow(base().sessions, 'D') === true)
check('归属判定：QQ 会话 = false', ownedByWindow(base().sessions, 'Q') === false)

console.log('QQ 广播不得改动桌面的全局标量')
const state = base()
const desktopTicket = state.approval
const deltaQ = reduceDelta(state, { sessionId: 'Q', messageId: 'm-q', delta: 'QQ 的增量' })
check('1 · 收 QQ delta 后 streamingId 仍是 D', deltaQ.streamingId === 'D', deltaQ.streamingId)
check('1b · QQ 的正文没有灌进桌面会话', deltaQ.sessions === undefined ? true : deltaQ.sessions[0].messages[0].content === '已有内容')

const doneQ = reduceDone(state, { sessionId: 'Q', messageId: 'm-q', content: 'QQ 完成', toolCalls: [] })
check('2 · 收 QQ done 后 streamingId 仍是 D', doneQ.streamingId === 'D', doneQ.streamingId)
check('2b · done 不把 approval 清掉', doneQ.approval === desktopTicket, String(doneQ.approval && doneQ.approval.requestId))

const errorQ = reduceError(state, { sessionId: 'Q', messageId: 'm-q', message: 'QQ 侧炸了' })
check('3 · 收 QQ error 后全局 error 仍是 null', errorQ.error === null, String(errorQ.error))
check('3b · 收 QQ error 后 streamingId 仍是 D', errorQ.streamingId === 'D', errorQ.streamingId)

const approvalQ = reduceApproval(state, {
  requestId: 'req-qq',
  sessionId: 'Q',
  messageId: 'm-q',
  call: {},
  reason: 'x'
})
check(
  '4 · 收 QQ 审批后仍是桌面那张票据（不清空、不覆盖）',
  approvalQ.approval === desktopTicket && approvalQ.approval.requestId === 'req-desktop',
  String(approvalQ.approval && approvalQ.approval.requestId)
)

console.log('本窗口广播的旧行为不能坏（对照物）')
const deltaD = reduceDelta(base(), { sessionId: 'D', messageId: 'm-d', delta: '，追加' })
check('5 · 本窗口 delta 让 streamingId 变成 D', deltaD.streamingId === 'D', deltaD.streamingId)
check(
  '5b · 本窗口 delta 正文真的追加上了',
  deltaD.sessions[0].messages[0].content === '已有内容，追加',
  deltaD.sessions[0].messages[0].content
)

const errorD = reduceError(base(), { sessionId: 'D', messageId: 'm-d', message: '桌面自己的错误' })
check('6 · 本窗口 error 会写进全局 error', errorD.error === '桌面自己的错误', String(errorD.error))
check('6b · 本窗口 error 会清掉审批票据', errorD.approval === null, String(errorD.approval))

done()
