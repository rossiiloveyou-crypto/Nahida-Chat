/**
 * P5 判据 `MP-nn`：按人聚合的记忆面板（数据层 + 摘要层）。
 *
 * 测的是**真实边界**，不是「把实现再写一遍」：
 * - 按人列表是三类来源的**并集**（有记忆 / 有人设行 / 只在 access.json）
 * - 每个「删了」的断言都配一个「别人没被删 / 群会话还在 / access.json 哈希不变」的对照物（P17）
 * - 按人删除的授权面：删完 stillAuthorized 仍为 true，且 access.json 逐字节不变（M23）
 * - 摘要 `(sessionId, personaId)` 复合键：两个人设互不覆盖、v1 文件迁移不丢内容
 *
 * 桩掉：embedder 与事实抽取（真模型会拖几分钟）。不桩 MemoryStore / MemoryService /
 * chatService / summaryService / IPC —— 被测的就是它们。
 * 破坏性判据全部在 os.tmpdir() 里的一次性 userData 中跑，绝不碰真实用户数据（S7）。
 *
 * 跑法：node scripts/test/memory-panel.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { bundleModuleWithStubs, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const require = createRequire(import.meta.url)
const { check, done } = createChecker()

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-panel-'))
installElectronStub(userData)

fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: true, autoExtract: true }, summary: { enabled: false } }),
  'utf8'
)

/* ── 在 bundle 之前补掉 electron 桩的两个缺口 ───────────────────────────────
 * 1) ipcMain.handle 是空函数：注册上去的 handler 拿不回来 → 这里换成收集器。
 * 2) shell.openPath 看不到实参：MP-20 要断言它打开的是 userData 而不是模型目录。
 * 🔴 必须在 require bundle 之前改 —— 改的是同一个 stub 对象，bundle 里的调用点
 *    在运行时读属性，早改晚改都生效，但早改能保证模块顶层就拿到收集器。 */
const electron = require('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, fn) => {
  handlers.set(channel, fn)
}
let openedPath = null
electron.shell.openPath = async (target) => {
  openedPath = target
  return ''
}

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-memory-panel-stubs-'))
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

const mod = await bundleModuleWithStubs(
  'memory-panel',
  [
    "export { chatService } from '" + p('src/main/features/chat/chatService.ts') + "'",
    "export { memoryService } from '" + p('src/main/features/rag/index.ts') + "'",
    "export { summaryService, SummaryService } from '" + p('src/main/features/summary/service.ts') + "'",
    "export { SummaryStore, summaryKeyOf } from '" + p('src/main/features/summary/store.ts') + "'",
    "export { channelStore } from '" + p('src/main/features/channels/store.ts') + "'",
    "export { registerMemoryIpcHandlers } from '" + p('src/main/ipc/memory.ts') + "'"
  ],
  { './embedder': embedderStub, './extract': extractStub }
)
const { chatService, memoryService, summaryService, SummaryService, SummaryStore, summaryKeyOf, channelStore } = mod
mod.registerMemoryIpcHandlers()

const call = async (channel, ...args) => handlers.get(channel)({}, ...args)
const accessFile = path.join(userData, 'channels', 'access.json')
const shaOf = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent')

/* ── 造数：三类来源（MP-01）＋ 两个对照用户 ──────────────────────────────── */
const A = '20001' // 按人删除的目标
const B = '20002' // 全删的对照物（P17）
const C = '20003' // 按人设删除的目标

channelStore.upsertAccount({ userId: A, label: '阿删' })
channelStore.upsertAccount({ userId: '10001', label: '阿一' })
channelStore.upsertAccount({ userId: '10003' }) // 只在授权表里，从没说过话
channelStore.upsertAccount({ userId: C }) // 按人设删除的目标也在授权名单里（MP-10 要断言授权不动）

// (a) 只有记忆、没有人设注册行（直接写 memories，不调 upsertPersona）
for (const text of ['10001 事实 A', '10001 事实 B', '10001 事实 C']) {
  await memoryService.save({ content: text, userId: '10001', personaId: 'default' })
}
// (b) 只有人设注册行、没有记忆
memoryService.upsertPersona('10002', 'work', true)

