/**
 * 工具权限模式的行为测试。
 *
 * 这里测的不是"配置能不能存下来"，而是三种模式下每个工具到底会不会被执行：
 * 只读模式必须真的挡住有副作用的调用，审批模式必须真的要求确认，
 * 完全访问必须真的不再问。权限这种东西，测了"存对了"不等于"判对了"。
 *
 * 跑法：pnpm test:permission
 *
 * 实现：把真实的 settingsStore 和 permissionGate 一起打成 CJS。
 * 不用桩——权限判定读的是 settingsStore 里的真实状态，用桩就等于在测桩。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')

const userData = path.join(os.tmpdir(), 'nahida-perm-test-' + process.pid + '-' + Date.now())
fs.mkdirSync(userData, { recursive: true })

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

const stubPath = path.join(userData, 'electron-stub.cjs')
fs.writeFileSync(
  stubPath,
  'module.exports = {' +
    ' app: {' +
    ' getPath: () => ' + JSON.stringify(userData) + ',' +
    ' getAppPath: () => ' + JSON.stringify(projectRoot) + ',' +
    ' isPackaged: false },' +
    " shell: { openPath: async () => '' }" +
    ' }',
  'utf8'
)

// 入口把两个模块放进同一个 bundle，共享同一份 settingsStore 单例
const entry = path.join(userData, 'entry.ts')
fs.writeFileSync(
  entry,
  "export { permissionGate } from " + JSON.stringify(path.join(projectRoot, 'src/main/features/tools/permission.ts')) + '\n' +
    "export { settingsStore } from " + JSON.stringify(path.join(projectRoot, 'src/main/features/settings/settingsStore.ts')) + '\n',
  'utf8'
)

const outFile = path.join(userData, 'bundle.cjs')
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: outFile,
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

const { permissionGate, settingsStore } = require(outFile)

/** 用真实落盘路径切模式，顺便验证设置保存后立刻影响判定 */
function setMode(mode) {
  const current = settingsStore.get()
  settingsStore.save({ permission: { ...current.permission, mode } })
  permissionGate.forgetRemembered()
}

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (error) {
    console.error('  FAIL ' + name)
    throw error
  }
}

console.log('只读模式')
setMode('readonly')
test('只读工具直接放行', () => {
  assert.equal(permissionGate.evaluate('fs.read_file', true), 'allow')
})
test('有副作用的工具直接拒绝', () => {
  assert.equal(permissionGate.evaluate('fs.write_file', false), 'deny')
})
test('拒绝不经过审批，用户不会被弹卡骚扰', () => {
  assert.notEqual(permissionGate.evaluate('shell.exec', false), 'ask')
})

console.log('审批模式')
setMode('approve')
test('只读工具直接放行', () => {
  assert.equal(permissionGate.evaluate('fs.list_dir', true), 'allow')
})
test('有副作用的工具要求审批', () => {
  assert.equal(permissionGate.evaluate('fs.write_file', false), 'ask')
})
test('审批理由说清是哪个工具和哪个模式', () => {
  const reason = permissionGate.reasonFor({
    id: '1', name: 'fs.write_file', title: '写入文件', readOnly: false,
    arguments: '{}', status: 'awaiting', result: null, error: null, startedAt: 0, durationMs: null
  })
  assert.ok(reason.includes('写入文件'), reason)
  assert.ok(reason.includes('审批'), reason)
})

console.log('完全访问模式')
setMode('full')
test('只读工具放行', () => {
  assert.equal(permissionGate.evaluate('fs.read_file', true), 'allow')
})
test('有副作用的工具也放行', () => {
  assert.equal(permissionGate.evaluate('fs.write_file', false), 'allow')
})

console.log('模式切换后立即生效')
setMode('approve')
settingsStore.save({ permission: { ...settingsStore.get().permission, mode: 'readonly' } })
test('从完全访问切回只读，副作用工具立刻被挡', () => {
  assert.equal(permissionGate.evaluate('fs.write_file', false), 'deny')
})
test('切模式清空「总是允许」记忆', () => {
  setMode('approve')
  assert.equal(permissionGate.evaluate('fs.write_file', false), 'ask')
})

fs.rmSync(userData, { recursive: true, force: true })
console.log('\n共 ' + passed + ' 项通过')
