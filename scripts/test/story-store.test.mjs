/**
 * 故事区数据模型（P4）—— A-01…A-07 / A-13…A-21。
 *
 * 测的是**真实边界**：
 *  - 真建目录、真落 story.json、真起 memory.db（不是 mock fs）
 *  - 真复现「句柄没关 → 删目录 EPERM」（A-17，本机行为变了这条会红）
 *  - 真走 chatService 建会话，验「故事会话不进最近列表」（A-20）
 *
 * 跑法：node scripts/test/story-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-store-'))
installElectronStub(userData)

// 记忆关掉：本套件不测抽取，只测落盘与句柄；开着会去加载 embedding 模型。
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false } }),
  'utf8'
)

// story/memory.ts 用的是真实 rag（要真的 MemoryService）；只把 chatService 的 rag 挡掉，
// 避免对话链路上真的去跑 embedding。本套件不调 send，所以这一层基本用不上，留着是为了
// 防止以后有人在这里加一条 send 断言时静默去加载模型。
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-ragstub-'))
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  'export const memoryService = { async buildContextBlock() { return "" }, async extractInBackground() {}, dispose() {} }\n',
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
  'story-store',
  [
    `export { createStory, listStories, getStory, deleteStory } from '${p('src/main/features/story/service.ts')}'`,
    `export { StoryStore } from '${p('src/main/features/story/store.ts')}'`,
    `export { storyMemory, closeStoryMemory } from '${p('src/main/features/story/memory.ts')}'`,
    `export { storiesRoot, storyDir, storyDbPath, trashRoot, isStoryId, newStoryId, assertStoryId } from '${p('src/main/features/story/paths.ts')}'`,
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`,
    `export { IPC } from '${p('src/shared/ipc.ts')}'`
  ].join('\n'),
  [plugin]
)
const {
  createStory,
  listStories,
  getStory,
  deleteStory,
  StoryStore,
  storyMemory,
  closeStoryMemory,
  storiesRoot,
  storyDir,
  storyDbPath,
  trashRoot,
  isStoryId,
  newStoryId,
  assertStoryId,
  chatService,
  MemoryStore,
  IPC
} = mod

const ROOT = storiesRoot()
const fileSize = (file) => (fs.existsSync(file) ? fs.statSync(file).size : -1)

/* ── 前置：路径与 id ───────────────────────────────────────────────── */

console.log('0 · 路径与 id 的形状')
const sample = newStoryId()
check('newStoryId 形状合法', isStoryId(sample), sample)
check('assertStoryId 拒绝 ../..', (() => { try { assertStoryId('../../x'); return false } catch { return true } })())
check('assertStoryId 拒绝大写', (() => { try { assertStoryId('story_1_ABCDEF'); return false } catch { return true } })())
check('assertStoryId 拒绝空串', (() => { try { assertStoryId(''); return false } catch { return true } })())
check('.trash 与 storiesRoot 同级（不在 storyDir 里）', trashRoot() === path.join(ROOT, '.trash'), trashRoot())

/* ── A-01 / A-02 / A-03：建区与落盘 ───────────────────────────────── */

console.log('1 · A-01 / A-02 / A-03 建区与落盘')
const created = createStory({ title: '测试故事一', characterId: 'nahida', synopsis: '梗概' })
const idA = created.meta.storyId
check('A-01 目录存在', fs.existsSync(storyDir(idA)), storyDir(idA))
check('A-01 目录里有 story.json', fs.existsSync(path.join(storyDir(idA), 'story.json')))
check(
  'A-01 目录里有 memory.db',
  fs.existsSync(storyDbPath(idA)),
  '大小=' + String(fileSize(storyDbPath(idA)))
)
check('A-01 memory.db 至少有 8192 B（空库也是 12288）', fileSize(storyDbPath(idA)) >= 8192, fileSize(storyDbPath(idA)))