// 目标用户 A：两个人设 + 两张表各自的条数 + 私聊/群聊会话
memoryService.upsertPersona(A, 'default', true)
memoryService.upsertPersona(A, 'work')
for (const text of ['A 的事实 1', 'A 的事实 2']) {
  await memoryService.save({ content: text, userId: A, personaId: 'default' })
}
await memoryService.save({ content: 'A-work 的事实', userId: A, personaId: 'work' })
memoryService.appendHistory({
  id: 'h-a-1',
  userId: A,
  personaId: 'default',
  role: 'user',
  content: 'A 对 default 说的一句话',
  sessionId: 'qq:9000:private:' + A,
  chatType: 'private',
  chatId: A,
  createdAt: 1
})
memoryService.appendHistory({
  id: 'h-a-2',
  userId: A,
  personaId: 'work',
  role: 'assistant',
  content: 'A 在 work 下的回话',
  sessionId: 'qq:9000:private:' + A,
  chatType: 'private',
  chatId: A,
  createdAt: 2
})
chatService.ensureChannelSession('qq:9000:private:' + A, { title: '与 A 的私聊' })
chatService.ensureChannelSession('qq:9000:group:88888', { title: '某个群' })

// 对照用户 B：4 条记忆 + 1 条历史 + 1 个私聊会话
memoryService.upsertPersona(B, 'default', true)
for (const text of ['B 的事实 1', 'B 的事实 2', 'B 的事实 3', 'B 的事实 4']) {
  await memoryService.save({ content: text, userId: B, personaId: 'default' })
}
memoryService.appendHistory({
  id: 'h-b-1',
  userId: B,
  personaId: 'default',
  role: 'user',
  content: 'B 的一句话',
  sessionId: 'qq:9000:private:' + B,
  chatType: 'private',
  chatId: B,
  createdAt: 3
})
chatService.ensureChannelSession('qq:9000:private:' + B, { title: '与 B 的私聊' })

// 用户 C：按人设删除用（default 1 记忆 1 历史；work 2 记忆 2 历史）
memoryService.upsertPersona(C, 'default', true)
memoryService.upsertPersona(C, 'work')
await memoryService.save({ content: 'C-default 的事实', userId: C, personaId: 'default' })
await memoryService.save({ content: 'C-work 的事实 1', userId: C, personaId: 'work' })
await memoryService.save({ content: 'C-work 的事实 2', userId: C, personaId: 'work' })
for (const id of ['h-c-1', 'h-c-2']) {
  memoryService.appendHistory({
    id,
    userId: C,
    personaId: 'work',
    role: 'user',
    content: 'C-work 的聊天 ' + id,
    sessionId: 'qq:9000:private:' + C,
    chatType: 'private',
    chatId: C,
    createdAt: 4
  })
}
memoryService.appendHistory({
  id: 'h-c-3',
  userId: C,
  personaId: 'default',
  role: 'user',
  content: 'C-default 的聊天',
  sessionId: 'qq:9000:private:' + C,
  chatType: 'private',
  chatId: C,
  createdAt: 5
})

/* 摘要：必须在 summaryService 首次读盘之前写好（它有内存缓存）。 */
const summarySeed = {
  ['qq:9000:private:' + A]: 'default',
  ['qq:9000:private:' + B]: 'default'
}
const summaryItems = {}
for (const [sessionId, personaId] of Object.entries(summarySeed)) {
  summaryItems[summaryKeyOf(sessionId, personaId)] = {
    sessionId,
    personaId,
    coveredCount: 1,
    anchorMessageId: null,
    sections: { short_term: '摘要：' + sessionId, long_term: '', user_info: '', promises: '' },
    updatedAt: 10,
    lastError: null,
    lastAttemptAt: 10
  }
}
fs.writeFileSync(path.join(userData, 'summaries.json'), JSON.stringify({ version: 2, items: summaryItems }, null, 2), 'utf8')

