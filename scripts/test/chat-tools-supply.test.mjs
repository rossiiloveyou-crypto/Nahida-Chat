/**
 * 工具供给守卫（PHASE-1 · T6）。
 *
 * 守的是**能力判定层**这一条真逻辑（capability.ts），不是「再实现一遍」——
 * 断言全部用真函数 + 真注册表 + 真 settingsStore，不复制里面任何判断。
 *
 * 对照物（经验库 P17）：A-02 与 A-03 成对判定。
 * 只有「agent 拿满」和「chat 未开拿空」同时绿，才能证明那个 0 不是「函数恒返回空」。
 *
 * 跑法：pnpm test:chat-tools-supply（或在 pnpm test 链尾）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')

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

const results = []
function check(label, ok, extra) {
  results.push({ label, ok: Boolean(ok) })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-chat-tools-supply-'))
const userData = path.join(sandbox, 'userData')
fs.mkdirSync(userData, { recursive: true })

// 「老配置」形态：**没有 chatTools 字段**。缺省必须等于全部关闭。
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify(
    {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test-0123456789',
      model: 'test-model',
      temperature: 0,
      defaultCharacterId: 'nahida',
      permission: { mode: 'approve' },
      memory: { enabled: false, autoExtract: false }
    },
    null,
    2
  ),
  'utf8'
)

const esbuild = loadEsbuild()
const entry = path.join(sandbox, 'entry.ts')
const p = (rel) => path.join(projectRoot, rel).replace(/\\/g, '/')
fs.writeFileSync(
  entry,
  [
    "export { resolveToolSupply } from '" + p('src/main/features/tools/capability.ts') + "'",
    "export { registerBuiltinTools } from '" + p('src/main/features/tools/builtin.ts') + "'",
    "export { listDefinitions } from '" + p('src/main/features/tools/registry.ts') + "'"
  ].join('\n'),
  'utf8'
)

const outfile = path.join(sandbox, 'bundle.cjs')
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['electron'],
  alias: { '@shared': path.join(projectRoot, 'src/shared') },
  logLevel: 'silent'
})

const stubPath = path.join(sandbox, 'electron-stub.cjs')
fs.writeFileSync(
  stubPath,
  'module.exports = { app: { getPath: () => ' +
    JSON.stringify(userData) +
    ', getAppPath: () => ' +
    JSON.stringify(projectRoot) +
    ', isPackaged: false, getVersion: () => "0.1.0", getName: () => "Nahida Chat", on: () => {}, whenReady: async () => {} },' +
    ' shell: { openPath: async () => "", openExternal: async () => "" },' +
    ' ipcMain: { handle: () => {}, on: () => {} },' +
    ' nativeTheme: { shouldUseDarkColors: false, themeSource: "system", on: () => {} } }',
  'utf8'
)
const Module = require('node:module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stubPath
  return originalResolve.call(this, request, ...rest)
}

const { resolveToolSupply, registerBuiltinTools, listDefinitions } = require(outfile)
registerBuiltinTools()
const allTools = listDefinitions()

const call = (over) => resolveToolSupply({ mode: 'chat', allTools, isChannel: false, ...over })
const names = (list) => list.map((tool) => tool.name).join(',')

console.log('工具供给判定层（capability.resolveToolSupply）')

// 对照物先立：注册表为空时下面所有「= 0」都通过得毫无意义。
check('对照物：注册表非空', allTools.length > 0, 'registered=' + allTools.length)

// ── A-02 / A-03 成对 ────────────────────────────────────────
check(
  'A-02 agent 返回全部工具（与改动前一致）',
  call({ mode: 'agent' }).length === allTools.length,
  'agent=' + call({ mode: 'agent' }).length + ' all=' + allTools.length
)

check(
  'A-03 chat + 无 chatTools（老配置）→ 空',
  call({ chatTools: undefined }).length === 0,
  'n=' + call({ chatTools: undefined }).length
)

check(
  'A-04 chat + enabled:false → 空',
  call({ chatTools: { enabled: false, tools: { 'fs.list_dir': true } } }).length === 0,
  'n=' + call({ chatTools: { enabled: false, tools: { 'fs.list_dir': true } } }).length
)

// ── 严格 opt-in ────────────────────────────────────────────
const oneOn = call({ chatTools: { enabled: true, tools: { 'fs.list_dir': true } } })
check(
  'A-05 chat + enabled:true + 勾 1 个 → 恰好 1 个且是它',
  oneOn.length === 1 && oneOn[0].name === 'fs.list_dir',
  'n=' + oneOn.length + ' names=' + names(oneOn)
)

check(
  'A-06 chat + enabled:true + 空 tools → 空（勾总开关不等于全给）',
  call({ chatTools: { enabled: true, tools: {} } }).length === 0,
  'n=' + call({ chatTools: { enabled: true, tools: {} } }).length
)

check(
  'A-06b chat + enabled:true + tools 缺省 → 空（同上，缺省不兜底）',
  call({ chatTools: { enabled: true } }).length === 0,
  'n=' + call({ chatTools: { enabled: true } }).length
)

check(
  'A-06c chat + enabled:true + 勾了不存在的工具名 → 空（不给幽灵工具发目录）',
  call({ chatTools: { enabled: true, tools: { 'no.such_tool': true } } }).length === 0,
  'n=' + call({ chatTools: { enabled: true, tools: { 'no.such_tool': true } } }).length
)

// ── 群聊开关（M02：默认开）────────────────────────────────
const groupBase = { isChannel: true, channelChatType: 'group' }

check(
  'A-07 群聊 + enabled:true + groupEnabled:true → 有工具',
  call({ ...groupBase, chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: true } }).length === 1,
  'n=' + call({ ...groupBase, chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: true } }).length
)

check(
  'A-08 群聊 + enabled:true + groupEnabled:false → 空（M02 群聊开关生效）',
  call({ ...groupBase, chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: false } }).length === 0,
  'n=' + call({ ...groupBase, chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: false } }).length
)

check(
  'A-08b 群聊 + groupEnabled 缺省 → 有工具（M02 默认开启，不得写成 !== true）',
  call({ ...groupBase, chatTools: { enabled: true, tools: { 'fs.list_dir': true } } }).length === 1,
  'n=' + call({ ...groupBase, chatTools: { enabled: true, tools: { 'fs.list_dir': true } } }).length
)

check(
  'A-09 私聊 + enabled:true + groupEnabled:false → 仍有工具（群聊开关不影响私聊）',
  call({
    isChannel: true,
    channelChatType: 'private',
    chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: false }
  }).length === 1,
  'n=' + call({
    isChannel: true,
    channelChatType: 'private',
    chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: false }
  }).length
)

check(
  'A-09b 桌面会话 + enabled:true + groupEnabled:false → 仍有工具（群聊开关作用域只到群）',
  call({ isChannel: false, chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: false } }).length === 1,
  'n=' + call({ isChannel: false, chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: false } }).length
)

// ── 故事模式（M10）────────────────────────────────────────
check(
  'A-10 故事模式 → 恒空（即使 chatTools 全开）',
  call({ mode: 'story', chatTools: { enabled: true, tools: { 'fs.list_dir': true } } }).length === 0,
  'n=' + call({ mode: 'story', chatTools: { enabled: true, tools: { 'fs.list_dir': true } } }).length
)

check(
  'A-10b 故事模式 → 恒空（即使 groupEnabled 全开且是群聊）',
  call({
    mode: 'story',
    isChannel: true,
    channelChatType: 'group',
    chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: true }
  }).length === 0,
  'n=' + call({
    mode: 'story',
    isChannel: true,
    channelChatType: 'group',
    chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: true }
  }).length
)

// ── 纯函数纪律：不得修改入参 ───────────────────────────────
const frozen = Object.freeze({
  mode: 'agent',
  allTools: Object.freeze(allTools.slice()),
  isChannel: false
})
let mutationError = ''
let mutated = 0
try {
  mutated = resolveToolSupply(frozen).length
} catch (error) {
  mutationError = error && error.message ? error.message : String(error)
}
check(
  'A-02b agent 分支返回副本而非入参本身（纯函数，不改调用方数组）',
  !mutationError && mutated === allTools.length,
  mutationError || 'n=' + mutated
)

const failed = results.filter((row) => !row.ok)
console.log('')
console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项')
if (failed.length > 0) {
  console.log('失败：')
  for (const row of failed) console.log('  - ' + row.label)
  process.exit(1)
}
console.log('PASS chat-tools-supply')
