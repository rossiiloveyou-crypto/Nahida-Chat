/**
 * 失败的一轮怎么收场（用户 2026-11-14）。
 *
 * 反馈原文：「现在的对话出现某些调用错误后会卡在图片的那种状态，虽然不影响发送下一条消息，
 * 但是不美观，而且没给用户提供重试的键，用户只能发下一条消息来继续对话」。
 *
 * 图片上就是头像 + 三个点的打字动画。根因有两处，这里各给一组判据：
 *  A. 界面：气泡只看 content 有没有字，于是 status 已经是 error 也照样走「三个点」那一支；
 *  B. 数据：失败原因只发一次广播，不落盘，重启后就查不到为什么没回。
 *
 * 判据分四段：纯规则（能不能显示对话不依赖 React）、主进程真跑一轮、渲染层契约、读盘收敛。
 *
 * 跑法：node scripts/test/chat-failed-turn.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p, projectRoot } from './qq-test-util.mjs'

const { check, done } = createChecker()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readSrc = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8')

const mkUserData = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-failed-' + tag + '-'))
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ memory: { enabled: false, autoExtract: false } }),
    'utf8'
  )
  return dir
}

/** 假窗口：只记账，不判断。retry 的第三参是 WindowLike */
function fakeSender() {
  const seen = []
  return {
    seen,
    isDestroyed: () => false,
    send: (channel, payload) => seen.push({ channel, payload })
  }
}

async function waitIdle(chatService, sessionId, budget = 15000) {
  const started = Date.now()
  while (chatService.isGenerating(sessionId)) {
    if (Date.now() - started > budget) throw new Error('等这一轮结束超时')
    await sleep(25)
  }
}

const msg = (id, role, content, status, extra = {}) =>
  Object.assign({ id, role, content, createdAt: Date.now(), status }, extra)

/* ───────────────────────── A. 气泡形态（纯规则） ───────────────────────── */

console.log('A · 气泡该显示什么（bubble.ts，纯函数）')
const bubble = await bundleModule(
  'chat-bubble',
  'export { bubbleViewOf, bubbleClassOf, FAILED_FALLBACK, INTERRUPTED_FALLBACK, EMPTY_FALLBACK } from ' +
    JSON.stringify(p('src/renderer/src/features/chat/bubble.ts'))
)
const { bubbleViewOf, bubbleClassOf } = bubble

const live = { isLive: true, isTail: true }
const tail = { isLive: false, isTail: true }
const middle = { isLive: false, isTail: false }

check('A-01 真在生成 + 还没有正文 → typing（这是唯一该转圈的情形）',
  bubbleViewOf(msg('a', 'assistant', '', 'streaming'), live).phase === 'typing')
check('A-02 真在生成 + 已有正文 → text',
  bubbleViewOf(msg('a', 'assistant', '在的', 'streaming'), live).phase === 'text')
check('A-03 失败 + 有原因 → failed，且说明就是那个原因',
  bubbleViewOf(msg('a', 'assistant', '', 'error', { error: '连接被重置' }), tail).note === '连接被重置',
  bubbleViewOf(msg('a', 'assistant', '', 'error', { error: '连接被重置' }), tail).note)
check('A-04 失败 + 没原因 → failed 且用兜底文案',
  bubbleViewOf(msg('a', 'assistant', '', 'error'), tail).note === bubble.FAILED_FALLBACK)
check('A-05 失败的那条**不许**再显示三个点',
  bubbleViewOf(msg('a', 'assistant', '', 'error'), tail).phase !== 'typing')
check('A-06 最后一条失败 → 可以重试', bubbleViewOf(msg('a', 'assistant', '', 'error'), tail).canRetry === true)
check('A-07 中间那条失败 → 不能重试（重跑会截断后面的上下文）',
  bubbleViewOf(msg('a', 'assistant', '', 'error'), middle).canRetry === false)
check('A-08 中间那条失败 → 仍然可以删掉',
  bubbleViewOf(msg('a', 'assistant', '', 'error'), middle).canRemove === true)
