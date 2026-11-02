/**
 * 时间感知的行为测试。
 *
 * 测的是「模型到底能不能知道现在几点」，不是「有没有一个叫 clock.now 的实现」：
 *   - 注入文本是否真的带日期/时刻/时区/星期，且与系统时钟一致；
 *   - 注入文本是否自报"运行时注入"，避免被当成训练数据里的旧时间；
 *   - clock.now 是否真的可执行、能不能查别的时区、非法时区是否报错而不是静默回落；
 *   - 工具是否仍被登记成只读（只读模式不该因为它弹审批，审批模式也不该拦它）。
 *
 * 跑法：pnpm test:clock
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

const workDir = path.join(os.tmpdir(), 'nahida-clock-test-' + process.pid + '-' + Date.now())
fs.mkdirSync(workDir, { recursive: true })

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

const stubPath = path.join(workDir, 'electron-stub.cjs')
fs.writeFileSync(
  stubPath,
  'module.exports = {' +
    ' app: { getPath: () => ' + JSON.stringify(workDir) + ', getAppPath: () => ' + JSON.stringify(projectRoot) + ', isPackaged: false },' +
    " shell: { openPath: async () => '' }" +
    ' }',
  'utf8'
)

const entry = path.join(workDir, 'entry.ts')
fs.writeFileSync(
  entry,
  'export { registerClockTools, clockSnapshot, clockNotice, describeClock, localTimeZone } from ' +
    JSON.stringify(path.join(projectRoot, 'src/main/features/tools/clock.ts')) + '\n' +
    'export { executeTool, definitionOf } from ' +
    JSON.stringify(path.join(projectRoot, 'src/main/features/tools/registry.ts')) + '\n',
  'utf8'
)

const outFile = path.join(workDir, 'bundle.cjs')
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

const mod = require(outFile)
const { registerClockTools, clockSnapshot, clockNotice, localTimeZone } = mod
registerClockTools()

const scope = { mode: 'full', workspaceRoot: workDir }
const call = async (args) => mod.executeTool('clock.now', JSON.stringify(args), scope)

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (error) {
    console.error('  FAIL ' + name)
    throw error
  }
}

console.log('注入文本')
await test('带日期、时刻、时区、星期四要素', () => {
  const text = clockNotice(new Date('2026-11-02T00:27:59+08:00'))
  assert.match(text, /2026-11-02/)
  assert.match(text, /00:27:59/)
  assert.match(text, /星期[日一二三四五六]/)
  assert.match(text, /Asia\/Shanghai|UTC/)
})

await test('星期按目标时区的日历算，不受本机时区影响', () => {
  assert.equal(clockSnapshot(new Date('2026-11-02T00:27:59+08:00'), 'Asia/Shanghai').weekday, '星期一')
  // 同一时刻在纽约还是 11 月 1 日（星期日），偏移必须跟着时区走
  const ny = clockSnapshot(new Date('2026-11-02T00:27:59+08:00'), 'America/New_York')
  assert.equal(ny.date, '2026-11-01')
  assert.equal(ny.weekday, '星期日')
  assert.equal(ny.time, '11:27:59')
  assert.equal(ny.utcOffset, '-05:00')
})

await test('声明自己是运行时注入，且提醒不要凭记忆推算', () => {
  const text = clockNotice(new Date('2026-11-02T00:27:59+08:00'))
  assert.match(text, /运行时注入/)
  assert.match(text, /不要凭记忆推算/)
})

await test('注入的是真实当前时刻（与系统时钟差在 5 秒内）', () => {
  const stamp = clockSnapshot().epochMs
  assert.ok(Math.abs(Date.now() - stamp) < 5000, '时间戳偏离系统时钟：' + (Date.now() - stamp) + 'ms')
})

console.log('clock.now 工具')
await test('工具已注册且声明为只读', () => {
  const definition = mod.definitionOf('clock.now')
  assert.ok(definition, 'clock.now 未注册')
  assert.equal(definition.readOnly, true)
})

await test('不带参数走本机时区，输出带星期与时区', async () => {
  const result = await call({})
  assert.equal(result.ok, true, result.output)
  assert.match(result.output, /当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（星期[日一二三四五六]）/)
  assert.ok(result.output.includes(localTimeZone()), result.output)
})

await test('指定时区能查到当地时刻', async () => {
  const result = await call({ timezone: 'UTC' })
  assert.equal(result.ok, true, result.output)
  assert.match(result.output, /时区：UTC（UTC\+00:00）/)
})

await test('查其它时区时附带本机时区，省一次调用', async () => {
  const result = await call({ timezone: 'UTC' })
  assert.match(result.output, /本机时区：/)
})

await test('非法时区报错而不是静默回落到本机时区', async () => {
  const result = await call({ timezone: 'Mars/Olympus' })
  assert.equal(result.ok, false, '非法时区居然成功了：' + result.output)
  assert.match(result.output, /无效的时区/)
})

await test('时区参数不是字符串时按"未指定"处理', async () => {
  const result = await call({ timezone: 42 })
  assert.equal(result.ok, true, result.output)
})

await test('ISO 8601 与 Unix 毫秒自洽', () => {
  const snapshot = clockSnapshot(new Date('2026-11-02T00:27:59+08:00'), 'Asia/Shanghai')
  assert.equal(snapshot.iso, '2026-11-02T00:27:59+08:00')
  assert.equal(new Date(snapshot.iso).getTime(), snapshot.epochMs)
})

fs.rmSync(workDir, { recursive: true, force: true })
console.log('\n通过 ' + passed + ' 项')
