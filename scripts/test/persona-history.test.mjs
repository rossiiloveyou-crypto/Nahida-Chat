/**
 * P3 回归套件：会话锚定 + 人设历史（D4 / D7 / D8）。
 *
 * 测的是**身份与写入**，不是模型质量：每条否定断言都配一个正向对照物（P17），
 * 因为一个「永远不写」的坏实现也能让所有「没写进别处」的断言全绿。
 *
 * 桩掉：rag 门面的 embedder 与 LLM 抽取（真模型会拖几分钟）。
 * 不桩 MemoryStore / MemoryService / chatService —— 被测的就是它们。
 *
 * 跑法：node scripts/test/persona-history.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModuleWithStubs, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-persona-history-'))
installElectronStub(userData)

// 记忆开着（否则 chatService 直接跳过召回/抽取）；摘要关掉：它是用户的功能，不在本套件判据面
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    memory: { enabled: true, autoExtract: true },
    summary: { enabled: false }
  }),
  'utf8'
)

/* ── 桩：embedder / extract。🔴 必须走 bundleModuleWithStubs（I19：alias 会抢在 onResolve 之前） ── */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-persona-history-stubs-'))
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
fs.writeFileSync(
  extractStub,
  [
    'export async function extractMemories(userText: string) {',
    '  return ["事实:" + String(userText).slice(0, 24)]',
    '}'
  ].join('\n'),
  'utf8'
)

const mod = await bundleModuleWithStubs(
  'persona-history',
  [
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { HeadlessSink } from '${p('src/main/features/chat/sink.ts')}'`,
    `export { QqSink } from '${p('src/main/features/qq/sink.ts')}'`,
    `export { memoryService } from '${p('src/main/features/rag/index.ts')}'`,
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`
  ],
  { './embedder': embedderStub, './extract': extractStub }
)
const { chatService, HeadlessSink, QqSink, memoryService, MemoryStore } = mod

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等后台抽取落地（它是 fire-and-forget，不能只 sleep 一拍） */
async function waitFor(fn, ms = 4000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < ms) {
    if (fn()) return true
    await sleep(25)
  }
  return false
}

const store = new MemoryStore()
const memoryRowsOf = (sessionId) =>
  store.list().filter((row) => row.sourceSessionId === sessionId)

/* ── 场景夹具：一个桌面会话 + 三个渠道会话 ───────────────────────────── */

const TEXT_A = '我叫小P，住在上海，平时喜欢喝手冲咖啡'
const TEXT_B = '我叫小Q，我在杭州做设计工作，最近在学陶艺'
const TEXT_C = '我叫小R，这是我第一次跟你说话，请多关照'
/*
 * 🔴 桌面那一路必须用**另一句话**：如果和渠道发同一句，T-02 / T-04 的
 *    「root 里不含她的事实」就会被自家对照物弄成假红（实测踩过一次）。
 */
const TEXT_DESKTOP = '这台机器的主人喜欢在深夜写代码，习惯泡一壶普洱'

const desktopSession = chatService.createSession({ mode: 'chat' })
const alicePrivate = chatService.ensureChannelSession('qq:10001:private:20001', { title: '私聊A' })
const bobGroup = chatService.ensureChannelSession('qq:10002:group:88888', { title: '群B' })
const carolPrivate = chatService.ensureChannelSession('qq:10003:private:20003', { title: '私聊C' })

const broadcast = () => {}
const sendAs = async (session, text, sink) =>
  chatService.sendAwait({ sessionId: session.id, content: text }, sink)

/* ── 第 1 组：身份解析（T-01 … T-04） ──────────────────────────────── */

