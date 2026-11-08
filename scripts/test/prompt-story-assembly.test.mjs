/**
 * 故事提示词七层装配（P5）—— A-01…A-15。
 *
 * 测的是**真实边界**：
 *  - 真起一个临时 Prompt/ 根（假角色资产），不读用户真实 Prompt/ —— 用户改了自己的
 *    角色文件不该让本套件变红（P5 蓝图 §6.3「不算失败」第 3 条）
 *  - 真调 promptStore.compose()，按 '\n\n---\n\n' 拆段后逐段判（不是正则猜）
 *  - 真走 chatService.storyPromptOf（J-05：测生产路径的真实返回，不测纯函数）
 *  - 两档成对判据（A-06 ↔ A-07）：先证「default 档角色设定在」，再证「override 档不在」
 *
 * 跑法：node scripts/test/prompt-story-assembly.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { bundleModule, createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const require = createRequire(import.meta.url)

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p5-user-'))
const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p5-app-'))

/**
 * 自建 electron 桩：promptStore.root() 在非打包态是 app.getAppPath()/Prompt，
 * 所以这里必须能把 getAppPath 指到临时目录（qq-test-util 的桩固定成 projectRoot）。
 */
function installStub(root, target) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p5-stub-'))
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

// 记忆关掉：本套件不测抽取，开着会去加载 embedding 模型
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false }, chatTools: {} }),
  'utf8'
)

/* ── 假的 Prompt/ 根（角色资产只读，本套件自己造一份）──────────────── */

const PROMPT = path.join(appPath, 'Prompt')
const CHAR = path.join(PROMPT, 'characters', 'testchar')
const write = (rel, body) => {
  const file = path.join(PROMPT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
  return file
}
write('shared/base.md', '# 全局底线\n\nBASE_MARKER_全局')
write('shared/tone.md', 'TONE_MARKER_语气')
write('shared/tool_usage.md', 'TOOL_MARKER_工具规范')
write('characters/testchar/soul.md', '# 测试角色 · Soul\n\nSOUL_MARKER_人格')
write('characters/testchar/canon/s1.md', 'CANON_MARKER_台词')
write('characters/testchar/worldbook/wb1.md', 'ROLE_WB_MARKER_角色设定')
write('characters/testchar/modes/chat.md', 'MODE_CHAT_MARKER_模式规则')
write('characters/testchar/styles/chat.md', 'STYLE_CHAT_MARKER_表达风格')
// 🔴 刻意**不建** modes/story.md / styles/story.md（P5 蓝图 §4.7 的有意保留）

// chatService 的 rag 换成桩：本套件不调 send，只调 storyPromptOf，但 import 链路会带进 embedding
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p5-ragstub-'))
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  'export const memoryService = { async buildContextBlock() { return "" }, async extractBackground() {}, dispose() {} }\n' +
    'export const memoryServiceAlias = memoryService\n',
  'utf8'
)
const plugin = {
  name: 'stub-rag-for-chat',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) =>
      args.importer.endsWith('chatService.ts') ? { path: ragStub } : null
    )
  }
}

const mod = await bundleModule(
  'prompt-story-assembly',
  [
    "export { promptStore } from '" + p('src/main/features/prompt/promptStore.ts') + "'",
    "export { StoryStore } from '" + p('src/main/features/story/store.ts') + "'",
    "export { resolveWorldbookDir, storyProfilePath, storiesRoot, storyDir, newStoryId, isStoryId } from '" + p('src/main/features/story/paths.ts') + "'",
    "export { chatService } from '" + p('src/main/features/chat/chatService.ts') + "'",
    "export { STORY_WORLDBOOK_MODE_DEFAULT, STORY_PROFILE_FILE } from '" + p('src/shared/story.ts') + "'"
  ].join('\n'),
  [plugin]
)
const {
  promptStore,
  StoryStore,
  resolveWorldbookDir,
  storyProfilePath,
  storiesRoot,
  storyDir,
  newStoryId,
  isStoryId,
  chatService,
  STORY_WORLDBOOK_MODE_DEFAULT,
  STORY_PROFILE_FILE
} = mod

