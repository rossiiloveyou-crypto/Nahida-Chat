/**
 * 模型档案落盘行为测试。
 * 重点不是"再实现一遍 normalize"，而是真实边界：
 * 旧配置（M0，没有 modelProfiles）升级、镜像字段同步、删光回归演示模式、重启后仍然读得回来。
 *
 * 跑法：pnpm test:settings
 * 实现方式：用 esbuild 把 settingsStore 打成 CJS，把 electron 换成一个只有 app.getPath 的桩，
 * 这样就能在普通 Node 里验证真实的落盘读写，而不需要起 Electron。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')

// esbuild 是 vite 的传递依赖，pnpm 下不会出现在顶层 node_modules，这里按 .pnpm 目录找
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

const esbuild = loadEsbuild()

const userData = path.join(os.tmpdir(), 'nahida-settings-test-' + process.pid + '-' + Date.now())
fs.mkdirSync(userData, { recursive: true })

const stubPath = path.join(userData, 'electron-stub.cjs')
// 桩需要 app.getPath / app.getAppPath（提示词库定位用）和 shell（本测试用不到）
fs.writeFileSync(
  stubPath,
  'module.exports = {' +
    ' app: {' +
    ' getPath: () => ' + JSON.stringify(userData) + ',' +
    ' getAppPath: () => ' + JSON.stringify(projectRoot) + ',' +
    ' isPackaged: false },' +
    ' shell: { openPath: async () => \'\' }' +
    ' }',
  'utf8'
)

const outFile = path.join(userData, 'settingsStore.cjs')
await esbuild.build({
  entryPoints: [path.join(projectRoot, 'src/main/features/settings/settingsStore.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: outFile,
  external: ['electron'],
  alias: { '@shared': path.join(projectRoot, 'src/shared') },
  logLevel: 'silent'
})

// 把 'electron' 的解析改到桩模块上
const Module = require('node:module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stubPath
  return originalResolve.call(this, request, ...rest)
}

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

function reloadStore() {
  delete require.cache[require.resolve(outFile)]
  return require(outFile)
}

function writeSettings(value) {
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(value, null, 2), 'utf8')
}

function readSettings() {
  return JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
}

try {
  // ---- 1. M0 旧配置升级：只有扁平字段 ----
  writeSettings({
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-old',
    model: 'deepseek-chat',
    temperature: 1.4,
    systemPromptId: 'system/chat.base.md',
    toolPolicy: { byRisk: { read: 'allow', write: 'ask', network: 'ask', exec: 'deny' }, byTool: {} },
    workspaceRoots: ['C:/tmp/ws']
  })

  let { settingsStore } = reloadStore()
  let settings = settingsStore.get()

  check('旧配置升级出一条档案', settings.modelProfiles.length === 1, settings.modelProfiles.length)
  check('迁移后镜像 provider 一致', settings.provider === settings.modelProfiles[0].provider)
  check('迁移后镜像 model 一致', settings.model === settings.modelProfiles[0].defaultModel, settings.model)
  check('旧 baseUrl 保留', settings.modelProfiles[0].baseUrl === 'https://api.deepseek.com/v1')
  check('旧 apiKey 保留', settings.modelProfiles[0].apiKey === 'sk-old')
  check('旧 temperature 保留', settings.modelProfiles[0].temperature === 1.4, settings.modelProfiles[0].temperature)
  // 旧配置里只有 toolPolicy + workspaceRoots：模式迁到 permission.mode，
  // 目录迁到 workspaces 清单（单工作区时代 → 清单第一条）
  check('旧 toolPolicy 迁移成权限模式', settings.permission.mode === 'approve', settings.permission.mode)
  check('旧 workspaceRoots 迁移成工作区清单', settings.workspaces.length >= 1 && settings.workspaces[0].dir.endsWith('tmp\\ws') || settings.workspaces[0].dir.endsWith('tmp/ws'), settings.workspaces.map((w) => w.dir).join(','))
  check('迁移后 activeWorkspaceId 指向真实条目', settings.workspaces.some((w) => w.id === settings.activeWorkspaceId))
  check('迁移后 permission 不再带 workspaceDir', settings.permission.workspaceDir === undefined)
  check('迁移后旧字段被清掉', settings.toolPolicy === undefined && settings.workspaceRoots === undefined)

  const firstId = settings.modelProfiles[0].id

  // ---- 2. 新增档案不会顶掉默认档案 ----
  let catalog = settingsStore.saveProfile({
    name: 'Claude',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    defaultModel: 'claude-haiku-4-5',
    temperature: 0.3,
    modelOptions: { 'claude-haiku-4-5': { contextWindowTokens: 200000, multimodal: true } }
  })
  check('新增后共两条档案', catalog.profiles.length === 2, catalog.profiles.length)
  check('默认档案不被新增改动', catalog.defaultProfileId === firstId)

  // ---- 3. 切换默认档案后镜像同步 ----
  const claude = catalog.profiles.find((item) => item.name === 'Claude')
  settingsStore.setDefaultProfile(claude.id)
  settings = settingsStore.get()
  check('切默认后镜像 provider 同步', settings.provider === 'anthropic', settings.provider)
  check('切默认后镜像 model 同步', settings.model === 'claude-haiku-4-5', settings.model)
  check('未配置的模型有默认上下文窗口', settings.modelProfiles.find((p) => p.name === 'Claude').modelOptions['claude-sonnet-4-5'].contextWindowTokens === 128000)
  check('已配置的上下文窗口保留', settings.modelProfiles.find((p) => p.name === 'Claude').modelOptions['claude-haiku-4-5'].contextWindowTokens === 200000)
  check('多模态标记保留', settings.modelProfiles.find((p) => p.name === 'Claude').modelOptions['claude-haiku-4-5'].multimodal === true)
  check('切默认后落盘', readSettings().model === 'claude-haiku-4-5')

  // ---- 4. 校验边界 ----
  function expectReject(label, draft) {
    let rejected = false
    try {
      settingsStore.saveProfile(draft)
    } catch {
      rejected = true
    }
    check(label, rejected)
  }

  expectReject('重复档案被拒绝', {
    name: 'dup', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'x',
    models: ['claude-haiku-4-5'], defaultModel: 'claude-haiku-4-5', temperature: 0.7, modelOptions: {}
  })
  expectReject('非法 baseUrl 被拒绝', {
    name: 'bad', provider: 'openai-compatible', baseUrl: 'not-a-url', apiKey: 'x',
    models: ['m'], defaultModel: 'm', temperature: 0.7, modelOptions: {}
  })
  expectReject('空模型清单被拒绝', {
    name: 'none', provider: 'openai-compatible', baseUrl: 'https://x.dev/v1', apiKey: 'x',
    models: [], defaultModel: '', temperature: 0.7, modelOptions: {}
  })
  expectReject('默认模型不在清单里被拒绝', {
    name: 'mismatch', provider: 'openai-compatible', baseUrl: 'https://y.dev/v1', apiKey: 'x',
    models: ['a'], defaultModel: 'b', temperature: 0.7, modelOptions: {}
  })

  // ---- 5. 删除：默认顺位、删光回归演示模式 ----
  const afterDelete = settingsStore.deleteProfile(claude.id)
  check('删除默认档案后顺位首条', afterDelete.defaultProfileId === afterDelete.profiles[0].id)
  check('删除后镜像跟随回落', settingsStore.get().model === afterDelete.profiles[0].defaultModel)

  settingsStore.deleteProfile(afterDelete.profiles[0].id)
  const empty = settingsStore.get()
  check('删光后回到演示模式', empty.provider === 'mock' && empty.model === 'demo', empty.provider + '/' + empty.model)
  check('删光后档案为空', empty.modelProfiles.length === 0, empty.modelProfiles.length)

  // ---- 6. 重启后仍然读得回来 ----
  settingsStore.saveProfile({
    name: 'persisted', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-p',
    models: ['gpt-4.1'], defaultModel: 'gpt-4.1', temperature: 0.5, modelOptions: {}
  })
  const persisted = reloadStore().settingsStore.get()
  check('重启后档案还在', persisted.modelProfiles.length === 1 && persisted.modelProfiles[0].name === 'persisted')
  check('重启后镜像正确', persisted.model === 'gpt-4.1' && persisted.provider === 'openai-compatible')

  // ---- 7. 手写脏数据：重复档案去重、悬空 defaultProfileId 修正 ----
  writeSettings({
    modelProfiles: [
      { id: 'a', name: 'A', provider: 'openai-compatible', baseUrl: 'https://x.dev/v1', apiKey: '', models: ['m'], defaultModel: 'm', temperature: 0.7, modelOptions: {} },
      { id: 'b', name: 'B', provider: 'openai-compatible', baseUrl: 'https://x.dev/v1', apiKey: '', models: ['m'], defaultModel: 'm', temperature: 0.7, modelOptions: {} }
    ],
    defaultProfileId: 'does-not-exist'
  })
  const deduped = reloadStore().settingsStore.get()
  check('重复档案被去重', deduped.modelProfiles.length === 1, deduped.modelProfiles.length)
  check('悬空 defaultProfileId 被修正', deduped.defaultProfileId === deduped.modelProfiles[0].id)

  // ---- 8. 多工作区：增删改 / 目录去重 / 删空不复活 / 重启可读回 ----
  // 空清单 + 没有 workspaceOptOut = 「从没建过」-> 仍补默认工作区（对新人友好）
  writeSettings({ workspaces: [], activeWorkspaceId: null })
  let store = reloadStore().settingsStore
  let ws = store.listWorkspaces()
  check('从没建过时补一个默认工作区', ws.workspaces.length === 1, ws.workspaces.length)
  check('补的默认工作区有绝对路径', path.isAbsolute(ws.workspaces[0].dir), ws.workspaces[0].dir)

  const dirA = path.join(userData, 'proj-a')
  const dirB = path.join(userData, 'proj-b')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })

  ws = store.saveWorkspace({ name: '项目 A', dir: dirA })
  const idA = ws.workspaces.find((w) => w.dir === dirA).id
  check('新建工作区追加到清单', ws.workspaces.some((w) => w.id === idA))
  check('工作区名按用户填的保存', ws.workspaces.find((w) => w.id === idA).name === '项目 A')

  ws = store.saveWorkspace({ name: '', dir: dirB })
  check('名字留空时回落到目录名', ws.workspaces.find((w) => w.dir === dirB).name === 'proj-b', ws.workspaces.find((w) => w.dir === dirB).name)

  let rejected = false
  try {
    store.saveWorkspace({ name: 'dup', dir: dirA })
  } catch {
    rejected = true
  }
  check('同一目录不能建两个工作区', rejected)

  rejected = false
  try {
    store.saveWorkspace({ name: 'nope', dir: path.join(userData, 'does-not-exist') })
  } catch {
    rejected = true
  }
  check('不存在的目录被拒绝', rejected)

  store.setActiveWorkspace(idA)
  check('切换活动工作区落盘', readSettings().activeWorkspaceId === idA)

  store.deleteWorkspace(idA)
  const afterWs = store.listWorkspaces()
  check('删掉活动工作区后活动顺位', afterWs.activeWorkspaceId !== idA && afterWs.workspaces.some((w) => w.id === afterWs.activeWorkspaceId))

  // 重启后工作区清单还在（这条最容易漏：清单只在内存里改没 flush）
  store.saveWorkspace({ name: '持久化', dir: dirA })
  const reloadedWs = reloadStore().settingsStore.listWorkspaces()
  check('重启后工作区清单还在', reloadedWs.workspaces.some((w) => w.dir === dirA))
  check('重启后活动工作区有效', reloadedWs.workspaces.some((w) => w.id === reloadedWs.activeWorkspaceId))

  // ---- 9. P6 G1：删空后保持空，不自动重建（台账 H-27 / 蓝图 §4.2 / §4.3）----
  // 逐条删真实文件里的清单：每一次都重新 load，才能证明「删空」是落盘事实而不是内存假象。
  let guard = 0
  for (const item of store.listWorkspaces().workspaces) {
    reloadStore().settingsStore.deleteWorkspace(item.id)
    if ((guard += 1) > 10) break
  }
  const swept = reloadStore().settingsStore.listWorkspaces()
  check('删光后清单保持为空（不再自动重建）', swept.workspaces.length === 0, swept.workspaces.length)
  check('空清单下 activeWorkspaceId 是 null（不是 undefined）', swept.activeWorkspaceId === null, String(swept.activeWorkspaceId))
  check('删空后磁盘上 workspaceOptOut 为 true', readSettings().workspaceOptOut === true, String(readSettings().workspaceOptOut))
  check('删空后重启仍然为空（不复活）', reloadStore().settingsStore.listWorkspaces().workspaces.length === 0, reloadStore().settingsStore.listWorkspaces().workspaces.length)

  // 新建 -> 标记清掉；再删空 -> 第二次删空也不许长回来
  const rebuilt = reloadStore().settingsStore.saveWorkspace({ name: '重建', dir: dirA })
  check('删空后新建工作区成功', rebuilt.workspaces.length === 1, rebuilt.workspaces.length)
  check('新建后 workspaceOptOut 被清掉', readSettings().workspaceOptOut === false, String(readSettings().workspaceOptOut))
  reloadStore().settingsStore.deleteWorkspace(rebuilt.workspaces[0].id)
  const sweptAgain = reloadStore().settingsStore.listWorkspaces()
  check('第二次删空同样保持为空', sweptAgain.workspaces.length === 0, sweptAgain.workspaces.length)

  // dispose #2 (E3 陷阱)：删空之后，任何一次整体 save 都不能把默认工作区又补回来
  reloadStore().settingsStore.save({ temperature: 0.3 })
  check('删空后整体 save 不会复活默认工作区', reloadStore().settingsStore.listWorkspaces().workspaces.length === 0, reloadStore().settingsStore.listWorkspaces().workspaces.length)
} finally {
  fs.rmSync(userData, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  const suffix = item.extra === undefined ? '' : ' :: ' + String(item.extra)
  console.log((item.ok ? 'PASS ' : 'FAIL ') + item.label + suffix)
}
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过')
if (failed.length > 0) process.exitCode = 1