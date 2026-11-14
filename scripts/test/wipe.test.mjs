/**
 * P7「清空全部数据」判据套件（WP-01…WP-21）。
 *
 * 🔴 全部破坏性判据只在 os.tmpdir() 的一次性 userData 里跑，**一次都不碰真实 APPDATA**。
 * 🔴 每条「删了」都配一条「保留的还在」（P17）；WP-21 是最重要的一条：
 *    备份失败时**一个字节都不许删** —— 那是本功能的唯一安全网。
 *
 * 跑法：node scripts/test/wipe.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { bundleModuleWithStubs, createChecker, installElectronStub, p, projectRoot } from './qq-test-util.mjs'

const require = createRequire(import.meta.url)
const { check, done } = createChecker()

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p7-wipe-'))
installElectronStub(userData)

fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false }, summary: { enabled: false } }),
  'utf8'
)

/* ── 补掉 electron 桩的缺口（必须在 require bundle 之前改同一个对象）──────────
 * 1) ipcMain.handle 是空函数：注册上去的 handler 拿不回来（与 memory-panel 同一手法）。
 * 2) app.relaunch / app.exit 不存在：P7 清空成功后会调它们，不桩就会抛。 */
const electron = require('electron')
const handlers = new Map()
electron.ipcMain.handle = (channel, fn) => {
  handlers.set(channel, fn)
}
let relaunchCalls = 0
let quitCalls = 0
electron.app.relaunch = () => {
  relaunchCalls += 1
}
electron.app.exit = () => {}
electron.app.quit = () => {
  quitCalls += 1
}

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p7-stubs-'))
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
  'p7-wipe',
  [
    "export { chatService } from '" + p('src/main/features/chat/chatService.ts') + "'",
    "export { memoryService } from '" + p('src/main/features/rag/index.ts') + "'",
    "export { summaryService } from '" + p('src/main/features/summary/service.ts') + "'",
    "export { SummaryStore } from '" + p('src/main/features/summary/store.ts') + "'",
    "export { createStory } from '" + p('src/main/features/story/service.ts') + "'",
    "export { storyStore } from '" + p('src/main/features/story/store.ts') + "'",
    "export { wipeAllData } from '" + p('src/main/features/wipe/index.ts') + "'",
    "export { registerWipeIpcHandlers } from '" + p('src/main/ipc/wipe.ts') + "'",
    "export { planRelaunch, relaunchAfterWipe } from '" + p('src/main/features/wipe/relaunch.ts') + "'",
    "export { POST_WIPE_FLAG } from '" + p('src/shared/constants.ts') + "'",
    "export { IPC } from '" + p('src/shared/ipc.ts') + "'"
  ],
  { './embedder': embedderStub, './extract': extractStub }
)
const {
  chatService,
  memoryService,
  summaryService,
  SummaryStore,
  createStory,
  storyStore,
  wipeAllData,
  registerWipeIpcHandlers,
  planRelaunch,
  relaunchAfterWipe,
  POST_WIPE_FLAG,
  IPC
} = mod
registerWipeIpcHandlers()
const call = (channel, ...args) => handlers.get(channel)({}, ...args)

const j = (...parts) => path.join(userData, ...parts)
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent')
const dbCount = (table) => {
  const db = new DatabaseSync(j('memory.db'))
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()
    return Number(row.n)
  } finally {
    db.close()
  }
}
/** 目录清单哈希：只比「有哪些文件 + 各自 sha」，不逐字节搬 30MB */
const treeHash = (dir) => {
  if (!fs.existsSync(dir)) return 'absent'
  const rows = []
  const walk = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) walk(full)
      else rows.push(path.relative(dir, full).replace(/\\/g, '/') + ':' + sha(full))
    }
  }
  walk(dir)
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex')
}

