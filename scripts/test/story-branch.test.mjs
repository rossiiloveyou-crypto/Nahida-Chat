/**
 * 故事分支（P6 修订：**分支独立**）+ 分支记忆可见性 —— A-01…A-21 + N-01…N-05。
 *
 * 这一版测的是改过的契约：
 *  - branches.json 是**扁平列表**（version 2），节点上没有 parentBranchId / children
 *  - 派生来源只以 forkedFrom 快照存在；删掉源分支后子分支照常工作（N-01 是本轮的核心）
 *  - 记忆可见范围在派生时固化成 memoryBounds 快照，召回不再沿父链上溯
 *  - 删分支只有两条拒绝：不存在 / 最后一条；删当前分支是被允许的，会自动换活跃指针
 *  - v1 老文件（parentBranchId 那套）读时迁移成 v2，且迁移前后可见性逐字一致
 *
 * 测的是真实边界：真落 branches.json（真 fs）、真派生会话、真走 chatService；
 * 记忆可见性走**真实** MemoryService + 真实 MemoryStore（embedder/extract 桩掉）。
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
  'story-branch',
  [
    "export { deriveBranch, deleteBranch, listStoryBranches, switchBranch, listStories, createStory } from '" + p('src/main/features/story/service.ts') + "'",
    "export { BranchStore, branchStore, normalizeBranches } from '" + p('src/main/features/story/branches.ts') + "'",
    "export { branchVisibility } from '" + p('src/main/features/story/visibility.ts') + "'",
    "export { chatService } from '" + p('src/main/features/chat/chatService.ts') + "'",
    "export { StoryStore } from '" + p('src/main/features/story/store.ts') + "'",
    "export { storiesRoot, storyBranchesPath, storyDbPath } from '" + p('src/main/features/story/paths.ts') + "'",
    "export { storyScope } from '" + p('src/main/features/story/route.ts') + "'",
    "export { MemoryService } from '" + p('src/main/features/rag/index.ts') + "'",
    "export { MemoryStore } from '" + p('src/main/features/rag/store.ts') + "'"
  ].join('\n'),
  [plugin]
)
const {
  deriveBranch,
  deleteBranch,
  listStoryBranches,
  switchBranch,
  listStories,
  BranchStore,
  branchStore,
  normalizeBranches,
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
const readBranches = (storyId) => JSON.parse(fs.readFileSync(storyBranchesPath(storyId), 'utf8'))
const branchOf = (storyId, branchId) =>
  listStoryBranches(storyId).find((branch) => branch.branchId === branchId)
const sessionIds = (storyId) => chatService.listSessionsByStory(storyId).map((item) => item.id)

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
check(
  'A-01 branches.json 存在且可 parse、version===2、branches 是数组',
  fileA.version === 2 && Array.isArray(fileA.branches),
  JSON.stringify({ version: fileA.version, n: fileA.branches.length })
)

// A-02：新节点是「扁平 + 两张快照」，没有 parentBranchId
const nodeA = fileA.branches.find((branch) => branch.branchId === derived.sessionId)
check(
  'A-02 新节点字段齐（branchId/title/createdAt/forkedFrom），且**没有** parentBranchId',
  Boolean(nodeA) &&
    typeof nodeA.branchId === 'string' &&
    typeof nodeA.title === 'string' &&
    typeof nodeA.createdAt === 'number' &&
    Object.prototype.hasOwnProperty.call(nodeA, 'parentBranchId') === false,
  JSON.stringify(nodeA)
)

// A-02b：派生来源是快照（id + 标题 + 第几条）
check(
  'A-02b forkedFrom 快照 = 源分支 id / 源标题 / 第 5 条（idx 4 + 1）/ 消息 id',
  Boolean(nodeA.forkedFrom) &&
    nodeA.forkedFrom.branchId === rootA.id &&
    nodeA.forkedFrom.title === '根分支' &&
    nodeA.forkedFrom.messageNumber === 5 &&
    nodeA.forkedFrom.messageId === 'a4',
  JSON.stringify(nodeA.forkedFrom)
)

// A-02c：记忆可见范围在派生时就固化下来
const boundsA = new Map((nodeA.memoryBounds || []).map((item) => [item.branchId, item.maxMessageIndex]))
check(
  'A-02c memoryBounds 快照 = 自己无上界 + 源分支在上标 4',
  boundsA.get(derived.sessionId) === null && boundsA.get(rootA.id) === 4,
  JSON.stringify(nodeA.memoryBounds)
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

// A-13：扁平列表（这是 P6 修订最直接的一条：节点上不该有任何树结构）
const listA = listStoryBranches(storyA.storyId)
const activeA = listA.filter((item) => item.isActive)
check(
  'A-13 扁平列表：两行、没有 children、isActive 恰好一个',
  listA.length === 2 &&
    listA.every((item) => Object.prototype.hasOwnProperty.call(item, 'children') === false) &&
    activeA.length === 1 &&
    activeA[0].branchId === derived.sessionId,
  JSON.stringify({ n: listA.length, active: activeA.map((i) => i.branchId) })
)

/* ══════════════════════ A-14：懒迁移幂等（storyB） ══════════════════════ */
const storyB = makeStory(store, 'P6 懒迁移')
const rootB = makeRootSession(chatService, storyB.storyId, 3, 'b')
check('A-14 前置：一开始没有 branches.json', !fs.existsSync(storyBranchesPath(storyB.storyId)), 'ABSENT')
const listB1 = listStoryBranches(storyB.storyId)
const mtime1 = fs.statSync(storyBranchesPath(storyB.storyId)).mtimeMs
check(
  'A-14 第一次产出单行根分支并写回（version 2）',
  listB1.length === 1 && listB1[0].branchId === rootB.id && readBranches(storyB.storyId).version === 2,
  JSON.stringify(listB1.map((n) => n.branchId))
)
await sleep(30)
listStoryBranches(storyB.storyId)
const mtime2 = fs.statSync(storyBranchesPath(storyB.storyId)).mtimeMs
check('A-14 第二次不再写盘（mtime 不变）', mtime1 === mtime2, mtime1 + ' vs ' + mtime2)