const ROOT = storiesRoot()
const SEP = '\n\n---\n\n'
const sectionsOf = (text) => (text ? text.split(SEP) : [])
const LOOKS_THERE = (text, marker) => text.includes(marker)
const countOf = (text, marker) => text.split(marker).length - 1

// 剧本世界书：相对 storiesRoot() 解析 ⇒ 建在 <userData>/stories/wb-alpha/
const WB_REL = 'wb-alpha'
const WB_ABS = path.join(ROOT, WB_REL)
fs.mkdirSync(WB_ABS, { recursive: true })
fs.writeFileSync(path.join(WB_ABS, 'a.md'), 'STORY_WB_MARKER_A_剧本设定', 'utf8')
fs.writeFileSync(path.join(WB_ABS, 'b.md'), 'STORY_WB_MARKER_B_剧本设定', 'utf8')

const storyStore = new StoryStore()

/* ── A-01 契约补全 ─────────────────────────────────────────────────── */

console.log('1 · A-01 契约（StoryDraft / StoryMeta / 类型 / 常量）')
const storySrc = fs.readFileSync(p('src/shared/story.ts'), 'utf8')
check('A-01 StoryMeta 有 worldbookDir?', /worldbookDir\?: string/.test(storySrc))
check('A-01 StoryMeta 有 worldbookMode?', /worldbookMode\?: StoryWorldbookMode/.test(storySrc))
check('A-01 StoryDraft 有两个可选字段（同文件出现 ≥ 2 次）',
  (storySrc.match(/worldbookMode\?: StoryWorldbookMode/g) || []).length >= 2,
  (storySrc.match(/worldbookMode\?: StoryWorldbookMode/g) || []).length)
check('A-01 新增 StoryWorldbookMode 类型', /export type StoryWorldbookMode = 'default' \| 'override'/.test(storySrc))
check('A-01 缺省常量是 default', STORY_WORLDBOOK_MODE_DEFAULT === 'default', STORY_WORLDBOOK_MODE_DEFAULT)
check('A-01 画像文件名常量是 profile.md', STORY_PROFILE_FILE === 'profile.md', STORY_PROFILE_FILE)
check('A-01 store.ts 已去掉类型旁路（不再从 draft 里强转取 worldbookDir）',
  !/\(draft as unknown as Record<[^>]*>\)\??\.worldbookDir/.test(fs.readFileSync(p('src/main/features/story/store.ts'), 'utf8')))

/* ── A-02 / A-03 建区守卫与落盘 ─────────────────────────────────────── */

console.log('2 · A-02 override 无目录 → 抛错且磁盘什么都没建')
const dirsBefore = () => fs.readdirSync(ROOT).filter((name) => isStoryId(name)).sort()
const beforeBad = dirsBefore()
let threw = null
try {
  storyStore.create({ title: '坏区', characterId: 'testchar', worldbookMode: 'override' })
} catch (error) {
  threw = error
}
check('A-02 抛错了', threw instanceof Error, threw && threw.message)
check('A-02 错误里说清后果（世界书会整段消失）', threw && /世界书/.test(threw.message), threw && threw.message)
check('A-02 磁盘上没多出任何 story_* 目录',
  JSON.stringify(dirsBefore()) === JSON.stringify(beforeBad),
  JSON.stringify(dirsBefore()))

