/** Real chatService/store pre-send contract. Run: node scripts/test/chat-presend.test.mjs */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
async function test(label, run) {
  try { await run(); check(label, true) }
  catch (error) { check(label, false, error.stack ?? String(error)) }
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-chat-presend-'))
installElectronStub(userData)
fs.mkdirSync(path.join(userData, 'stories', 'story_presend_abc123'), { recursive: true })
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  provider: 'mock', defaultCharacterId: 'fixture',
  memory: { enabled: true, autoExtract: false }, bridge: { enabled: false }
}))
const stateKey = '__nahida_chat_presend_test__'
const control = globalThis[stateKey] = { providers: 0, calls: [], recalls: [], plans: [], releases: [] }
function gate(extra = {}) {
  let release
  const wait = new Promise(resolve => { release = resolve })
  control.releases.push(release)
  const plan = { wait, release, ...extra }
  control.plans.push(plan)
  return plan
}
const shared = `const state = globalThis[${JSON.stringify(stateKey)}];`
// Only capability boundaries are fixtures: storage, begin/runStream, payload mapping and reducers stay real.
const stubs = {
  '../llm': shared + `
    export function createProvider() {
      state.providers++;
      return { async *stream(input) {
        const plan = state.plans.shift() ?? {};
        state.calls.push({ messages: structuredClone(input.messages), signal: input.signal });
        if (plan.wait) await plan.wait;
        if (plan.error) throw new Error(plan.error);
        yield { type: 'reasoning', text: '思考片段' };
        yield { type: 'text', text: '真实流回复' };
      } };
    }`,
  '../rag': shared + `
    export const memoryService = {
      activePersona() { return 'default' }, upsertPersona() {}, appendHistory() {},
      async buildContextBlock(query) { state.recalls.push({ query, story: false }); return '' },
      async extractInBackground() {}, dispose() {}
    };`,
  '../story/memory': shared + `
    export function storyMemory() { return {
      async buildContextBlock(query) { state.recalls.push({ query, story: true }); return '' },
      async buildStoryContextBlock() { return '' }, async extractInBackground() {}, appendHistory() {}
    } }`,
  '../summary/service': `export const summaryService = {
    historyOf(session) { return session.messages.slice() }, systemBlock() { return '' },
    schedule() {}, forget() {}
  };`,
  '../rag/storyArchive': `export const storyArchiveService = { schedule() {}, forget() {}, invalidate() {}, isForgotten() { return false } };`,
  '../story/store': `export const storyStore = { get() { return null } };`,
  '../story/visibility': `export function branchVisibility() { return { bounds: new Map(), visible: () => true } }`,
  '../prompt/promptStore': `export const promptStore = {
    compose() { return '' }, hasCharacter() { return true },
    library() { return { characters: [{ id: 'fixture', name: 'fixture' }] } }
  };`,
  '../tools/registry': `export const listDefinitions = () => []; export const definitionOf = () => null;
    export async function executeTool() { throw new Error('unexpected tool execution') }`,
  '../tools/permission': `export const permissionGate = { cancelSession() {}, evaluate() { return 'deny' } };`,
  '../tools/clock': `export function clockNotice() { return '' }`,
  '../channels/toolGate': `export function channelToolVerdict() { return { allowed: false } }`,
  '../bridge/stream': `export async function* bridgeStream() { throw new Error('unexpected bridge request') }`
}
const plugin = { name: 'presend-capability-fixtures', setup(build) {
  build.onResolve({ filter: /.*/ }, args => {
    const importer = args.importer.replaceAll('\\', '/')
    if (Object.hasOwn(stubs, args.path) &&
      (importer.endsWith('/chat/chatService.ts') || importer.endsWith('/settings/settingsStore.ts'))) {
      return { path: args.path, namespace: 'presend-fixture' }
    }
    return null
  })
  build.onLoad({ filter: /.*/, namespace: 'presend-fixture' }, args => ({ contents: stubs[args.path], loader: 'ts' }))
} }
const source = [
  `export { chatService } from ${JSON.stringify(p('src/main/features/chat/chatService.ts'))}`,
  `export { IPC } from ${JSON.stringify(p('src/shared/ipc.ts'))}`
].join('\n')
const snapshot = value => structuredClone(value)
const callbacks = {}
const events = []
let IPC
const sender = { isDestroyed: () => false, send(channel, payload) {
  events.push({ channel, payload: snapshot(payload) })
  const names = { [IPC?.chatDelta]: 'delta', [IPC?.chatReasoning]: 'reasoning',
    [IPC?.chatTool]: 'tool', [IPC?.chatDone]: 'done', [IPC?.chatError]: 'error', [IPC?.chatApproval]: 'approval' }
  callbacks[names[channel]]?.(snapshot(payload))
} }
async function until(predicate, label) {
  const end = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('timeout: ' + label)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
let service
const row = id => service.listSessions().find(s => s.id === id)
const disk = id => JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8')).find(s => s.id === id)
const finish = async id => until(() => !service.isGenerating(id), 'turn finalization')
const message = (id, role, content) => ({ id, role, content, createdAt: 1, status: 'done' })
const watchdog = setTimeout(() => { check('standalone completion deadline', false); done() }, 30000)
try {
  const main = await bundleModule('chat-presend-main', source, [plugin])
  service = main.chatService; IPC = main.IPC
  await test('public pre-send methods exist on real service', () => {
    assert.equal(typeof service.queueMessage, 'function'); assert.equal(typeof service.requestReply, 'function')
  })

  const legacy = service.createSession({ mode: 'chat' })
  const legacyGate = gate()
  const sent = await service.send({ sessionId: legacy.id, content: '  普通发送  ' }, sender)
  await until(() => control.calls.length === 1, 'legacy provider entry')
  await test('send regression: unchanged user + assistant result and one provider stream', () => {
    assert.equal(sent.userMessage.content, '普通发送'); assert.equal(sent.userMessage.role, 'user')
    assert.equal(sent.assistantMessage.role, 'assistant'); assert.equal(sent.assistantMessage.status, 'streaming')
    assert.deepEqual(row(legacy.id).messages.map(m => m.role), ['user', 'assistant'])
    assert.equal(control.providers, 1); assert.equal(control.calls.length, 1)
  })
  legacyGate.release(); await finish(legacy.id)
  await test('send regression: real completion broadcasts and persists final assistant', () => {
    assert.equal(disk(legacy.id).messages.at(-1).content, '真实流回复')
    assert.ok(events.some(e => e.channel === IPC.chatDone && e.payload.messageId === sent.assistantMessage.id))
  })

  const story = service.createSession({ mode: 'story', storyId: 'story_presend_abc123' })
  service.updateSession(story.id, { preSend: true })
  const providersBefore = control.providers, callsBefore = control.calls.length
  const first = service.queueMessage({ sessionId: story.id, content: '  第一条\n 问候  ' })
  const second = service.queueMessage({ sessionId: story.id, content: '  第二条  ' })
  const narration = service.narrate(story.id, '  灯光暗下来。  ')
  await test('queue two users + narration: trim, done, exact order and zero provider activity', () => {
    assert.deepEqual(row(story.id).messages.map(m => [m.role, m.content, m.status]), [
      ['user', '第一条\n 问候', 'done'], ['user', '第二条', 'done'], ['narration', '灯光暗下来。', 'done']
    ])
    assert.equal(control.providers, providersBefore); assert.equal(control.calls.length, callsBefore)
    assert.equal(service.isGenerating(story.id), false)
  })
  await test('queue derives title and persists preSend and all three messages immediately', () => {
    assert.equal(row(story.id).title, '第一条 问候'); assert.equal(disk(story.id).preSend, true)
    assert.deepEqual(disk(story.id).messages.map(m => m.id), [first.id, second.id, narration.id])
  })
  await test('queue result is detached from stored message', () => { first.content = 'external mutation'; assert.equal(row(story.id).messages[0].content, '第一条\n 问候') })
  await test('queue rejects empty/non-string/missing-session inputs without mutation', () => {
    const before = snapshot(row(story.id))
    for (const content of ['', ' \n ', null, 12]) assert.throws(() => service.queueMessage({ sessionId: story.id, content }), /内容为空/)
    assert.throws(() => service.queueMessage({ sessionId: 'missing', content: 'x' }), /会话不存在/)
    assert.deepEqual(row(story.id), before)
  })
  const replyGate = gate()
  const reply = await service.requestReply({ sessionId: story.id }, sender)
  await until(() => control.calls.length === callsBefore + 1, 'pre-send provider entry')
  await test('requestReply returns only assistant placeholder and appends exactly one message', () => {
    assert.equal(reply.role, 'assistant'); assert.equal(reply.status, 'streaming'); assert.equal(reply.content, '')
    assert.equal(reply.userMessage, undefined); assert.equal(row(story.id).messages.length, 4)
    assert.deepEqual(row(story.id).messages.slice(0, 3).map(m => m.id), [first.id, second.id, narration.id])
    assert.equal(row(story.id).messages.at(-1).id, reply.id)
  })
  await test('real provider payload preserves user/user/narration order without synthetic user', () => {
    assert.deepEqual(control.calls.at(-1).messages, [
      { role: 'user', content: '第一条\n 问候' }, { role: 'user', content: '第二条' },
      { role: 'assistant', content: '系统旁白：灯光暗下来。' }
    ])
    assert.deepEqual(control.recalls.at(-1), { query: '第二条', story: true })
  })
  await test('generating turn rejects duplicate reply, enqueue and switch changes atomically', async () => {
    const before = snapshot(row(story.id)), count = control.providers
    await assert.rejects(service.requestReply({ sessionId: story.id }, sender), /生成/)
    assert.throws(() => service.queueMessage({ sessionId: story.id, content: 'late' }), /生成/)
    assert.throws(() => service.updateSession(story.id, { preSend: false }), /生成/)
    assert.throws(() => service.narrate(story.id, 'late'), /生成/)
    assert.deepEqual(row(story.id), before); assert.equal(control.providers, count)
  })
  service.stop(story.id)
  await test('stop keeps isGenerating true until blocked provider actually settles', () => {
    assert.equal(control.calls.at(-1).signal.aborted, true); assert.equal(service.isGenerating(story.id), true)
  })
  await test('stop tail lock rejects queue/reply/switch while inflight controller is gone', async () => {
    const before = snapshot(row(story.id))
    assert.throws(() => service.queueMessage({ sessionId: story.id, content: 'during finalization' }), /生成/)
    await assert.rejects(service.requestReply({ sessionId: story.id }, sender), /生成/)
    assert.throws(() => service.updateSession(story.id, { preSend: false }), /生成/)
    assert.deepEqual(row(story.id), before)
  })
  replyGate.release(); await finish(story.id)
  await test('already-replied queue rejects another reply without appending', async () => {
    const before = snapshot(row(story.id)), count = control.providers
    await assert.rejects(service.requestReply({ sessionId: story.id }, sender), /待回复/)
    assert.deepEqual(row(story.id), before); assert.equal(control.providers, count)
  })

  const empty = service.createSession({ mode: 'chat' })
  await test('empty queue and missing session reject requestReply', async () => {
    await assert.rejects(service.requestReply({ sessionId: empty.id }, sender), /待回复/)
    await assert.rejects(service.requestReply({ sessionId: 'missing' }, sender), /会话不存在/)
    assert.deepEqual(row(empty.id).messages, [])
  })
  const deleted = service.queueMessage({ sessionId: empty.id, content: 'to delete' })
  service.deleteMessage(empty.id, deleted.id)
  await test('deleting final queued user leaves no pending reply', async () => {
    await assert.rejects(service.requestReply({ sessionId: empty.id }, sender), /待回复/)
    assert.deepEqual(disk(empty.id).messages, [])
  })
  service.appendMessages(empty.id, [message('empty-user', 'user', '  '), message('empty-narration', 'narration', '\n')])
  await test('whitespace-only persisted tail is not a pending queue', async () => {
    await assert.rejects(service.requestReply({ sessionId: empty.id }, sender), /待回复/)
    assert.equal(row(empty.id).messages.length, 2)
  })
  await test('ordinary chat rejects narration regardless of preSend', () => {
    service.updateSession(empty.id, { preSend: true })
    assert.throws(() => service.narrate(empty.id, 'stage direction'), /故事区/)
  })

  const concurrent = service.createSession({ mode: 'chat' })
  service.queueMessage({ sessionId: concurrent.id, content: 'same tick queue' })
  const concurrentGate = gate(), concurrentCalls = control.calls.length
  const attempts = await Promise.allSettled([
    service.requestReply({ sessionId: concurrent.id }, sender),
    service.requestReply({ sessionId: concurrent.id }, sender)
  ])
  await until(() => control.calls.length === concurrentCalls + 1, 'same tick provider entry')
  await test('same-tick concurrent requestReply accepts exactly one and creates one assistant', () => {
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
    const rejected = attempts.find(item => item.status === 'rejected')
    assert.match(rejected.reason.message, /生成/)
    assert.deepEqual(row(concurrent.id).messages.map(m => m.role), ['user', 'assistant'])
    assert.equal(control.calls.length, concurrentCalls + 1)
  })
  concurrentGate.release(); await finish(concurrent.id)

  const noSwitch = service.createSession({ mode: 'chat', title: '保留自定义标题' })
  service.queueMessage({ sessionId: noSwitch.id, content: 'API does not require switch' })
  const noSwitchGate = gate()
  await service.requestReply({ sessionId: noSwitch.id }, sender)
  noSwitchGate.release(); await finish(noSwitch.id)
  await test('API queue/reply works with preSend absent and preserves custom title', () => {
    assert.equal(row(noSwitch.id).preSend, undefined); assert.equal(row(noSwitch.id).title, '保留自定义标题')
    assert.deepEqual(row(noSwitch.id).messages.map(m => m.role), ['user', 'assistant'])
  })

  // The old user must not become the query for a new narration-only round.
  const oldStory = service.createSession({ mode: 'story', storyId: 'story_presend_abc123' })
  service.appendMessages(oldStory.id, [message('old-user', 'user', '历史用户问题'), message('old-assistant', 'assistant', '旧回复')])
  service.narrate(oldStory.id, '新的旁白')
  const recallBefore = control.recalls.length, narrationGate = gate()
  await service.requestReply({ sessionId: oldStory.id }, sender)
  narrationGate.release(); await finish(oldStory.id)
  await test('narration-only new round skips recall even when an older user exists', () => {
    assert.equal(control.recalls.length, recallBefore)
    assert.deepEqual(control.calls.at(-1).messages, [
      { role: 'user', content: '历史用户问题' }, { role: 'assistant', content: '旧回复' },
      { role: 'assistant', content: '系统旁白：新的旁白' }
    ])
  })
  const pureNarration = service.createSession({ mode: 'story', storyId: 'story_presend_abc123' })
  const onlyNarration = service.narrate(pureNarration.id, '只有旁白')
  const pureRecallBefore = control.recalls.length, pureGate = gate()
  await service.requestReply({ sessionId: pureNarration.id }, sender)
  pureGate.release(); await finish(pureNarration.id)
  await test('narration alone is replyable with zero user and zero memory recall', () => {
    assert.deepEqual(row(pureNarration.id).messages.map(m => m.role), ['narration', 'assistant'])
    assert.equal(control.recalls.length, pureRecallBefore)
    assert.equal(row(pureNarration.id).messages[0].id, onlyNarration.id)
  })
  await test('pure narration failed reply retries same assistant with no user and no empty-query recall', async () => {
    const retryStory = service.createSession({ mode: 'story', storyId: 'story_presend_abc123' })
    service.updateSession(retryStory.id, { preSend: true })
    const queuedNarration = service.narrate(retryStory.id, '旁白失败后重试')
    const recallsBeforeRetry = control.recalls.length, streamsBeforeRetry = control.calls.length
    const failureGate = gate({ error: 'narration provider fixture failure' })
    const failedPlaceholder = await service.requestReply({ sessionId: retryStory.id }, sender)
    failureGate.release(); await finish(retryStory.id)
    const failed = disk(retryStory.id).messages.at(-1)
    assert.equal(failed.id, failedPlaceholder.id); assert.equal(failed.status, 'error')
    assert.equal(failed.error, 'narration provider fixture failure')
    assert.ok(events.some(e => e.channel === IPC.chatError && e.payload.messageId === failedPlaceholder.id))
    const retryGate = gate()
    try {
      const retryPlaceholder = await service.retry(retryStory.id, failedPlaceholder.id, sender)
      assert.equal(retryPlaceholder.id, failedPlaceholder.id); assert.equal(retryPlaceholder.status, 'streaming')
      assert.equal(retryPlaceholder.error, undefined)
      assert.deepEqual(row(retryStory.id).messages.map(m => m.id), [queuedNarration.id, failedPlaceholder.id])
      retryGate.release(); await finish(retryStory.id)
      const completed = disk(retryStory.id).messages.at(-1)
      assert.equal(completed.id, failedPlaceholder.id); assert.equal(completed.status, 'done')
      assert.equal(completed.content, '真实流回复'); assert.equal(completed.error, undefined)
      assert.deepEqual(row(retryStory.id).messages.map(m => m.role), ['narration', 'assistant'])
      assert.equal(control.recalls.length, recallsBeforeRetry); assert.equal(control.calls.length, streamsBeforeRetry + 2)
      assert.deepEqual(control.calls.at(-1).messages, [{ role: 'assistant', content: '系统旁白：旁白失败后重试' }])
      assert.ok(events.some(e => e.channel === IPC.chatDone && e.payload.messageId === failedPlaceholder.id))
    } finally {
      retryGate.release()
      const unused = control.plans.indexOf(retryGate)
      if (unused !== -1) control.plans.splice(unused, 1)
    }
  })

  const deletedNarration = service.createSession({ mode: 'story', storyId: 'story_presend_abc123' })
  const toDelete = service.narrate(deletedNarration.id, '待删除旁白')
  service.deleteMessage(deletedNarration.id, toDelete.id)
  await test('deleting final narration empties pending queue', async () => {
    await assert.rejects(service.requestReply({ sessionId: deletedNarration.id }, sender), /待回复/)
  })

  const channel = service.ensureChannelSession('qq:10001:private:10002', { title: 'QQ fixture' })
  await test('QQ channel rejects switch, enqueue and reply at service boundary', async () => {
    const before = snapshot(row(channel.id)), count = control.providers
    assert.throws(() => service.updateSession(channel.id, { preSend: true }), /渠道/)
    assert.throws(() => service.queueMessage({ sessionId: channel.id, content: 'forged' }), /渠道/)
    await assert.rejects(service.requestReply({ sessionId: channel.id }, sender), /渠道/)
    assert.deepEqual(row(channel.id), before); assert.equal(control.providers, count)
  })

  // A fresh bundle creates a fresh ChatService instance and reads real sessions.json.
  service.updateSession(noSwitch.id, { preSend: false })
  const persisted = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
  const forged = persisted.find(s => s.id === channel.id)
  forged.preSend = true; forged.messages.push(message('forged-user', 'user', '伪造渠道队列'))
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify(persisted))
  const reload = (await bundleModule('chat-presend-restart', source, [plugin])).chatService
  await test('restart reads both enabled and disabled preSend from real disk', () => {
    assert.equal(reload.listSessions().find(s => s.id === story.id).preSend, true)
    assert.equal(reload.listSessions().find(s => s.id === noSwitch.id).preSend, false)
    assert.equal(reload.listSessions().find(s => s.id === story.id).messages.length, 4)
  })
  await test('QQ persisted forged preSend=true and queued user do not bypass channel guard', async () => {
    const before = snapshot(reload.listSessions().find(s => s.id === channel.id)), count = control.providers
    assert.throws(() => reload.queueMessage({ sessionId: channel.id, content: 'x' }), /渠道/)
    await assert.rejects(reload.requestReply({ sessionId: channel.id }, sender), /渠道/)
    assert.deepEqual(reload.listSessions().find(s => s.id === channel.id), before)
    assert.equal(control.providers, count)
  })

  // Use real Zustand and the production reducers; IPC transport deliberately delays invoke returns.
  const apiCounts = { queue: 0, reply: 0 }
  let earlyDone = false, rejectReply = false, lastUiAssistant
  const uiSender = { ...sender, send(channel, payload) {
    if (channel === IPC.chatDone) earlyDone = true
    sender.send(channel, payload)
  } }
  globalThis.window = { nahida: { chat: {
    listSessions: async () => service.listDesktopSessions(),
    queueMessage: async input => { apiCounts.queue++; return service.queueMessage(input) },
    requestReply: async input => {
      apiCounts.reply++
      if (rejectReply) throw new Error('fixture invoke failed')
      const placeholder = await service.requestReply(input, uiSender)
      lastUiAssistant = placeholder.id
      await finish(input.sessionId) // done/delta arrive before placeholder invoke resolves.
      return placeholder
    },
    narrate: async (id, text) => service.narrate(id, text),
    stop: async id => service.stop(id),
    updateSession: async (id, patch) => service.updateSession(id, patch),
    onDelta: fn => (callbacks.delta = fn, () => {}),
    onReasoning: fn => (callbacks.reasoning = fn, () => {}),
    onTool: fn => (callbacks.tool = fn, () => {}),
    onApproval: fn => (callbacks.approval = fn, () => {}),
    onDone: fn => (callbacks.done = fn, () => {}),
    onError: fn => (callbacks.error = fn, () => {})
  } } }
  const { useChatStore: store } = await bundleModule('chat-presend-renderer',
    `export { useChatStore } from ${JSON.stringify(p('src/renderer/src/features/chat/store.ts'))}`)
  await store.getState().init()
  const uiSession = service.createSession({ mode: 'story', storyId: 'story_presend_abc123' })
  service.updateSession(uiSession.id, { preSend: true })
  store.getState().adoptStorySession(row(uiSession.id))
  await test('renderer queue keeps streaming idle and appends authoritative trimmed user', async () => {
    const count = control.providers
    await store.getState().queueMessage('  renderer user  ')
    assert.equal(store.getState().streamingId, null); assert.equal(control.providers, count)
    assert.equal(store.getState().sessions.find(s => s.id === uiSession.id).messages.at(-1).content, 'renderer user')
  })
  await store.getState().narrate(' renderer narration ')
  const uiGate = gate()
  const uiReplyPromise = store.getState().requestReply()
  await until(() => apiCounts.reply === 1 && service.isGenerating(uiSession.id), 'renderer request entry')
  await test('renderer locks streaming before invoke and suppresses duplicate reply/enqueue', async () => {
    assert.equal(store.getState().streamingId, uiSession.id)
    const queueCount = apiCounts.queue
    await store.getState().requestReply(); await store.getState().queueMessage('late')
    assert.equal(apiCounts.reply, 1); assert.equal(apiCounts.queue, queueCount)
  })
  uiGate.release(); await uiReplyPromise
  await test('renderer replays early delta/reasoning/done after installing exactly one placeholder', () => {
    const state = store.getState(), messages = state.sessions.find(s => s.id === uiSession.id).messages
    assert.equal(earlyDone, true); assert.equal(state.streamingId, null); assert.equal(state.error, null)
    assert.deepEqual(messages.map(m => m.role), ['user', 'narration', 'assistant'])
    assert.equal(messages.filter(m => m.id === lastUiAssistant).length, 1)
    assert.equal(messages.at(-1).content, '真实流回复'); assert.equal(messages.at(-1).reasoning, '思考片段')
    assert.equal(messages.at(-1).status, 'done')
  })
  await store.getState().queueMessage('after completion')
  rejectReply = true
  await store.getState().requestReply()
  await test('renderer invoke rejection clears lock, preserves queue and exposes error', () => {
    assert.equal(store.getState().streamingId, null); assert.equal(store.getState().error, 'fixture invoke failed')
    assert.equal(store.getState().sessions.find(s => s.id === uiSession.id).messages.at(-1).content, 'after completion')
  })
  rejectReply = false
  const recoverGate = gate()
  const recovering = store.getState().requestReply()
  await until(() => service.isGenerating(uiSession.id), 'renderer recovery entry')
  recoverGate.release(); await recovering
  await test('renderer request recovers after rejection without stale pending event lock', () => {
    assert.equal(store.getState().error, null); assert.equal(store.getState().streamingId, null)
    assert.equal(store.getState().sessions.find(s => s.id === uiSession.id).messages.at(-1).status, 'done')
  })

  const view = await bundleModule('chat-presend-message-list-ssr', [
    `export { createElement } from ${JSON.stringify(p('node_modules/react/index.js'))}`,
    `export { renderToStaticMarkup } from ${JSON.stringify(p('node_modules/react-dom/server.node.js'))}`,
    `export { MessageList } from ${JSON.stringify(p('src/renderer/src/features/chat/components/MessageList.tsx'))}`
  ].join('\n'), [{ name: 'presend-ssr-assets', setup(build) {
    build.onLoad({ filter: /[.](png|svg)$/ }, () => ({ contents: 'export default "asset"', loader: 'js' }))
  } }])
  const renderMessages = (messages, extra = {}) => view.renderToStaticMarkup(
    view.createElement(view.MessageList, { messages, onRetry() {}, ...extra }))
  await test('MessageList SSR exposes retry for failed pure-narration tail assistant', () => {
    const html = renderMessages([message('ssr-narration', 'narration', '只有舞台旁白'),
      { ...message('ssr-failed-assistant', 'assistant', ''), status: 'error', error: 'provider failed' }])
    assert.match(html, /aria-label="重试这一轮"/)
  })
  await test('MessageList SSR keeps opening-only and read-only channel retry hidden', () => {
    const opening = [{ ...message('ssr-opening', 'assistant', ''), status: 'error', error: 'opening fixture' }]
    assert.doesNotMatch(renderMessages(opening), /aria-label="重试这一轮"/)
    assert.doesNotMatch(renderMessages([message('ssr-channel-narration', 'narration', 'forged narration'), ...opening],
      { readOnly: true }), /aria-label="重试这一轮"/)
  })
} catch (error) {
  check('test setup and execution completed', false, error.stack ?? String(error))
} finally {
  for (const release of control.releases) release()
  if (service) {
    service.abortAll()
    await until(() => service.listSessions().every(s => !service.isGenerating(s.id)), 'all turns cleanup').catch(error => check('all turns cleanup', false, error.message))
  }
  clearTimeout(watchdog)
  delete globalThis[stateKey]
}
done()
