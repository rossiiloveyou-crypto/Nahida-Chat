/**
 * P8：用户画像语义 · 背景与剧本设定 · 故事长期记忆展示 —— A-01…A-12。
 *
 * 测真实边界：
 *  - 真起临时 Prompt/ 根与临时 userData（不碰用户真实资产）
 *  - 真调 store 落盘 / 真调 compose / 真调 storyMemory（该区自己的库）
 *  - A-09/A-10 专测「故事记忆 ⊂ 该区库，不进全局库」（M11 隔离）
 *
 * 跑法：node scripts/test/story-profile-memory.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { bundleModule, createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const require = createRequire(import.meta.url)

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p8-user-'))
const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p8-app-'))

/** 自建 electron 桩：getAppPath 指到临时 Prompt/ 根，getPath(userData) 指到临时数据目录 */
function installStub(root, target) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p8-stub-'))
  const stub = path.join(sandbox, 'electron-stub.cjs')
  fs.writeFileSync(
    stub,
    [
      'const path = require("node:path")',
      'const userData = ' + JSON.stringify(root),
      'const appPath = ' + JSON.stringify(target),
      'module.exports = {',
      '  app: {',
      '    getPath: (key) => (key === "userData" ? userData : path.join(userData, String(key))),',
      '    getAppPath: () => appPath,',
      '    getName: () => "Nahida Chat",',
      '    getVersion: () => "0.1.0",',
      '    isPackaged: false,',
      '    on: () => {},',
      '    whenReady: async () => {}',
      '  },',
      '  shell: { openPath: async () => "", openExternal: async () => "" },',
      '  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },',
      '  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },',
      '  ipcMain: { handle: () => {}, on: () => {} },',
      '  nativeTheme: { shouldUseDarkColors: false, themeSource: "system", on: () => {} }',
      '}'
    ].join('\n'),
    'utf8'
  )
  const Module = require('node:module')
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return stub
    return original.call(this, request, ...rest)
  }
}
installStub(userData, appPath)

// 记忆关闭：本套件不测抽取，开着会去加载 embedding 模型
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ defaultCharacterId: 'testchar', memory: { enabled: false, autoExtract: false } }),
  'utf8'
)

/* ── 临时 Prompt/ 根（角色资产只读，本套件自己造一份）───────────── */
const PROMPT = path.join(appPath, 'Prompt')
const write = (rel, body) => {
  const file = path.join(PROMPT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
}
write('shared/base.md', '# 全局底线\n\nBASE_MARKER_全局')
write('shared/tone.md', 'TONE_MARKER_语气')
write('shared/tool_usage.md', 'TOOL_MARKER_工具规范')
write('characters/testchar/soul.md', '# 测试角色 · Soul\n\nSOUL_MARKER_人格')
write('characters/testchar/worldbook/wb1.md', 'ROLE_WB_MARKER_角色设定')
write('characters/testchar/modes/chat.md', 'MODE_CHAT_MARKER_模式规则')
write('characters/testchar/styles/chat.md', 'STYLE_CHAT_MARKER_表达风格')
// 刻意不建 modes/story.md（缺则跳过）

/* ── 桩掉 embedder / extract / chatService 的 ../rag（只测落盘与装配，不测模型）── */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p8-stubs-'))
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
  'export const memoryService = { async buildContextBlock() { return "" }, async extractInBackground() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n',
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
  'story-profile-memory',
  [
    "export { createStory, updateStoryMeta, getStory, listStoryMemories, deleteStoryMemory, clearStoryMemories } from '" + p('src/main/features/story/service.ts') + "'",
    "export { storyMemory } from '" + p('src/main/features/story/memory.ts') + "'",
    "export { promptStore } from '" + p('src/main/features/prompt/promptStore.ts') + "'",
    "export { memoryService } from '" + p('src/main/features/rag/index.ts') + "'",
    "export { StoryStore } from '" + p('src/main/features/story/store.ts') + "'"
  ].join('\n'),
  [plugin]
)
const {
  createStory,
  updateStoryMeta,
  getStory,
  listStoryMemories,
  deleteStoryMemory,
  clearStoryMemories,
  storyMemory,
  promptStore,
  memoryService,
  StoryStore
} = mod

