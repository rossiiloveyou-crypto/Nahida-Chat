/**
 * chatTools 深合并守卫（PHASE-2 · T4）。
 *
 * 守的是**主进程 settingsStore.save() 的真实现**，不是「再抄一遍合并逻辑」：
 * 断言全部走真 store + 真落盘文件（userData/settings.json），用 esbuild 打成 CJS、
 * 把 electron 换成 app.getPath 桩，和 settings-store.test.mjs 同一套手法。
 *
 * 为什么必须守这里（P2 §2.1 E1）：
 *   save() 原先是 `{ ...this.get(), ...patch }` 浅合并，
 *   一次只传 { chatTools: { groupEnabled: false } } 会把整个 chatTools 覆盖掉 ——
 *   用户在工具权限页勾的 enabled / tools 全部丢失，而且是**静默**丢失。
 *
 * 对照物（经验库 P17 / P13）：断言 1 与断言 2 成对。
 *   「保留旧字段」只有在「新字段确实写进去了」同时成立时才有意义，
 *   否则一个恒返回旧值的坏实现也能让「保留」全绿。
 *
 * 跑法：pnpm test:chat-tools-settings（或在 pnpm test 链尾）
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
  results.push({ label, ok: Boolean(ok), extra })
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' :: ' + String(extra)))
}

const userData = path.join(os.tmpdir(), 'nahida-chat-tools-settings-' + process.pid + '-' + Date.now())
fs.mkdirSync(userData, { recursive: true })

const stubPath = path.join(userData, 'electron-stub.cjs')
fs.writeFileSync(
  stubPath,
  'module.exports = {' +
    ' app: { getPath: () => ' + JSON.stringify(userData) + ',' +
    ' getAppPath: () => ' + JSON.stringify(projectRoot) + ',' +
    ' isPackaged: false },' +
    " shell: { openPath: async () => '' }" +
    ' }',
  'utf8'
)

const outFile = path.join(userData, 'settingsStore.cjs')
await loadEsbuild().build({
  entryPoints: [path.join(projectRoot, 'src/main/features/settings/settingsStore.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: outFile,
  external: ['electron'],
  alias: { '@shared': path.join(projectRoot, 'src/shared') },
  logLevel: 'silent'
})

// 另打一份 capability.ts：A-09…A-11b 要证明「落盘的配置进得了判定层」。
// 它是纯函数（不 import electron / 不读盘），所以能直接拿实参调。
const capabilityEntry = path.join(userData, 'capability-entry.ts')
fs.writeFileSync(
  capabilityEntry,
  "export { resolveToolSupply } from '" +
    path.join(projectRoot, 'src/main/features/tools/capability.ts').replace(/\\/g, '/') +
    "'",
  'utf8'
)
const capabilityOut = path.join(userData, 'capability.cjs')
await loadEsbuild().build({
  entryPoints: [capabilityEntry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: capabilityOut,
  external: ['electron'],
  alias: { '@shared': path.join(projectRoot, 'src/shared') },
  logLevel: 'silent'
})

const Module = require('node:module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stubPath
  return originalResolve.call(this, request, ...rest)
}

function reloadStore() {
  delete require.cache[require.resolve(outFile)]
  return require(outFile).settingsStore
}

function writeSettings(value) {
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(value, null, 2), 'utf8')
}

function readSettings() {
  return JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
}

try {
  // 起点：老配置（**没有 chatTools 字段** —— 这正是全部真实用户的现状）
  writeSettings({
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-old',
    model: 'deepseek-chat',
    temperature: 0.7,
    permission: { mode: 'approve' }
  })

  let store = reloadStore()
  check('起点：老配置没有 chatTools 字段', store.get().chatTools === undefined)

  // ---- 断言 5（先跑：它决定缺省方向，后面的断言都建立在它之上）----
  // 深合并**不能**把缺省的 groupEnabled 填成 false：那会把 M02 的「默认开」变成「默认关」。
  store.save({ chatTools: { enabled: true } })
  let settings = reloadStore().get()
  check('断言 5：老配置 + 只传 enabled → enabled 写入', settings.chatTools?.enabled === true, JSON.stringify(settings.chatTools))
  check(
    '断言 5：groupEnabled 仍为 undefined（不许被填成 false，M02 默认开）',
    settings.chatTools?.groupEnabled === undefined,
    String(settings.chatTools?.groupEnabled)
  )
  // tools 允许是 undefined 或被并成空对象：两种都表示「一个也没勾」，
  // 但**不许**凭空多出任何键（多出一个键 = 给模型发了一个用户没勾过的工具）。
  check(
    "断言 5：tools 里一个键都没有（undefined 与 {} 等价，都表示没勾）",
    settings.chatTools?.tools === undefined || Object.keys(settings.chatTools?.tools ?? {}).length === 0,
    JSON.stringify(settings.chatTools?.tools)
  )

  // ---- 断言 1：只传 tools 的一个键 → enabled 保留、新增键写入 ----
  // 成对判定：enabled 必须在（保住），新工具必须真的进（写入成功）。
  store.save({ chatTools: { tools: { 'fs.list_dir': true } } })
  settings = reloadStore().get()
  check('断言 1：enabled 被保留（浅合并会把它冲成 undefined）', settings.chatTools?.enabled === true, String(settings.chatTools?.enabled))
  check("断言 1：tools['fs.list_dir'] 真的写进去了", settings.chatTools?.tools?.['fs.list_dir'] === true, JSON.stringify(settings.chatTools?.tools))

  // ---- 断言 3：只传 groupEnabled → enabled 与 tools 全保留 ----
  store.save({ chatTools: { groupEnabled: false } })
  settings = reloadStore().get()
  check('断言 3：groupEnabled 写入 false', settings.chatTools?.groupEnabled === false, String(settings.chatTools?.groupEnabled))
  check('断言 3：enabled 保留 true', settings.chatTools?.enabled === true, String(settings.chatTools?.enabled))
  check("断言 3：tools['fs.list_dir'] 保留", settings.chatTools?.tools?.['fs.list_dir'] === true, JSON.stringify(settings.chatTools?.tools))

  // ---- 断言 2：再传一次别的工具 → 旧工具键不被清掉（逐键合并，不是整体替换）----
  store.save({ chatTools: { tools: { 'clock.now': true } } })
  settings = reloadStore().get()
  check("断言 2：旧键 tools['fs.list_dir'] 未被冲掉", settings.chatTools?.tools?.['fs.list_dir'] === true, JSON.stringify(settings.chatTools?.tools))
  check("断言 2：新键 tools['clock.now'] 已写入", settings.chatTools?.tools?.['clock.now'] === true, JSON.stringify(settings.chatTools?.tools))
  check('断言 2：groupEnabled 仍是 false（上一次写入未被这次覆盖）', settings.chatTools?.groupEnabled === false, String(settings.chatTools?.groupEnabled))

  // ---- 断言 4：完全不传 chatTools → 原样保留（同一 patch 的其它字段照常生效）----
  // 用 permission 做「其它字段」的对照：temperature 在当前实现里是档案镜像（profile → 扁平），
  // 单传扁平字段会被 normalizeProfiles 覆盖回去，那不是合并逻辑的问题，做对照只会误判。
  store.save({ permission: { mode: 'readonly' } })
  settings = reloadStore().get()
  check('断言 4：不传 chatTools 时整块原样保留', JSON.stringify(settings.chatTools) === JSON.stringify({ enabled: true, tools: { 'fs.list_dir': true, 'clock.now': true }, groupEnabled: false }), JSON.stringify(settings.chatTools))
  check('断言 4：同一 patch 的其它字段照常生效', settings.permission.mode === 'readonly', settings.permission.mode)

  // ---- 落盘：重启后（新进程视图）读回的必须是合并结果，不是内存幻觉 ----
  const persisted = readSettings()
  check('落盘：settings.json 里 chatTools 三字段齐全', persisted.chatTools && persisted.chatTools.enabled === true && persisted.chatTools.groupEnabled === false && persisted.chatTools?.tools?.['fs.list_dir'] === true, JSON.stringify(persisted.chatTools))
  const reopened = reloadStore().get()
  check('落盘：重启后读回一致', JSON.stringify(reopened.chatTools) === JSON.stringify(settings.chatTools), JSON.stringify(reopened.chatTools))

  // ---- 反向边界：显式传 enabled:false 必须真的关掉（合并逻辑不许「只会加不会减」）----
  reloadStore().save({ chatTools: { enabled: false } })
  settings = reloadStore().get()
  check('边界：显式 enabled:false 生效（合并不是只会加不会减）', settings.chatTools?.enabled === false, String(settings.chatTools?.enabled))
  check('边界：关总开关不动 tools（重新打开时勾选还在）', settings.chatTools?.tools?.['fs.list_dir'] === true, JSON.stringify(settings.chatTools?.tools))

  // ---- 反向边界：chatTools 传空对象 → 什么都不变 ----
  reloadStore().save({ chatTools: {} })
  const afterEmpty = reloadStore().get()
  check('边界：传空 chatTools 不改变任何字段', afterEmpty.chatTools?.enabled === false && afterEmpty.chatTools?.groupEnabled === false && afterEmpty.chatTools?.tools?.['clock.now'] === true, JSON.stringify(afterEmpty.chatTools))

  // ── A-09 / A-10 / A-11：端到端 —— 落盘的配置真的进得了 P1 的判定层 ──
  // 这一组是本 Phase 的动因（J-01：看得见但不出效果的开关不算存在）。
  // 它不重算 UI，只回答一件事：**UI 存下去的那份 chatTools，判定层读到的和它一致吗**。
  const capability = require(capabilityOut)
  const toolNames = ['fs.list_dir', 'clock.now']
  const fakeTools = toolNames.map((name) => ({
    name,
    title: name,
    description: '',
    readOnly: true,
    parameters: {}
  }))
  const supply = (over) =>
    capability.resolveToolSupply({ mode: 'chat', allTools: fakeTools, isChannel: false, ...over })

  // A-09：勾一个工具 → 供给非空
  // 每段从干净配置起步：深合并会把前面段落勾过的工具留着（那是它的正确行为），
  // 不重置的话这里数出来的是「上一段 + 这一段」，看起来像判定层多给了工具。
  writeSettings({ provider: 'mock', model: 'demo', temperature: 0.7, permission: { mode: 'approve' } })
  reloadStore().save({ chatTools: { enabled: true, tools: { 'fs.list_dir': true }, groupEnabled: true } })
  const uiCfg = reloadStore().get().chatTools
  const supplied = supply({ chatTools: uiCfg })
  check('A-09 勾了 fs.list_dir → 供给恰好 1 个且是它', supplied.length === 1 && supplied[0].name === 'fs.list_dir', 'n=' + supplied.length)

  // A-10：关总开关 → 供给空（工具勾选还在，但一个都不给）
  reloadStore().save({ chatTools: { enabled: false } })
  const offCfg = reloadStore().get().chatTools
  check('A-10 关总开关 → 供给 0（勾选仍保留在配置里）', supply({ chatTools: offCfg }).length === 0 && Object.keys(offCfg.tools).length > 0, JSON.stringify(offCfg))

  // A-11：群聊开关关 → 群 0 / 私聊与桌面仍有（同样从干净配置起步）
  writeSettings({ provider: 'mock', model: 'demo', temperature: 0.7, permission: { mode: 'approve' } })
  reloadStore().save({ chatTools: { enabled: true, groupEnabled: false, tools: { 'fs.list_dir': true } } })
  const groupOff = reloadStore().get().chatTools
  check(
    'A-11 关群聊开关 → 群聊 0 / 私聊 1 / 桌面 1',
    supply({ chatTools: groupOff, isChannel: true, channelChatType: 'group' }).length === 0 &&
      supply({ chatTools: groupOff, isChannel: true, channelChatType: 'private' }).length === 1 &&
      supply({ chatTools: groupOff }).length === 1,
    'group=' + supply({ chatTools: groupOff, isChannel: true, channelChatType: 'group' }).length +
      ' private=' + supply({ chatTools: groupOff, isChannel: true, channelChatType: 'private' }).length +
      ' desktop=' + supply({ chatTools: groupOff }).length
  )

  // A-11b 缺省方向（M02）：groupEnabled 未写过（老配置）→ 群聊仍有工具
  writeSettings({ provider: 'mock', model: 'demo', temperature: 0.7, permission: { mode: 'approve' } })
  reloadStore().save({ chatTools: { enabled: true, tools: { 'fs.list_dir': true } } })
  const legacyCfg = reloadStore().get().chatTools
  check(
    'A-11b 老配置（groupEnabled 缺省）→ 群聊仍有工具（默认开启）',
    legacyCfg.groupEnabled === undefined && supply({ chatTools: legacyCfg, isChannel: true, channelChatType: 'group' }).length === 1,
    'groupEnabled=' + String(legacyCfg.groupEnabled)
  )
} finally {
  fs.rmSync(userData, { recursive: true, force: true })
}

// ── 第 2 段：渲染层源码契约（A-04…A-08b）─────────────────────────────
//
// 渲染层没有 DOM 测试设施（既有测试全是 node 脚本跑主进程逻辑），
// 这里沿用 channels-ui-contract.test.mjs 的做法：读源码 + 断言结构。
// 它挡的是「改错方向」而不是「渲染错位」：
//   enabled 与 groupEnabled 的缺省方向相反，写反了界面看起来一样，行为却反 —— 只有源码断言能抓。
const toolsSrc = fs.readFileSync(
  path.join(projectRoot, 'src/renderer/src/features/settings/sections/ToolsSection.tsx'),
  'utf8'
)
const channelsSrc = fs.readFileSync(
  path.join(projectRoot, 'src/renderer/src/features/settings/sections/ChannelsSection.tsx'),
  'utf8'
)

check('A-04 工具权限页有「B Chat 工具增强」区域', (toolsSrc.match(/data-ui-region="B Chat 工具增强"/g) || []).length === 1)
check(
  'A-05 总开关用 === true（缺省 = 关，老配置行为不变）',
  toolsSrc.includes('chatTools?.enabled === true')
)
check(
  'A-06 群聊开关用 !== false（缺省 = 开，M02）',
  channelsSrc.includes('groupEnabled !== false')
)
check(
  'A-07 ChannelsSection 不自己再实现一遍合并（B2：同一语义两处载体）',
  !/\.\.\.chatTools/.test(channelsSrc),
  (channelsSrc.match(/\.\.\.chatTools/g) || []).length + ' 处'
)
check(
  'A-08 工具权限页保存时同时传 permission 与 chatTools（不丢字段）',
  toolsSrc.includes('save({ permission: draft.permission, chatTools')
)
check(
  'A-08b 渠道控制台走主进程深合并写局部 patch',
  channelsSrc.includes('settings.save({ chatTools: { groupEnabled')
)
check(
  'A-08c 两个新控件都带 data-ui-target（出图要能编号）',
  toolsSrc.includes('data-ui-target="Chat 工具增强总开关"') &&
    toolsSrc.includes('data-ui-target="Chat 逐工具勾选"') &&
    channelsSrc.includes('data-ui-target="群聊工具增强"')
)
// 反向：不许在渲染层硬编码色值（色值只出现在 tokens.css）
check(
  'A-08d 新增组件没有硬编码色值',
  !/#[0-9a-fA-F]{3,6}\b/.test(toolsSrc) && !/#[0-9a-fA-F]{3,6}\b/.test(channelsSrc)
)

const failed = results.filter((row) => !row.ok)
console.log('')
console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项')
if (failed.length > 0) {
  console.log('失败：')
  for (const row of failed) console.log('  - ' + row.label)
  process.exit(1)
}
console.log('PASS chat-tools-settings')