console.log('3 · A-03 两档落盘口径')
const createdDefault = storyStore.create({
  title: '默认档',
  characterId: 'testchar',
  worldbookDir: WB_REL
})
const metaDefaultRaw = JSON.parse(fs.readFileSync(path.join(storyDir(createdDefault.storyId), 'story.json'), 'utf8'))
check('A-03 default 档：worldbookDir 落盘', metaDefaultRaw.meta.worldbookDir === WB_REL, metaDefaultRaw.meta.worldbookDir)
check('A-03 default 档：story.json 里**没有** worldbookMode 键',
  !Object.prototype.hasOwnProperty.call(metaDefaultRaw.meta, 'worldbookMode'),
  JSON.stringify(Object.keys(metaDefaultRaw.meta)))
check('A-03 default 档：读回时 meta.worldbookMode 是 undefined（缺省不落盘 → 不补）',
  createdDefault.worldbookMode === undefined, String(createdDefault.worldbookMode))

const createdOverride = storyStore.create({
  title: '覆盖档',
  characterId: 'testchar',
  worldbookDir: WB_REL,
  worldbookMode: 'override'
})
const metaOverrideRaw = JSON.parse(fs.readFileSync(path.join(storyDir(createdOverride.storyId), 'story.json'), 'utf8'))
check('A-03 override 档：worldbookMode === override',
  metaOverrideRaw.meta.worldbookMode === 'override', metaOverrideRaw.meta.worldbookMode)
check('A-03 读回时 override 也保住了', storyStore.get(createdOverride.storyId).worldbookMode === 'override')

// 读坏值 → fail-safe 回 default
const broken = storyStore.create({ title: '坏档', characterId: 'testchar', worldbookDir: WB_REL })
const brokenFile = path.join(storyDir(broken.storyId), 'story.json')
const brokenRaw = JSON.parse(fs.readFileSync(brokenFile, 'utf8'))
brokenRaw.meta.worldbookMode = 'nonsense'
fs.writeFileSync(brokenFile, JSON.stringify(brokenRaw), 'utf8')
check('A-03 非法档位读回回落 default（fail-safe：宁可多注入角色设定）',
  storyStore.get(broken.storyId).worldbookMode === undefined,
  String(storyStore.get(broken.storyId).worldbookMode))

/* ── A-04 / A-05 缺省行为不变 ──────────────────────────────────────── */

console.log('4 · A-04 / A-05 缺省不改变既有行为')
const chatPlain = promptStore.compose('testchar', 'chat')
const chatEmptyOpts = promptStore.compose('testchar', 'chat', {})
check('A-04 不传第三参与传 {} 输出逐字一致', chatPlain === chatEmptyOpts)
check('A-04 无 story 时不含剧本世界书', !LOOKS_THERE(chatPlain, 'STORY_WB_MARKER'))
check('A-04 无 story 时不含画像', !LOOKS_THERE(chatPlain, 'PROFILE_MARKER'))
check('A-04 chat 无工具 → 不含工具规范（改动前既有语义）', !LOOKS_THERE(chatPlain, 'TOOL_MARKER'))
check('A-04 八段仍在：base/tone/soul/canon/worldbook/mode/style',
  ['BASE_MARKER', 'TONE_MARKER', 'SOUL_MARKER', 'CANON_MARKER', 'ROLE_WB_MARKER', 'MODE_CHAT_MARKER', 'STYLE_CHAT_MARKER']
    .every((marker) => LOOKS_THERE(chatPlain, marker)),
  sectionsOf(chatPlain).length)

const storyPlain = promptStore.compose('testchar', 'story', {})
check('A-05 story 模式不含 modes/story.md 的空段（文件不存在则跳过）',
  sectionsOf(storyPlain).length === 5, sectionsOf(storyPlain).length)
check('A-05 其余段与 chat 逐段一致（core 段是 chat 的子序列）',
  sectionsOf(storyPlain).every((section) => sectionsOf(chatPlain).includes(section)),
  sectionsOf(storyPlain).length + ' vs ' + sectionsOf(chatPlain).length)

/* ── A-06…A-09 世界书两档（成对）───────────────────────────────────── */

