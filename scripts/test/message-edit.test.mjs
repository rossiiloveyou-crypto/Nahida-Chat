/** P8: real service persistence, atomic resend, DOM actions and early IPC event ordering. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

let checks = 0
async function test(name, run) { await run(); console.log('ok ' + (++checks) + ' - ' + name) }
const msg = (id, role, content = id, extra = {}) => ({ id, role, content, status: 'done', createdAt: 1, ...extra })
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-message-edit-'))
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ memory: { enabled: false, autoExtract: false }, bridge: { enabled: false }, summary: { enabled: true } }))
installElectronStub(dir)
const main = await bundleModule('message-edit-main', [
  'export { chatService } from ' + JSON.stringify(p('src/main/features/chat/chatService.ts')),
  'export { settingsStore } from ' + JSON.stringify(p('src/main/features/settings/settingsStore.ts')),
  'export { SummaryStore, summaryKeyOf } from ' + JSON.stringify(p('src/main/features/summary/store.ts')),
  'export { summaryService } from ' + JSON.stringify(p('src/main/features/summary/service.ts')),
  'export { emptySummary } from ' + JSON.stringify(p('src/main/features/summary/types.ts')),
  'export { IPC } from ' + JSON.stringify(p('src/shared/ipc.ts'))
].join(String.fromCharCode(10)))
const { chatService: service, IPC } = main
const session = service.createSession({ mode: 'chat' })
service.appendMessages(session.id, [msg('u', 'user'), msg('a', 'assistant'), msg('n', 'narration'), msg('later', 'assistant')])
const row = () => service.listSessions().find(s => s.id === session.id)
const disk = () => JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).find(s => s.id === session.id)
const raw = '  原文 ' + String.fromCharCode(10) + '<tag>你好 🌱</tag>  '
const before = row()
let calls = 0
const realRun = service.runStream.bind(service)
service.runStream = (...args) => { calls++; return realRun(...args) }
await test('save preserves exact text, id and createdAt', () => {
  const updated = service.updateMessage(session.id, 'u', raw)
  assert.equal(updated.content, raw); assert.equal(updated.id, 'u'); assert.equal(updated.createdAt, before.messages[0].createdAt)
})
await test('save adds no reply, inflight or stream call', () => { assert.equal(calls, 0); assert.equal(service.isGenerating(session.id), false); assert.equal(row().messages.length, 4) })
await test('save persists and advances session timestamp', () => { assert.equal(disk().messages[0].content, raw); assert.ok(row().updatedAt > before.updatedAt) })
await test('returned message is detached from stored message', () => { const m = service.updateMessage(session.id, 'u', raw); m.content = 'external'; assert.equal(row().messages[0].content, raw) })
await test('narration save is exact and starts no generation', () => { assert.equal(service.updateMessage(session.id, 'n', raw).content, raw); assert.equal(calls, 0) })
for (const action of ['updateMessage', 'resendFrom']) {
  await test(action + ' rejects missing session', () => assert.throws(() => service[action]('missing', 'u', raw, {}), /会话不存在/))
  await test(action + ' rejects missing message', () => assert.throws(() => service[action](session.id, 'missing', raw, {}), /消息不存在/))
  await test(action + ' rejects assistant and leaves all history intact', () => { const old = JSON.stringify(row()); assert.throws(() => service[action](session.id, 'a', raw, {}), /助手回复请使用重试/); assert.equal(JSON.stringify(row()), old) })
  await test(action + ' rejects whitespace and non-string before mutation', () => { const old = JSON.stringify(row()); for (const invalid of ['   ', null, 42]) assert.throws(() => service[action](session.id, 'u', invalid, {}), /消息内容为空/); assert.equal(JSON.stringify(row()), old) })
}
const channel = service.ensureChannelSession('qq:1:private:2', { title: 'fixture' })
service.appendMessages(channel.id, [msg('qu', 'user')])
for (const action of ['updateMessage', 'resendFrom']) await test(action + ' enforces channel read-only at service boundary', () => assert.throws(() => service[action](channel.id, 'qu', raw, {}), /只读/))

// Seed a real persisted summary so delete/healing can be observed without a summary model.
const summary = { ...main.emptySummary(session.id), coveredCount: 4, anchorMessageId: 'later', sections: { short_term: 'existing', long_term: '', user_info: '', promises: '' } }
const summaryStore = new main.SummaryStore(() => dir)
summaryStore.save(new Map([[main.summaryKeyOf(session.id, summary.personaId), summary]]))
main.summaryService.stateOf(session.id)
const summaryFile = path.join(dir, 'summaries.json')
const summaryBytes = fs.readFileSync(summaryFile, 'utf8')
await test('delete removes only target and preserves remaining order', () => { service.deleteMessage(session.id, 'a'); assert.deepEqual(row().messages.map(m => m.id), ['u', 'n', 'later']); assert.deepEqual(disk().messages.map(m => m.id), ['u', 'n', 'later']) })
await test('delete alone leaves summary storage untouched', () => assert.equal(fs.readFileSync(summaryFile, 'utf8'), summaryBytes))
await test('S2 historyOf omits deleted message and heals shifted anchor', () => { const history = main.summaryService.historyOf(row()); assert.deepEqual(history.map(m => m.id), ['u', 'n', 'later']); assert.equal(main.summaryService.stateOf(session.id).coveredCount, 3); assert.equal(main.summaryService.stateOf(session.id).anchorMessageId, 'later') })
await test('S2 history healing persists only coordinates and diagnostic', () => { const healed = new main.SummaryStore(() => dir).load().get(main.summaryKeyOf(session.id, summary.personaId)); assert.equal(healed.coveredCount, 3); assert.equal(healed.anchorMessageId, 'later'); assert.deepEqual(healed.sections, summary.sections); assert.equal(healed.updatedAt, summary.updatedAt); assert.ok(healed.lastError.includes('重挂')) })
const healedSummaryBytes = fs.readFileSync(summaryFile, 'utf8')
await test('S2 repeated history read is idempotent on disk', () => { main.summaryService.historyOf(row()); assert.equal(fs.readFileSync(summaryFile, 'utf8'), healedSummaryBytes) })

let release
service.runStream = (_session, _message, _sink, controller) => {
  calls++
  return new Promise(resolve => { release = () => { service.inflight.delete(_session.id); service.turns.delete(_session.id); resolve({ status: controller.signal.aborted ? 'aborted' : 'done' }) } })
}
const sender = { isDestroyed: () => false, send: () => {} }
const priorCalls = calls
const placeholder = service.resendFrom(session.id, 'n', raw, sender)
await test('resend truncates suffix and appends exactly one assistant placeholder', () => { assert.deepEqual(row().messages.map(m => m.id), ['u', 'n', placeholder.id]); assert.equal(placeholder.role, 'assistant'); assert.equal(placeholder.status, 'streaming'); assert.equal(placeholder.content, ''); assert.deepEqual(placeholder.toolCalls, []) })
await test('resend invokes stream once, with exact persisted narration', () => { assert.equal(calls, priorCalls + 1); assert.equal(disk().messages[1].content, raw); assert.equal(service.isGenerating(session.id), true) })
await test('resend leaves healed summary storage unchanged', () => assert.equal(fs.readFileSync(summaryFile, 'utf8'), healedSummaryBytes))
await test('inflight update/resend share exact restartTurn error', async () => {
  let expected
  try { await service.retry(session.id, placeholder.id, sender) } catch (e) { expected = e.message }
  assert.ok(expected.includes('先停止'))
  for (const action of ['updateMessage', 'resendFrom']) assert.throws(() => service[action](session.id, 'n', raw, sender), e => e.message === expected)
})
await test('inflight delete keeps existing stop-first guard', () => assert.throws(() => service.deleteMessage(session.id, 'u'), /先停止/))
release()
service.runStream = realRun
const seen = []
const realPlaceholder = service.resendFrom(session.id, 'u', raw, { ...sender, send: (channel, payload) => seen.push({ channel, payload }) })
for (let i = 0; service.isGenerating(session.id) && i < 800; i++) await new Promise(resolve => setTimeout(resolve, 20))
await test('real runStream finishes and emits done for the new id', () => { assert.equal(service.isGenerating(session.id), false); assert.ok(seen.some(e => e.channel === IPC.chatDone && e.payload.messageId === realPlaceholder.id)); assert.equal(disk().messages.at(-1).status, 'done') })
await test('real resend retains only edited user and new response', () => { assert.deepEqual(row().messages.map(m => m.role), ['user', 'assistant']); assert.equal(row().messages[0].content, raw) })
await test('new service instance reads exact edited content from disk', async () => { const reloaded = await bundleModule('message-edit-reload', 'export { chatService } from ' + JSON.stringify(p('src/main/features/chat/chatService.ts'))); assert.equal(reloaded.chatService.listSessions().find(s => s.id === session.id).messages[0].content, raw) })

// React DOM uses the production components/store; only browser assets and backend APIs are fixtures.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1' })
globalThis.window = dom.window; globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
const callbacks = {}
const uiSession = { ...row(), id: 'ui', mode: 'story', storyId: undefined, messages: [msg('ui-u', 'user', '用户原文'), msg('ui-n', 'narration', '旁白原文'), msg('ui-a', 'assistant', '助手正文')] }
let uiSettings = { ...main.settingsStore.get(), bridge: { enabled: true } }
let modelWrites = 0, sendCalls = 0
window.nahida = {
 initialTheme: 'light',
 settings: { get: async () => uiSettings, save: async patch => (uiSettings = { ...uiSettings, ...patch }) },
 modelProfiles: { list: async () => ({ profiles: [{ id: 'profile', name: 'Profile', provider: 'mock', models: ['model'], defaultModel: 'model' }], defaultProfileId: 'profile' }) },
 prompts: { library: async () => ({ characters: [] }) },
 workspaces: { list: async () => ({ workspaces: [], activeWorkspaceId: null }) },
 regex: { listScripts: async () => [] },
 chat: {
   listSessions: async () => [structuredClone(uiSession)],
   updateSession: async () => { modelWrites++; return uiSession },
   update: async (_sid, mid, content) => ({ ...uiSession.messages.find(m => m.id === mid), content }),
   send: async () => { sendCalls++; throw Error('fixture') },
   onDelta: fn => (callbacks.delta = fn, () => {}), onReasoning: fn => (callbacks.reasoning = fn, () => {}),
   onTool: fn => (callbacks.tool = fn, () => {}), onApproval: fn => (callbacks.approval = fn, () => {}),
   onDone: fn => (callbacks.done = fn, () => {}), onError: fn => (callbacks.error = fn, () => {})
 }
}
const ui = await bundleModule('message-edit-dom', [
 'export { createElement, act } from ' + JSON.stringify(p('node_modules/react/index.js')),
 'export { createRoot } from ' + JSON.stringify(p('node_modules/react-dom/client.js')),
 'export { MessageList } from ' + JSON.stringify(p('src/renderer/src/features/chat/components/MessageList.tsx')),
 'export { ChatPage } from ' + JSON.stringify(p('src/renderer/src/features/chat/ChatPage.tsx')),
 'export { useChatStore } from ' + JSON.stringify(p('src/renderer/src/features/chat/store.ts')),
 'export { useSettings } from ' + JSON.stringify(p('src/renderer/src/features/settings/useSettings.ts')),
 'export { bridgeEligible } from ' + JSON.stringify(p('src/shared/bridge.ts'))
].join(String.fromCharCode(10)), [{ name: 'fixture-assets', setup(build) { build.onLoad({ filter: new RegExp('[.](png|svg)$') }, () => ({ contents: 'export default "asset"', loader: 'js' })) } }])
const { act, createElement: h, createRoot } = ui
const root = createRoot(document.getElementById('root'))
const mount = async (Component, props) => act(async () => { root.render(h(Component, props)) })
const buttons = () => [...document.querySelectorAll('button')]
const findButton = text => buttons().find(b => b.textContent === text)
const click = async b => { assert.ok(b, 'button exists'); await act(async () => b.click()) }
const input = async (node, value) => act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new window.Event('input', { bubbles: true })) })
let saved = [], resent = [], removed = [], retried = [], editing = false
const props = { messages: uiSession.messages, onUpdate: async (id, content) => (saved.push({ id, content }), true), onResend: async (id, content) => (resent.push({ id, content }), true), onRemove: id => removed.push(id), onRetry: id => retried.push(id), onEditingChange: value => { editing = value } }
await mount(ui.MessageList, props)
await test('DOM edits user and narration but never assistant', () => { assert.equal(buttons().filter(b => b.textContent === '编辑这条').length, 2); assert.equal(document.querySelector('[data-message-id="ui-a"]') .textContent.includes('编辑这条'), false) })
await test('DOM delete is available for every role', () => assert.equal(buttons().filter(b => b.textContent === '删除这条').length, 3))
await test('assistant tail uses existing retry callback', async () => { await click(findButton('重试这一轮')); assert.deepEqual(retried, ['ui-a']) })
await test('narration editor starts from original source', async () => { await click(document.querySelector('[data-message-id="ui-n"] button')); assert.equal(document.querySelector('.message-editor textarea').value, '旁白原文'); assert.equal(editing, true) })
await test('save-only DOM submits exact draft and closes editor', async () => { await input(document.querySelector('.message-editor textarea'), raw); await click(findButton('保存不发送')); assert.deepEqual(saved, [{ id: 'ui-n', content: raw }]); assert.equal(resent.length, 0); assert.equal(editing, false) })
await test('resend requires explicit confirmation and submits exact draft', async () => { await click(document.querySelector('[data-message-id="ui-u"] button')); await input(document.querySelector('.message-editor textarea'), raw); await click(findButton('保存并重新提问')); assert.equal(resent.length, 0); assert.ok(document.querySelector('.message-confirm').textContent.includes('全部消息')); await click(document.querySelector('.message-confirm button')); assert.deepEqual(resent, [{ id: 'ui-u', content: raw }]) })
await test('delete cancellation has no callback; confirmation removes chosen id', async () => { await click(findButton('删除这条')); assert.equal(removed.length, 0); await click(findButton('取消')); assert.equal(removed.length, 0); await click(findButton('删除这条')); await click(document.querySelector('.message-confirm button')); assert.deepEqual(removed, ['ui-u']) })
await test('channel read-only renders no edit/delete/retry action buttons', async () => { await mount(ui.MessageList, { ...props, readOnly: true }); assert.equal(document.querySelectorAll('.message-actions button').length, 0) })
await test('streaming disables edits and displays stop-first reason', async () => { await mount(ui.MessageList, { ...props, isStreaming: true }); const edit = findButton('编辑这条'); assert.equal(edit.disabled, true); assert.ok(edit.title.includes('先停止')); await click(edit); assert.equal(document.querySelector('.message-editor'), null) })
await mount(ui.ChatPage)
await test('bridge story model selector is natively disabled and explains ST selection', () => { const pick = document.querySelector('[data-ui-target="模型选择"]'); assert.equal(pick.disabled, true); assert.equal(pick.title, '本轮由 ST 桥接生成，模型在 ST 里设置') })
function composerProps() { const node = document.querySelector('.composer'); const key = Object.keys(node).find(k => k.startsWith('__reactFiber$')); let fiber = node[key]; while (fiber && fiber.type?.name !== 'Composer') fiber = fiber.return; assert.ok(fiber, 'production Composer fiber'); return fiber.memoizedProps }
await test('direct model callback is guarded before session writes', async () => { await act(async () => composerProps().onPickModel('profile', 'model')); assert.equal(modelWrites, 0) })
await test('editing locks composer send while preserving typed draft', async () => { await input(document.querySelector('.composer__input'), '新消息'); await click(findButton('编辑这条')); assert.equal(document.querySelector('.composer__action').disabled, true); await act(async () => composerProps().onSend('新消息')); assert.equal(sendCalls, 0); await click(findButton('取消编辑')); assert.equal(document.querySelector('.composer__action').disabled, false) })
let settingsApi
function SettingsProbe() { settingsApi = ui.useSettings(); return null }
await act(async () => root.render(h('div', null, h(ui.ChatPage), h(SettingsProbe))))
await act(async () => { await settingsApi.save({ bridge: { enabled: false } }) })
await test('turning bridge off restores model selector and callback', async () => { assert.equal(document.querySelector('[data-ui-target="模型选择"]').disabled, false); await act(async () => composerProps().onPickModel('profile', 'model')); assert.equal(modelWrites, 1) })
await test('shared predicate excludes chat, agent and channel sessions', () => { const enabled = { bridge: { enabled: true } }; assert.equal(ui.bridgeEligible({ id: 'x', mode: 'story' }, enabled), true); for (const mode of ['chat', 'agent']) assert.equal(ui.bridgeEligible({ id: 'x', mode }, enabled), false); assert.equal(ui.bridgeEligible({ id: 'qq:1:private:2', mode: 'story' }, enabled), false) })

await test('channel ChatPage passes read-only through to all message actions', async () => {
 await act(async () => ui.useChatStore.setState({ sessions: [{ ...uiSession, id: 'qq:1:private:2' }], activeId: 'qq:1:private:2' }))
 assert.equal(document.querySelectorAll('.message-actions button').length, 0)
})

// Exercise production store with broadcasts emitted before IPC resolves.
await act(async () => root.unmount())
const store = ui.useChatStore
const resetStore = () => store.setState({ sessions: [structuredClone(uiSession)], activeId: 'ui', streamingId: null, approval: null, error: null })
resetStore()
window.nahida.chat.resend = async (sessionId, messageId, content) => {
 const payload = { sessionId, messageId: 'new-reply' }
 callbacks.delta({ ...payload, delta: '首段' }); callbacks.reasoning({ ...payload, delta: '思考' })
 callbacks.tool({ ...payload, calls: [{ id: 't', name: 'fixture' }] })
 callbacks.done({ ...payload, content: '完整回复', reasoning: '完整思考', toolCalls: [], warnings: ['本轮告警'] })
 return msg('new-reply', 'assistant', '', { status: 'streaming' })
}
await test('resend buffers early delta/reasoning/tool/done and preserves terminal state', async () => { assert.equal(await store.getState().resendFrom('ui-u', raw), true); const s = store.getState(); assert.deepEqual(s.sessions[0].messages.map(m => m.id), ['ui-u', 'new-reply']); const reply = s.sessions[0].messages[1]; assert.equal(reply.content, '完整回复'); assert.equal(reply.reasoning, '完整思考'); assert.deepEqual(reply.warnings, ['本轮告警']); assert.equal(reply.status, 'done'); assert.equal(s.streamingId, null) })
resetStore()
window.nahida.chat.resend = async sessionId => {
 const payload = { sessionId, messageId: 'live-reply' }
 callbacks.delta({ ...payload, delta: '首段' }); callbacks.reasoning({ ...payload, delta: '思考' })
 callbacks.tool({ ...payload, calls: [{ id: 't', name: 'fixture' }] })
 return msg('live-reply', 'assistant', '', { status: 'streaming' })
}
await test('early live increments survive without a done event overwriting them', async () => {
 await store.getState().resendFrom('ui-u', raw)
 const reply = store.getState().sessions[0].messages[1]
 assert.equal(reply.content, '首段'); assert.equal(reply.reasoning, '思考'); assert.equal(reply.toolCalls[0].id, 't')
 assert.equal(store.getState().streamingId, 'ui')
})
resetStore()
window.nahida.chat.resend = async sessionId => { callbacks.error({ sessionId, messageId: 'failed-reply', message: 'fixture failure' }); return msg('failed-reply', 'assistant', '', { status: 'streaming' }) }
await test('early resend failure belongs to newly installed assistant bubble', async () => { await store.getState().resendFrom('ui-u', raw); assert.equal(store.getState().sessions[0].messages[1].error, 'fixture failure'); assert.equal(store.getState().streamingId, null) })
resetStore()
window.nahida.chat.resend = async () => { throw Error('fixture rejected') }
await test('IPC rejection retains original messages without optimistic truncation', async () => { assert.equal(await store.getState().resendFrom('ui-u', raw), false); assert.deepEqual(store.getState().sessions[0].messages, uiSession.messages); assert.equal(store.getState().streamingId, null) })
// 拒绝＝没有这一轮：提前到达的广播必须被丢弃，不回放给一个不存在的占位 id。
resetStore()
window.nahida.chat.resend = async sessionId => { callbacks.delta({ sessionId, messageId: 'ghost-reply', delta: '幽灵' }); throw Error('fixture rejected') }
await test('rejected resend drops buffered broadcasts instead of replaying them', async () => {
 assert.equal(await store.getState().resendFrom('ui-u', raw), false)
 assert.ok(!store.getState().sessions[0].messages.some(m => m.id === 'ghost-reply'))
 assert.deepEqual(store.getState().sessions[0].messages, uiSession.messages)
})
await test('a rejection leaves no stuck buffer for the next attempt', async () => {
 window.nahida.chat.resend = async sessionId => { const payload = { sessionId, messageId: 'after-reply' }; callbacks.delta({ ...payload, delta: '正常' }); return msg('after-reply', 'assistant', '', { status: 'streaming' }) }
 assert.equal(await store.getState().resendFrom('ui-u', raw), true)
 const reply = store.getState().sessions[0].messages[1]
 assert.equal(reply.id, 'after-reply'); assert.equal(reply.content, '正常')
})
const storeSrc = fs.readFileSync(p('src/renderer/src/features/chat/store.ts'), 'utf8')
await test('rejection path drops the queue instead of flushing it', () => {
 // SUP-02 的 requestReply 也复用缓冲；本断言只约束 resendFrom 的成功/失败分支。
 const resendSrc = storeSrc.slice(storeSrc.indexOf('  resendFrom: async '), storeSrc.indexOf('  removeMessage: async '))
 assert.ok(resendSrc.length > 0)
 assert.equal((resendSrc.match(/flushResend\(sessionId\)/g) || []).length, 1)
 assert.ok(resendSrc.includes('dropResend(sessionId)'))
})
resetStore()
await test('save-only store updates exact content without generation', async () => { assert.equal(await store.getState().updateMessage('ui-n', raw), true); assert.equal(store.getState().sessions[0].messages[1].content, raw); assert.equal(store.getState().sessions[0].messages.length, 3); assert.equal(store.getState().streamingId, null) })
for (const [channelName, method] of [['chatUpdateMessage', 'update'], ['chatResend', 'resend']]) await test('IPC contract is connected: ' + method, () => { for (const file of ['src/shared/ipc.ts', 'src/main/ipc/index.ts', 'src/preload/index.ts']) assert.ok(fs.readFileSync(p(file), 'utf8').includes(channelName), file); assert.ok(fs.readFileSync(p('src/shared/api.ts'), 'utf8').includes(method + ': (sessionId: string, messageId: string, content: string)')) })
await test('desktop delete handler guards channel identity without changing service deletion', () => {
 const source = fs.readFileSync(p('src/main/ipc/index.ts'), 'utf8')
 const start = source.indexOf('ipcMain.handle(IPC.chatDeleteMessage')
 assert.ok(source.slice(start, start + 280).includes("if (isChannelSessionId(sessionId))"))
})
dom.window.close()
// jsdom/React scheduler MessagePorts outlive unmount; release only their event-loop refs.
for (const handle of process._getActiveHandles()) if (handle.constructor.name === 'MessagePort') handle.unref()
console.log('PASS message-edit ' + checks + '/' + checks)