console.log('T-01…T-04 发送者解析：渠道走发言人、桌面走 root')
const outAlice = await sendAs(alicePrivate, TEXT_A, new QqSink(broadcast, '10001'))
check('T-01 渠道会话跑完', outAlice.status === 'done', outAlice.status)
check(
  'T-01 记忆落 10001/default',
  await waitFor(() => memoryRowsOf(alicePrivate.id).length > 0) &&
    memoryRowsOf(alicePrivate.id).every((row) => row.userId === '10001' && row.personaId === 'default'),
  JSON.stringify(memoryRowsOf(alicePrivate.id).map((row) => row.userId + '/' + row.personaId))
)
// 对照物：桌面那一路必须先证明「能写进去」，否则下面的「没写进 root」恒真（P17）
const outDesktop = await sendAs(desktopSession, TEXT_DESKTOP, new HeadlessSink())
check('T-03 桌面会话跑完', outDesktop.status === 'done', outDesktop.status)
check(
  'T-03 对照物：桌面记忆落 root/default',
  await waitFor(() => memoryRowsOf(desktopSession.id).length > 0) &&
    memoryRowsOf(desktopSession.id).every((row) => row.userId === 'root' && row.personaId === 'default'),
  JSON.stringify(memoryRowsOf(desktopSession.id).map((row) => row.userId + '/' + row.personaId))
)
const rootAll = store.listByTenant('root', 'default')
const aliceAll = store.listByTenant('10001', 'default')
check(
  'T-02 反向：10001 的话没有落进 root/default（root 里不含「手冲」）',
  rootAll.length > 0 && rootAll.every((row) => !row.content.includes('手冲')),
  rootAll.map((row) => row.content).join(' | ')
)
check(
  'T-04 反向：桌面的话没有落进 10001/default（10001 里不含「普洱」）',
  aliceAll.length > 0 && aliceAll.every((row) => !row.content.includes('普洱')),
  aliceAll.map((row) => row.content).join(' | ')
)

/* ── 第 2 组：fail-safe（T-05） ────────────────────────────────────── */

console.log('T-05 渠道会话但取不到发言人 → 回落 root（不写孤儿行）')
const noSender = chatService.ensureChannelSession('qq:10009:private:29999', { title: '无发言人' })
await sendAs(noSender, TEXT_C, new QqSink(broadcast, ''))
check(
  'T-05 空 senderId 的渠道会话落 root/default',
  await waitFor(() => memoryRowsOf(noSender.id).length > 0) &&
    memoryRowsOf(noSender.id).every((row) => row.userId === 'root'),
  JSON.stringify(memoryRowsOf(noSender.id).map((row) => row.userId + '/' + row.personaId))
)
check(
  'T-05 反向：库里没有 userId 为空串的孤儿行',
  store.list().every((row) => row.userId.trim().length > 0 && row.personaId.trim().length > 0),
  store.list().map((row) => JSON.stringify(row.userId)).join(',')
)

/* ── 第 3 组：自动注册（T-06 / T-07 / D4） ──────────────────────────── */

console.log('T-06 / T-07 新用户自动注册 default 且激活，重复调用幂等')
// 先让 10003 真的说一句话：注册发生在解析身份的那一刻，没发消息就没注册（这正是 D4 的语义）
check('T-06 前置：10003 说话前没有注册记录', store.listPersonas('10003').length === 0, store.listPersonas('10003').length)
await sendAs(carolPrivate, TEXT_C, new QqSink(broadcast, '10003'))
await waitFor(() => store.listPersonas('10003').length > 0)
const carolPersonas = store.listPersonas('10003')
check(
  'T-06 新用户 10003 自动注册 default',
  carolPersonas.length === 1 && carolPersonas[0].personaId === 'default',
  JSON.stringify(carolPersonas)
)
check('T-06 且该人设是激活态', carolPersonas[0]?.isActive === true, JSON.stringify(carolPersonas[0]))
check('T-06 库内 activePersona 与之一致', memoryService.activePersona('10003') === 'default', memoryService.activePersona('10003'))

await sendAs(carolPrivate, TEXT_C + '，这是第二句', new QqSink(broadcast, '10003'))
const carolPersonas2 = store.listPersonas('10003')
check('T-07 第二次说话后仍然只有 1 行（幂等）', carolPersonas2.length === 1, carolPersonas2.length)
const activeCount = store.listPersonas('10003').filter((row) => row.isActive).length
check('T-07 同一用户同一时刻只有 1 个激活人设', activeCount === 1, activeCount)

/* ── 第 4 组：人设历史（T-08 … T-13） ──────────────────────────────── */