console.log('5 · A-06…A-09 世界书两档 + 画像')
fs.writeFileSync(path.join(storyDir(createdDefault.storyId), 'profile.md'), 'PROFILE_MARKER_画像', 'utf8')
fs.writeFileSync(path.join(storyDir(createdOverride.storyId), 'profile.md'), 'PROFILE_MARKER_画像', 'utf8')
const profilePath = storyProfilePath(createdDefault.storyId)
check('T4 storyProfilePath 落在 storyDir 下且叫 profile.md',
  path.dirname(profilePath) === storyDir(createdDefault.storyId) && path.basename(profilePath) === 'profile.md',
  profilePath)

const wbDirDefault = resolveWorldbookDir(storyStore.get(createdDefault.storyId))
check('T4 相对路径按 storiesRoot() 解析（不是进程 cwd）', wbDirDefault === path.resolve(ROOT, WB_REL), wbDirDefault)
check('T4 绝对路径原样返回',
  resolveWorldbookDir({ worldbookDir: WB_ABS }) === path.resolve(WB_ABS),
  resolveWorldbookDir({ worldbookDir: WB_ABS }))
check('T4 没配 → null', resolveWorldbookDir({}) === null)

const atDefault = promptStore.compose('testchar', 'story', {
  story: { worldbookDir: wbDirDefault, worldbookMode: 'default', profile: 'PROFILE_MARKER_画像' }
})
const atOverride = promptStore.compose('testchar', 'story', {
  story: { worldbookDir: wbDirDefault, worldbookMode: 'override', profile: 'PROFILE_MARKER_画像' }
})

check('A-06 default 档含角色 worldbook 原文（对照物）', LOOKS_THERE(atDefault, 'ROLE_WB_MARKER'))
check('A-06 default 档含剧本世界书原文', LOOKS_THERE(atDefault, 'STORY_WB_MARKER_A') && LOOKS_THERE(atDefault, 'STORY_WB_MARKER_B'))
check('A-07 override 档**不含**角色 worldbook（D11 否定判据）', !LOOKS_THERE(atOverride, 'ROLE_WB_MARKER'))
check('A-07 override 档含剧本世界书原文（对照物）',
  LOOKS_THERE(atOverride, 'STORY_WB_MARKER_A') && LOOKS_THERE(atOverride, 'STORY_WB_MARKER_B'))
// 🔴 成对判据的三段写法（M2 突变实测教训）：只写「两档一致 + 角色设定不同」是不够的 ——
//    剧本世界书两边**都为空**时「一致」仍然成立，A-08 会在 M2 下假绿。
//    必须先各自命中（对照物在场），再判一致，再判差别。
check('A-08 成对①：两档**都**命中了剧本世界书（对照物在场）',
  LOOKS_THERE(atDefault, 'STORY_WB_MARKER_A') && LOOKS_THERE(atOverride, 'STORY_WB_MARKER_A'))
check('A-08 成对②：两档的剧本世界书内容一致（同一份来源）',
  countOf(atDefault, 'STORY_WB_MARKER_A') === countOf(atOverride, 'STORY_WB_MARKER_A')
    && countOf(atDefault, 'STORY_WB_MARKER_B') === countOf(atOverride, 'STORY_WB_MARKER_B'),
  countOf(atDefault, 'STORY_WB_MARKER_A') + ' vs ' + countOf(atOverride, 'STORY_WB_MARKER_A'))
check('A-08 成对③：唯一差别就是角色设定在不在',
  LOOKS_THERE(atDefault, 'ROLE_WB_MARKER') !== LOOKS_THERE(atOverride, 'ROLE_WB_MARKER'))
check('A-08 两档都不是空产物（防「override 什么都不注入」也能让 A-07 变绿）',
  sectionsOf(atDefault).length >= 6 && sectionsOf(atOverride).length >= 5,
  sectionsOf(atDefault).length + ' / ' + sectionsOf(atOverride).length)
