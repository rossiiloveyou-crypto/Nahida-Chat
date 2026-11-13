/**
 * P7：故事视口 / 检索 / meta / 画像 / 侧栏过滤 —— A-01…A-20（20 条）。
 *
 * 测真实边界：真落 story.json / profile.md / branches.json，真走 chatService，
 * searchStory 在真实消息上做大小写无关子串匹配。
 *
 * 跑法：node scripts/test/story-ui.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-ui-'))
installElectronStub(userData)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ defaultCharacterId: 'nahida', memory: { enabled: false, autoExtract: false } }),
  'utf8'
)

/* ── 桩掉 rag 依赖：chatService 会把 embedder / extract / retriever 拉进来 ── */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-ui-stubs-'))
const embedderStub = path.join(stubDir, 'embedder-stub.ts')
fs.writeFileSync(
  embedderStub,
  [
    'export const embedder = {',
    '  async embedOne() { return null },',
    '  async embed() { return null },',
    '  status() { return { ready: false, dimensions: 0, modelPath: "", lastError: null } },',
    '  modelInstalled() { return false }',
    '}'
  ].join('\n'),
  'utf8'
)
const extractStub = path.join(stubDir, 'extract-stub.ts')
fs.writeFileSync(extractStub, 'export async function extractMemories() { return [] }\n', 'utf8')
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  'export const memoryService = { async buildContextBlock() { return "" }, async extractInBackground() {}, activePersona() { return null }, upsertPersona() {}, appendHistory() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n',
  'utf8'
)
const plugin = {
  name: 'stub-rag-deps',
  setup(build) {
    const inRag = (importer) => importer.includes('features/rag') || importer.includes('features\\rag')
    build.onResolve({ filter: /^\.\/embedder$/ }, (args) => (inRag(args.importer) ? { path: embedderStub } : null))
    build.onResolve({ filter: /^\.\/extract$/ }, (args) => (inRag(args.importer) ? { path: extractStub } : null))
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) =>
      args.importer.endsWith('chatService.ts') ? { path: ragStub } : null
    )
  }
}