/* ── 造数：删除面 4 项 + 保留面 10 项 ───────────────────────────────────── */
fs.mkdirSync(j('channels'), { recursive: true })
fs.writeFileSync(
  j('channels', 'access.json'),
  JSON.stringify({ version: 2, accounts: [{ userId: '20001', label: '甲', level: 'low' }], groups: [] }, null, 2),
  'utf8'
)
fs.mkdirSync(j('qq'), { recursive: true })
fs.writeFileSync(j('qq', 'settings.json'), JSON.stringify({ typingMode: 'off' }), 'utf8')
fs.mkdirSync(j('presets', 'p1'), { recursive: true })
fs.writeFileSync(j('presets', 'p1', 'mirror.json'), JSON.stringify({ a: 1 }), 'utf8')
fs.mkdirSync(j('workspace'), { recursive: true })
fs.writeFileSync(j('workspace', 'README.md'), '# workspace', 'utf8')
fs.writeFileSync(j('memory.db.p5-backup'), 'P5-BACKUP-SENTINEL', 'utf8')
fs.mkdirSync(j('observe', '10001', 'group'), { recursive: true })
fs.writeFileSync(j('observe', '10001', 'group', '555.jsonl'), '{"t":1}\n', 'utf8')
fs.mkdirSync(j('snowluma', 'data'), { recursive: true })
fs.writeFileSync(j('snowluma', 'data', 'identity.db'), 'IDB-SENTINEL', 'utf8')
fs.writeFileSync(j('zones.json.retired-bak'), JSON.stringify({ zones: [{ id: 'root' }] }), 'utf8')
// summaries.json 必须在任何 summaryService 调用之前落盘：服务是懒加载的
fs.writeFileSync(
  j('summaries.json'),
  JSON.stringify({
    version: 2,
    items: {
      ['s1\u0000default']: {
        sessionId: 's1',
        personaId: 'default',
        coveredCount: 10,
        anchorMessageId: null,
        sections: { short_term: '近况', long_term: '', user_info: '', promises: '' },
        updatedAt: 1,
        lastError: null,
        lastAttemptAt: 1
      }
    }
  }),
  'utf8'
)

const s1 = chatService.createSession({ title: '甲' })
const s2 = chatService.createSession({ id: 'qq:10001:private:20001' })
memoryService.upsertPersona('20001', 'default', true)
memoryService.appendHistory({
  id: s2.id + ':u:m1',
  userId: '20001',
  personaId: 'default',
  role: 'user',
  content: '记住我喜欢蓝色',
  sessionId: s2.id,
  chatType: 'private',
  chatId: '20001',
  createdAt: Date.now()
})
await memoryService.save({ content: '甲喜欢蓝色', userId: '20001', personaId: 'default' })
const story = createStory({ title: '测试故事', characterId: 'default', synopsis: '一句话' })

const KEEPS = [
  'settings.json',
  'channels/access.json',
  'qq/settings.json',
  'memory.db.p5-backup'
]
const before = {
  keeps: Object.fromEntries(KEEPS.map((rel) => [rel, sha(j(rel))])),
  observe: treeHash(j('observe')),
  snowluma: treeHash(j('snowluma')),
  presets: treeHash(j('presets')),
  workspace: treeHash(j('workspace')),
  sessions: JSON.parse(fs.readFileSync(j('sessions.json'), 'utf8')).length,
  memories: dbCount('memories'),
  histories: dbCount('persona_chat_history'),
  personas: dbCount('user_personas')
}

console.log('WP-13 · 没生成过码就执行 → 拒绝（M15：码只在点按钮后出现）')
{
  const res = await call(IPC.wipeExecute, { code: '00000000' })
  check('WP-13 未生成码时执行被拒（no_captcha）', res.ok === false && res.reason === 'no_captcha', res.reason)
}

console.log('WP-21 · 备份失败 → 一个字节都不删（本功能唯一的安全网）')
{
  const res = await wipeAllData({ confirmed: true, backupRoot: path.join(userData, 'settings.json', 'nope') })
  const intact =
    JSON.parse(fs.readFileSync(j('sessions.json'), 'utf8')).length === before.sessions &&
    dbCount('memories') === before.memories &&
    fs.existsSync(j('stories')) &&
    JSON.parse(fs.readFileSync(j('summaries.json'), 'utf8')).items['s1\u0000default'] !== undefined
  check('WP-21 备份目录建不出来时 ok=false', res.ok === false && res.backupDir !== '' ? res.ok === false : res.ok === false, res.detail.slice(0, 48))
  check('WP-21 四个删除面原样还在（会话/记忆/故事/摘要）', intact)
}

console.log('WP-14 / WP-15 · 码的形状与刷新')
const codes = []
for (let i = 0; i < 5; i += 1) {
  const c = await call(IPC.wipeCaptcha)
  codes.push(c.code)
}
const last = codes[codes.length - 1]
check('WP-14 码是 8 位小写 hex', codes.every((c) => /^[0-9a-f]{8}$/.test(c)), codes.join(','))
check('WP-15 连续生成 5 次都不同（每次开框刷新）', new Set(codes).size === 5)