const metaRaw = JSON.parse(fs.readFileSync(path.join(storyDir(idA), 'story.json'), 'utf8'))
check('A-02 version === 1', metaRaw.version === 1, metaRaw.version)
check('A-02 meta.storyId 与目录名一致', metaRaw.meta && metaRaw.meta.storyId === idA, metaRaw.meta && metaRaw.meta.storyId)
check('A-02 标题原样落盘', metaRaw.meta.title === '测试故事一', metaRaw.meta.title)

// 再建一个（A-03 要逐一对照目录）
const created2 = createStory({ title: '测试故事二', characterId: 'nahida' })
const idB = created2.meta.storyId
const dirsOnDisk = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && isStoryId(entry.name))
  .map((entry) => entry.name)
  .sort()
const listed = listStories().map((item) => item.storyId).sort()
check('A-03 list() 与磁盘目录逐一相等', JSON.stringify(listed) === JSON.stringify(dirsOnDisk), JSON.stringify(listed))
check('A-03 两个区都在', listed.length === 2, listed.length)
check('A-03 标题为空时回落「未命名故事」',
  (() => { const m = createStory({ title: '', characterId: 'nahida' }).meta; return m.title === '未命名故事' })(),
  getStory(idA) && getStory(idA).title
)
const idC = listStories().find((item) => item.title === '未命名故事').storyId

/* ── A-04：非法 id 一律拒绝，且磁盘什么都没建 ─────────────────────── */

console.log('2 · A-04 非法 id')
const beforeDirs = fs.readdirSync(ROOT).filter((name) => isStoryId(name)).length
for (const bad of ['../../x', 'story_1', '', 'story_1_ABCDEF']) {
  let threw = false
  try { StoryStore ? new StoryStore(ROOT).get(bad) : null } catch { threw = true }
  check('A-04 拒绝 ' + JSON.stringify(bad), threw)
}
const afterDirs = fs.readdirSync(ROOT).filter((name) => isStoryId(name)).length
check('A-04 磁盘目录数未变（校验排在建目录之前）', beforeDirs === afterDirs, beforeDirs + ' → ' + afterDirs)

/* ── A-05：story.json 写入失败 → 半截目录被回滚 ───────────────────── */

console.log('3 · A-05 写入失败的回滚')
const fsModule = createRequire(import.meta.url)('node:fs')
const realWrite = fsModule.writeFileSync
const countStoryDirs = () =>
  fs.readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory() && isStoryId(entry.name)).length
const beforeRollback = countStoryDirs()
let writeFailed = false
fsModule.writeFileSync = function (target, ...rest) {
  if (String(target).endsWith('story.json.tmp')) {
    fsModule.writeFileSync = realWrite
    writeFailed = true
    throw new Error('模拟：story.json 写入失败')
  }
  return realWrite.call(this, target, ...rest)
}
let threwOnCreate = false
try {
  createStory({ title: '这条应当失败', characterId: 'nahida' })
} catch {
  threwOnCreate = true
}
fsModule.writeFileSync = realWrite
check('A-05 create 抛错（失败没有被吞）', threwOnCreate === true)
check('A-05 注入点真的命中了', writeFailed === true)
check('A-05 半截目录被回滚（目录数不变）', countStoryDirs() === beforeRollback, beforeRollback + ' → ' + countStoryDirs())

/* ── A-06 / A-07：每区一个库 + 关句柄后无 -wal/-shm ───────────────── */

console.log('4 · A-06 / A-07 句柄与库文件')
check('A-06 两区 memory.db 路径不同', storyDbPath(idA) !== storyDbPath(idB), storyDbPath(idA) + ' vs ' + storyDbPath(idB))
const serviceA = storyMemory(idA)
storyMemory(idA)
check('A-06 同一 storyId 复用同一个句柄（不重复开连接）', storyMemory(idA) === serviceA)
closeStoryMemory(idA)
const leftoverA = fs.readdirSync(storyDir(idA)).sort()
check('A-07 关句柄后只剩 story.json 与 memory.db', JSON.stringify(leftoverA) === JSON.stringify(['memory.db', 'story.json']), JSON.stringify(leftoverA))
check('A-07 没有 -wal 残留', !leftoverA.some((name) => name.endsWith('-wal')), JSON.stringify(leftoverA))