check('A-09 两档下其余段一字不少（base/tone/soul/canon/canon 之后再判画像）',
  ['BASE_MARKER', 'TONE_MARKER', 'SOUL_MARKER', 'CANON_MARKER', 'PROFILE_MARKER']
    .every((marker) => LOOKS_THERE(atDefault, marker)),
  sectionsOf(atDefault).length)
check('A-09 override 档同样保留其余各段',
  ['BASE_MARKER', 'TONE_MARKER', 'SOUL_MARKER', 'CANON_MARKER', 'PROFILE_MARKER']
    .every((marker) => LOOKS_THERE(atOverride, marker)),
  sectionsOf(atOverride).length)
check('A-09 story 模式即使 toolsEnabled:true 也不注入工具规范（M10 边界）',
  !LOOKS_THERE(promptStore.compose('testchar', 'story', { toolsEnabled: true, story: { worldbookDir: wbDirDefault, worldbookMode: 'default', profile: '' } }), 'TOOL_MARKER'))

/* ── A-10 / A-11 剧本世界书的两个异常分支 ─────────────────────────── */

console.log('6 · A-10 / A-11 目录异常')
const warnCount = () => warns.length
const warns = []
const originalWarn = console.warn
console.warn = (...args) => { warns.push(args.map(String).join(' ')) }
const missing = promptStore.compose('testchar', 'story', {
  story: { worldbookDir: path.join(ROOT, 'no-such-dir'), worldbookMode: 'default', profile: '' }
})
check('A-10 目录不存在 → 不抛', typeof missing === 'string')
check('A-10 目录不存在 → 不注入（也不含角色世界书被挤掉）',
  !LOOKS_THERE(missing, 'STORY_WB_MARKER') && LOOKS_THERE(missing, 'ROLE_WB_MARKER'),
  sectionsOf(missing).length)
check('A-10 目录不存在 → 打一次 warn', warnCount() >= 1, warns.join(' | ').slice(0, 80))

const warningsBeforeOverlap = warnCount()
const overlap = promptStore.compose('testchar', 'story', {
  story: {
    worldbookDir: path.join(CHAR, 'worldbook'),
    worldbookMode: 'default',
    profile: ''
  }
})
check('A-11 与角色目录重叠 → 角色设定只注入一次（剧本世界书被跳过）',
  countOf(overlap, 'ROLE_WB_MARKER') === 1,
  countOf(overlap, 'ROLE_WB_MARKER'))
check('A-11 重叠时打一次 warn', warnCount() > warningsBeforeOverlap, warns.slice(-1).join(''))

const badFile = path.join(ROOT, 'wb-file.md')
fs.writeFileSync(badFile, 'NOT_A_DIR', 'utf8')
const notDir = promptStore.compose('testchar', 'story', {
  story: { worldbookDir: badFile, worldbookMode: 'default', profile: '' }
})
check('A-10 路径是文件而不是目录 → 不抛且不注入', !LOOKS_THERE(notDir, 'STORY_WB_MARKER'))
console.warn = originalWarn

/* ── A-12 / A-13 画像的位置与缺省 ─────────────────────────────────── */

console.log('7 · A-12 / A-13 故事画像')
const withProfileChat = promptStore.compose('testchar', 'chat', {
  toolsEnabled: true,
  story: { worldbookDir: null, worldbookMode: 'default', profile: 'PROFILE_MARKER_画像' }
})
const idxStyle = withProfileChat.indexOf('STYLE_CHAT_MARKER')
const idxProfile = withProfileChat.indexOf('PROFILE_MARKER')
const idxTool = withProfileChat.indexOf('TOOL_MARKER')
check('A-12 画像在表达风格之后', idxStyle >= 0 && idxProfile > idxStyle, idxStyle + ' → ' + idxProfile)
check('A-12 画像在工具规范之前', idxProfile >= 0 && idxTool > idxProfile, idxProfile + ' → ' + idxTool)
check('A-12 画像自成一节（两侧都是分隔符）',
  sectionsOf(withProfileChat).includes('PROFILE_MARKER_画像'),
  JSON.stringify(sectionsOf(withProfileChat).map((s) => s.slice(0, 16))))