// 顺序间谍：清空前必须先 abortAll，否则在飞的 persist() 会把会话写回来（WP-19）
const order = []
const realAbort = chatService.abortAll.bind(chatService)
const realWipe = chatService.wipeAllSessions.bind(chatService)
chatService.abortAll = () => {
  order.push('abortAll')
  realAbort()
}
chatService.wipeAllSessions = () => {
  order.push('wipeAllSessions')
  return realWipe()
}

console.log('WP-16 · 错 1、2 次：留框、清空输入、码不变')
const wrong1 = await call(IPC.wipeExecute, { code: 'deadbeef' })
const wrong2 = await call(IPC.wipeExecute, { code: 'ffffffff' })
check('WP-16 前两次错都返回 wrong（不是 too_many_failures）', wrong1.reason === 'wrong' && wrong2.reason === 'wrong', wrong1.reason + '/' + wrong2.reason)
const okRun = await call(IPC.wipeExecute, { code: last })
check('WP-16 用原码仍能执行成功（码在错两次后没有变）', okRun.ok === true, okRun.reason ?? okRun.report?.detail?.slice(0, 40))
const report = okRun.report ?? {}

console.log('WP-01…WP-06 · 删除面')
{
  const file = j('sessions.json')
  const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  check('WP-01 sessions.json 仍存在且内容为 []（M14：写回，不是删掉）', Array.isArray(parsed) && parsed.length === 0)
  check('WP-02 memories 清零', dbCount('memories') === 0 && memoryService.list().length === 0)
  check(
    'WP-03 persona_chat_history 清零（用了 clear() 就会漏这条）',
    dbCount('persona_chat_history') === 0 && memoryService.recentHistory('20001', 'default', 50).length === 0
  )
  check('WP-04 user_personas 清零（//list 不该还能看到人设）', dbCount('user_personas') === 0 && memoryService.listPersonas('20001').length === 0)
  check('WP-05 stories/ 整目录已删', fs.existsSync(j('stories')) === false)
  // 版本号不能硬编码：让同一份代码自己空跑一次，用它所写的 version 当基准
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p7-sum-'))
  const probeStore = new SummaryStore(() => probeDir)
  probeStore.save(new Map())
  const fileVersion = JSON.parse(fs.readFileSync(probeStore.file(), 'utf8')).version
  const written = JSON.parse(fs.readFileSync(j('summaries.json'), 'utf8'))
  check(
    'WP-06 summaries.json 的 items 为空且版本是当前代码版本（不是硬编码 1）',
    Object.keys(written.items).length === 0 && written.version === fileVersion && fileVersion !== 1,
    'v' + String(written.version) + '/' + String(fileVersion)
  )
}

console.log('WP-07…WP-12 · 保留面（每条「删了」都配一条「留的还在」，P17）')
{
  const changed = KEEPS.filter((rel) => sha(j(rel)) !== before.keeps[rel])
  check('WP-07 四个关键保留文件逐字节不变', changed.length === 0, changed.join(','))
  check('WP-08 observe/ 一个文件都没少', treeHash(j('observe')) === before.observe)
  check('WP-09 snowluma/ 没动', treeHash(j('snowluma')) === before.snowluma)
  check('WP-10 presets/ 与 workspace/ 没动', treeHash(j('presets')) === before.presets && treeHash(j('workspace')) === before.workspace)
  const access = JSON.parse(fs.readFileSync(j('channels', 'access.json'), 'utf8'))
  const stillAuthorized = access.accounts.some((a) => a.userId === '20001')
  memoryService.upsertPersona('20001', 'default', true)
  check(
    'WP-10b 授权仍在，且清空后仍能重新登记人设（下次说话 = 全新用户）',
    stillAuthorized && memoryService.activePersona('20001') === 'default'
  )
  check('WP-11 zones.json.retired-bak 已删（H-C-14）', fs.existsSync(j('zones.json.retired-bak')) === false)
  let integrity = ''
  {
    const db = new DatabaseSync(j('memory.db'))
    try {
      integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check)
    } finally {
      db.close()
    }
  }
  check('WP-12 memory.db 文件本身还在且 integrity_check=ok（清表不删库）', fs.existsSync(j('memory.db')) && integrity === 'ok', integrity)
}