check('A-09 done 的空回复（点了停止）→ failed，不是一直转圈',
  bubbleViewOf(msg('a', 'assistant', '', 'done'), tail).note === bubble.EMPTY_FALLBACK)
check('A-10 只剩工具调用、没有正文 → text（工具卡自己会说话，不叠红字）',
  bubbleViewOf(msg('a', 'assistant', '', 'done', { toolCalls: [{ id: 't1', name: 'clock.now' }] }), tail).phase === 'text')
check('A-11 正常有正文 → text', bubbleViewOf(msg('a', 'assistant', '好的', 'done'), tail).phase === 'text')
check('A-12 状态写着 streaming 但会话不在生成（上次没跑完）→ failed + 中断文案',
  bubbleViewOf(msg('a', 'assistant', '', 'streaming'), tail).note === bubble.INTERRUPTED_FALLBACK)
check('A-13 正在生成的那条不能删（删了增量会打到孤儿 id 上）',
  bubbleViewOf(msg('a', 'assistant', '', 'streaming'), live).canRemove === false)
check('A-14 类名：failed 才带 bubble--failed（旧的红字类 bubble--error 已下线）',
  bubbleClassOf('failed') === 'bubble bubble--failed' && bubbleClassOf('text') === 'bubble')

/* ───────────────── B. 主进程：真跑一轮重试 ───────────────── */

console.log('')
console.log('B · 主进程 retry / deleteMessage（真跑一轮，演示 provider）')

const userData = mkUserData('main')
installElectronStub(userData)
const mainMod = await bundleModule(
  'chat-failed-main',
  ['export { chatService } from ' + JSON.stringify(p('src/main/features/chat/chatService.ts')),
   'export { IPC } from ' + JSON.stringify(p('src/shared/ipc.ts'))].join('\n')
)
const { chatService, IPC } = mainMod
const sessionsFile = path.join(userData, 'sessions.json')
const diskOf = (sessionId) => {
  const all = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
  return all.find((item) => item.id === sessionId)
}

const session = chatService.createSession({ mode: 'chat' })
chatService.appendMessages(session.id, [
  msg('u-1', 'user', '你好', 'done'),
  msg('a-1', 'assistant', '', 'error', { error: '连接被重置', toolCalls: [] })
])

const sender = fakeSender()
const returned = await chatService.retry(session.id, 'a-1', sender)
check('B-01 retry 返回的是那条回复的重置态（streaming / 空正文 / 原因已清）',
  returned.id === 'a-1' && returned.status === 'streaming' && returned.content === '' && returned.error === undefined,
  JSON.stringify({ id: returned.id, status: returned.status, error: returned.error }))
check('B-02 重试不新增用户消息（历史里不许出现两句一样的原话）',
  chatService.listSessions().find((s) => s.id === session.id).messages.filter((m) => m.role === 'user').length === 1)
check('B-03 重试期间 isGenerating === true', chatService.isGenerating(session.id) === true)
let inFlightRejected = ''
try { await chatService.retry(session.id, 'a-1', fakeSender()) } catch (error) { inFlightRejected = String(error.message) }
check('B-04 生成中再点重试 → 明确拒绝（不会两轮写同一条）', inFlightRejected.includes('仍在生成中'), inFlightRejected)

await waitIdle(chatService, session.id)
const afterRetry = chatService.listSessions().find((s) => s.id === session.id)
const retried = afterRetry.messages.find((m) => m.id === 'a-1')
check('B-05 跑完 status = done 且正文非空', retried.status === 'done' && retried.content.length > 0,
  retried.status + ' / ' + retried.content.length + ' 字')
check('B-06 跑完把失败原因清掉了（不会一边失败一边完成）', retried.error === undefined, String(retried.error))
check('B-07 窗口真的收到了增量与完成广播',
  sender.seen.some((e) => e.channel === IPC.chatDelta) && sender.seen.some((e) => e.channel === IPC.chatDone),
  sender.seen.map((e) => e.channel).join(','))