/* ══════════════════════ A-15…A-17 / N-02…N-03：删分支的新规矩（storyC） ══════════════════════ */
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
const branchE = deriveBranch({ storyId: storyC.storyId, fromSessionId: rootC.id, fromMessageId: 'c7', title: 'E' })

// N-02：删「有子分支」的分支 —— 以前被拒，现在允许（分支之间本来就没有父子关系）
let n02Error = ''
try {
  deleteBranch(storyC.storyId, branchB.sessionId)
} catch (error) {
  n02Error = error instanceof Error ? error.message : String(error)
}
const afterDeleteB = listStoryBranches(storyC.storyId)
check(
  'N-02 删掉「源分支」成功：C 仍在列表里、C 的会话没被动过',
  n02Error === '' &&
    afterDeleteB.length === 3 &&
    !afterDeleteB.some((item) => item.branchId === branchB.sessionId) &&
    afterDeleteB.some((item) => item.branchId === branchC.sessionId) &&
    sessionIds(storyC.storyId).includes(branchC.sessionId),
  n02Error || JSON.stringify(afterDeleteB.map((i) => i.branchId))
)

// A-15：删**当前**分支 → 允许，活跃指针交给剩下的里面最近活动的那条
check('A-15 前置：当前活跃分支是 E（最后派生的一条）', branchStore.read(storyC.storyId).activeBranchId === branchE.sessionId, branchStore.read(storyC.storyId).activeBranchId)
deleteBranch(storyC.storyId, branchE.sessionId)
const afterDeleteE = branchStore.read(storyC.storyId)
check(
  'A-15 删当前分支成功：活跃指针换成 C（最近活动），E 的会话没了',
  afterDeleteE.activeBranchId === branchC.sessionId &&
    !afterDeleteE.branches.some((item) => item.branchId === branchE.sessionId) &&
    !sessionIds(storyC.storyId).includes(branchE.sessionId),
  JSON.stringify({ active: afterDeleteE.activeBranchId, want: branchC.sessionId })
)

