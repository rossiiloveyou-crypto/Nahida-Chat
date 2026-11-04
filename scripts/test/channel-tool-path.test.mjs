/**
 * 渠道工具路径守卫（PHASE-3 · T6）—— A-01…A-09。
 *
 * 守的是**真实现**：真 chatService + 真 settingsStore + 真 permissionGate，
 * 断言全部走「真跑一轮」，不是「再抄一遍判定逻辑」（P17：抄一遍只会验自己）。
 *
 * 三条主线：
 *   ① 渠道会话在没有 workspace 时有自己的根（M21），桌面会话仍然抛原错误（对照物）；
 *   ② 渠道拒绝理由面向 QQ（M03），桌面理由仍逐字是「用户拒绝或审批超时」（对照物）；
 *   ③ QqSink.canApprove() 恒 false —— M03 成立的前提。
 *
 * 🔴 对照物成对（P17 / P13）：
 *   A-02（渠道有根）必须有 A-03（桌面仍抛错）；A-07（渠道新文案）必须有 A-08（桌面旧文案）。
 *   只有一边时，一个「把 check 整个删掉」的实现也能全绿。
 *
 * 跑法：pnpm test:channel-tool-path（在 pnpm test 链尾）
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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-channel-path-'))
const userData = path.join(sandbox, 'userData')
fs.mkdirSync(userData, { recursive: true })
// 权限模式 full：让「有工具」的路径真的执行下来，这样能观测到 root 到底落在哪。
// 工作区清单**留空**且 workspaceOptOut=true：模拟「用户把工作区全删了」的零工作区现场。
// 🔴 这一条是本套件的地基：清单非空时 resolveWorkspace 永远返回一条，A-02/A-03 就测不到分支。
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    memory: { enabled: false, autoExtract: false },
    permission: { mode: 'full' },
    workspaces: [],
    activeWorkspaceId: null,
    workspaceOptOut: true,
    chatTools: { enabled: true, tools: { 'fs.list_dir': true } }
  }),
  'utf8'
)

// 渠道授权真源：授权层（channels/toolGate.ts）是 fail-closed 的 —— 白名单里没有这个人，
// 工具在 permissionGate 之前就被拦下，于是 toolScopeOf 根本不会被调用，A-02/A-04/A-05 就观测不到 root。
// 🔴 所以本套件必须**先给足授权**，让每一条用例都真的走到「执行层」，测的才是 scope 而不是闸门。
const accessDir = path.join(userData, 'channels')
fs.mkdirSync(accessDir, { recursive: true })
const TOOL_ACCOUNT = '20002'
const PRIVATE_ACCOUNT = '10001'
fs.writeFileSync(
  path.join(accessDir, 'access.json'),
  JSON.stringify({
    version: 2,
    groupMemberGate: false,
    toolGate: true,
    accounts: [
      { channel: 'qq', userId: TOOL_ACCOUNT, label: '', addedAt: 1, lastAt: 0, permissions: { private: true, group: true, tool: true } },
      { channel: 'qq', userId: PRIVATE_ACCOUNT, label: '', addedAt: 1, lastAt: 0, permissions: { private: true, group: true, tool: true } }
    ],
    groups: [{ channel: 'qq', chatId: '88888', label: '测试群', addedAt: 1, lastAt: 0 }],
    uins: ['10001']
  }),
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
    `export { settingsStore, defaultChannelWorkspaceDir, defaultWorkspaceRoot } from '${p('src/main/features/settings/settingsStore.ts')}'`,
    `export { isChannelSessionId } from '${p('src/shared/channels.ts')}'`,
    `export { permissionGate } from '${p('src/main/features/tools/permission.ts')}'`
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
  settingsStore,
  defaultChannelWorkspaceDir,
  defaultWorkspaceRoot,
  isChannelSessionId,
  permissionGate
} = mod
registerBuiltinTools()

const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8')

/* ── A-01 契约 ─────────────────────────────────────────────────────────── */