console.log('WP-18 · 验证码不可鼠标复制（机器能断言的那一半）')
{
  const css = fs.readFileSync(p('src/renderer/src/styles/global.css'), 'utf8')
  const block = css.slice(css.indexOf('.wipe-code'))
  check(
    'WP-18 .wipe-code 同时有 user-select: none 与 -webkit-user-select: none',
    block.slice(0, 400).includes('user-select: none') && block.slice(0, 400).includes('-webkit-user-select: none')
  )
}

console.log('WP-19 · 先 stop 再清（防写回）')
{
  check('WP-19 abortAll 排在 wipeAllSessions 之前', order.join('>') === 'abortAll>wipeAllSessions', order.join('>'))
  check('WP-19b 清完后会话数是 0（不是 [那条在飞的会话]）', JSON.parse(fs.readFileSync(j('sessions.json'), 'utf8')).length === 0)
}

console.log('WP-20 · 备份先于删除，且备份里四个关键文件都在')
{
  const dir = report.backupDir ?? ''
  const backupNames = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  const hasFour = ['sessions.json', 'memory.db', 'summaries.json', 'settings.json'].every((n) => backupNames.includes(n))
  const hasStories = fs.existsSync(path.join(dir, 'stories', story.meta.storyId, 'story.json'))
  check('WP-20 备份目录里四个关键文件齐全', hasFour, backupNames.join(','))
  check('WP-20b 备份里还有被删掉的故事区（唯一无法重建的东西）', hasStories)
  check(
    'WP-20c 报告逐项非零（会话/记忆/历史/人设/摘要/故事）',
    report.sessions >= 2 && report.memories >= 1 && report.histories >= 1 && report.personas >= 1 && report.summaries >= 1 && report.stories >= 1,
    JSON.stringify({ s: report.sessions, m: report.memories, h: report.histories, p: report.personas, su: report.summaries, st: report.stories })
  )
  // setImmediate 是「先让 IPC 回复发出去，再重启」的实现手段 —— 所以要等一个宏任务再看
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('WP-20d 成功后在报告返回之后才重启（relaunch 已调）', relaunchCalls >= 1, relaunchCalls)
}

console.log('WP-17 · 第 3 次错 → too_many_failures 且码作废')
{
  const fresh = await call(IPC.wipeCaptcha)
  await call(IPC.wipeExecute, { code: 'aaaaaaa1' })
  await call(IPC.wipeExecute, { code: 'aaaaaaa2' })
  const third = await call(IPC.wipeExecute, { code: 'aaaaaaa3' })
  const after = await call(IPC.wipeExecute, { code: fresh.code })
  check('WP-17 第 3 次错返回 too_many_failures（弹框该关，M16）', third.reason === 'too_many_failures', third.reason)
  check('WP-17b 码已作废：拿原码再执行也进不去（no_captcha）', after.ok === false && after.reason === 'no_captcha', after.reason)
}

console.log('WP-22 / WP-23 · 入口位置与文案（A-13 / A-14；替身判据，见完成报告的出图说明）')
{
  const section = fs.readFileSync(
    p('src/renderer/src/features/settings/sections/MemorySection.tsx'),
    'utf8'
  )
  const dangerAt = section.indexOf('setting-group memory-danger')
  const wipeAt = section.indexOf('清空全部数据（不可撤销）')
  const byUserAt = section.indexOf('按人删除')
  const dialogAt = section.indexOf('<WipeDialog')
  // D-1：危险区不再是详情态的一部分，按人删除只在详情态出现 → 「按人删除」的**首个**出现
  // 位置（文案里的那一处）可能在按钮之前，所以判据改成「危险区在按人列表之后、清空按钮在危险区内」
  check('WP-22 「清空全部数据」在危险区内部、位于按人列表之后', dangerAt > 0 && wipeAt > dangerAt && dialogAt > wipeAt)
  check(
    'WP-22b 危险区不在 `selected === null ?` 的分支里（列表态必须也能看到清空入口）',
    section.lastIndexOf('memory-danger') > section.indexOf('按人查看与清理')
  )
  check('WP-23 危险区是页面最底部（其后没有别的 setting-group）', section.lastIndexOf('setting-group memory-danger') > section.lastIndexOf('<section className="setting-group">'))
  const dialog = fs.readFileSync(p('src/renderer/src/features/settings/sections/WipeDialog.tsx'), 'utf8')
  check(
    'WP-24 弹框逐项列出「会删除 / 会保留」（J-05：显式枚举，不许只写「全部数据」）',
    dialog.includes('会删除') && dialog.includes('会保留') && dialog.includes('willDelete') && dialog.includes('willKeep')
  )
  // 源码里两个调用之间隔了换行与缩进，所以按「方法名」定位，不按整串
  const previewAt = dialog.indexOf('.preview(')
  const captchaAt = dialog.indexOf('.captcha(')
  check('WP-25 弹框打开时只拉清单、不请求验证码（M15：点按钮才生成）', previewAt > 0 && captchaAt > previewAt, previewAt + '<' + captchaAt)
}