const SEP = '\n\n---\n\n'
const sectionsOf = (text) => (text ? text.split(SEP) : [])
const BG_TITLE = '【本故事背景与剧本设定】'

const store = new StoryStore()

/* ── 1 · A-01 background 落盘（createStory → getStory 读回）────────── */
console.log('1 · A-01 createStory 落盘 background 并读回')
const created = createStory({ title: '雾港故事', characterId: 'testchar', background: '雾港的清晨' })
const readBack = getStory(created.meta.storyId)
check('A-01 createStory 后 getStory.background === 「雾港的清晨」',
  readBack && readBack.background === '雾港的清晨', readBack && readBack.background)
check('A-01 story.json 磁盘上确有 background 键',
  (() => {
    const raw = JSON.parse(fs.readFileSync(path.join(userData, 'stories', created.meta.storyId, 'story.json'), 'utf8'))
    return raw.meta.background === '雾港的清晨'
  })(),
  (() => {
    const raw = JSON.parse(fs.readFileSync(path.join(userData, 'stories', created.meta.storyId, 'story.json'), 'utf8'))
    return JSON.stringify(raw.meta)
  })())

/* ── 2 · A-02 / A-03 updateMeta 的 background 与「只动它」──────────── */
console.log('2 · A-02 / A-03 updateStoryMeta')
const upd = updateStoryMeta(created.meta.storyId, { background: '新场景' })
check('A-02 updateStoryMeta{background:"新场景"} 读回「新场景」', upd && upd.background === '新场景', upd && upd.background)
const cleared = updateStoryMeta(created.meta.storyId, { background: '' })
check('A-02 updateStoryMeta{background:""} → 读回无（空/无键）',
  cleared && !cleared.background, JSON.stringify(cleared && cleared.background))

const before = getStory(created.meta.storyId)
const patchOnly = updateStoryMeta(created.meta.storyId, { background: '只改背景' })
check('A-03 只改 background，title 逐字不变', patchOnly.title === before.title, patchOnly.title + ' vs ' + before.title)
check('A-03 只改 background，synopsis 逐字不变', patchOnly.synopsis === before.synopsis, JSON.stringify(patchOnly.synopsis))
check('A-03 只改 background，worldbookMode 口径不变（都不落 default）',
  patchOnly.worldbookMode === before.worldbookMode, String(patchOnly.worldbookMode))

/* ── 3 · A-04 / A-05 / A-11 compose 注入 background（设定层）──────── */
console.log('3 · A-04 / A-05 / A-11 promptStore.compose 注入 background')
const withBg = promptStore.compose('testchar', 'story', { story: { background: '雾港的清晨' } })
const withoutBg = promptStore.compose('testchar', 'story')
check('A-04 含 background 的产物包含「雾港的清晨」', withBg.includes('雾港的清晨'), sectionsOf(withBg).length)
check('A-04 对照物：不传 background 的产物不含「雾港的清晨」', !withoutBg.includes('雾港的清晨'), sectionsOf(withoutBg).length)
check('A-04 background 自成一节且带标题', sectionsOf(withBg).includes(BG_TITLE + '\n雾港的清晨'),
  JSON.stringify(sectionsOf(withBg).map((s) => s.slice(0, 12))))

const chatNoBg = promptStore.compose('testchar', 'chat', { story: { background: '' } })
check('A-05 非 story 模式产物不含任何 background 段', !chatNoBg.includes(BG_TITLE) && !chatNoBg.includes('雾港的清晨'), sectionsOf(chatNoBg).length)

const both = promptStore.compose('testchar', 'story', { story: { background: 'BG_MARKER_背景', profile: 'PROFILE_MARKER_画像' } })
const idxBg = both.indexOf('BG_MARKER_背景')
const idxProfile = both.indexOf('PROFILE_MARKER_画像')
check('A-11 同时含 background 与 profile 两段', idxBg >= 0 && idxProfile >= 0, idxBg + ' / ' + idxProfile)
check('A-11 background 在 profile 之前（设定层 vs 末尾）', idxBg >= 0 && idxProfile >= 0 && idxBg < idxProfile, idxBg + ' < ' + idxProfile)