/* ── A-18 / A-19：AI 开场 ───────────────────────────────────────── */

console.log('5 · A-18 / A-19 AI 开场')
const withOpening = createStory({ title: '带开场', characterId: 'nahida', openingText: '  夜色沉下来了。  ' })
const openingSession = chatService.listSessions().find((item) => item.id === withOpening.sessionId)
check('A-18 首条是 assistant', openingSession.messages[0] && openingSession.messages[0].role === 'assistant', openingSession.messages[0] && openingSession.messages[0].role)
check('A-18 内容逐字等于入参（去首尾空白）', openingSession.messages[0].content === '夜色沉下来了。', JSON.stringify(openingSession.messages[0].content))
check('A-18 只有一条消息', openingSession.messages.length === 1, openingSession.messages.length)
const plainSession = chatService.listSessions().find((item) => item.id === created.sessionId)
check('A-19 未传 openingText → 一条消息都没有', plainSession.messages.length === 0, plainSession.messages.length)

/* ── A-20：故事会话不进「最近」 ────────────────────────────────────── */

console.log('6 · A-20 桌面会话过滤')
const desktopNow = chatService.listDesktopSessions().map((item) => item.id)
check('A-20 故事会话不在桌面列表里', !desktopNow.includes(created.sessionId), desktopNow.length + ' 条桌面会话')
const normal = chatService.createSession({ mode: 'chat', title: '普通会话' })
check(
  'A-20 对照物：普通会话仍在桌面列表里',
  chatService.listDesktopSessions().some((item) => item.id === normal.id)
)
check(
  'A-20 故事会话的 mode 是 story（不是被静默归一化成 chat）',
  chatService.listSessions().find((item) => item.id === created.sessionId).mode === 'story',
  chatService.listSessions().find((item) => item.id === created.sessionId).mode
)

/* ── A-17：EPERM 复现（本机行为证据，不是代码 bug 的判据） ──────────── */

console.log('7 · A-17 未关句柄时删目录失败')
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-eperm-'))
const probeStore = new MemoryStore(path.join(probeDir, 'memory.db'))
probeStore.healthy()
let removeFailed = false
try {
  fs.rmSync(probeDir, { recursive: true, force: true })
} catch {
  removeFailed = true
}
check('A-17 句柄未关 → 删目录失败或被拦下', removeFailed || fs.existsSync(probeDir), removeFailed ? '抛出' : '仍存在')
probeStore.close()
let removedAfterClose = false
try {
  fs.rmSync(probeDir, { recursive: true, force: true })
  removedAfterClose = !fs.existsSync(probeDir)
} catch {
  removedAfterClose = false
}
check('A-17 关掉句柄后同一操作成功', removedAfterClose === true)

/* ── A-13 / A-14 / A-15 / A-16：删区三态 ─────────────────────────── */

console.log('8 · A-13 缺 confirmed 不删')
// 🔴 删区**前**必须让句柄真的开着：否则「删前先 close」这条判据无从证明 ——
//    A-07 那一步已经把句柄关了，这里再关一次是空操作，M2 突变（注释掉 close）会静默全绿。
const targetId = idA
// MemoryStore 是**惰性打开**的：只取句柄不碰库，连接不会真的建立（§2.3 ③）。
// 所以这里必须真的读一次，让 -wal 出现 —— 那才是「句柄开着」的可观测证据。
storyMemory(targetId).list()
check(
  '前置：删区前该区句柄确实打开（目录里出现 -wal）',
  fs.readdirSync(storyDir(targetId)).some((name) => name.endsWith('-wal')),
  fs.readdirSync(storyDir(targetId)).sort().join(',')
)
const snapshot = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name + ':' + String(fs.statSync(path.join(dir, entry.name)).size))
    .sort()
const beforeDelete = snapshot(storyDir(targetId))
const refused = deleteStory(targetId, {})
check('A-13 reason === need_confirm', refused.ok === false && refused.reason === 'need_confirm', JSON.stringify(refused))
check('A-13 目录一个字节没动', JSON.stringify(snapshot(storyDir(targetId))) === JSON.stringify(beforeDelete), JSON.stringify(snapshot(storyDir(targetId))))