console.log('T-08 / T-09 一轮正常对话写 2 条历史（user + assistant）')
const aliceHistory = store.recentHistory('10001', 'default', 20)
check('T-08 10001/default 有 2 条历史', aliceHistory.length === 2, aliceHistory.length)
check(
  'T-09 role 分别是 assistant / user（倒序）',
  aliceHistory[0]?.role === 'assistant' && aliceHistory[1]?.role === 'user',
  aliceHistory.map((row) => row.role).join(',')
)
check(
  'T-09 user 那条的正文与本轮一致',
  aliceHistory[1]?.content === TEXT_A,
  JSON.stringify(aliceHistory[1]?.content)
)
check(
  'T-09 assistant 那条非空（证明真的写了成品）',
  (aliceHistory[0]?.content ?? '').length > 0,
  JSON.stringify(aliceHistory[0]?.content)
)

console.log('T-10 / T-11 chatType 与 chatId 由会话 id 解析')
const desktopHistory = store.recentHistory('root', 'default', 30)
const desktopEntry = desktopHistory.find((row) => row.sessionId === desktopSession.id)
const privateEntry = aliceHistory.find((row) => row.sessionId === alicePrivate.id)
const groupEntry = (await (async () => {
  await sendAs(bobGroup, TEXT_B, new QqSink(broadcast, '10002'))
  await waitFor(() => store.recentHistory('10002', 'default', 10).length >= 2)
  return store.recentHistory('10002', 'default', 10)
})()).find((row) => row.sessionId === bobGroup.id)

check('T-10 桌面 → desktop', desktopEntry?.chatType === 'desktop', desktopEntry?.chatType)
check('T-10 私聊 → private', privateEntry?.chatType === 'private', privateEntry?.chatType)
check('T-10 群聊 → group', groupEntry?.chatType === 'group', groupEntry?.chatType)
check('T-11 桌面 chatId 为 null', desktopEntry?.chatId === null, String(desktopEntry?.chatId))
check('T-11 私聊 chatId = 会话 id 第四段', privateEntry?.chatId === '20001', privateEntry?.chatId)
check('T-11 群聊 chatId = 会话 id 第四段', groupEntry?.chatId === '88888', groupEntry?.chatId)

console.log('T-12 / T-13 aborted / error 只写 user 一条')
const abortSession = chatService.ensureChannelSession('qq:10004:private:20004', { title: '中止' })
void sendAs(abortSession, '这句话说到一半就被停掉了', new QqSink(broadcast, '10004'))
await sleep(30)
chatService.stop(abortSession.id)
await waitFor(() => store.recentHistory('10004', 'default', 10).length >= 1)
await sleep(200)
const abortHistory = store.recentHistory('10004', 'default', 10)
check(
  'T-12 中止的一轮只写 user 一条',
  abortHistory.length === 1 && abortHistory[0].role === 'user',
  abortHistory.map((row) => row.role).join(',') || '(空)'
)
check(
  'T-12 对照物：这一轮确实被中止过（user 那条已落库）',
  abortHistory[0]?.content === '这句话说到一半就被停掉了',
  JSON.stringify(abortHistory[0]?.content)
)

/*
 * T-13 error：让 provider 抛错。
 * 用「没有工作区的 Agent 模式会话」触发 toolScopeOf 的显式抛错路径 —— 那是既有的真实错误源，
 * 不用为测试造一个假 provider。
 */
const errorSession = chatService.createSession({ mode: 'agent' })
void sendAs(errorSession, '看看工作区里有什么文件', new HeadlessSink())
await sleep(500)
const errorHistory = store.recentHistory('root', 'default', 40).filter((row) => row.sessionId === errorSession.id)
check(
  'T-13 出错的一轮不写 assistant',
  errorHistory.every((row) => row.role === 'user'),
  errorHistory.map((row) => row.role).join(',') || '(空)'
)

/* ── 第 5 组：切换人设（T-14 / T-15 / A-08） ────────────────────────── */

console.log('T-14 / T-15 切换激活人设后，历史与记忆都进新人设，旧人设条数不变')
const defaultBefore = store.recentHistory('10001', 'default', 100).length
const defaultMemoryBefore = store.listByTenant('10001', 'default').length
store.upsertPersona('10001', 'work', true)
check('T-14 切换后激活人设是 work', memoryService.activePersona('10001') === 'work', memoryService.activePersona('10001'))
check('T-14 守恒：10001 只有 1 个激活人设', store.listPersonas('10001').filter((row) => row.isActive).length === 1)