/* ── MP-01…MP-04：按人列表 = 三类来源的并集 ──────────────────────────────── */
const users = await call('memory:users')
const byId = new Map(users.map((row) => [row.userId, row]))
check('MP-01 有记忆无人设行的用户出现（10001）', byId.has('10001'))
check('MP-01 有人设行无记忆的用户出现（10002）', byId.has('10002'))
check('MP-01 只在 access.json 的用户出现（10003）', byId.has('10003'))
check('MP-01 授权了但从没说过话的行 memoryCount === 0', byId.get('10003')?.memoryCount === 0, byId.get('10003')?.memoryCount)
check('MP-02 空记忆行仍然 inAllowList === true', byId.get('10003')?.inAllowList === true)
check('MP-03 label 来自 access.json（10001 = 阿一）', byId.get('10001')?.label === '阿一', byId.get('10001')?.label)
check('MP-03 未登记者 label 是空串，不伪造占位文案', byId.get('10002')?.label === '', JSON.stringify(byId.get('10002')?.label))
check('MP-04 P17：A 的记忆条数是 3，B 是 4（不串）', byId.get(A)?.memoryCount === 3 && byId.get(B)?.memoryCount === 4, [byId.get(A)?.memoryCount, byId.get(B)?.memoryCount])
const entriesOfA = await call('memory:user-entries', A, 'default')
const entriesOfB = await call('memory:user-entries', B, 'default')
check('MP-04 A 的条目里不含 B 的内容', entriesOfA.entries.every((item) => !item.content.startsWith('B ')))
check('MP-04 B 的条目里不含 A 的内容', entriesOfB.entries.every((item) => !item.content.startsWith('A ')))

/* ── MP-05…MP-07：单人详情 ──────────────────────────────────────────────── */
const detailA = await call('memory:user-detail', A)
check('MP-05 恰好一个激活人设', detailA.personas.filter((row) => row.isActive).length === 1, detailA.personas.length)
check('MP-05 激活的人设在排序首位', detailA.personas[0]?.isActive === true, detailA.personas[0]?.personaId)
const personaDefault = detailA.personas.find((row) => row.personaId === 'default')
const personaWork = detailA.personas.find((row) => row.personaId === 'work')
check('MP-06 记忆/历史分属两张表（default 2/1）', personaDefault?.memoryCount === 2 && personaDefault?.historyCount === 1, [personaDefault?.memoryCount, personaDefault?.historyCount])
check('MP-06 work 人设 1/1，不是合并成 4', personaWork?.memoryCount === 1 && personaWork?.historyCount === 1, [personaWork?.memoryCount, personaWork?.historyCount])
check('MP-07 dbPath 是真实文件且 basename 为 memory.db', fs.existsSync(detailA.dbPath) && fs.statSync(detailA.dbPath).isFile() && path.basename(detailA.dbPath) === 'memory.db', detailA.dbPath)
check('MP-07 userDataPath 与一次性 userData 一致', path.resolve(detailA.userDataPath) === path.resolve(userData), detailA.userDataPath)

/* ── MP-08…MP-10：按人设删除（用户 C）────────────────────────────────────── */
const accessShaBeforePersona = shaOf(accessFile)
const cDefaultBefore = {
  memories: memoryService.listByTenant(C, 'default').length,
  histories: memoryService.recentHistory(C, 'default', 50).length
}
const reportPersona = await call('memory:delete-persona', C, 'work')
check('MP-08 该人设的记忆清零', memoryService.listByTenant(C, 'work').length === 0, memoryService.listByTenant(C, 'work').length)
check('MP-08 该人设的人设历史清零', memoryService.recentHistory(C, 'work', 50).length === 0, memoryService.recentHistory(C, 'work', 50).length)
check('MP-08 该人设的注册行消失', memoryService.listPersonas(C).every((row) => row.personaId !== 'work'))
check('MP-08 报告逐面报数（不是只有布尔）', reportPersona.personaId === 'work' && reportPersona.memories === 2 && reportPersona.histories === 2, JSON.stringify(reportPersona))
check('MP-09 P17：同一用户的 default 一条不少', memoryService.listByTenant(C, 'default').length === cDefaultBefore.memories && memoryService.recentHistory(C, 'default', 50).length === cDefaultBefore.histories, JSON.stringify(cDefaultBefore))
check('MP-10 按人设删除不动 access.json（sha256 相同）', shaOf(accessFile) === accessShaBeforePersona)
check('MP-10 报告里授权仍然有效', reportPersona.stillAuthorized === true)