// A-17：再删一条（当前的 C）→ 只剩 rootC，会话同步少一条
const beforeA17 = listStoryBranches(storyC.storyId).length
const sessionsBeforeA17 = sessionIds(storyC.storyId).length
deleteBranch(storyC.storyId, branchC.sessionId)
const afterA17 = listStoryBranches(storyC.storyId)
check(
  'A-17 删到只剩一条：列表 1 行、会话 1 条、活跃指针指向 rootC',
  afterA17.length === 1 &&
    afterA17[0].branchId === rootC.id &&
    afterA17[0].isActive &&
    sessionIds(storyC.storyId).length === sessionsBeforeA17 - 1 &&
    beforeA17 === 2,
  JSON.stringify({ list: afterA17.map((i) => i.branchId), sessions: sessionIds(storyC.storyId) })
)

// N-03：最后一条不能删（唯一一条非「依赖」的拒绝：删完这个故事就没有会话可进了）
let n03Error = ''
try {
  deleteBranch(storyC.storyId, rootC.id)
} catch (error) {
  n03Error = error instanceof Error ? error.message : String(error)
}
check(
  'N-03 删最后一条被拒：抛错且文件没动',
  n03Error.includes('最后一条') && branchStore.read(storyC.storyId).branches.length === 1,
  n03Error || '(没有抛)'
)

/* ══════════════════════ A-03 / A-04：归一化、v1 迁移与原子写 ══════════════════════ */
const normDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-branch-norm-'))
const idN = 'story_norm_abcdef'
const normStore = new BranchStore(normDir)
const normFile = path.join(normDir, idN, 'branches.json')
fs.mkdirSync(path.join(normDir, idN), { recursive: true })

fs.writeFileSync(normFile, '{ "version": 2, "branches": [', 'utf8')
check('A-03 截断 JSON 不抛且读回 null', normStore.read(idN) === null)

fs.writeFileSync(normFile, JSON.stringify({ version: 3, activeBranchId: 'x', branches: [{ branchId: 'x' }] }), 'utf8')
check('A-03 version 不认识（3）读回 null', normStore.read(idN) === null)

fs.writeFileSync(normFile, JSON.stringify({ version: 2, activeBranchId: 'x', branches: [] }), 'utf8')
check('A-03 空数组读回 null', normStore.read(idN) === null)

// v1 自环：迁移后 forkedFrom 保留（快照不解析），可见范围按根处理
fs.writeFileSync(
  normFile,
  JSON.stringify({
    version: 1,
    activeBranchId: 'A',
    branches: [{ branchId: 'A', parentBranchId: 'A', parentMessageId: 'm', parentMessageIndex: 4, createdAt: 1, title: 'A' }]
  }),
  'utf8'
)
const cyc = normStore.read(idN)
check(
  'A-03b v1 自环迁移：version 升到 2、forkedFrom 保留快照、memoryBounds 只有自己且无上界',
  cyc &&
    cyc.version === 2 &&
    cyc.branches.length === 1 &&
    cyc.branches[0].forkedFrom &&
    cyc.branches[0].forkedFrom.branchId === 'A' &&
    cyc.branches[0].memoryBounds.length === 1 &&
    cyc.branches[0].memoryBounds[0].maxMessageIndex === null,
  JSON.stringify(cyc && cyc.branches[0])
)

// v1 重复 id + 悬空父 + 活跃指向幽灵
fs.writeFileSync(
  normFile,
  JSON.stringify({
    version: 1,
    activeBranchId: 'ghost',
    branches: [
      { branchId: 'A', parentBranchId: null, parentMessageId: null, createdAt: 1, title: 'A' },
      { branchId: 'A', parentBranchId: null, parentMessageId: null, createdAt: 2, title: 'A2' },
      { branchId: 'B', parentBranchId: 'missing', parentMessageId: 'm', parentMessageIndex: 2, createdAt: 3, title: 'B' }
    ]
  }),
  'utf8'
)
const dup = normStore.read(idN)
check(
  'A-03c v1 重复 id 保留第一条 + 悬空父保留为快照（不再「挂到根」）+ 活跃回落第一条',
  dup &&
    dup.branches.length === 2 &&
    dup.branches[0].title === 'A' &&
    dup.branches[1].forkedFrom.branchId === 'missing' &&
    dup.activeBranchId === 'A',
  JSON.stringify(dup && { n: dup.branches.length, active: dup.activeBranchId, b1: dup.branches[1].forkedFrom })
)