console.log('WP-26 / WP-27 / WP-28 · D-3：SQLite 侧车文件（真机阻塞缺陷）')
{
  // 必须**主动造**出 0 字节 -wal：测试环境从不打开故事库，所以这条路径以前从未被走过
  const storyDir = path.join(userData, 'stories', 'story_test_000001')
  fs.mkdirSync(storyDir, { recursive: true })
  fs.writeFileSync(path.join(storyDir, 'story.json'), JSON.stringify({ version: 1, meta: {} }), 'utf8')
  {
    const db = new DatabaseSync(path.join(storyDir, 'memory.db'))
    db.exec('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, body TEXT)')
    db.exec("INSERT INTO memories (id, body) VALUES ('m1', 'x')")
    db.exec('PRAGMA journal_mode=WAL')
    db.exec("INSERT INTO memories (id, body) VALUES ('m2', 'y')")
    db.close()
  }
  const wal = path.join(storyDir, 'memory.db-wal')
  // close() 之后 SQLite 可能直接**删掉** WAL，而不是留 0 字节 —— 手工补一个，
  // 否则这条判据会在「恰好没有 -wal」的环境里静默通过（正是 D-3 漏网的原因）
  if (!fs.existsSync(wal)) fs.writeFileSync(wal, '')
  const walSize = fs.existsSync(wal) ? fs.statSync(wal).size : -1
  check('WP-26a 已造出 0 字节的故事库 -wal（复现真机现场）', walSize === 0, String(walSize))

  const backupRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p7-bk2-'))
  const report2 = await wipeAllData({ confirmed: true, backupRoot: backupRoot2 })
  check('WP-26 存在 0 字节 -wal 时 wipe 仍然成功（D-3 的直接锁）', report2.ok === true, report2.detail.slice(0, 60))

  const names = []
  const walkNames = (dir, prefix = '') => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + item.name : item.name
      if (item.isDirectory()) walkNames(path.join(dir, item.name), rel)
      else names.push(rel)
    }
  }
  if (report2.backupDir && fs.existsSync(report2.backupDir)) walkNames(report2.backupDir)
  check(
    'WP-27 备份里不含 *.db-wal / *.db-shm（侧车不是独立数据）',
    !names.some((n) => /\.db-(wal|shm)$/i.test(n)),
    names.join(',')
  )

  const storyBackup = path.join(report2.backupDir, 'stories', 'story_test_000001', 'memory.db')
  let storyRows = -1
  let storyOk = false
  try {
    const db = new DatabaseSync(storyBackup)
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get()
      storyRows = Number(row.n)
      storyOk = String(db.prepare('PRAGMA integrity_check').get().integrity_check) === 'ok'
    } finally {
      db.close()
    }
  } catch {
    storyOk = false
  }
  check(
    'WP-28 故事库备份是一致快照（能打开 / integrity ok / 2 条都在，不只拷了主文件）',
    fs.existsSync(storyBackup) && storyOk && storyRows === 2,
    'rows=' + String(storyRows) + ' ok=' + String(storyOk)
  )
}

console.log('WP-29 · D-2：失败提示在危险区内（D-1 之后列表态也要能看见）')
{
  const section = fs.readFileSync(p('src/renderer/src/features/settings/sections/MemorySection.tsx'), 'utf8')
  const dangerAt = section.lastIndexOf('memory-danger')
  const noticeAt = section.indexOf('data-ui-target="危险区提示"')
  const scrollAt = section.indexOf('scrollIntoView')
  check('WP-29 危险区内渲染提示（不是只塞进页面顶部的 notice）', noticeAt > dangerAt)
  check('WP-29b 关闭弹框后滚到提示（渲染在视口外 = 没看到）', scrollAt > 0)
  const css = fs.readFileSync(p('src/renderer/src/styles/global.css'), 'utf8')
  const block = css.slice(css.indexOf('.wipe-code'))
  check('WP-29c D-4：.wipe-code 是 block（不再与输入框挤一行）', /\.wipe-code \{[^}]*display: block/.test(block))
}