/* ── 4 · A-06…A-08 故事记忆增 / 删单条 / 清空 ─────────────────────── */
console.log('4 · A-06…A-08 故事记忆增删清')
const sA = createStory({ title: '记忆A', characterId: 'testchar' }).meta.storyId
const sB = createStory({ title: '记忆B', characterId: 'testchar' }).meta.storyId

await storyMemory(sA).save({ content: '她怕水' })
const listA1 = listStoryMemories(sA)
check('A-06 存 1 条后 listStoryMemories 长度 1', listA1.length === 1, listA1.length)
check('A-06 内容一致（她怕水）', listA1[0] && listA1[0].content === '她怕水', listA1[0] && listA1[0].content)

const afterDel = deleteStoryMemory(sA, listA1[0].id)
check('A-07 删单条后长度 0', afterDel.length === 0, afterDel.length)

await storyMemory(sA).save({ content: '第一件事' })
await storyMemory(sA).save({ content: '第二件事' })
check('A-08 前提：存 2 条后长度 2', listStoryMemories(sA).length === 2, listStoryMemories(sA).length)
const afterClear = clearStoryMemories(sA)
check('A-08 清空后长度 0', afterClear.length === 0, afterClear.length)

/* ── 5 · A-09 / A-10 隔离（该区库 vs 该区库 / 该区库 vs 全局库）──────── */
console.log('5 · A-09 / A-10 隔离')
await storyMemory(sA).save({ content: '故事A独有的事实' })
const aLen = listStoryMemories(sA).length
const bLen = listStoryMemories(sB).length
check('A-09 storyA 有 1 条、storyB 为 0', aLen === 1 && bLen === 0, aLen + ' / ' + bLen)

const globalList = memoryService.list()
check('A-10 故事记忆不出现在全局 memoryService.list()（M11 回归）',
  !globalList.some((item) => item.content === '故事A独有的事实'),
  globalList.map((item) => item.content).join(',') || '(空)')

/* ── 6 · A-12 契约存在性（静态文本断言，防 J-01）──────────────────── */
console.log('6 · A-12 契约存在性')
const ipcSrc = fs.readFileSync(p('src/shared/ipc.ts'), 'utf8')
check('A-12 IPC 含 storyMemoryList', /storyMemoryList:\s*'story:memory-list'/.test(ipcSrc))
check('A-12 IPC 含 storyMemoryDelete', /storyMemoryDelete:\s*'story:memory-delete'/.test(ipcSrc))
check('A-12 IPC 含 storyMemoryClear', /storyMemoryClear:\s*'story:memory-clear'/.test(ipcSrc))
const preloadSrc = fs.readFileSync(p('src/preload/index.ts'), 'utf8')
check('A-12 preload 有 memoryList/memoryDelete/memoryClear',
  /memoryList:\s*\(storyId\)/.test(preloadSrc) && /memoryDelete:\s*\(storyId, id\)/.test(preloadSrc) && /memoryClear:\s*\(storyId\)/.test(preloadSrc))
const apiSrc = fs.readFileSync(p('src/shared/api.ts'), 'utf8')
check('A-12 api 有 memoryList/memoryDelete/memoryClear 签名',
  /memoryList:\s*\(storyId: string\) => Promise<MemoryEntry\[\]>/.test(apiSrc)
    && /memoryDelete:\s*\(storyId: string, id: string\) => Promise<MemoryEntry\[\]>/.test(apiSrc)
    && /memoryClear:\s*\(storyId: string\) => Promise<MemoryEntry\[\]>/.test(apiSrc))
const storySrc = fs.readFileSync(p('src/shared/story.ts'), 'utf8')
check('A-12 StoryMetaPatch 有 background',
  /interface StoryMetaPatch[\s\S]*?background\?: string \| null/.test(storySrc))
check('A-12 StoryMeta 与 StoryDraft 都有 background?: string',
  (storySrc.match(/background\?: string/g) || []).length >= 2, (storySrc.match(/background\?: string/g) || []).length)

done()
