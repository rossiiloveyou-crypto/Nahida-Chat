/**
 * 渠道工具闸门（P9-R3 / toolGate.ts）—— 判据 R3-C1…C13。
 *
 * 用**真 chatService** 跑一整轮（mockProvider 会主动请求 fs.list_dir），
 * 断言的是三件真事：
 *  1. 闸门在 permissionGate **之前**（被拒时 presentApproval 0 次）；
 *  2. 判定按**发言人**，不按会话（同一会话换个人 = 换结论）；
 *  3. 工具**照常暴露给模型**（R3-C10）—— 拒绝不等于把目录摘掉。
 *
 * 跑法：node scripts/test/channels-tool-gate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)

const results = []
function check(label, ok, extra) {
  results.push({ label, ok: Boolean(ok) })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
}

function loadEsbuild() {
  const pnpmDir = path.join(projectRoot, 'node_modules/.pnpm')
  const candidates = fs.existsSync(pnpmDir)
    ? fs.readdirSync(pnpmDir).filter((name) => name.startsWith('esbuild@'))
    : []
  for (const name of candidates) {
    const entry = path.join(pnpmDir, name, 'node_modules/esbuild/lib/main.js')
    if (fs.existsSync(entry)) return require(entry)
  }
  return require('esbuild')
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tool-gate-'))
const userData = path.join(sandbox, 'userData')
fs.mkdirSync(userData, { recursive: true })
// 默认权限模式设成 full：让「有工具权限」的那条路径真的能执行下来
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false }, permission: { mode: 'full' } }),
  'utf8'
)

const esbuild = loadEsbuild()
const entry = path.join(sandbox, 'entry.ts')
const p = (rel) => path.join(projectRoot, rel).replace(/\\/g, '/')
fs.writeFileSync(
  entry,
  [
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { registerTool, listDefinitions } from '${p('src/main/features/tools/registry.ts')}'`,
    `export { registerBuiltinTools } from '${p('src/main/features/tools/builtin.ts')}'`,
    `export { HeadlessSink } from '${p('src/main/features/chat/sink.ts')}'`,
    `export { QqSink } from '${p('src/main/features/qq/sink.ts')}'`,
    `export { channelToolVerdict, channelToolVerdictWith } from '${p('src/main/features/channels/toolGate.ts')}'`,
    `export { ChannelAccessStore } from '${p('src/main/features/channels/store.ts')}'`,
    `export { settingsStore } from '${p('src/main/features/settings/settingsStore.ts')}'`
  ].join('\n'),
  'utf8'
)

const output = path.join(sandbox, 'bundle.cjs')
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  external: ['electron'],
  alias: { '@shared': path.join(projectRoot, 'src/shared') },
  logLevel: 'silent'
})

const electronStub = path.join(sandbox, 'electron-stub.cjs')
fs.writeFileSync(
  electronStub,
  `const path = require('node:path')
const userData = ${JSON.stringify(userData)}
module.exports = {
  app: {
    getPath: (key) => (key === 'userData' ? userData : path.join(userData, String(key))),
    getAppPath: () => ${JSON.stringify(projectRoot)},
    getName: () => 'Nahida Chat',
    getVersion: () => '0.1.0',
    isPackaged: false,
    on: () => {},
    whenReady: async () => {}
  },
  shell: { openPath: async () => '', openExternal: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on: () => {} }
}`,
  'utf8'
)

const Module = require('node:module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return electronStub
  return originalResolve.call(this, request, ...rest)
}

const mod = require(output)
const {
  chatService,
  registerTool,
  listDefinitions,
  registerBuiltinTools,
  HeadlessSink,
  QqSink,
  channelToolVerdict,
  channelToolVerdictWith,
  ChannelAccessStore,
  settingsStore
} = mod
registerBuiltinTools()

const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8')

/* ── 结构判据（测的是「设计意图有没有被写进代码」） ─────────────────────── */

console.log('R3-C1/C2/C5/C13 · 结构判据')
{
  // C1：§四 4.3 的 channelToolsAllowed 已作废，必须 0 命中
  const hits = []
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(item.name) && fs.readFileSync(full, 'utf8').includes('channelToolsAllowed')) {
        hits.push(path.relative(projectRoot, full))
      }
    }
  }
  walk(path.join(projectRoot, 'src'))
  check('C1 channelToolsAllowed 全仓 0 命中（摘目录的做法已作废）', hits.length === 0, hits.join(',') || '0 命中')

  const gateSrc = read('src/main/features/channels/toolGate.ts')
  check(
    'C2 channelToolVerdict 的第一个参数是**发言人** senderId',
    /export function channelToolVerdict\(\s*senderId: string,\s*sessionId: string\s*\)/.test(gateSrc)
  )

  const chatSrc = read('src/main/features/chat/chatService.ts')
  check(
    "C5 listDefinitions 调用点未被修改（仍是 session.mode === 'agent' ? …）",
    chatSrc.includes("session.mode === 'agent' ? listDefinitions() : []")
  )

  // C13：代码行里不许出现 mode（注释允许）——这是「授权与供给正交」的守卫
  const codeLines = gateSrc
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed !== '' && !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
    })
  const modeHits = codeLines.filter((line) => /\bmode\b/.test(line))
  check('C13 toolGate.ts 的**代码行**里 mode 命中 = 0（注释允许）', modeHits.length === 0, modeHits.join(' | ') || '0 命中')
}