const diskRow = diskOf(session.id).messages.find((m) => m.id === 'a-1')
check('B-08 落盘那条也是 done + 正文（不是只在内存里成功）',
  diskRow.status === 'done' && diskRow.content.length > 0, diskRow.status + ' / ' + diskRow.content.length + ' 字')
check('B-09 落盘没有多出用户消息', diskOf(session.id).messages.filter((m) => m.role === 'user').length === 1)

/** 这段操作**必须**被拒绝，且拒绝理由里带着这句话。返回 ok 才算过。 */
const failsWith = async (fn, fragment) => {
  try { await fn() } catch (error) {
    const text = String(error && error.message)
    return text.includes(fragment) ? 'ok' : 'wrong: ' + text
  }
  return 'no-throw'
}

check('B-10 拿用户消息去重试 → 拒绝',
  (await failsWith(() => chatService.retry(session.id, 'u-1', fakeSender()), '只有回复能重试')) === 'ok')
const two = chatService.createSession({ mode: 'chat' })
chatService.appendMessages(two.id, [
  msg('u-2', 'user', '第一句', 'done'),
  msg('a-2', 'assistant', '', 'error'),
  msg('u-3', 'user', '第二句', 'done'),
  msg('a-3', 'assistant', '好的', 'done')
])
check('B-11 重试中间那条 → 拒绝（后面已经有既成事实）',
  (await failsWith(() => chatService.retry(two.id, 'a-2', fakeSender()), '只能重试最后一条回复')) === 'ok')
check('B-12 不存在的消息 id → 拒绝',
  (await failsWith(() => chatService.retry(two.id, 'nope', fakeSender()), '这条消息不存在')) === 'ok')
const opening = chatService.createSession({ mode: 'chat' })
chatService.appendMessages(opening.id, [msg('a-4', 'assistant', '开场白', 'done')])
check('B-13 只有开场白（没有用户发言）→ 拒绝重试',
  (await failsWith(() => chatService.retry(opening.id, 'a-4', fakeSender()), '没有用户发言')) === 'ok')
check('B-14 不存在的会话 → 拒绝',
  (await failsWith(() => chatService.retry('no-such-session', 'a-1', fakeSender()), '会话不存在')) === 'ok')

console.log('')
console.log('C · 删除一条消息')
const before = chatService.listSessions().find((s) => s.id === session.id).messages.length
chatService.deleteMessage(session.id, 'a-1')
const afterDelete = chatService.listSessions().find((s) => s.id === session.id)
check('C-01 内存里少了一条', afterDelete.messages.length === before - 1, afterDelete.messages.length + ' / ' + before)
check('C-02 用户那条还在（只删掉被打废的那条回复）',
  afterDelete.messages.length === 1 && afterDelete.messages[0].id === 'u-1')
check('C-03 盘上也少了一条', diskOf(session.id).messages.length === 1)
check('C-04 删不存在的 → 拒绝',
  (await failsWith(async () => chatService.deleteMessage(session.id, 'a-1'), '这条消息不存在')) === 'ok')

const deleting = chatService.createSession({ mode: 'chat' })
chatService.appendMessages(deleting.id, [msg('u-9', 'user', '在吗', 'done'), msg('a-9', 'assistant', '', 'error')])
const delSender = fakeSender()
await chatService.retry(deleting.id, 'a-9', delSender)
check('C-05 生成中删消息 → 拒绝',
  (await failsWith(async () => chatService.deleteMessage(deleting.id, 'a-9'), '先停止再删')) === 'ok')
chatService.stop(deleting.id)
await waitIdle(chatService, deleting.id)

/* ───────────────── D. 读盘收敛：上次没跑完的回复 ───────────────── */