/* ── MP-11…MP-16：按人删除（用户 A）──────────────────────────────────────── */
const accessShaBeforeUser = shaOf(accessFile)
const statusBefore = summaryService.status()
const bBefore = {
  memories: memoryService.listByTenant(B, 'default').length,
  histories: memoryService.recentHistory(B, 'default', 50).length,
  personas: memoryService.listPersonas(B).length,
  sessions: chatService.listSessions().filter((item) => item.id === 'qq:9000:private:' + B).length,
  summary: statusBefore.sessionCount
}
const reportUser = await call('memory:delete-user', A)
check('MP-11 三表全清且逐面报数（3 记忆 / 2 历史 / 2 人设）', reportUser.memories === 3 && reportUser.histories === 2 && reportUser.personas === 2, JSON.stringify(reportUser))
check('MP-11 查库确认：记忆 0 / 历史 0 / 人设 0',
  memoryService.listByTenant(A, 'default').length === 0 &&
  memoryService.listByTenant(A, 'work').length === 0 &&
  memoryService.recentHistory(A, 'default', 50).length === 0 &&
  memoryService.listPersonas(A).length === 0)
const statusAfter = summaryService.status()
check('MP-12 他的摘要被删（会话数 -1）', statusAfter.sessionCount === statusBefore.sessionCount - 1, [statusBefore.sessionCount, statusAfter.sessionCount])
check('MP-12 报告里摘要计数为 1', reportUser.summaries === 1, reportUser.summaries)
const remainingIds = chatService.listSessions().map((item) => item.id)
check('MP-13 他的私聊会话被删', remainingIds.every((id) => id !== 'qq:9000:private:' + A))
check('MP-13 P17：群会话仍在（不许毁别人的对话）', remainingIds.includes('qq:9000:group:88888'))
check('MP-13 报告里会话计数为 1', reportUser.sessions === 1, reportUser.sessions)
check('MP-14 stillAuthorized === true（M23 的核心承诺）', reportUser.stillAuthorized === true)
check('MP-14 access.json 逐字节不变', shaOf(accessFile) === accessShaBeforeUser)
check('MP-15 删完 activePersona 返回 null 而不是抛错', memoryService.activePersona(A) === null, memoryService.activePersona(A))
memoryService.upsertPersona(A, 'default', true)
check('MP-15 重新注册后立刻可用（人没被删坏死）', memoryService.activePersona(A) === 'default' && memoryService.listPersonas(A).length === 1)
const statusAfterB = summaryService.status()
check('MP-16 P17：B 的记忆一条不少', memoryService.listByTenant(B, 'default').length === bBefore.memories, memoryService.listByTenant(B, 'default').length)
check('MP-16 P17：B 的历史一条不少', memoryService.recentHistory(B, 'default', 50).length === bBefore.histories)
check('MP-16 P17：B 的人设一条不少', memoryService.listPersonas(B).length === bBefore.personas)
check('MP-16 P17：B 的私聊会话仍在', chatService.listSessions().some((item) => item.id === 'qq:9000:private:' + B))
check('MP-16 P17：B 的摘要仍在（删的是 A 那份，B 那条还在）',
  summaryService.stateOf('qq:9000:private:' + B, 'default') !== null &&
  statusAfterB.sessionCount === bBefore.summary - 1,
  [bBefore.summary, statusAfterB.sessionCount])

/* ── MP-20：打开目录 = userData（不是模型目录）────────────────────────────── */
await call('memory:open-dir')
check('MP-20 打开的是 userData 目录', openedPath !== null && path.resolve(openedPath) === path.resolve(userData), openedPath)

/* ── MP-21…MP-25：摘要 (sessionId, personaId) 复合键 ─────────────────────── */
function writeSummaryFile(dir, version, items) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'summaries.json'), JSON.stringify({ version, items }, null, 2), 'utf8')
  return dir
}
const sectionText = (value) => ({
  short_term: value,
  long_term: value,
  user_info: value,
  promises: value
})
const SESSION = { id: 'S1', messages: [
  { id: 'm1', role: 'user', content: '一', createdAt: 1, status: 'done' },
  { id: 'm2', role: 'assistant', content: '二', createdAt: 2, status: 'done' },
  { id: 'm3', role: 'user', content: '三', createdAt: 3, status: 'done' },
  { id: 'm4', role: 'assistant', content: '四', createdAt: 4, status: 'done' },
  { id: 'm5', role: 'user', content: '五', createdAt: 5, status: 'done' }
] }
const enabledSettings = {
  summary: {
    enabled: true,
    triggerCount: 40,
    // 窗口给 1：这样「游标往前数 1 条」的结果与全量历史**可区分**，否则默认 12 条窗口
    // 在任何小于 12 条的会话上都等于全量，MP-25 就成了永远为真的假断言。
    windowCount: 1,
    shortTermMaxChars: 400,
    longTermMaxChars: 1200,
    userInfoMaxChars: 600,
    promisesMaxChars: 400
  }
}
const dirTwo = writeSummaryFile(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mp-two-')), 2, {
  [summaryKeyOf('S1', 'default')]: {
    sessionId: 'S1',
    personaId: 'default',
    coveredCount: 0,
    anchorMessageId: null,
    sections: sectionText('DEFAULT-哨兵'),
    updatedAt: 1,
    lastError: null,
    lastAttemptAt: 1
  },
  [summaryKeyOf('S1', 'work')]: {
    sessionId: 'S1',
    personaId: 'work',
    coveredCount: 3,
    anchorMessageId: 'm3',
    sections: sectionText('WORK-哨兵'),
    updatedAt: 2,
    lastError: null,
    lastAttemptAt: 2
  }
})
const two = new SummaryService(new SummaryStore(() => dirTwo), () => enabledSettings)
check('MP-21 同一会话下两个人物设的摘要互不覆盖',
  two.stateOf('S1', 'work')?.sections.short_term === 'WORK-哨兵' &&
  two.stateOf('S1', 'default')?.sections.short_term === 'DEFAULT-哨兵')