// A-04 原子写：成功后 tmp 不存在
const idAtomic = 'story_atom_abcdef'
normStore.write(idAtomic, {
  version: 2,
  activeBranchId: 'R',
  branches: [
    { branchId: 'R', title: 'R', createdAt: 1, forkedFrom: null, memoryBounds: [{ branchId: 'R', maxMessageIndex: null }] }
  ]
})
check(
  'A-04 原子写：成功后 tmp 文件不存在、目标可 parse',
  !fs.existsSync(path.join(normDir, idAtomic, 'branches.json') + '.tmp') &&
    JSON.parse(fs.readFileSync(path.join(normDir, idAtomic, 'branches.json'), 'utf8')).activeBranchId === 'R'
)

/* ══════════════════════ A-18…A-21 + N-01：分支记忆可见性（storyD） ══════════════════════ */
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

const mstore = new MemoryStore(storyDbPath(storyD.storyId))
const svc = new MemoryService(mstore)
/*
 * P1：MemoryEntry 的构造点换成租户字段（必填）。故事区的物理隔离由「一故事一库」保证。
 * P2：逻辑租户 root/default 是 chatService.memoryTenantOf() 的兜底值。
 */
const TENANT_D = { userId: 'root', personaId: 'default' }
const putFact = (content, sourceSessionId, sourceMessageIndex) =>
  mstore.upsert({ content, ...TENANT_D, sourceSessionId, sourceMessageIndex, weight: 1 })

putFact('她怕水', rootD.id, 2) // 分叉点(4)之前 → B 可见
putFact('镇上有个钟楼', rootD.id, 12) // 分叉点(4)之后 → B 不可见
putFact('我叫小明', bD.sessionId, 4) // B 自己 → B 可见
putFact('她讨厌蛇', bD.sessionId, 4) // B 的、在 C 分叉点(2)之后 → C 不可见
putFact('手工添加的记忆', null, null) // A-19b：sourceSessionId null → 全可见
putFact('老故事记忆', rootD.id, null) // A-18b：有来源没下标 → 全可见

const block = (query, visible) => svc.buildContextBlock(query, SETTINGS, [TENANT_D], visible)

const visB = branchVisibility(storyD.storyId, bD.sessionId).visible
const visC = branchVisibility(storyD.storyId, cD.sessionId).visible

const bWater = await block('怕水', visB)
check('A-18 分叉点之前的事实：B 命中「怕水」', bWater.includes('她怕水'), bWater.replace(/\n/g, ' | ') || '(空)')

const bTower = await block('钟楼', visB)
check('A-19 分叉点之后的事实：B 召回 0 条（不含「钟楼」）', !bTower.includes('钟楼'), bTower.replace(/\n/g, ' | ') || '(空)')

const bSelf = await block('小明', visB)
check('A-20 自己这条线的事实：B 命中「我叫小明」', bSelf.includes('我叫小明'), bSelf.replace(/\n/g, ' | ') || '(空)')

const cSnake = await block('讨厌', visC)
const cWater = await block('怕水', visC)
check('A-21 其它分支的事实：C 召回 0 条（不含「讨厌蛇」）', !cSnake.includes('讨厌蛇'), cSnake.replace(/\n/g, ' | ') || '(空)')
check('A-21 对照物：C 仍命中分叉链内的事实「怕水」', cWater.includes('她怕水'), cWater.replace(/\n/g, ' | ') || '(空)')

