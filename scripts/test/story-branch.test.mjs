/**
 * 故事分支树 + 分支记忆可见性（P6）—— A-01…A-17 / A-18…A-21 + 4 条补充断言。
 *
 * 测的是真实边界：
 *  - 真落 branches.json（真 fs）、真派生会话、真走 chatService
 *  - 记忆可见性走**真实** MemoryService + 真实 MemoryStore（embedder/extract 桩掉，测的是过滤不是模型）
 *
 * 跑法：node scripts/test/story-branch.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-branch-'))
installElectronStub(userData)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ defaultCharacterId: 'nahida', memory: { enabled: false, autoExtract: false } }),
  'utf8'
)

/* ── 桩掉 embedder / extract（真实 MemoryService，只测可见性过滤，不测模型） ── */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-branch-stubs-'))
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
  'story-branch',
  [
    `export { deriveBranch, deleteBranch, getBranchTree, switchBranch, listStories, createStory } from '${p('src/main/features/story/service.ts')}'`,
    `export { BranchStore, branchStore, normalizeBranches } from '${p('src/main/features/story/branches.ts')}'`,
    `export { branchVisibility } from '${p('src/main/features/story/visibility.ts')}'`,
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { StoryStore } from '${p('src/main/features/story/store.ts')}'`,
    `export { storiesRoot, storyBranchesPath, storyDbPath } from '${p('src/main/features/story/paths.ts')}'`,
    `export { storyScope } from '${p('src/main/features/story/route.ts')}'`,
    `export { MemoryService } from '${p('src/main/features/rag/index.ts')}'`,
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`
  ].join('\n'),
  [plugin]
)
const {
  deriveBranch,
  deleteBranch,
  getBranchTree,
  switchBranch,
  listStories,
  BranchStore,
  branchStore,
  branchVisibility,
  chatService,
  StoryStore,
  storiesRoot,
  storyBranchesPath,
  storyDbPath,
  storyScope,
  MemoryService,
  MemoryStore
} = mod