const blockWork = two.systemBlock(SESSION, 'work')
const blockDefault = two.systemBlock(SESSION, 'default')
check('MP-22 systemBlock(work) 只含 work 的四段', blockWork.includes('WORK-哨兵') && !blockWork.includes('DEFAULT-哨兵'))
// P3.7：none 态不注入；有四段正文也不能绕过有效覆盖边界判定。
check('MP-22 systemBlock(default) 无覆盖锚点时不注入', blockDefault === '')
const workWindow = two.historyOf(SESSION, 'work').map((item) => item.id).join(',')
check('MP-25 historyOf(work) 的窗口只由 work 的 coveredCount 决定（m3 起 3 条）', workWindow === 'm3,m4,m5', workWindow)
check('MP-25 对照：default 的 coveredCount=0 → 全量 5 条', two.historyOf(SESSION, 'default').length === 5, two.historyOf(SESSION, 'default').length)
// 再给 default 有效边界，仍以真实 systemBlock 验证两个方向都不串四段。
Object.assign(two.stateOf('S1', 'default'), { coveredCount: 1, anchorMessageId: 'm1' })
const validDefault = two.systemBlock(SESSION, 'default')
check('MP-22 有效 default 只注入自己的四段', validDefault.includes('DEFAULT-哨兵') && !validDefault.includes('WORK-哨兵'))
check('MP-22 default 激活不影响 work 注入', two.systemBlock(SESSION, 'work') === blockWork)

const dirV1 = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mp-v1-'))
const v1Sections = { short_term: 'v1-短期', long_term: 'v1-长期', user_info: 'v1-用户', promises: 'v1-约定' }
writeSummaryFile(dirV1, 1, {
  S9: {
    sessionId: 'S9',
    coveredCount: 2,
    anchorMessageId: 'a9',
    sections: v1Sections,
    updatedAt: 111,
    lastError: null,
    lastAttemptAt: 222
  }
})
const migrated = new SummaryStore(() => dirV1).load()
const migratedEntry = migrated.get(summaryKeyOf('S9', 'default'))
check('MP-23 v1 文件能读出（不静默清空）', Boolean(migratedEntry), migrated.size)
check('MP-23 迁移后 personaId === default', migratedEntry?.personaId === 'default')
check('MP-23 迁移后四段逐字段相等（内容没丢）',
  migratedEntry?.sections.short_term === v1Sections.short_term &&
  migratedEntry?.sections.long_term === v1Sections.long_term &&
  migratedEntry?.sections.user_info === v1Sections.user_info &&
  migratedEntry?.sections.promises === v1Sections.promises)
check('MP-23 迁移后游标与锚点不丢', migratedEntry?.coveredCount === 2 && migratedEntry?.anchorMessageId === 'a9')

const dirV2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mp-v2-'))
const storeV2 = new SummaryStore(() => dirV2)
storeV2.save(migrated)
const written = JSON.parse(fs.readFileSync(path.join(dirV2, 'summaries.json'), 'utf8'))
check('MP-24 落盘 version === 2', written.version === 2, written.version)
check('MP-24 键是复合键（sessionId + NUL + personaId）', Object.keys(written.items).some((key) => key.includes('\u0000')), Object.keys(written.items)[0])

done()