console.log('A-01 · 契约：Settings.channelWorkspaceDir?')
{
  const typesSrc = read('src/shared/types.ts')
  const hits = (typesSrc.match(/channelWorkspaceDir\?\??:/g) || []).length
  check('A-01a types.ts 声明了 channelWorkspaceDir 字段', hits >= 1, hits)
  // 三端契约只做加法：必须是可选字段（老配置没有它也要能读）
  check('A-01b 该字段是**可选**（带 ?），老配置无损', /channelWorkspaceDir\?:/.test(typesSrc))
  const storeSrc = read('src/main/features/settings/settingsStore.ts')
  check(
    'A-01c settingsStore 导出了 defaultChannelWorkspaceDir()',
    /export function defaultChannelWorkspaceDir\s*\(/.test(storeSrc)
  )
  // B2：缺省值只在一处定义 —— defaultSettings() 里不许出现这个字段（否则落盘会存冗余值）
  const defaultBlock = storeSrc.slice(storeSrc.indexOf('export function defaultSettings'))
  const defaultHead = defaultBlock.slice(0, defaultBlock.indexOf('\n}\n'))
  check(
    'A-01d defaultSettings() 里**不**写这个字段（缺省值单一载体）',
    !defaultHead.includes('channelWorkspaceDir')
  )
}

/* ── 工具桩：把 fs.list_dir 换成能回报「我拿到的 root」的探针 ───────────── */

// 为什么换掉 run 而不是读 record.result：
//   record.result 只是工具的输出文本，root 是 runTool 传给 executeTool 的**入参**。
//   想知道 toolScopeOf 到底给了什么根，只能在工具实现里把它记下来（这才是真边界）。
const seenScopes = []
registerTool({
  definition: { ...listDefinitions().find((item) => item.name === 'fs.list_dir'), readOnly: true },
  async run(_args, context) {
    seenScopes.push({ ...context.scope })
    return { ok: true, output: '桩工具：root=' + context.scope.root }
  }
})

const QUESTION = '看看工作区里有什么文件'
const lastScope = () => seenScopes[seenScopes.length - 1]

/* ── A-02 / A-03：渠道有根 vs 桌面仍抛错（对照物成对） ──────────────────── */

console.log('A-02/A-03 · toolScopeOf 的渠道分支与桌面原路径')
const CHANNEL_KEY = 'qq:10001:group:88888'
{
  check('前置：channelWorkspaceDir 未配置时读出来是 undefined', settingsStore.get().channelWorkspaceDir === undefined)

  chatService.ensureChannelSession(CHANNEL_KEY, { title: '测试群' })
  check('前置：渠道会话存在且 workspaceId 为 null', chatService.listSessions().find((s) => s.id === CHANNEL_KEY)?.workspaceId === null)

  const before = seenScopes.length
  const outcome = await chatService.sendAwait({ sessionId: CHANNEL_KEY, content: QUESTION }, new QqSink(() => {}, TOOL_ACCOUNT))
  const call = (outcome.toolCalls || [])[0]
  const scope = seenScopes.length > before ? lastScope() : null

  check('A-02a 渠道会话在零工作区时**有** root（不抛「当前没有工作区」）', Boolean(scope) && Boolean(scope.root), scope ? scope.root : '没有执行到工具')
  check(
    'A-02b root === defaultChannelWorkspaceDir()（缺省走渠道根）',
    Boolean(scope) && scope.root === defaultChannelWorkspaceDir(),
    scope ? scope.root + ' vs ' + defaultChannelWorkspaceDir() : '-'
  )
  check('A-02c 工具真的执行成功（不是被兜成 error）', Boolean(call) && call.status === 'ok', call ? call.status + ' / ' + call.error : '没有 toolCall')
  check('A-02d 渠道根不是桌面的活动工作区（没有借用桌面目录）', Boolean(scope) && scope.root === defaultWorkspaceRoot(), scope ? scope.root : '-')

  // A-03 对照物：桌面会话在同样零工作区条件下必须仍抛原错误
  const desktop = chatService.createSession({ mode: 'agent' })
  check('A-03 前置：桌面会话 workspaceId 也是 null', desktop.workspaceId === null)
  const beforeDesktop = seenScopes.length
  const desktopOutcome = await chatService.sendAwait({ sessionId: desktop.id, content: QUESTION }, new HeadlessSink())
  const desktopCall = (desktopOutcome.toolCalls || [])[0]
  check(
    'A-03a 桌面会话仍被拦下（没有执行到工具）',
    seenScopes.length === beforeDesktop,
    seenScopes.length - beforeDesktop
  )
  check(
    'A-03b 桌面错误文案含「当前没有工作区」（原错误逐字保留）',
    Boolean(desktopCall) && String(desktopCall.error).includes('当前没有工作区'),
    desktopCall ? desktopCall.error : '没有 toolCall'
  )
}

/* ── A-04：配置了 channelWorkspaceDir 时渠道用它 ───────────────────────── */

console.log('A-04 · 配置值优先')
const CUSTOM_DIR = path.join(sandbox, 'channel-custom')
fs.mkdirSync(CUSTOM_DIR, { recursive: true })
{
  settingsStore.save({ channelWorkspaceDir: CUSTOM_DIR })
  check('前置：配置已落盘', settingsStore.get().channelWorkspaceDir === CUSTOM_DIR, settingsStore.get().channelWorkspaceDir)
  const raw = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
  check('A-04a 配置真的写进 settings.json（不是只在内存）', raw.channelWorkspaceDir === CUSTOM_DIR, raw.channelWorkspaceDir)

  const before = seenScopes.length
  await chatService.sendAwait({ sessionId: CHANNEL_KEY, content: QUESTION }, new QqSink(() => {}, TOOL_ACCOUNT))
  const scope = seenScopes.length > before ? lastScope() : null
  check('A-04b 渠道 root === 配置值', Boolean(scope) && scope.root === CUSTOM_DIR, scope ? scope.root : '-')
  check('A-04c 渠道 root 不再是缺省值', Boolean(scope) && scope.root !== defaultChannelWorkspaceDir(), scope ? scope.root : '-')
}

/* ── A-05：渠道会话已绑 workspace 时仍用绑定的（陷阱 2 的对照物） ───────── */

console.log('A-05 · 已绑定工作区的渠道会话不被渠道根覆盖')
const BOUND_DIR = path.join(sandbox, 'bound-workspace')
fs.mkdirSync(BOUND_DIR, { recursive: true })
{
  const id = 'bound-workspace-id'
  settingsStore.save({
    workspaces: [{ id, name: '绑定区', dir: BOUND_DIR, createdAt: Date.now(), updatedAt: Date.now() }],
    activeWorkspaceId: id
  })
  const boundKey = 'qq:10001:private:77777'
  chatService.ensureChannelSession(boundKey, { title: '私聊' })
  // ensureChannelSession 建完会把 workspaceId 清成 null；这里显式绑回去，
  // 模拟「历史数据里已经绑过工作区的渠道会话」（判断顺序写错时这类会话会被覆盖）。
  chatService.updateSession(boundKey, { workspaceId: id })
  check('A-05 前置：渠道会话真的绑上了工作区', chatService.listSessions().find((item) => item.id === boundKey)?.workspaceId === id)

  const before = seenScopes.length
  await chatService.sendAwait({ sessionId: boundKey, content: QUESTION }, new QqSink(() => {}, '10001'))
  const scope = seenScopes.length > before ? lastScope() : null
  check('A-05a 已绑工作区的渠道会话 root === 该工作区 dir', Boolean(scope) && scope.root === BOUND_DIR, scope ? scope.root : '-')
  check('A-05b 没有被渠道根覆盖', Boolean(scope) && scope.root !== CUSTOM_DIR, scope ? scope.root : '-')

  // 桌面会话在同一配置下也用绑定的工作区（三步回落的原行为不变）
  const desktop2 = chatService.createSession({ mode: 'agent' })
  const before2 = seenScopes.length
  await chatService.sendAwait({ sessionId: desktop2.id, content: QUESTION }, new HeadlessSink())
  const scope2 = seenScopes.length > before2 ? lastScope() : null
  check('A-05c 桌面对照：root === 活动工作区 dir', Boolean(scope2) && scope2.root === BOUND_DIR, scope2 ? scope2.root : '-')
}

/* ── A-06：defaultChannelWorkspaceDir() 的目录真实存在 ─────────────────── */

console.log('A-06 · 缺省目录真实存在')
{
  const dir = defaultChannelWorkspaceDir()
  check('A-06a 缺省目录 existsSync === true', fs.existsSync(dir), dir)
  check('A-06b 它就在 userData 下（不是进程 cwd 或盘根）', dir.startsWith(userData), dir)
  fs.rmSync(dir, { recursive: true, force: true })
  const again = defaultChannelWorkspaceDir()
  check('A-06c 目录被删掉后再次调用会重建（mkdirSync recursive）', fs.existsSync(again), again)
}

/* ── A-07 / A-08 / A-09：拒绝理由与 QqSink ─────────────────────────────── */

console.log('A-07/A-08/A-09 · 拒绝理由的两条分支（对照物成对）')
{
  // A-09：M03 的前提 —— QQ 侧没有卡片可点
  const qq = new QqSink(() => {}, TOOL_ACCOUNT)
  check('A-09  QqSink.canApprove() 恒 false（M03 前提）', qq.canApprove() === false)
  check('A-09b QqSink.canApprove 是方法而不是属性（typeof === function）', typeof qq.canApprove === 'function')

  // 保持上面那份 access.json 不动（同一语义只留一处载体，B2）：
  // 本条要观测的是 permissionGate 的 ask 分支，授权层已经在 TOOL_ACCOUNT 上放行了。

  // 有副作用工具 + approve 模式 = 一定走 ask 分支
  registerTool({
    definition: { ...listDefinitions().find((item) => item.name === 'fs.list_dir'), readOnly: false },
    async run() {
      return { ok: true, output: '不该被执行' }
    }
  })
  settingsStore.save({ permission: { mode: 'approve' } })

  // A-07：渠道（canApprove=false）
  const channelSink = new QqSink(() => {}, TOOL_ACCOUNT)
  const channelOutcome = await chatService.sendAwait({ sessionId: CHANNEL_KEY, content: QUESTION }, channelSink)
  const channelCall = (channelOutcome.toolCalls || [])[0]
  const channelError = channelCall ? String(channelCall.error ?? '') : ''
  check('A-07a 渠道拒绝理由**不含**「用户拒绝」', Boolean(channelCall) && !channelError.includes('用户拒绝'), channelError)
  check('A-07b 渠道拒绝理由**不含**「审批超时」', Boolean(channelCall) && !channelError.includes('审批超时'), channelError)
  check(
    'A-07c 渠道拒绝理由含「不支持交互式审批」',
    Boolean(channelCall) && channelError.includes('不支持交互式审批'),
    channelError
  )
  check(
    'A-07d 渠道拒绝理由不含内部术语（canApprove / permissionGate）',
    !/canApprove|permissionGate/.test(channelError),
    channelError
  )
  check('A-07e 这一条真的走到了审批分支（票据 1 张）', channelSink.approvals.length === 1, channelSink.approvals.length)
  check('A-07f 工具没有被执行', channelCall ? channelCall.status === 'denied' : false, channelCall ? channelCall.status : '-')

  // A-08 对照物：桌面（canApprove === true）用户点了「拒绝」→ 文案必须逐字不变。
  // 🔴 必须真跑一轮：只 grep 源码里的字符串，一个「把整段删掉」的实现也能让它绿。
  class RejectingSink extends HeadlessSink {
    canApprove() {
      return true
    }
    presentApproval(ticket) {
      super.presentApproval(ticket)
      // 模拟用户点了「拒绝」：结算仍归 permissionGate（sink 不自己 resolve 结论）
      setImmediate(() => permissionGate.resolve({ requestId: ticket.requestId, approved: false, remember: false }))
    }
  }

  const desktop = chatService.createSession({ mode: 'agent' })
  const desktopSink = new RejectingSink()
  const desktopOutcome = await chatService.sendAwait({ sessionId: desktop.id, content: QUESTION }, desktopSink)
  const desktopCall = (desktopOutcome.toolCalls || [])[0]
  const desktopError = desktopCall ? String(desktopCall.error ?? '') : ''
  check('A-08a 桌面这一轮真的走到了审批分支（票据 1 张）', desktopSink.approvals.length === 1, desktopSink.approvals.length)
  check(
    'A-08b 桌面拒绝理由**逐字**是「用户拒绝或审批超时」（A-07 的对照物）',
    desktopError === '用户拒绝或审批超时',
    desktopError
  )
  check('A-08c 桌面文案里**没有**渠道那句（两条分支互不串味）', !desktopError.includes('不支持交互式审批'), desktopError)

  settingsStore.save({ permission: { mode: 'full' } })
}

/* ── 汇总 ──────────────────────────────────────────────────────────────── */

const failed = results.filter((item) => !item.ok)
console.log('')
// 🔴 与 qq-test-util 的 createChecker 保持同一汇总口径（「共 N 项，通过 N 项」），
//    否则基线 BASELINE.txt 的 cases 求和不含本套件，新增的 35 条断言在基线上是不可见的。
console.log('共 ' + String(results.length) + ' 项，通过 ' + String(results.length - failed.length) + ' 项')
console.log('channel-tool-path: ' + String(results.length - failed.length) + '/' + String(results.length) + ' passed')
if (failed.length > 0) {
  console.log('失败：')
  for (const item of failed) console.log('  - ' + item.label)
  process.exitCode = 1
} else {
  console.log('PASS')
}