/* ── 纯判定（内存假 store，不碰 userData） ──────────────────────────────── */

console.log('纯判定 · 渠道闸门')
const memoryStore = (config) => ({ config: () => config })
const baseConfig = (patch = {}) => ({
  version: 2,
  groupMemberGate: false,
  toolGate: true,
  accounts: [],
  groups: [],
  uins: [],
  ...patch
})
const acct = (userId, permissions = {}) => ({
  channel: 'qq',
  userId,
  label: '',
  addedAt: 1,
  lastAt: 0,
  permissions: { private: false, group: true, tool: false, ...permissions }
})

{
  const verdict = channelToolVerdictWith(memoryStore(baseConfig()), '20002', '3f2a9c1e-0000-4000-8000-000000000000')
  check('桌面会话（UUID）→ 放行（本闸门不管桌面）', verdict.allowed === true, verdict.reason)
}
{
  const verdict = channelToolVerdictWith(memoryStore(baseConfig()), '20002', 'qq::private:')
  check('渠道 id 解析失败 → 拒绝，理由含「解析失败」', verdict.allowed === false && verdict.reason.includes('解析失败'), verdict.reason)
}
{
  const verdict = channelToolVerdictWith(memoryStore(baseConfig()), '', 'qq:10001:group:88888')
  check('空 senderId → 拒绝（fail-closed，C11）', verdict.allowed === false && verdict.reason.includes('拿不到发言人'), verdict.reason)
}
{
  const verdict = channelToolVerdictWith(memoryStore(baseConfig()), '20002', 'qq:10001:group:88888')
  check('不在白名单 → 拒绝，理由含「QQ 号白名单」（C8）', verdict.allowed === false && verdict.reason.includes('QQ 号白名单'), verdict.reason)
  check('拒绝理由同时指路「设置 → 渠道控制台」', verdict.reason.includes('渠道控制台'), verdict.reason)
}
{
  const verdict = channelToolVerdictWith(
    memoryStore(baseConfig({ accounts: [acct('20002', { tool: false })] })),
    '20002',
    'qq:10001:group:88888'
  )
  check('在白名单但 tool=false → 拒绝，理由含「未授予工具权限」', verdict.allowed === false && verdict.reason.includes('未授予工具权限'), verdict.reason)
}
{
  const verdict = channelToolVerdictWith(
    memoryStore(baseConfig({ accounts: [acct('20002', { tool: true })] })),
    '20002',
    'qq:10001:group:88888'
  )
  check('在白名单且 tool=true → 放行', verdict.allowed === true, verdict.reason)
}
{
  const verdict = channelToolVerdictWith(memoryStore(baseConfig({ toolGate: false })), '20002', 'qq:10001:group:88888')
  check('toolGate=false → 恒放行（用户显式关掉整层）', verdict.allowed === true, verdict.reason)
}
{
  // 同一条会话换个人 = 换结论：这是「按人不按会话」的立身之本
  const store = memoryStore(baseConfig({ accounts: [acct('A111', { tool: true }), acct('B222', { tool: false })] }))
  const a = channelToolVerdictWith(store, 'A111', 'qq:10001:group:88888')
  const b = channelToolVerdictWith(store, 'B222', 'qq:10001:group:88888')
  check('同一会话里 A 放行、B 拒绝（按发言人判，不按会话判）', a.allowed === true && b.allowed === false, a.allowed + '/' + b.allowed)
}

/* ── 端到端：真跑一轮 agent 会话（mockProvider 会请求 fs.list_dir） ─────── */

console.log('端到端 · 真跑一轮')
const accessDir = path.join(userData, 'channels')
const store = new ChannelAccessStore(accessDir)
const SESSION_ID = 'qq:10001:group:88888'
store.writeConfig(
  baseConfig({
    groups: [{ channel: 'qq', chatId: '88888', label: '测试群', addedAt: 1, lastAt: 0 }],
    uins: ['10001'],
    accounts: [acct('20002', { tool: true }), acct('30003', { tool: false }), acct('10001', { tool: true })]
  })
)

// 把 fs.list_dir 换成「非只读 + 立刻成功」的桩：这样 approve 模式下一定会走 ask 分支，
// 而 full 模式下真的会执行（两个分支都要能观测到）。
let toolRuns = 0
registerTool({
  definition: { ...listDefinitions().find((item) => item.name === 'fs.list_dir'), readOnly: false },
  async run() {
    toolRuns += 1
    return { ok: true, output: '桩工具执行了' }
  }
})