const workSession = chatService.ensureChannelSession('qq:10001:private:20001b', { title: '工作' })
await sendAs(workSession, '这是我在工作人设下说的话，请记住我在做陶艺', new QqSink(broadcast, '10001'))
check(
  'T-14 新历史进 work',
  await waitFor(() => store.recentHistory('10001', 'work', 10).length >= 2),
  store.recentHistory('10001', 'work', 10).length
)
check(
  'T-14 守恒：default 的历史条数没变',
  store.recentHistory('10001', 'default', 100).length === defaultBefore,
  store.recentHistory('10001', 'default', 100).length + ' vs ' + defaultBefore
)
check(
  'T-15 记忆也跟着进 work',
  await waitFor(() => store.listByTenant('10001', 'work').length > 0),
  store.listByTenant('10001', 'work').length
)
check(
  'T-15 守恒：default 的记忆条数没变',
  store.listByTenant('10001', 'default').length === defaultMemoryBefore,
  store.listByTenant('10001', 'default').length + ' vs ' + defaultMemoryBefore
)

/* ── 第 6 组：双向隔离（T-16） ─────────────────────────────────────── */

console.log('T-16 两个发送者互不可见（含正反两向 + 对照物）')
const block10001 = await memoryService.buildContextBlock('手冲咖啡', { enabled: true, topK: 5, budgetTokens: 1200, minScore: 0 }, [
  { userId: '10001', personaId: 'default' }
])
const block10002 = await memoryService.buildContextBlock('手冲咖啡', { enabled: true, topK: 5, budgetTokens: 1200, minScore: 0 }, [
  { userId: '10002', personaId: 'default' }
])
check('T-16 对照物：10001 能召回自己的「手冲」', block10001.includes('手冲'), block10001.replace(/\n/g, ' | ') || '(空)')
check('T-16 10002 的召回里没有 10001 的事实', !block10002.includes('手冲'), block10002.replace(/\n/g, ' | ') || '(空)')
const block10002own = await memoryService.buildContextBlock('设计', { enabled: true, topK: 5, budgetTokens: 1200, minScore: 0 }, [
  { userId: '10002', personaId: 'default' }
])
check('T-16 对照物：10002 能召回自己的「设计」', block10002own.includes('设计'), block10002own.replace(/\n/g, ' | ') || '(空)')

/* ── 第 7 组：落盘与幂等（T-17 / T-18 / T-20） ──────────────────────── */

console.log('T-17 / T-18 / T-20 读盘复核：历史真的落库、id 幂等、倒序 + limit')
const disk = new MemoryStore()
const diskHistory = disk.recentHistory('10001', 'default', 10)
check('T-17 重开 MemoryStore 后历史仍在（读盘不是读内存）', diskHistory.length >= 2, diskHistory.length)
check(
  'T-17 落盘行的租户字段是真值',
  diskHistory.every((row) => row.userId === '10001' && row.personaId === 'default'),
  diskHistory.map((row) => row.userId + '/' + row.personaId).join(',')
)
const oneEntry = diskHistory[diskHistory.length - 1]
const beforeDup = disk.recentHistory('10001', 'default', 100).length
disk.appendHistory(oneEntry)
check(
  'T-18 同一条消息写两次仍只有 1 行（INSERT OR REPLACE）',
  disk.recentHistory('10001', 'default', 100).length === beforeDup,
  disk.recentHistory('10001', 'default', 100).length + ' vs ' + beforeDup
)
check(
  'T-20 recentHistory 倒序：第一条比第二条更新',
  diskHistory[0].createdAt >= diskHistory[diskHistory.length - 1].createdAt,
  diskHistory.map((row) => String(row.createdAt)).join(',')
)
check('T-20 limit 生效：limit=1 只回 1 条', disk.recentHistory('10001', 'default', 1).length === 1, disk.recentHistory('10001', 'default', 1).length)
disk.close()
store.close()

/* ── 第 8 组：故事区（T-19） ───────────────────────────────────────── */