const mod = await bundleModule(
  'story-ui',
  [
    `export { createStory, deriveBranch, deleteBranch, listStoryBranches, listStories, switchBranch, getStory, getStorySession, searchStory, updateStoryMeta, readStoryProfile, saveStoryProfile } from '${p('src/main/features/story/service.ts')}'`,
    `export { StoryStore } from '${p('src/main/features/story/store.ts')}'`,
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { storyProfilePath, storiesRoot } from '${p('src/main/features/story/paths.ts')}'`,
    `export { visibleDesktopSessions } from '${p('src/renderer/src/features/story/sessionFilter.ts')}'`
  ].join('\n'),
  [plugin]
)
const {
  createStory,
  deriveBranch,
  listStoryBranches,
  listStories,
  switchBranch,
  getStory,
  getStorySession,
  searchStory,
  updateStoryMeta,
  readStoryProfile,
  saveStoryProfile,
  StoryStore,
  chatService,
  storyProfilePath,
  visibleDesktopSessions
} = mod

const store = new StoryStore()

/* ── 夹具：一个故事区，根分支 10 条（第 2 条含「钟楼」），再从第 4 条派生一条子分支 ── */
const story = createStory({
  title: 'P7 检索夹具',
  synopsis: '夹具概要',
  characterId: 'nahida',
  worldbookMode: 'override',
  worldbookDir: 'worldbooks/clock'
})
const storyId = story.meta.storyId
const root = chatService.listSessionsByStory(storyId)[0]

const rootMessages = []
for (let i = 0; i < 10; i += 1) {
  rootMessages.push({
    id: 'r' + i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: i === 2 ? '钟楼的指针停在了三点' : '第' + i + '句普通台词',
    createdAt: 1000 + i,
    status: 'done'
  })
}
chatService.appendMessages(root.id, rootMessages)

const derived = deriveBranch({ storyId, fromSessionId: root.id, fromMessageId: 'r4', title: '子分支' })
const childMessages = [
  { id: 'c0', role: 'user', content: '子分支里也提到了钟楼', createdAt: 2000, status: 'done' },
  { id: 'c1', role: 'assistant', content: '子分支独有的一句暗号：夜莺', createdAt: 2001, status: 'done' }
]
chatService.appendMessages(derived.sessionId, childMessages)

/* ═══════════════════ A-01…A-05：story:session ═══════════════════ */

// A-01：无 branchId → 活跃分支（派生即激活），且带 messages
const activeSession = getStorySession(storyId)
check(
  'A-01 无 branchId → 返回活跃分支会话，messages.length > 0',
  Boolean(activeSession) && activeSession.id === derived.sessionId && activeSession.messages.length > 0,
  JSON.stringify({ id: activeSession && activeSession.id, n: activeSession && activeSession.messages.length })
)

// A-02：显式 branchId → 该分支会话
const rootSession = getStorySession(storyId, root.id)
check(
  'A-02 story:session(branchId=根) → 返回该分支会话（id 相等、消息=根分支消息）',
  Boolean(rootSession) && rootSession.id === root.id && rootSession.messages.length === 10,
  JSON.stringify({ id: rootSession && rootSession.id, n: rootSession && rootSession.messages.length })
)

// A-03：只有子分支出现的词 → 命中含 branchId=子分支
const nightingale = searchStory(storyId, '夜莺')
check(
  'A-03 只在子分支出现的词 → 命中 branchId=子分支',
  nightingale.length > 0 && nightingale.every((hit) => hit.branchId === derived.sessionId),
  JSON.stringify(nightingale.map((hit) => hit.branchId))
)

// A-04：不存在词 0 条 + 对照（存在词 >0）
const missing = searchStory(storyId, '完全不存在的词xyz')
const existing = searchStory(storyId, '钟楼')
check('A-04 不存在词 → 0 条（对照：存在词 >0）', missing.length === 0 && existing.length > 0, JSON.stringify({ missing: missing.length, existing: existing.length }))

// A-05：空串 / 纯空格 → []
check('A-05 空串与纯空格 → []（不抛）', searchStory(storyId, '').length === 0 && searchStory(storyId, '   ').length === 0)

/* ═══════════════════ A-06…A-09：updateMeta / 画像 ═══════════════════ */

// A-06：改 title+synopsis+worldbookMode → 逐字段读回
const patched = updateStoryMeta(storyId, { title: '改过的标题', synopsis: '改过的概要', worldbookMode: 'default' })
const reread = getStory(storyId)
check(
  'A-06 updateMeta 改 title+synopsis+worldbookMode → getStory 逐字段一致',
  Boolean(patched) &&
    reread.title === '改过的标题' &&
    reread.synopsis === '改过的概要' &&
    reread.worldbookMode === undefined,
  JSON.stringify({ title: reread.title, synopsis: reread.synopsis, mode: reread.worldbookMode })
)

// A-07：非法 storyId → null，不抛
let invalidThrew = false
let invalidResult = 'n/a'
try {
  invalidResult = updateStoryMeta('../../evil', { title: 'x' })
} catch {
  invalidThrew = true
}
check('A-07 非法 storyId → null 且不抛', !invalidThrew && invalidResult === null, String(invalidResult))

// A-08：画像写读逐字一致，路径 = storyProfilePath
const profileText = '# 画像\n\n她今天开始叫我名字了。\n'
const savedOk = saveStoryProfile(storyId, profileText)
const profileFile = storyProfilePath(storyId)
check(
  'A-08 profileSave 写盘、profileGet 读回逐字一致，路径 = storyProfilePath()',
  savedOk && fs.existsSync(profileFile) && readStoryProfile(storyId) === profileText,
  profileFile
)

// A-09：空串保存 → 文件被删，读回空串
const cleared = saveStoryProfile(storyId, '  ')
check(
  'A-09 profileSave("") → 文件被删、profileGet 返回 ""',
  cleared && !fs.existsSync(profileFile) && readStoryProfile(storyId) === '',
  'exists=' + fs.existsSync(profileFile)
)

/* ═══════════════════ A-10 / A-11 / A-20：命中字段 ═══════════════════ */

const towerHits = searchStory(storyId, '钟楼')
const hitCheck = towerHits.every((hit) => {
  const session = chatService.listSessionsByStory(storyId).find((item) => item.id === hit.branchId)
  return session && session.messages[hit.messageIndex] && session.messages[hit.messageIndex].id === hit.messageId
})
check('A-10 snippet 含查询词，且 messageIndex 指向 messages[idx].id === messageId', towerHits.length > 0 && towerHits.every((hit) => hit.snippet.includes('钟楼')) && hitCheck, String(towerHits.length))

const activeHit = towerHits.find((hit) => hit.branchId === derived.sessionId)
const inactiveHit = towerHits.find((hit) => hit.branchId === root.id)
check(
  'A-11 非活跃分支命中 isActiveBranch=false；活跃分支命中 true',
  Boolean(activeHit) && activeHit.isActiveBranch === true && Boolean(inactiveHit) && inactiveHit.isActiveBranch === false,
  JSON.stringify(towerHits.map((hit) => [hit.branchId === derived.sessionId, hit.isActiveBranch]))
)

// A-20：超长消息命中时 snippet 不超过 160
saveStoryProfile(storyId, 'placeholder')
const longSession = chatService.createSession({ mode: 'story', storyId, title: '超长' })
chatService.appendMessages(longSession.id, [
  { id: 'L0', role: 'user', content: 'x'.repeat(2500), createdAt: 3000, status: 'done' }
])
const longHit = searchStory(storyId, 'xxxx')
check('A-20 超长消息命中时 snippet.length <= 160', longHit.length > 0 && longHit.every((hit) => hit.snippet.length <= 160), JSON.stringify(longHit.map((hit) => hit.snippet.length)))

/* ═══════════════════ A-12 / A-13：侧栏过滤 ═══════════════════ */

const plain = { id: 'p1', title: '普通', mode: 'chat', messages: [], workspaceId: 'ws1' }
const plainNoWs = { id: 'p2', title: '无工作区', mode: 'chat', messages: [] }
const storySession = { id: 's1', title: '故事', mode: 'story', messages: [], storyId }
const filterList = [plain, plainNoWs, storySession]

const visibleAll = visibleDesktopSessions(filterList, null)
check(
  'A-12 visibleDesktopSessions(list, null)：story 不进、普通会话保留',
  visibleAll.length === 2 && !visibleAll.some((item) => item.storyId) && visibleAll.some((item) => item.id === 'p1'),
  visibleAll.map((item) => item.id).join(',')
)

const visibleWs = visibleDesktopSessions(filterList, 'ws1')
check(
  'A-13 visibleDesktopSessions(list, ws1)：按 workspaceId 过滤且 story 恒排除',
  visibleWs.length === 1 && visibleWs[0].id === 'p1',
  visibleWs.map((item) => item.id).join(',')
)

/* ═══════════════════ A-14 / A-16 / A-17 / A-18 / A-19：卡片与分支数据面 ═══════════════════ */

const summaries = listStories()
const mine = summaries.find((item) => item.storyId === storyId)
check(
  'A-14 listStories 每项含 title/synopsis/characterId/lastActiveAt/branchCount/memoryCount',
  Boolean(mine) &&
    typeof mine.title === 'string' &&
    typeof mine.synopsis === 'string' &&
    typeof mine.characterId === 'string' &&
    typeof mine.lastActiveAt === 'number' &&
    typeof mine.branchCount === 'number' &&
    typeof mine.memoryCount === 'number',
  JSON.stringify(mine && { branchCount: mine.branchCount, memoryCount: mine.memoryCount })
)

const overrideStory = createStory({
  title: '覆盖档位',
  characterId: 'nahida',
  worldbookMode: 'override',
  worldbookDir: 'worldbooks/override'
})
check(
  'A-16 createStory(worldbookMode=override) → getStory().worldbookMode === "override"',
  getStory(overrideStory.meta.storyId).worldbookMode === 'override',
  String(getStory(overrideStory.meta.storyId).worldbookMode)
)

switchBranch(storyId, root.id)
const afterSwitch = getStorySession(storyId)
check(
  'A-17 switchBranch 后 story:session 返回的分支 id = 切换目标',
  Boolean(afterSwitch) && afterSwitch.id === root.id,
  afterSwitch && afterSwitch.id
)

// A-18：派生守恒 —— 新分支消息数 = idx+1，且原分支 id 序列不变
const beforeRootIds = chatService
  .listSessionsByStory(storyId)
  .find((item) => item.id === root.id)
  .messages.map((message) => message.id)
  .join(',')
const derived2 = deriveBranch({ storyId, fromSessionId: root.id, fromMessageId: 'r3', title: '守恒' })
const derived2Session = getStorySession(storyId, derived2.sessionId)
const afterRootIds = chatService
  .listSessionsByStory(storyId)
  .find((item) => item.id === root.id)
  .messages.map((message) => message.id)
  .join(',')
check(
  'A-18 deriveBranch 后新会话消息数 = idx+1 = 4，且原分支 id 序列不变',
  Boolean(derived2Session) && derived2Session.messages.length === 4 && beforeRootIds === afterRootIds,
  JSON.stringify({ n: derived2Session && derived2Session.messages.length, same: beforeRootIds === afterRootIds })
)

// A-19：删**当前**分支 → 列表少一行、会话少一条、活跃指针自动换人
// 🔴 P6 修订后不再需要「先把活跃分支切走」：分支之间没有父子依赖，删当前分支也被允许，
//    主进程会把活跃指针交给剩下的里面最近活动的那条。
const beforeList = listStoryBranches(storyId)
const beforeSessions = chatService.listSessionsByStory(storyId).length
const { deleteBranch } = mod
deleteBranch(storyId, derived2.sessionId)
const afterList = listStoryBranches(storyId)
const afterSessions = chatService.listSessionsByStory(storyId).length
const activeAfter = afterList.filter((item) => item.isActive)
check(
  'A-19 deleteBranch（删的是当前分支）→ 行数 -1、会话 -1、活跃指针恰好一个且不是被删的',
  afterList.length === beforeList.length - 1 &&
    afterSessions === beforeSessions - 1 &&
    activeAfter.length === 1 &&
    activeAfter[0].branchId !== derived2.sessionId,
  JSON.stringify({ before: beforeList.length, after: afterList.length, active: activeAfter.map((i) => i.branchId) })
)

/* ═══════════════════ A-15：契约存在性（静态文本断言，防 J-01） ═══════════════════ */

const readText = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
const ipcText = readText('src/shared/ipc.ts')
const preloadText = readText('src/preload/index.ts')
const apiText = readText('src/shared/api.ts')
const ipcKeys = ['storySession', 'storySearch', 'storyUpdateMeta', 'storyProfileGet', 'storyProfileSave', 'storyPickWorldbookDir']
const bridgeKeys = ['session:', 'search:', 'updateMeta:', 'profileGet:', 'profileSave:', 'pickWorldbookDir']
check(
  'A-15 IPC 6 个新频道 + preload/api 6 个键都在',
  ipcKeys.every((key) => ipcText.includes(key)) &&
    bridgeKeys.every((key) => preloadText.includes(key)) &&
    bridgeKeys.every((key) => apiText.includes(key)),
  ipcKeys.filter((key) => !ipcText.includes(key)).join(',') || 'all-present'
)

done()
