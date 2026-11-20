/** P4.9 B/C: production React DOM/store + real story service/disk/payload, no source regex. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
async function test(name, run) { await run(); check(name, true) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p49-story-entry-'))
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultCharacterId: 'fixture', memory: { enabled: false, autoExtract: false }, storyRecall: { enabled: false }, bridge: { enabled: false }, summary: { enabled: false } }))
installElectronStub(dir)
const api = await bundleModule('p49-story-entry-main', [
  'export * from ' + JSON.stringify(p('src/main/features/story/service.ts')),
  'export { StoryStore } from ' + JSON.stringify(p('src/main/features/story/store.ts')),
  'export { storyProfilePath, storyDir } from ' + JSON.stringify(p('src/main/features/story/paths.ts')),
  'export { closeAllStoryMemory } from ' + JSON.stringify(p('src/main/features/story/memory.ts')),
  'export { chatService } from ' + JSON.stringify(p('src/main/features/chat/chatService.ts')),
  'export { settingsStore } from ' + JSON.stringify(p('src/main/features/settings/settingsStore.ts')),
  'export { promptStore } from ' + JSON.stringify(p('src/main/features/prompt/promptStore.ts')),
  'export { resolveToolSupply } from ' + JSON.stringify(p('src/main/features/tools/capability.ts'))
].join('\n'))
// All authored prompt assets live in this fixture, never in the repository's Prompt/.
const promptRoot = path.join(dir, 'fixture-prompt')
fs.mkdirSync(path.join(promptRoot, 'characters/fixture/modes'), { recursive: true })
fs.writeFileSync(path.join(promptRoot, 'characters/fixture/soul.md'), 'CHARACTER_SENTINEL')
for (const mode of ['chat', 'agent', 'story']) fs.writeFileSync(path.join(promptRoot, 'characters/fixture/modes', mode + '.md'), 'MODE_' + mode)
api.promptStore.root = () => promptRoot
const main = api.chatService
const make = (extra = {}) => api.createStory({ title: '行为测试故事', characterId: 'fixture', ...extra })
const payloadFor = (session, contextOnly = true) => main.buildPayload(session, '', '', false, main.storyPromptOf(session), 'fixture', contextOnly, session.messages)
const exact = '  # 你的设定\r\n\r\n名字：旅行者 🌱\r\n能力：<观察> & 记住\r\n尾部空格  \r\n'
let made
await test('C-02 create writes exact UTF-8 bytes at existing profile.md path', () => {
  made = make({ profile: exact, background: '独立背景', openingText: '角色开场' })
  assert.deepEqual(fs.readFileSync(api.storyProfilePath(made.meta.storyId)), Buffer.from(exact))
  const metaFile = JSON.parse(fs.readFileSync(path.join(api.storyDir(made.meta.storyId), 'story.json'), 'utf8'))
  assert.equal(Object.hasOwn(metaFile.meta, 'profile'), false)
  assert.equal(fs.existsSync(api.storyProfilePath(made.meta.storyId) + '.tmp'), false)
})
await test('C-02 fresh store and existing profile reader reload exact text', () => {
  const reloaded = new api.StoryStore()
  assert.equal(reloaded.get(made.meta.storyId).title, '行为测试故事')
  assert.equal(api.readStoryProfile(made.meta.storyId), exact)
})
await test('C-03 next bridge payload contains separate profile system message exactly once', async () => {
  const session = api.getStorySession(made.meta.storyId)
  const payload = await payloadFor(session)
  assert.equal(main.storyPromptOf(session).profile, exact.trim())
  assert.equal(payload.filter(m => m.role === 'system' && m.content === exact.trim()).length, 1)
  assert.equal(payload.filter(m => m.role === 'system' && m.content.includes('独立背景')).length, 1)
  assert.deepEqual(session.messages.map(m => [m.role, m.content]), [['assistant', '角色开场']])
  assert.equal(payload.some(m => m.role !== 'system' && m.content.includes('旅行者')), false)
})
await test('C-03 non-bridge assembly also includes profile once without merging it into opening/history', async () => {
  const payload = await payloadFor(api.getStorySession(made.meta.storyId), false)
  assert.equal(payload.filter(m => m.role === 'system' && m.content.includes(exact.trim())).length, 1)
  assert.ok(payload.find(m => m.role === 'system').content.includes('CHARACTER_SENTINEL'))
})
await test('C-05 existing profile editor save is reused by next payload', async () => {
  assert.equal(api.saveStoryProfile(made.meta.storyId, '  编辑后的画像  '), true)
  const payload = await payloadFor(api.getStorySession(made.meta.storyId))
  assert.equal(payload.filter(m => m.role === 'system' && m.content === '编辑后的画像').length, 1)
  assert.equal(payload.some(m => m.content.includes('旅行者')), false)
})
await test('C-04 omitted, empty and whitespace-only profile create no file or empty payload segment', async () => {
  for (const extra of [{}, { profile: '' }, { profile: ' \r\n\t ' }]) {
    const created = make(extra)
    assert.equal(fs.existsSync(api.storyProfilePath(created.meta.storyId)), false)
    assert.equal(api.readStoryProfile(created.meta.storyId), '')
    const payload = await payloadFor(api.getStorySession(created.meta.storyId))
    assert.equal(payload.some(m => !m.content.trim()), false)
    assert.deepEqual(payload, [])
  }
})
await test('C-02 profile write failure throws before creating session and rolls back story directory', () => {
  const beforeStories = new Set(api.storyStoreOf().list().map(s => s.storyId))
  const beforeSessions = main.listSessions().length
  const rename = fs.renameSync
  fs.renameSync = (from, to) => { if (String(to).endsWith('profile.md')) throw new Error('fixture disk failure'); return rename(from, to) }
  try { assert.throws(() => make({ profile: exact }), /保存故事画像失败/) } finally { fs.renameSync = rename }
  assert.deepEqual(new Set(api.storyStoreOf().list().map(s => s.storyId)), beforeStories)
  assert.equal(main.listSessions().length, beforeSessions)
})
await test('B-04 story tool supply remains empty; chat opt-in and agent supply remain unchanged', () => {
  const allTools = [{ name: 'fixture.tool' }]
  const base = { allTools, isChannel: false, chatTools: { enabled: true, tools: { 'fixture.tool': true } } }
  assert.deepEqual(api.resolveToolSupply({ ...base, mode: 'story' }), [])
  assert.deepEqual(api.resolveToolSupply({ ...base, mode: 'chat' }), allTools)
  assert.deepEqual(api.resolveToolSupply({ ...base, mode: 'agent' }), allTools)
})
await test('B-05 ordinary chat/agent do not pick up a story profile', async () => {
  for (const mode of ['chat', 'agent']) {
    const session = main.createSession({ mode, characterId: 'fixture' })
    assert.equal(main.storyPromptOf(session), null)
    const payload = await payloadFor(session, false)
    assert.ok(payload.find(m => m.role === 'system').content.includes('MODE_' + mode))
    assert.equal(payload.some(m => m.content.includes('编辑后的画像')), false)
  }
})

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/chat' })
globalThis.window = dom.window; globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
let uiSettings = api.settingsStore.get(), createCalls = [], updateCalls = [], sent = [], opened = [], submitted = []
let createError = null, listError = null, pendingCreate = null
const workspace = { id: 'fixture-workspace', name: '测试工作区', path: dir }
window.nahida = {
  initialTheme: 'light',
  settings: { get: async () => uiSettings, save: async patch => (uiSettings = { ...uiSettings, ...patch }) },
  modelProfiles: { list: async () => ({ profiles: [], defaultProfileId: null }) },
  prompts: { library: async () => ({ characters: [{ id: 'fixture', name: '测试角色', complete: true }] }) },
  workspaces: { list: async () => ({ workspaces: [workspace], activeWorkspaceId: workspace.id }) },
  regex: { listScripts: async () => [] },
  story: {
    list: async () => { if (listError) throw new Error(listError); return api.listStories() },
    session: async id => { opened.push(id); return api.getStorySession(id) },
    branches: async id => api.listStoryBranches(id),
    create: async draft => { submitted.push(draft); if (pendingCreate) await pendingCreate; if (createError) throw new Error(createError); return api.createStory(draft) },
    pickWorldbookDir: async () => ''
  },
  chat: {
    listSessions: async () => [],
    createSession: async draft => { createCalls.push(draft); return main.createSession(draft) },
    updateSession: async (id, patch) => { updateCalls.push({ id, patch }); return main.updateSession(id, patch) },
    send: async ({ sessionId, content }) => { sent.push({ sessionId, content }); const userMessage = { id: 'sent-' + sent.length, role: 'user', content, status: 'done', createdAt: Date.now() }; const assistantMessage = { id: 'reply-' + sent.length, role: 'assistant', content: 'fixture reply', status: 'done', createdAt: Date.now() }; main.appendMessages(sessionId, [userMessage, assistantMessage]); return { userMessage, assistantMessage } },
    onDelta: () => () => {}, onReasoning: () => () => {}, onTool: () => () => {},
    onApproval: () => () => {}, onDone: () => () => {}, onError: () => () => {}
  }
}
const ui = await bundleModule('p49-story-entry-dom', [
  'export { createElement, act } from ' + JSON.stringify(p('node_modules/react/index.js')),
  'export { createRoot } from ' + JSON.stringify(p('node_modules/react-dom/client.js')),
  'export { MemoryRouter } from ' + JSON.stringify(p('node_modules/react-router-dom/dist/index.js')),
  'export { ChatPage } from ' + JSON.stringify(p('src/renderer/src/features/chat/ChatPage.tsx')),
  'export { Sidebar } from ' + JSON.stringify(p('src/renderer/src/components/Sidebar.tsx')),
  'export { useChatStore } from ' + JSON.stringify(p('src/renderer/src/features/chat/store.ts')),
  'export { useStoryStore } from ' + JSON.stringify(p('src/renderer/src/features/story/store.ts'))
].join('\n'), [{ name: 'fixture-assets', setup(build) { build.onLoad({ filter: /[.](png|svg)$/ }, () => ({ contents: 'export default "asset"', loader: 'js' })) } }])
const { act, createElement: h, createRoot } = ui
const root = createRoot(document.getElementById('root'))
const q = selector => document.querySelector(selector)
const click = async node => { assert.ok(node, 'expected production button'); await act(async () => node.click()) }
const input = async (node, value) => {
  assert.ok(node, 'expected production input')
  await act(async () => {
    const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const modeButton = mode => [...document.querySelectorAll('.mode-switch__item')].find(b => b.querySelector('strong').textContent === mode)
const target = name => q('[data-ui-target="' + name + '"]')
const reset = async (extra = {}) => act(async () => { ui.useChatStore.setState({ sessions: [], activeId: null, streamingId: null, draftMode: 'chat', error: null, approval: null, ...extra }); ui.useStoryStore.getState().closeStory() })
await act(async () => root.render(h(ui.MemoryRouter, { initialEntries: ['/chat'] }, h('div', null, h(ui.Sidebar), h(ui.ChatPage)))))
await test('B-01 sidebar has no create-story button but keeps list and opens selected story', async () => {
  const sidebar = q('.sidebar')
  assert.equal(sidebar.querySelector('[data-ui-target="新建故事"]'), null)
  const card = sidebar.querySelector('.story-card')
  assert.ok(card)
  await click(card)
  assert.ok(ui.useChatStore.getState().sessions.find(s => s.id === ui.useChatStore.getState().activeId).storyId)
  assert.equal(q('[aria-label="故事列表与创建"]'), null, 'active empty story is not a new-story landing page')
})
await reset()
await test('B-02 production slider has Chat / Agent / 故事 and story selects only the draft', async () => {
  assert.deepEqual([...document.querySelectorAll('.mode-switch__item strong')].map(n => n.textContent), ['Chat', 'Agent', '故事'])
  const before = main.listSessions().length, opens = opened.length
  await click(modeButton('故事'))
  assert.equal(modeButton('故事').getAttribute('aria-checked'), 'true')
  assert.equal(ui.useChatStore.getState().draftMode, 'story')
  assert.equal(main.listSessions().length, before)
  assert.equal(opened.length, opens, 'selecting story does not open last story')
  assert.ok(target('新建故事'))
  assert.equal(q('.composer'), null, 'cannot create bare story session through send/presend')
})
await test('B-02 empty list explains creation and cancel creates no state', async () => {
  const stored = ui.useStoryStore.getState().stories
  await act(async () => ui.useStoryStore.setState({ stories: [] }))
  assert.ok(q('[aria-label="故事列表与创建"]').textContent.includes('还没有故事区'))
  const before = submitted.length
  await click(target('新建故事')); await input(target('故事画像输入'), '取消的草稿')
  await click(q('.story-dialog__close'))
  assert.equal(submitted.length, before)
  assert.equal(ui.useChatStore.getState().activeId, null)
  await act(async () => ui.useStoryStore.setState({ stories: stored }))
})
await test('B-02 story list is shown and opens exactly the chosen recent story', async () => {
  const list = target('最近故事列表')
  assert.ok(list); assert.equal(list.querySelectorAll('.story-card').length, api.listStories().length)
  await click(list.querySelector('.story-card'))
  assert.ok(ui.useChatStore.getState().activeId)
  assert.ok(q('.composer'))
})
await reset()
await test('B-02 switching existing empty chat to story never overwrites session mode', async () => {
  const empty = main.createSession({ mode: 'chat', characterId: 'fixture' })
  await act(async () => ui.useChatStore.setState({ sessions: [empty], activeId: empty.id }))
  const writes = updateCalls.length
  await click(modeButton('故事'))
  assert.equal(updateCalls.length, writes)
  assert.equal(main.listSessions().find(s => s.id === empty.id).mode, 'chat')
  assert.equal(ui.useChatStore.getState().activeId, null)
})
await test('B-03 C-01 main page opens migrated dialog with optional multiline profile and purpose', async () => {
  await click(target('新建故事'))
  assert.ok(q('[role="dialog"]'))
  const field = target('故事画像输入')
  assert.equal(field.tagName, 'TEXTAREA'); assert.equal(field.value, '')
  assert.ok(field.closest('label').textContent.includes('你的设定（画像）'))
  assert.ok(field.placeholder.includes('注入每一轮'))
})
const uiProfile = '  UI画像\n名字：星 🌱\n关系：同伴  \n'
await test('B-03 C-02 real input/create chain preserves profile and enters created story', async () => {
  await input(q('.story-dialog input'), '入口创建故事')
  await input(target('故事画像输入'), uiProfile)
  await click(target('创建故事区'))
  assert.equal(q('[role="dialog"]'), null)
  assert.equal(submitted.at(-1).profile, uiProfile)
  const active = ui.useChatStore.getState().sessions.find(s => s.id === ui.useChatStore.getState().activeId)
  assert.equal(active.mode, 'story'); assert.ok(active.storyId)
  assert.equal(api.getStory(active.storyId).title, '入口创建故事')
  assert.equal(fs.readFileSync(api.storyProfilePath(active.storyId), 'utf8'), uiProfile)
  assert.equal(createCalls.some(call => call.mode === 'story'), false)
  const payload = await payloadFor(api.getStorySession(active.storyId))
  assert.ok(payload.some(m => m.role === 'system' && m.content === uiProfile.trim()))
})
await test('B-03 empty profile can be submitted through the same dialog', async () => {
  await reset(); await click(modeButton('故事')); await click(target('新建故事'))
  await input(q('.story-dialog input'), '没有画像的故事')
  await click(target('创建故事区'))
  const session = ui.useChatStore.getState().sessions.find(s => s.id === ui.useChatStore.getState().activeId)
  assert.equal(fs.existsSync(api.storyProfilePath(session.storyId)), false)
})
await test('B-03 creation failure stays visible and preserves typed profile for retry', async () => {
  await reset(); await click(modeButton('故事')); await click(target('新建故事'))
  await input(q('.story-dialog input'), '失败重试')
  await input(target('故事画像输入'), uiProfile)
  createError = 'fixture create rejected'
  await click(target('创建故事区'))
  assert.ok(q('.story-dialog__error').textContent.includes(createError))
  assert.equal(target('故事画像输入').value, uiProfile)
  assert.equal(target('创建故事区').disabled, false)
  createError = null
  await click(q('.story-dialog__close'))
})
await test('B-03 submitting disables repeated create until backend resolves', async () => {
  await click(target('新建故事')); await input(q('.story-dialog input'), '单次创建')
  let resolveCreate
  pendingCreate = new Promise(resolve => { resolveCreate = resolve })
  const before = submitted.length
  await click(target('创建故事区'))
  assert.equal(target('创建故事区').disabled, true)
  await click(target('创建故事区'))
  assert.equal(submitted.length, before + 1)
  await act(async () => { resolveCreate(); pendingCreate = null })
  assert.equal(q('[role="dialog"]'), null)
})
await test('B-02 list load failure is visible without opening a story', async () => {
  await reset(); listError = 'fixture list failed'
  const before = opened.length
  await click(modeButton('故事'))
  assert.ok(q('[aria-label="故事列表与创建"] [role="alert"]').textContent.includes(listError))
  assert.equal(opened.length, before)
  listError = null
})
await test('B-02 existing streaming conversation keeps mode buttons disabled', async () => {
  const empty = main.createSession({ mode: 'chat', characterId: 'fixture' })
  await reset({ sessions: [empty], activeId: empty.id, streamingId: empty.id })
  assert.equal(modeButton('故事').disabled, true)
  await click(modeButton('故事'))
  assert.equal(ui.useChatStore.getState().activeId, empty.id)
  assert.equal(ui.useChatStore.getState().draftMode, 'chat')
})
await test('B-05 Chat and Agent switching plus first send preserve existing create/send path', async () => {
  for (const [mode, label] of [['chat', 'Chat'], ['agent', 'Agent']]) {
    await reset(); await click(modeButton(label))
    assert.equal(q('[aria-label="故事列表与创建"]'), null)
    assert.ok(q('.composer'))
    const before = createCalls.length
    await input(q('.composer__input'), mode + ' 首句')
    await click(q('.composer__action'))
    assert.equal(createCalls.length, before + 1)
    assert.equal(createCalls.at(-1).mode, mode)
    assert.equal(sent.at(-1).content, mode + ' 首句')
    assert.equal(main.listSessions().find(s => s.id === sent.at(-1).sessionId).mode, mode)
    assert.equal(main.listSessions().find(s => s.id === sent.at(-1).sessionId).storyId, undefined)
  }
})
await act(async () => root.unmount())
api.closeAllStoryMemory()
dom.window.close()
// Match the existing jsdom suites: React scheduler MessagePorts outlive unmount.
for (const handle of process._getActiveHandles()) if (handle.constructor.name === 'MessagePort') handle.unref()
done()