// N-01：**核心独立性** —— 删掉源分支之后，子分支的召回范围一个字节都不变
const visBBefore = JSON.stringify([...branchVisibility(storyD.storyId, bD.sessionId).bounds])
const visCBefore = JSON.stringify([...branchVisibility(storyD.storyId, cD.sessionId).bounds])
deleteBranch(storyD.storyId, rootD.id)
const afterDeleteRoot = listStoryBranches(storyD.storyId)
const visBAfter = branchVisibility(storyD.storyId, bD.sessionId).visible
const visCAfter = branchVisibility(storyD.storyId, cD.sessionId).visible
const n01Water = await block('怕水', visBAfter)
const n01CWater = await block('怕水', visCAfter)
check(
  'N-01 删掉源分支（rootD）后：B/C 仍在列表里，且可见范围与删除前逐字相同',
  afterDeleteRoot.length === 2 &&
    !afterDeleteRoot.some((item) => item.branchId === rootD.id) &&
    JSON.stringify([...branchVisibility(storyD.storyId, bD.sessionId).bounds]) === visBBefore &&
    JSON.stringify([...branchVisibility(storyD.storyId, cD.sessionId).bounds]) === visCBefore,
  JSON.stringify({ list: afterDeleteRoot.map((i) => i.branchId), before: visBBefore })
)
check(
  'N-01b 源分支删了照样召回它留下的记忆（B 命中「怕水」，C 也命中）',
  n01Water.includes('她怕水') && n01CWater.includes('她怕水'),
  JSON.stringify({ b: n01Water.replace(/\n/g, ' | '), c: n01CWater.replace(/\n/g, ' | ') })
)
const n01Tower = await block('钟楼', visBAfter)
check('N-01c 边界仍然生效：删了源分支，B 依旧召回不到分叉点之后的「钟楼」', !n01Tower.includes('钟楼'), n01Tower.replace(/\n/g, ' | ') || '(空)')

// N-05：forkedFrom 是快照 —— 源分支改名后它不变
{
  const fileD = readBranches(storyD.storyId)
  const target = fileD.branches.find((item) => item.branchId === bD.sessionId)
  const originalTitle = target.forkedFrom.title
  // 直接把 bD 自己改名，再看它记的出处有没有跟着变
  target.title = '改过名的 B'
  fs.writeFileSync(storyBranchesPath(storyD.storyId), JSON.stringify(fileD, null, 2), 'utf8')
  const reread = listStoryBranches(storyD.storyId).find((item) => item.branchId === bD.sessionId)
  check(
    'N-05 改名不影响自己记的出处（forkedFrom 是快照，不是外键）',
    reread.title === '改过名的 B' && reread.forkedFrom.title === originalTitle,
    JSON.stringify({ now: reread.title, from: reread.forkedFrom })
  )
}

// 补充断言
const bOld = await block('老故事记忆', visB)
check('A-18b 老记忆（sourceMessageIndex=null）对所有分支可见', bOld.includes('老故事记忆'), bOld.replace(/\n/g, ' | ') || '(空)')

const bManual = await block('手工添加', visB)
check('A-19b 手工记忆（sourceSessionId=null）对所有分支可见', bManual.includes('手工添加的记忆'), bManual.replace(/\n/g, ' | ') || '(空)')

const bNoVisible = await block('钟楼', undefined)
check('A-20b 非故事区不传 visible：召回与 P5 逐字一致（仍能命中「钟楼」）', bNoVisible.includes('钟楼'), bNoVisible.replace(/\n/g, ' | ') || '(空)')

// A-21b：v1 环文件不让可见性死循环
const storyE = makeStory(store, 'P6 环')
makeRootSession(chatService, storyE.storyId, 2, 'e')
fs.writeFileSync(
  storyBranchesPath(storyE.storyId),
  JSON.stringify({
    version: 1,
    activeBranchId: 'A',
    branches: [
      { branchId: 'A', parentBranchId: 'B', parentMessageId: 'x', parentMessageIndex: 1, createdAt: 1, title: 'A' },
      { branchId: 'B', parentBranchId: 'A', parentMessageId: 'y', parentMessageIndex: 1, createdAt: 2, title: 'B' }
    ]
  }),
  'utf8'
)
const t0 = Date.now()
const visCycle = branchVisibility(storyE.storyId, 'A')
const elapsed = Date.now() - t0
check('A-21b v1 环文件：可见性不死循环（100ms 内返回）', elapsed < 100 && typeof visCycle.visible === 'function', elapsed + 'ms')

// 归属守卫：故事区的 branchId 只可能来自本区会话
check(
  'N-06 分支 id 与故事会话一一对应（列表里的每个 id 都能查到会话）',
  listStoryBranches(storyD.storyId).every((item) => sessionIds(storyD.storyId).includes(item.branchId)),
  JSON.stringify(listStoryBranches(storyD.storyId).map((i) => i.branchId))
)

mstore.close()
done()