const SETTINGS = { enabled: true, autoExtract: true, topK: 5, budgetTokens: 1200, minScore: 0 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 造一条含 n 条消息的故事会话（用 appendMessages，不经模型） ── */
let seq = 0
function makeStory(store, title) {
  return store.create({ title, characterId: 'nahida' }, { characterId: 'nahida' })
}
function makeRootSession(chatService, storyId, count, prefix) {
  const session = chatService.createSession({ mode: 'story', storyId, title: '根分支' })
  const messages = []
  for (let i = 0; i < count; i += 1) {
    messages.push({
      id: prefix + i,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: '第' + i + '句',
      createdAt: 1000 + i,
      status: 'done'
    })
  }
  chatService.appendMessages(session.id, messages)
  return session
}
function readBranches(storyId) {
  return JSON.parse(fs.readFileSync(storyBranchesPath(storyId), 'utf8'))
}

const store = new StoryStore()

/* ══════════════════════ A-01…A-13：派生基础（storyA） ══════════════════════ */
const storyA = makeStory(store, 'P6 派生基础')
const rootA = makeRootSession(chatService, storyA.storyId, 10, 'a')
const beforeIds = chatService
  .listSessionsByStory(storyA.storyId)
  .find((session) => session.id === rootA.id)
  .messages.map((message) => message.id)
  .join(',')

const derived = deriveBranch({ storyId: storyA.storyId, fromSessionId: rootA.id, fromMessageId: 'a4', title: '支线' })

// A-01
const fileA = readBranches(storyA.storyId)
check('A-01 branches.json 存在且可 parse、version===1', fileA.version === 1 && Array.isArray(fileA.branches), JSON.stringify({ version: fileA.version, n: fileA.branches.length }))

// A-02
const nodeA = fileA.branches.find((branch) => branch.branchId === derived.sessionId)
check(
  'A-02 新节点四字段齐（branchId/parentBranchId/parentMessageId/createdAt）',
  Boolean(nodeA) &&
    typeof nodeA.branchId === 'string' &&
    nodeA.parentBranchId === rootA.id &&
    nodeA.parentMessageId === 'a4' &&
    typeof nodeA.createdAt === 'number',
  JSON.stringify(nodeA)
)

// A-05
const newSession = chatService.listSessionsByStory(storyA.storyId).find((session) => session.id === derived.sessionId)
check('A-05 新会话 messages.length === idx+1（5 条，含分叉点）', newSession.messages.length === 5, newSession.messages.length)

// A-06
const newIds = new Set(newSession.messages.map((message) => message.id))
const srcIds = new Set(['a0', 'a1', 'a2', 'a3', 'a4'])
const intersect = [...newIds].filter((id) => srcIds.has(id))
check('A-06 新会话消息 id 与源完全不相交（重新生成）', intersect.length === 0, intersect.join(','))

// A-07
const expectedSrc = ['a0', 'a1', 'a2', 'a3', 'a4']
const copiedOk = newSession.messages.every((message, index) => message.copiedFromMessageId === expectedSrc[index])
check('A-07 每条 copiedFromMessageId 按顺序等于源消息 id', copiedOk, newSession.messages.map((m) => m.copiedFromMessageId).join(','))

// A-08
check('A-08 新会话没有 streaming 消息（全部 done）', newSession.messages.every((message) => message.status === 'done'), newSession.messages.map((m) => m.status).join(','))

// A-09
const afterIds = chatService
  .listSessionsByStory(storyA.storyId)
  .find((session) => session.id === rootA.id)
  .messages.map((message) => message.id)
  .join(',')
check('A-09 守恒：源会话 id 序列逐字不变', afterIds === beforeIds, 'before=' + beforeIds + ' after=' + afterIds)

// A-10
const rootAfter = chatService.listSessionsByStory(storyA.storyId).find((session) => session.id === rootA.id)
check(
  'A-10 守恒第二维：源 length===10 且末条 id 不变',
  rootAfter.messages.length === 10 && rootAfter.messages[rootAfter.messages.length - 1].id === 'a9',
  rootAfter.messages.length + '/' + rootAfter.messages[rootAfter.messages.length - 1].id
)

// A-11
check('A-11 派生后 activeBranchId === 新分支 id（自动激活）', branchStore.read(storyA.storyId).activeBranchId === derived.sessionId, branchStore.read(storyA.storyId).activeBranchId)

// A-12
switchBranch(storyA.storyId, rootA.id)
const afterSwitchRoot = branchStore.read(storyA.storyId).activeBranchId
switchBranch(storyA.storyId, derived.sessionId)
const afterSwitchBack = branchStore.read(storyA.storyId).activeBranchId
check('A-12 切换往返幂等', afterSwitchRoot === rootA.id && afterSwitchBack === derived.sessionId, afterSwitchRoot + '→' + afterSwitchBack)

// A-13
const treeA = getBranchTree(storyA.storyId)
const rootNode = treeA.find((node) => node.branchId === rootA.id)
const activeCount = []
const walk = (list) => list.forEach((node) => { if (node.isActive) activeCount.push(node.branchId); walk(node.children) })
walk(treeA)
check(
  'A-13 树结构正确：根有 1 个子节点、isActive 恰好一个',
  treeA.length === 1 &&
    rootNode &&
    rootNode.children.length === 1 &&
    rootNode.children[0].branchId === derived.sessionId &&
    activeCount.length === 1 &&
    activeCount[0] === derived.sessionId,
  JSON.stringify({ roots: treeA.length, children: rootNode && rootNode.children.map((c) => c.branchId), activeCount })
)

/* ══════════════════════ A-14：懒迁移幂等（storyB） ══════════════════════ */
const storyB = makeStory(store, 'P6 懒迁移')
const rootB = makeRootSession(chatService, storyB.storyId, 3, 'b')
check('A-14 前置：一开始没有 branches.json', !fs.existsSync(storyBranchesPath(storyB.storyId)), 'ABSENT')
const treeB1 = getBranchTree(storyB.storyId)
const mtime1 = fs.statSync(storyBranchesPath(storyB.storyId)).mtimeMs
check('A-14 第一次产出单节点树并写回', treeB1.length === 1 && treeB1[0].branchId === rootB.id && fs.existsSync(storyBranchesPath(storyB.storyId)), JSON.stringify(treeB1.map((n) => n.branchId)))
await sleep(30)
getBranchTree(storyB.storyId)
const mtime2 = fs.statSync(storyBranchesPath(storyB.storyId)).mtimeMs
check('A-14 第二次不再写盘（mtime 不变）', mtime1 === mtime2, mtime1 + ' vs ' + mtime2)

/* ══════════════════════ A-15…A-17：删分支三道拒绝（storyC） ══════════════════════ */
const storyC = makeStory(store, 'P6 删分支')
const rootC = makeRootSession(chatService, storyC.storyId, 10, 'c')
const branchB = deriveBranch({ storyId: storyC.storyId, fromSessionId: rootC.id, fromMessageId: 'c4', title: 'B' })
const bSession = chatService.listSessionsByStory(storyC.storyId).find((session) => session.id === branchB.sessionId)
const branchC = deriveBranch({
  storyId: storyC.storyId,
  fromSessionId: branchB.sessionId,
  fromMessageId: bSession.messages[1].id,
  title: 'C'
})

// A-15：删活跃分支 → 抛，文件一字节没动
const bytesBefore = fs.readFileSync(storyBranchesPath(storyC.storyId), 'utf8')
let a15Threw = false
try {
  deleteBranch(storyC.storyId, branchC.sessionId)
} catch {
  a15Threw = true
}
const bytesAfter = fs.readFileSync(storyBranchesPath(storyC.storyId), 'utf8')
check('A-15 删活跃分支抛错且文件未动', a15Threw && bytesBefore === bytesAfter, 'threw=' + a15Threw)

// A-16：删有子分支的 B → 抛
let a16Threw = false
try {
  deleteBranch(storyC.storyId, branchB.sessionId)
} catch {
  a16Threw = true
}
check('A-16 删有子分支的分支抛错', a16Threw)

// A-17：叶子且非活跃 → 成功，会话也没了，其它一条不少
const leaf = deriveBranch({ storyId: storyC.storyId, fromSessionId: rootC.id, fromMessageId: 'c7', title: '叶子' })
switchBranch(storyC.storyId, rootC.id)
const idsBefore = new Set(chatService.listSessionsByStory(storyC.storyId).map((session) => session.id))
deleteBranch(storyC.storyId, leaf.sessionId)
const idsAfter = new Set(chatService.listSessionsByStory(storyC.storyId).map((session) => session.id))
const fileC = readBranches(storyC.storyId)
const expectRemain = [rootC.id, branchB.sessionId, branchC.sessionId]
check(
  'A-17 删叶子非活跃成功：树里没了、会话没了、其它一条不少',
  !fileC.branches.some((branch) => branch.branchId === leaf.sessionId) &&
    !idsAfter.has(leaf.sessionId) &&
    expectRemain.every((id) => idsAfter.has(id)) &&
    idsAfter.size === idsBefore.size - 1,
  JSON.stringify({ after: [...idsAfter], branches: fileC.branches.map((b) => b.branchId) })
)

/* ══════════════════════ A-03 / A-04：归一化与原子写（独立临时目录） ══════════════════════ */
const normDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-branch-norm-'))
const idN = 'story_norm_abcdef'
const normStore = new BranchStore(normDir)
const normFile = path.join(normDir, idN, 'branches.json')
fs.mkdirSync(path.join(normDir, idN), { recursive: true })

fs.writeFileSync(normFile, '{ "version": 1, "branches": [', 'utf8')
check('A-03 截断 JSON 不抛且读回 null', normStore.read(idN) === null)

fs.writeFileSync(normFile, JSON.stringify({ version: 2, activeBranchId: 'x', branches: [{ branchId: 'x' }] }), 'utf8')
check('A-03 version≠1 读回 null', normStore.read(idN) === null)

fs.writeFileSync(normFile, JSON.stringify({ version: 1, activeBranchId: 'x', branches: [] }), 'utf8')
check('A-03 空数组读回 null', normStore.read(idN) === null)

fs.writeFileSync(
  normFile,
  JSON.stringify({ version: 1, activeBranchId: 'A', branches: [{ branchId: 'A', parentBranchId: 'A', parentMessageId: 'm', createdAt: 1, title: 'A' }] }),
  'utf8'
)
const cyc = normStore.read(idN)
check('A-03 自环挂到根（parentBranchId 变 null）', cyc && cyc.branches[0].parentBranchId === null, JSON.stringify(cyc && cyc.branches[0]))

fs.writeFileSync(
  normFile,
  JSON.stringify({
    version: 1,
    activeBranchId: 'ghost',
    branches: [
      { branchId: 'A', parentBranchId: null, parentMessageId: null, createdAt: 1, title: 'A' },
      { branchId: 'A', parentBranchId: null, parentMessageId: null, createdAt: 2, title: 'A2' },
      { branchId: 'B', parentBranchId: 'missing', parentMessageId: 'm', createdAt: 3, title: 'B' }
    ]
  }),
  'utf8'
)
const dup = normStore.read(idN)
check(
  'A-03 重复 id 保留第一条 + 悬空父挂根 + active 回落第一条',
  dup && dup.branches.length === 2 && dup.branches[0].title === 'A' && dup.branches[1].parentBranchId === null && dup.activeBranchId === 'A',
  JSON.stringify(dup && { n: dup.branches.length, active: dup.activeBranchId, b1: dup.branches[1] })
)

// A-04 原子写：成功后 tmp 不存在
const idAtomic = 'story_atom_abcdef'
normStore.write(idAtomic, { version: 1, activeBranchId: 'R', branches: [{ branchId: 'R', parentBranchId: null, parentMessageId: null, createdAt: 1, title: 'R' }] })
check(
  'A-04 原子写：成功后 tmp 文件不存在、目标可 parse',
  !fs.existsSync(path.join(normDir, idAtomic, 'branches.json') + '.tmp') &&
    JSON.parse(fs.readFileSync(path.join(normDir, idAtomic, 'branches.json'), 'utf8')).activeBranchId === 'R'
)

/* ══════════════════════ A-18…A-21 + 补充：分支记忆可见性（storyD） ══════════════════════ */
const storyD = makeStory(store, 'P6 可见性')
const rootD = makeRootSession(chatService, storyD.storyId, 15, 'd')
const bD = deriveBranch({ storyId: storyD.storyId, fromSessionId: rootD.id, fromMessageId: 'd4', title: 'B' })
const bDSession = chatService.listSessionsByStory(storyD.storyId).find((session) => session.id === bD.sessionId)
const cD = deriveBranch({
  storyId: storyD.storyId,
  fromSessionId: bD.sessionId,
  fromMessageId: bDSession.messages[2].id,
  title: 'C'
})

const scopeD = storyScope(storyD.storyId)
const mstore = new MemoryStore(storyDbPath(storyD.storyId))
const svc = new MemoryService(mstore)
const putFact = (content, sourceSessionId, sourceMessageIndex) =>
  mstore.upsert({ content, scopeId: scopeD, sourceSessionId, sourceMessageIndex, weight: 1 })

putFact('她怕水', rootD.id, 2) // 分叉点(4)之前 → B 可见
putFact('镇上有个钟楼', rootD.id, 12) // 分叉点(4)之后 → B 不可见
putFact('我叫小明', bD.sessionId, 4) // B 自己 → B 可见
putFact('她讨厌蛇', bD.sessionId, 4) // B 的、在 C 分叉点(2)之后 → C 不可见
putFact('手工添加的记忆', null, null) // A-19b：sourceSessionId null → 全可见
putFact('老故事记忆', rootD.id, null) // A-18b：有来源没下标 → 全可见

const block = (branchId, query, visible) =>
  svc.buildContextBlock(query, SETTINGS, [scopeD], visible)

const visB = branchVisibility(storyD.storyId, bD.sessionId).visible
const visC = branchVisibility(storyD.storyId, cD.sessionId).visible

const bWater = await block(bD.sessionId, '怕水', visB)
check('A-18 分叉点之前的事实：B 命中「怕水」', bWater.includes('她怕水'), bWater.replace(/\n/g, ' | ') || '(空)')

const bTower = await block(bD.sessionId, '钟楼', visB)
check('A-19 分叉点之后的事实：B 召回 0 条（不含「钟楼」）', !bTower.includes('钟楼'), bTower.replace(/\n/g, ' | ') || '(空)')

const bSelf = await block(bD.sessionId, '小明', visB)
check('A-20 自己这条线的事实：B 命中「小明」', bSelf.includes('我叫小明'), bSelf.replace(/\n/g, ' | ') || '(空)')

const cSnake = await block(cD.sessionId, '讨厌', visC)
const cWater = await block(cD.sessionId, '怕水', visC)
check('A-21 其它分支的事实：C 召回 0 条（不含「讨厌蛇」）', !cSnake.includes('讨厌蛇'), cSnake.replace(/\n/g, ' | ') || '(空)')
check('A-21 对照物：C 仍命中分叉链内的事实「怕水」', cWater.includes('她怕水'), cWater.replace(/\n/g, ' | ') || '(空)')

// 补充断言
const bOld = await block(bD.sessionId, '老故事记忆', visB)
check('A-18b 老记忆（sourceMessageIndex=null）对所有分支可见', bOld.includes('老故事记忆'), bOld.replace(/\n/g, ' | ') || '(空)')

const bManual = await block(bD.sessionId, '手工添加', visB)
check('A-19b 手工记忆（sourceSessionId=null）对所有分支可见', bManual.includes('手工添加的记忆'), bManual.replace(/\n/g, ' | ') || '(空)')

const bNoVisible = await block(bD.sessionId, '钟楼', undefined)
check('A-20b 非故事区不传 visible：召回与 P5 逐字一致（仍能命中「钟楼」）', bNoVisible.includes('钟楼'), bNoVisible.replace(/\n/g, ' | ') || '(空)')

// A-21b：环不死循环
const storyE = makeStory(store, 'P6 环')
const rootE = makeRootSession(chatService, storyE.storyId, 2, 'e')
fs.writeFileSync(
  storyBranchesPath(storyE.storyId),
  JSON.stringify({
    version: 1,
    activeBranchId: 'A',
    branches: [
      { branchId: 'A', parentBranchId: 'B', parentMessageId: 'x', createdAt: 1, title: 'A' },
      { branchId: 'B', parentBranchId: 'A', parentMessageId: 'y', createdAt: 2, title: 'B' }
    ]
  }),
  'utf8'
)
const t0 = Date.now()
const visCycle = branchVisibility(storyE.storyId, 'A')
const elapsed = Date.now() - t0
check('A-21b 环不死循环（100ms 内返回）', elapsed < 100 && typeof visCycle.visible === 'function', elapsed + 'ms')

mstore.close()
done()