console.log('')
console.log('D · 读盘收敛（应用关掉 / 崩掉后留下的 streaming 残骸）')
const userData2 = mkUserData('reload')
installElectronStub(userData2)
fs.writeFileSync(
  path.join(userData2, 'sessions.json'),
  JSON.stringify([
    {
      id: 'S-1',
      title: '崩过一次的对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      characterId: 'nahida',
      mode: 'chat',
      messages: [
        { id: 'm-u', role: 'user', content: '在吗', createdAt: 1, status: 'done' },
        { id: 'm-a', role: 'assistant', content: '在的，', createdAt: 2, status: 'streaming' },
        { id: 'm-b', role: 'assistant', content: '这句是正常的', createdAt: 3, status: 'done' }
      ]
    }
  ]),
  'utf8'
)
const reloadMod = await bundleModule(
  'chat-failed-reload',
  'export { chatService, INTERRUPTED_NOTICE } from ' + JSON.stringify(p('src/main/features/chat/chatService.ts'))
)
const reloaded = reloadMod.chatService.listSessions()[0]
const stale = reloaded.messages.find((m) => m.id === 'm-a')
check('D-01 残留的 streaming 读回来变成 error（不再是永远转圈）', stale.status === 'error', stale.status)
check('D-02 并且带上了原因', stale.error === reloadMod.INTERRUPTED_NOTICE, String(stale.error))
check('D-03 半截正文没被抹掉（用户要看得见它断在哪）', stale.content === '在的，')
check('D-04 正常的那条不动', reloaded.messages.find((m) => m.id === 'm-b').status === 'done')
const rewritten = JSON.parse(fs.readFileSync(path.join(userData2, 'sessions.json'), 'utf8'))[0]
check('D-05 收敛结果写回了盘（下次启动不会又变回转圈）',
  rewritten.messages.find((m) => m.id === 'm-a').status === 'error')

/* ───────────────── E. 渲染层契约（静态） ───────────────── */

console.log('')
console.log('E · 三端接线与界面契约')
const messageList = readSrc('src/renderer/src/features/chat/components/MessageList.tsx')
const chatPageSrc = readSrc('src/renderer/src/features/chat/ChatPage.tsx')
const storeSrc = readSrc('src/renderer/src/features/chat/store.ts')
const cssSrc = readSrc('src/renderer/src/styles/global.css')

check('E-01 MessageList 用 bubbleViewOf 决定形态（不再自己判 content）',
  messageList.includes("import { bubbleClassOf, bubbleViewOf } from '../bubble'") &&
    messageList.includes('bubbleViewOf(message, { isLive, isTail })'))
check('E-02 typing 只在 phase === typing 时出现',
  messageList.includes("view.phase === 'typing'") && /view\.phase === 'failed'/.test(messageList))
check('E-03 有「重试这一轮」按钮，且接 onRetry',
  messageList.includes('重试这一轮') && messageList.includes('onRetry?.(message.id)'))
check('E-04 有「删除这条」按钮，且接 onRemove',
  messageList.includes('删除这条') && messageList.includes('onRemove?.(message.id)'))
check('E-05 重试键排在删除键之前（主次顺序）',
  messageList.indexOf('重试这一轮') < messageList.indexOf('删除这条'))
check('E-06 不能重试时给一句原因，而不是留个坏掉的键',
  messageList.includes('只能重试最后一轮'))
check('E-07 ChatPage 把 isStreaming / onRetry / onRemove 都传下去了',
  chatPageSrc.includes('isStreaming={streaming}') && chatPageSrc.includes('void retry(messageId)') && chatPageSrc.includes('void removeMessage(messageId)'))
check('E-08 store 里有 retry / removeMessage 两个动作',
  /retry: \(messageId: string\) => Promise<void>/.test(storeSrc) && /removeMessage: \(messageId: string\)/.test(storeSrc))
check('E-09 失败原因写进**那一条**消息（不是只写顶部错误条）',
  /error: payload\.message/.test(storeSrc))
check('E-10 重试成功会清掉旧原因', /error: undefined/.test(storeSrc))
check('E-11 重试先清气泡再发 IPC（否则第一批增量会被抹掉）',
  storeSrc.indexOf('reduceRetryStart(state') < storeSrc.indexOf('window.nahida.chat.retry('))