check('A-13 没有画像 → 产物里没有画像段，且不抛',
  typeof promptStore.compose('testchar', 'story', { story: { worldbookDir: null, worldbookMode: 'default', profile: '' } }) === 'string'
    && !LOOKS_THERE(promptStore.compose('testchar', 'story', { story: { worldbookDir: null, worldbookMode: 'default', profile: '' } }), 'PROFILE_MARKER'))

const ghost = promptStore.compose('ghost-character', 'story', {})
check('F-07 角色不存在 → 不抛，仍发 base/tone',
  LOOKS_THERE(ghost, 'BASE_MARKER') && LOOKS_THERE(ghost, 'TONE_MARKER'),
  sectionsOf(ghost).length)

/* ── A-14 七层顺序守恒 ───────────────────────────────────────────── */

console.log('8 · A-14 七层顺序守恒（下标严格递增）')
const order = [
  'BASE_MARKER', 'TONE_MARKER', 'SOUL_MARKER', 'CANON_MARKER', 'ROLE_WB_MARKER',
  'STORY_WB_MARKER_A', 'STORY_WB_MARKER_B', 'PROFILE_MARKER'
]
const indexes = order.map((marker) => atDefault.indexOf(marker))
let increasing = true
for (let i = 1; i < indexes.length; i += 1) {
  if (!(indexes[i] > indexes[i - 1])) increasing = false
}
check('A-14 全部 8 个位置下标严格递增', increasing, indexes.join(' < '))
check('A-14 剧本世界书在角色 worldbook 之后（5b 紧随 5a）',
  indexes[5] > indexes[4], indexes[4] + ' → ' + indexes[5])
check('A-14 画像压在世界书之后（它不属于七层，但不许插到设定中间）',
  indexes[7] > indexes[6], indexes[6] + ' → ' + indexes[7])
check('A-14 分隔符唯一：join/拆 往返一致（没有段内自带分隔符）',
  sectionsOf(atDefault).join(SEP) === atDefault,
  sectionsOf(atDefault).length)

/* ── A-15 storyPromptOf（生产路径真实返回）────────────────────────── */

console.log('9 · A-15 storyPromptOf 以 mode 为准')
const storySession = { id: 's-1', mode: 'story', storyId: createdDefault.storyId, characterId: 'testchar' }
const chatButStoryId = { id: 's-2', mode: 'chat', storyId: createdDefault.storyId, characterId: 'testchar' }
const nullStoryId = { id: 's-3', mode: 'story', characterId: 'testchar' }
const ghostStoryId = { id: 's-4', mode: 'story', storyId: newStoryId(), characterId: 'testchar' }

const promptOf = (session) => chatService['storyPromptOf'](session)
const realOne = promptOf(storySession)
check('A-15 正向：story 会话拿到三段取值', realOne !== null, JSON.stringify(realOne))
check('A-15 正向：worldbookDir 是已解析的绝对目录', realOne && realOne.worldbookDir === path.resolve(ROOT, WB_REL), realOne && realOne.worldbookDir)
check('A-15 正向：worldbookMode 缺省补 default', realOne && realOne.worldbookMode === 'default', realOne && realOne.worldbookMode)
check('A-15 正向：画像正文读出来了', realOne && realOne.profile === 'PROFILE_MARKER_画像', realOne && realOne.profile)
check('A-15 反向：chat 会话即使带 storyId → null（不吃故事设定）', promptOf(chatButStoryId) === null, String(promptOf(chatButStoryId)))
check('A-15 反向：story 会话没有 storyId → null', promptOf(nullStoryId) === null, String(promptOf(nullStoryId)))
check('A-15 反向：storyId 形状合法但目录不存在 → null', promptOf(ghostStoryId) === null, String(promptOf(ghostStoryId)))
check('A-15 override 区读回 override', promptOf({ id: 's-5', mode: 'story', storyId: createdOverride.storyId, characterId: 'testchar' }).worldbookMode === 'override')
fs.rmSync(path.join(storyDir(createdOverride.storyId), 'profile.md'), { force: true })
check('A-13 删掉 profile.md 后读回空串（少文件不崩）',
  promptOf({ id: 's-5', mode: 'story', storyId: createdOverride.storyId, characterId: 'testchar' }).profile === '',
  JSON.stringify(promptOf({ id: 's-5', mode: 'story', storyId: createdOverride.storyId, characterId: 'testchar' }).profile))