console.log('T-19 故事会话：库仍是 stories/<id>/memory.db，库内租户 = 真实发送者')
const { StoryStore } = await bundleModuleWithStubs(
  'persona-history-story',
  [`export { StoryStore } from '${p('src/main/features/story/store.ts')}'`],
  {}
)
const storyStore = new StoryStore()
const story = storyStore.create({ title: 'P3 故事', characterId: 'nahida' }, { characterId: 'nahida' })
const storyDb = path.join(userData, 'stories', story.storyId, 'memory.db')

// ① 桌面故事会话：库换皮、租户不变（= root/default）—— 这是 H-12 的人工期望值
const storySession = chatService.createSession({ mode: 'chat', storyId: story.storyId })
const storyOutcome = await sendAs(storySession, '故事里她在花园里种了一株向日葵', new HeadlessSink())
check('T-19 桌面故事会话跑完', storyOutcome.status === 'done', storyOutcome.status)
check('T-19 故事库路径在 stories/<id>/ 下', fs.existsSync(storyDb), storyDb)
const storyDisk = new MemoryStore(storyDb)
check(
  'T-19 桌面故事会话的库内租户 = root/default（与桌面主库一致）',
  await waitFor(() => storyDisk.list().length > 0) &&
    storyDisk.list().every((row) => row.userId === 'root' && row.personaId === 'default'),
  storyDisk.list().map((row) => row.userId + '/' + row.personaId).join(',') || '(空)'
)
check(
  'T-19 主库里没有被这条故事消息污染（故事记忆进的是故事库）',
  (() => {
    const main = new MemoryStore()
    const polluted = main.list().some((row) => row.content.includes('向日葵'))
    main.close()
    return !polluted
  })(),
  '向日葵'
)

// ② 渠道故事会话：同一个故事库，但库内租户换成真实发送者
const storyChannel = chatService.createSession({
  mode: 'chat',
  storyId: story.storyId,
  id: 'qq:10007:private:20007',
  title: '故事群'
})
await sendAs(storyChannel, '故事里她给向日葵搭了一个木架子', new QqSink(broadcast, '10007'))
check(
  'T-19 渠道故事会话的库内租户 = 真实发送者 10007/default',
  await waitFor(() => storyDisk.list().some((row) => row.userId === '10007')),
  storyDisk.list().map((row) => row.userId + '/' + row.personaId).join(',') || '(空)'
)
check(
  'T-19 双向：root 那条没有被改写成 10007',
  storyDisk.list().some((row) => row.userId === 'root'),
  storyDisk.list().map((row) => row.userId).join(',')
)
storyDisk.close()

/* ── 第 9 组：不阻塞（A-11） ─────────────────────────────────────── */

console.log('A-11 历史写入同步且落在回复链终点（不是中途 await、也不是 fire-and-forget）')
const timedSession = chatService.ensureChannelSession('qq:10008:private:20008', { title: '计时' })
await sendAs(timedSession, '这句话只是用来量一次整轮耗时，没有别的意思', new QqSink(broadcast, '10008'))
/*
 * 🔴 判据不是「快不快」，而是「sendAwait 一返回，历史就已经在盘上」。
 *
 * recordHistory 写在 runStream 的 finally 里、同步调用；而 turn promise 要等 finally 跑完
 * 才 resolve 到 sendAwait。所以**不用 waitFor 轮询**也能立刻读到 2 条 ——
 * 这一条同时证明了三件事：① 它是同步写（不是 fire-and-forget）；
 * ② 它在回复链的**终点**而不是中途（不会拖慢流式输出）；
 * ③ 它没有被 await 成一个新的异步回合（否则这里读不到，且耗时会被拉长）。
 *
 * 用计时阈值判「不阻塞」是不可靠的（机器负载、mock 分片数都会漂），所以不写阈值。
 */
const verifyStore = new MemoryStore()
const immediate = verifyStore.recentHistory('10008', 'default', 10)
check(
  'A-11 sendAwait 返回时历史已落库（同步写，不轮询）',
  immediate.length >= 2,
  immediate.length
)
check(
  'A-11 对照物：这 2 条确实是 user + assistant',
  immediate[0]?.role === 'assistant' && immediate[1]?.role === 'user',
  immediate.map((row) => row.role).join(',')
)
verifyStore.close()

done()