console.log('WP-30 / WP-31 / WP-32 · D-5：清空后的「重启」到底走哪条路（真机白屏缺陷）')
{
  /* 真机现场：pnpm dev 起 electron，窗口 loadURL(ELECTRON_RENDERER_URL)。
     electron-vite 在 ps.on('close') 里 process.exit()，所以旧 electron 一退 dev server 立刻死。
     探针实测：原生 app.relaunch() 出来的新实例拿到 did-fail-load -102 ERR_CONNECTION_REFUSED。
     于是判据不是「有没有调 relaunch」，而是「渲染层还连不连得到页面」。 */
  const dev = {
    rendererUrl: 'http://localhost:5173',
    isPackaged: false,
    appPath: 'APP',
    nodePath: 'NODE',
    pnpmEntry: 'PNPM',
    scriptDir: 'DIR',
    builtRendererExists: true
  }

  const devPlan = planRelaunch(dev)
  check('WP-30 开发模式必须重拉整条 dev 链路（原生 relaunch 只会白屏）', devPlan.kind === 'spawn-dev')
  check(
    'WP-30a 用同一份 node + pnpm 入口跑 dev，cwd 是包目录（不是 electron.exe）',
    devPlan.kind === 'spawn-dev' &&
      devPlan.nodePath === 'NODE' &&
      devPlan.args.join(' ') === 'PNPM dev' &&
      devPlan.cwd === 'DIR'
  )

  const noPnpm = planRelaunch({ ...dev, pnpmEntry: undefined })
  check(
    'WP-30b 拿不到 pnpm 入口 → 改读构建产物，并带上 --nahida-post-wipe',
    noPnpm.kind === 'electron-relaunch' && noPnpm.args.includes(POST_WIPE_FLAG),
    noPnpm.args.join(' ')
  )

  const noBuilt = planRelaunch({ ...dev, pnpmEntry: undefined, builtRendererExists: false })
  check(
    'WP-30c 连构建产物也没有 → 原样重启（不假装成功，也不静默不重启）',
    noBuilt.kind === 'electron-relaunch' && !noBuilt.args.includes(POST_WIPE_FLAG)
  )

  const prod = planRelaunch({ ...dev, rendererUrl: undefined })
  check(
    'WP-31 生产/file://：原生 relaunch，且不带 post-wipe 标记（渲染层本来就不依赖 dev server）',
    prod.kind === 'electron-relaunch' && !prod.args.includes(POST_WIPE_FLAG),
    prod.args.join(' ')
  )

  /* 执行顺序与看门狗 —— 这两条是「点了清空之后到底会不会回来」的全部保证 */
  const order = []
  relaunchAfterWipe(
    { rendererUrl: undefined, isPackaged: false, appPath: 'APP' },
    {
      relaunch: (options) => order.push('relaunch:' + options.args.join(' ')),
      quit: () => order.push('quit'),
      exit: () => order.push('exit'),
      schedule: () => {
        order.push('schedule')
        return { unref() {} }
      }
    }
  )
  check(
    'WP-32 顺序必须是 relaunch → quit（先退出再想起新进程 = 没人重启），且不当场 exit',
    order[0] === 'relaunch:APP' && order[1] === 'quit' && order[2] === 'schedule',
    order.join(',')
  )

  let forced = false
  let spawned = null
  relaunchAfterWipe(
    { ...dev },
    {
      spawn: (command, args, options) => {
        spawned = { command, args, options }
        return { unref() {} }
      },
      quit: () => {},
      exit: () => {
        forced = true
      },
      schedule: (fn) => {
        queueMicrotask(fn)
        return { unref() {} }
      }
    }
  )
  check(
    'WP-32a spawn-dev 是 detached + stdio 丢弃 + 剥掉旧的 dev 地址（否则新实例连回已死的那个）',
    spawned !== null &&
      spawned.options.detached === true &&
      spawned.options.stdio === 'ignore' &&
      spawned.options.env['ELECTRON_RENDERER_URL'] === undefined
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('WP-32b quit 被拦住时看门狗强制退出（否则窗口不退也不重启）', forced === true)
}

console.log('')
done()