chatService.ensureChannelSession(SESSION_ID, { title: '测试群', mode: 'agent' })
const QUESTION = '看看工作区里有什么文件'

settingsStore.save({ permission: { mode: 'full' } })

{
  // ① 有工具权限的发言人 → 工具真的执行
  const sink = new QqSink(() => {}, '20002')
  const outcome = await chatService.sendAwait({ sessionId: SESSION_ID, content: QUESTION }, sink)
  const call = (outcome.toolCalls || [])[0]
  check('有工具权限的人 → 工具状态 ok（真的执行了）', Boolean(call) && call.status === 'ok', call ? call.status : '没有 toolCall')
  check('并且 run 被调用过（不是被别的地方挡下）', toolRuns === 1, toolRuns)
  check('sink.senderId 就是发言人（C2 的运行时对应项）', sink.senderId === '20002', sink.senderId)
}

{
  // ② 没有工具权限的发言人 → 执行前被拦，且**不弹审批卡**
  const before = toolRuns
  const sink = new QqSink(() => {}, '30003')
  settingsStore.save({ permission: { mode: 'full' } })
  const outcome = await chatService.sendAwait({ sessionId: SESSION_ID, content: QUESTION }, sink)
  const call = (outcome.toolCalls || [])[0]
  check('没有工具权限的人 → record.status === denied（C9）', Boolean(call) && call.status === 'denied', call ? call.status : '没有 toolCall')
  check('record.error 非空且指向 QQ 号白名单（C8/C9）', Boolean(call) && String(call.error).includes('QQ 号白名单'), call ? call.error : '')
  check('工具没有被执行', toolRuns === before, toolRuns)
  check('闸门在 permissionGate 之前：presentApproval 一次都没被调用（C7）', sink.approvals.length === 0, sink.approvals.length)
  check('整轮仍然 done（对话没断，她还能解释「我没有权限」）', outcome.status === 'done', outcome.status)
}

{
  // ③ 拒绝之后工具**仍在模型目录里**（C10：拦执行不等于摘目录）
  const names = listDefinitions().map((item) => item.name)
  check('C10 被拒之后 listDefinitions() 仍返回该工具（工具没被摘掉）', names.includes('fs.list_dir'), names.slice(0, 4).join(','))
}

{
  // ④ 桌面会话零影响（C12）：senderId === null → 整体跳过闸门，走 P3 的审批语义
  settingsStore.save({ permission: { mode: 'approve' } })
  const desktop = chatService.createSession({ mode: 'agent' })
  const sink = new HeadlessSink()
  const before = toolRuns
  const outcome = await chatService.sendAwait({ sessionId: desktop.id, content: QUESTION }, sink)
  const call = (outcome.toolCalls || [])[0]
  check('C12 桌面（senderId=null）→ 闸门跳过，走到 permissionGate 的 ask 分支', sink.approvals.length === 1, sink.approvals.length)
  check('C12 桌面拒绝文案是 P3 的「用户拒绝或审批超时」，不是渠道闸门的文案', Boolean(call) && /用户拒绝|审批超时/.test(String(call.error)), call ? call.error : '')
  check('C12 桌面工具的 run 未被调用（无审批能力 → 当场拒绝）', toolRuns === before, toolRuns)
  settingsStore.save({ permission: { mode: 'full' } })
}

{
  // ⑤ 有工具权限 + approve + 无审批能力 sink → permissionGate 照常工作（C6）
  const before = toolRuns
  const sink = new QqSink(() => {}, '20002')
  settingsStore.save({ permission: { mode: 'approve' } })
  const outcome = await chatService.sendAwait({ sessionId: SESSION_ID, content: QUESTION }, sink)
  const call = (outcome.toolCalls || [])[0]
  check('C6 有工具权限 + approve + QQ（无卡可弹）→ 仍被 permissionGate 拒（P3 行为不变）', Boolean(call) && call.status === 'denied', call ? call.status : '')
  check('C6 这一条真的走到了审批分支（票据 1 张），说明不是被渠道闸门挡下', sink.approvals.length === 1, sink.approvals.length)
  check('C6 工具没有被执行', toolRuns === before, toolRuns)
  settingsStore.save({ permission: { mode: 'full' } })
}

/* ── 汇总 ───────────────────────────────────────────────────────────────── */

const failed = results.filter((item) => !item.ok)
console.log('')
console.log('channels-tool-gate: ' + String(results.length - failed.length) + '/' + String(results.length) + ' passed')
if (failed.length > 0) {
  console.log('失败：')
  for (const item of failed) console.log('  - ' + item.label)
  process.exitCode = 1
} else {
  console.log('PASS')
}