check('E-12 旧的红字类 bubble--error 已下线（只允许出现在注释里）、新类 bubble--failed 有样式',
  !/\.bubble--error\s*\{/.test(cssSrc) &&
    /\.bubble--failed\s*\{/.test(cssSrc) &&
    cssSrc.includes('.bubble-actions button.bubble-actions__retry'))
const apiSrc = readSrc('src/shared/api.ts')
const ipcSrc = readSrc('src/shared/ipc.ts')
const preloadSrc = readSrc('src/preload/index.ts')
const ipcMainSrc = readSrc('src/main/ipc/index.ts')
check('E-13 三端都接了 chat:retry（shared → preload → main）',
  ipcSrc.includes("chatRetry: 'chat:retry'") && preloadSrc.includes('IPC.chatRetry') && ipcMainSrc.includes('IPC.chatRetry'))
check('E-14 三端都接了 chat:delete-message',
  ipcSrc.includes("chatDeleteMessage: 'chat:delete-message'") && preloadSrc.includes('IPC.chatDeleteMessage') && ipcMainSrc.includes('IPC.chatDeleteMessage'))
check('E-15 api.ts 有 retry / deleteMessage 的类型',
  /retry: \(sessionId: string, messageId: string\) => Promise<Message>/.test(apiSrc) && /deleteMessage: \(sessionId: string, messageId: string\) => Promise<void>/.test(apiSrc))

/* ───────────────── F. 广播 reducer ───────────────── */

console.log('')
console.log('F · 广播 reducer（把原因带进那一条）')
const storeMod = await bundleModule(
  'chat-failed-store',
  'export { reduceError, reduceDone, reduceRetryStart } from ' + JSON.stringify(p('src/renderer/src/features/chat/store.ts'))
)
const baseState = () => ({
  sessions: [{ id: 'S', title: 't', mode: 'chat', messages: [
    { id: 'm-a', role: 'assistant', content: '', status: 'streaming' },
    { id: 'm-b', role: 'assistant', content: '上一轮', status: 'done' }
  ] }],
  streamingId: 'S',
  approval: null,
  error: null
})
const errState = storeMod.reduceError(baseState(), { sessionId: 'S', messageId: 'm-a', message: '网络断了' })
check('F-01 reduceError 把原因写到那条消息上', errState.sessions[0].messages[0].error === '网络断了')
check('F-02 reduceError 同时收掉「正在生成」', errState.streamingId === null)
check('F-03 别的消息不受影响', errState.sessions[0].messages[1].content === '上一轮')
const doneState = storeMod.reduceDone(
  { sessions: [{ id: 'S', title: 't', mode: 'chat', messages: [{ id: 'm-a', role: 'assistant', content: '', status: 'error', error: '旧的失败原因' }] }], streamingId: 'S', approval: null, error: '旧的失败原因' },
  { sessionId: 'S', messageId: 'm-a', content: '重试成功', toolCalls: [] }
)
check('F-04 reduceDone 清掉旧原因（不会一边失败一边完成）', doneState.sessions[0].messages[0].error === undefined)
const retryState = storeMod.reduceRetryStart(
  { sessions: [{ id: 'S', title: 't', mode: 'chat', messages: [{ id: 'm-a', role: 'assistant', content: '半句', status: 'error', error: '断了', reasoning: '想过', toolCalls: [{ id: 'x' }] }] }], streamingId: null, approval: null, error: '断了' },
  { sessionId: 'S', messageId: 'm-a' }
)
const reset = retryState.sessions[0].messages[0]
check('F-05 reduceRetryStart 清空正文 / 思考 / 工具 / 原因',
  reset.content === '' && reset.reasoning === undefined && reset.toolCalls.length === 0 && reset.error === undefined)
check('F-06 reduceRetryStart 把状态拨回 streaming 并占住 streamingId',
  reset.status === 'streaming' && retryState.streamingId === 'S')
check('F-07 reduceRetryStart 顺手清掉顶部错误条', retryState.error === null)

done()