console.log('9 · A-13 / A-14 非法 id 与成功路径')
const notFound = deleteStory('../../etc', { confirmed: true })
check('A-13 非法 id → not_found，且不抛', notFound.ok === false && notFound.reason === 'not_found', JSON.stringify(notFound))

const good = deleteStory(targetId, { confirmed: true })
check('A-14 ok === true', good.ok === true, JSON.stringify(good.reason || 'ok'))
if (good.ok) {
  const backed = fs.readdirSync(good.receipt.backupPath, { withFileTypes: true }).filter((e) => e.isFile())
  check('A-14 fileCount 与备份目录一致', good.receipt.fileCount === backed.length, good.receipt.fileCount + ' vs ' + backed.length)
  const backupBytes = backed.reduce((sum, e) => sum + fs.statSync(path.join(good.receipt.backupPath, e.name)).size, 0)
  check('A-14 bytes 与备份目录一致', good.receipt.bytes === backupBytes, good.receipt.bytes + ' vs ' + backupBytes)
  check('A-14 备份里有 memory.db（没漏最大的那个）', backed.some((e) => e.name === 'memory.db'), backed.map((e) => e.name).join(','))
  check('A-14 备份在 .trash 下（不在被删目录里）', good.receipt.backupPath.startsWith(trashRoot()), good.receipt.backupPath)
  check('A-15 目录已不在', !fs.existsSync(storyDir(targetId)))
  check('A-15 list() 不再含它', !listStories().some((item) => item.storyId === targetId))
  check('A-16 该区的会话全部消失', chatService.listSessionsByStory(targetId).length === 0)
  check('A-14 sessionsRemoved 与实际条数一致', good.receipt ? good.sessionsRemoved === 1 : false, good.sessionsRemoved)
}
check('A-16 其它区一条不少（逐条比 id 集合）',
  JSON.stringify(chatService.listSessionsByStory(idB).map((s) => s.id)) === JSON.stringify([created2.sessionId]),
  JSON.stringify(chatService.listSessionsByStory(idB).map((s) => s.id))
)

/* ── A-21：类型穷尽（结构判据，tsc 的临时红见施工记录） ───────────── */

console.log('10 · A-21 四处表 + 归一化')
const readSrc = (rel) => fs.readFileSync(path.join(p('.'), rel), 'utf8')
const typesSrc = readSrc('src/shared/types.ts')
const promptSrc = readSrc('src/main/features/prompt/promptStore.ts')
const chatPageSrc = readSrc('src/renderer/src/features/chat/ChatPage.tsx')
const emptySrc = readSrc('src/renderer/src/features/chat/components/EmptyState.tsx')
check('A-21 ConversationMode 含 story', /export type ConversationMode = 'chat' \| 'agent' \| 'story'/.test(typesSrc))
check('A-21 MODE_RULES 有 story 键', /story: 'modes\/story\.md'/.test(promptSrc))
check('A-21 STYLE_FILES 有 story 键', /story: 'styles\/story\.md'/.test(promptSrc))
check('A-21 MODE_LABEL 有 story 键', /story: '故事'/.test(chatPageSrc))
check('A-21 MODE_COPY 有 story 键', /story: \{ label: '故事'/.test(emptySrc))
check(
  'A-21 首页滑块**不含** story（不能出现点了没反应的第三个按钮）',
  !/\(\['chat', 'agent'[^\]]*'story'/.test(emptySrc)
)
check('A-21 normalizeMode 认 story', /if \(value === 'story'\) return 'story'/.test(readSrc('src/main/features/chat/chatService.ts')))
check('A-21 IPC 四条通道齐全',
  [IPC.storyList, IPC.storyCreate, IPC.storyGet, IPC.storyDelete].join(',') === 'story:list,story:create,story:get,story:delete',
  [IPC.storyList, IPC.storyCreate, IPC.storyGet, IPC.storyDelete].join(','))

done()