// ── A-16 / A-17：角色目录**不存在**时的来源缺失边界（P5 复核 ★.4 / J-26）────────
//
// 这一组是复核时发现的真实缺陷补的：
// 世界书两档 + 剧本世界书 + 模式规则/风格 原本都写在 `if (existsSync(dir))` 块内，
// 于是**角色目录缺失时，剧本世界书整段消失**（M15 的语义反了：该生效的失效了）。
// 判据按「来源」枚举而不再按「已想到的场景」枚举 —— 见总蓝图 §9.1 J-26。
console.log('10 · 角色目录不存在时的来源缺失边界')

const ghostChar = 'no-such-character-' + Date.now()
const dirGhost = path.join(PROMPT, 'characters', ghostChar)
check('A-16 前提：角色目录确实不存在', !fs.existsSync(dirGhost))

const ghostDefault = promptStore.compose(ghostChar, 'story', {
  story: { worldbookDir: path.resolve(ROOT, WB_REL), worldbookMode: 'default', profile: 'PROFILE_MARKER_画像' }
})
check('A-16 角色目录不存在 → 剧本世界书**仍在**（M15 的核心语义）',
  ghostDefault.includes('STORY_WB_MARKER_A'), ghostDefault.slice(0, 120))
check('A-16 角色目录不存在 → 画像仍在', ghostDefault.includes('PROFILE_MARKER_画像'))
check('A-16 角色目录不存在 → 全局段仍在', ghostDefault.includes('BASE_MARKER') && ghostDefault.includes('TONE_MARKER'))
check('A-16 角色目录不存在 → 角色段确实不在（对照物：不是「什么都注入」）',
  !ghostDefault.includes('SOUL_MARKER') && !ghostDefault.includes('ROLE_WB_MARKER'))
check('A-16 角色目录不存在 → 不抛（chat 模式也走同一条路径）',
  typeof promptStore.compose(ghostChar, 'chat') === 'string')

const ghostOverride = promptStore.compose(ghostChar, 'story', {
  story: { worldbookDir: path.resolve(ROOT, WB_REL), worldbookMode: 'override', profile: '' }
})
check('A-17 override + 角色目录不存在 → 剧本世界书仍在',
  ghostOverride.includes('STORY_WB_MARKER_A'), ghostOverride.slice(0, 120))
check('A-17 override + 角色目录不存在 → 没有画像（profile 传空）', !ghostOverride.includes('PROFILE_MARKER_画像'))

// 真实缺陷的第二个成因：readStoryWorldbook 里的 realpathSync(characterDir) 会抛 ENOENT。
// 修法后它返回 null → 跳过「重叠检测」而不是跳过「整份世界书」。
//
// 🔴 这里**不再新增重叠断言**：重叠检测由上面的 A-11 覆盖（它传的是角色的 worldbook **子目录**，
//    正好落在 startsWith(realChar + sep) 的判定里）。
//    本节开始时我曾写过一条「剧本目录 = 角色目录本身」，它**验的不是它声称的东西** ——
//    按现有实现，「目录本身」不算重叠（只算子目录），所以那条断言既不会红也不会说明任何问题。
//    写过、跑红过、删掉，理由留在这里（J-24 的同族：判据要能真的变红）。

done()