/** Pure Node boundary tests: real bundled spawn/logpipe, fixture-only ST root. */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { bundleModule, createChecker, projectRoot, p } from './qq-test-util.mjs'

const checker = createChecker()
const root = fs.mkdtempSync(path.join(projectRoot, '.bridge-spawn-test-'))
const managed = new Set()
const ownedPids = new Set()
const pipes = new Set()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await sleep(25) }
  throw new Error('等待夹具状态超时')
}
async function test(label, run) {
  try { await run(); checker.check(label, true) }
  catch (error) { checker.check(label, false, error.stack || error.message || error) }
}
async function rejects(run, pattern) { await assert.rejects(run, pattern) }
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function listen() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, port: server.address().port }
}
async function close(server) { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
async function freePort() { const value = await listen(); await close(value.server); return value.port }
function envWith(overrides, run) {
  const keys = new Set([...Object.keys(process.env).filter(key => Object.keys(overrides).some(name => key.toLowerCase() === name.toLowerCase())), ...Object.keys(overrides)])
  const saved = [...keys].map(key => [key, process.env[key]])
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, overrides)
  return Promise.resolve().then(run).finally(() => { for (const key of keys) delete process.env[key]; for (const [key, value] of saved) if (value !== undefined) process.env[key] = value })
}

// This directory is only linked for dependency reads; never recurse into its target.
const yamlCandidates = [process.env.BRIDGE_TEST_ST_NODE_MODULES, path.resolve(projectRoot, '../SillyTavern/node_modules'), path.join(projectRoot, 'node_modules')].filter(Boolean)
const nodeModules = yamlCandidates.find(candidate => { try { createRequire(path.join(candidate, '..', 'package.json'))('yaml'); return fs.statSync(candidate).isDirectory() } catch { return false } })
let api
let defaults
let fixtureIndex = 0
const fixtureServer = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
const role = process.argv[2];
if (role === 'tree-child' || role === 'tree-grandchild') {
  fs.writeFileSync(path.join(__dirname, role + '.pid'), String(process.pid));
  if (role === 'tree-child') spawn(process.execPath, [__filename, 'tree-grandchild'], { stdio: 'ignore', windowsHide: true });
  setInterval(() => {}, 1000);
} else {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]);
  fs.appendFileSync(path.join(__dirname, 'starts.jsonl'), JSON.stringify({ pid: process.pid, argv: args, cwd: process.cwd() }) + '\n');
  spawn(process.execPath, [__filename, 'tree-child'], { stdio: 'ignore', windowsHide: true });
  process.stdout.write('标准输出中文\n');
  process.stderr.write('标准错误中文\n');
  if (mode.crash) setTimeout(() => process.exit(7), 30);
  else setTimeout(() => require('node:http').createServer((_req, res) => { res.statusCode = mode.status || 200; res.end('fixture HTTP'); }).listen(port, '127.0.0.1', () => {
    if (!mode.noBanner) console.log('Go to: http://127.0.0.1:' + port);
  }), mode.delay || 0);
}
`
async function fixture(mode = {}) {
  const dir = path.join(root, 'st-' + ++fixtureIndex)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"type":"commonjs"}')
  fs.writeFileSync(path.join(dir, 'server.js'), fixtureServer)
  fs.writeFileSync(path.join(dir, 'mode.json'), JSON.stringify(mode))
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'global: false\nport: 8000\n')
  assert.ok(nodeModules, '需要真实 yaml 依赖；设置 BRIDGE_TEST_ST_NODE_MODULES 指向其 node_modules')
  fs.symlinkSync(nodeModules, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  return { ...defaults, stRoot: dir, nodePath: process.execPath, port: await freePort(), readyTimeoutMs: 6000 }
}
function yaml(config, text) { fs.writeFileSync(path.join(config.stRoot, 'config.yaml'), text) }
function newProcess() { const st = new api.StProcess(); managed.add(st); return st }
async function treePids(config) {
  const files = ['tree-child.pid', 'tree-grandchild.pid'].map(name => path.join(config.stRoot, name))
  await until(() => files.every(file => fs.existsSync(file)))
  const pids = files.map(file => Number(fs.readFileSync(file, 'utf8')))
  pids.forEach(pid => ownedPids.add(pid))
  return pids
}
async function stop(st) {
  const child = st.child
  const closed = child && child.exitCode === null && child.signalCode === null ? once(child, 'close') : Promise.resolve()
  st.stop()
  await closed
  st.log?.close()
}
function logpipe(name, maxBytes) { const pipe = new api.BridgeLogPipe(path.join(root, name + '.log'), maxBytes); pipes.add(pipe); return pipe }
async function feed(pipe, chunks, stream = 'stdout') {
  const input = new PassThrough()
  const errors = []
  pipe.attach(input, stream, error => errors.push(error))
  const ended = once(input, 'end')
  for (const chunk of chunks) input.write(chunk)
  input.end()
  await ended
  assert.deepEqual(errors, [])
}

try {
  // qq-test-util normally uses OS temp; redirect its bundle scratch into this workspace.
  api = await envWith({ TEMP: root, TMP: root, TMPDIR: root }, () => bundleModule('bridge-spawn',
    'export * from ' + JSON.stringify(p('src/main/features/bridge/spawn.ts')) + ';\n' +
    'export * from ' + JSON.stringify(p('src/main/features/bridge/logpipe.ts')) + ';\n' +
    'export { BRIDGE_DEFAULT_CONFIG } from ' + JSON.stringify(p('src/shared/bridge.ts')) + ';'))
  defaults = api.BRIDGE_DEFAULT_CONFIG

  await test('体检 PASS：server.js 可读文件', async () => { const result = await api.preflight(await fixture()); assert.ok(result.checks.includes('server.js')) })
  await test('体检 FAIL：缺失或目录型 server.js', async () => {
    const config = await fixture(); const file = path.join(config.stRoot, 'server.js'); fs.unlinkSync(file)
    await rejects(() => api.preflight(config), /server\.js.*不可读/)
    fs.mkdirSync(file); await rejects(() => api.preflight(config), /server\.js/)
  })
  await test('体检 PASS：node_modules 真实依赖目录', async () => { assert.ok((await api.preflight(await fixture())).checks.includes('node_modules')) })
  await test('体检 FAIL：缺失或普通文件型 node_modules', async () => {
    const config = await fixture(); const target = path.join(config.stRoot, 'node_modules'); fs.unlinkSync(target)
    await rejects(() => api.preflight(config), /node_modules/)
    fs.writeFileSync(target, 'not a directory'); await rejects(() => api.preflight(config), /node_modules/)
  })
  await test('体检 PASS：config.yaml 可读且有效 YAML', async () => {
    const config = await fixture(); yaml(config, '{"global": false, port: 8000}\n'); assert.ok((await api.preflight(config)).checks.includes('config.yaml'))
  })
  await test('体检 FAIL：缺失/目录型 config.yaml、无效 YAML、非对象根', async () => {
    const config = await fixture(); const file = path.join(config.stRoot, 'config.yaml'); fs.unlinkSync(file)
    await rejects(() => api.preflight(config), /config\.yaml/)
    fs.mkdirSync(file); await rejects(() => api.preflight(config), /config\.yaml/); fs.rmdirSync(file)
    for (const text of ['global: [broken', '[false, true]', 'true', '', 'global: false\nglobal: true']) { yaml(config, text); await rejects(() => api.preflight(config), /配置体检失败/) }
  })
  for (const [name, text] of [
    ['block', 'global: false\n'], ['flow', '{global: false}'], ['引号键', '"global": false'],
    ['字符串 true', 'global: "true"'], ['anchor', 'flag: &flag false\nglobal: *flag'],
    ['merge', 'defaults: &defaults {global: false}\n<<: *defaults'],
    ['merge override', 'defaults: &defaults {global: true}\n<<: *defaults\nglobal: false']
  ]) await test('体检 PASS：global ' + name, async () => { const config = await fixture(); yaml(config, text); assert.ok((await api.preflight(config)).checks.includes('global !== true')) })
  for (const [name, text] of [
    ['block', 'global: true'], ['flow', '{global: true}'], ['引号键', '"global": true'],
    ['anchor', 'flag: &flag true\nglobal: *flag'], ['merge', 'defaults: &defaults {global: true}\n<<: *defaults']
  ]) await test('体检 FAIL：global true ' + name, async () => { const config = await fixture(); yaml(config, text); await rejects(() => api.preflight(config), /global: true.*dataRoot/) })
  await test('体检 PASS：空闲端口', async () => { const config = await fixture(); assert.ok((await api.preflight(config)).checks.includes('port')); await api.assertPortAvailable(config.port) })
  await test('体检 FAIL：已占用端口与非法端口', async () => {
    const config = await fixture(); const held = await listen()
    try { await rejects(() => api.preflight({ ...config, port: held.port }), /already in use/); assert.match(api.portError(held.port), new RegExp('127\\.0\\.0\\.1:' + held.port)) } finally { await close(held.server) }
    for (const port of [0, -1, 65536, 1.5, NaN]) await rejects(() => api.assertPortAvailable(port), /1–65535/)
  })
  await test('体检 PASS：Node 路径实际 --version', async () => { const result = await api.preflight(await fixture()); assert.equal(result.runtime.version, process.version); assert.ok(result.checks.includes('node ' + process.version)) })
  await test('体检 FAIL：不存在或非 Node 的配置路径', async () => {
    const config = await fixture(); await rejects(() => api.preflight({ ...config, nodePath: path.join(root, 'missing-node.exe') }), /Node 运行时不可用/)
    const text = path.join(root, 'not-node.txt'); fs.writeFileSync(text, 'not executable'); await rejects(() => api.resolveNode(text), /Node 运行时不可用/)
    if (process.platform === 'win32') await rejects(() => api.resolveNode(process.env.ComSpec || 'C:/Windows/System32/cmd.exe'), /Node 运行时不可用/)
  })
  await test('resolveNode：显式路径优先、trim 并清除继承的 ELECTRON_RUN_AS_NODE', async () => {
    await envWith({ ELECTRON_RUN_AS_NODE: 'inherited' }, async () => { const value = await api.resolveNode('  ' + process.execPath + '  '); assert.equal(value.command, process.execPath); assert.equal(value.source, 'configured'); assert.equal(value.env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(process.env.ELECTRON_RUN_AS_NODE, 'inherited') })
  })
  await test('resolveNode：PATH node 真实探测', async () => {
    await envWith({ PATH: path.dirname(process.execPath) }, async () => { const value = await api.resolveNode(); assert.equal(value.source, 'path'); assert.equal(value.command, 'node'); assert.equal(value.version, process.version); assert.equal(value.env.ELECTRON_RUN_AS_NODE, undefined) })
  })
  await test('resolveNode：PATH 缺失时 Electron Node fallback 与失败传播', async () => {
    await envWith({ PATH: path.join(root, 'empty-path') }, async () => { const value = await api.resolveNode('', process.execPath); assert.equal(value.source, 'electron'); assert.equal(value.command, process.execPath); assert.equal(value.version, process.version); assert.equal(value.env.ELECTRON_RUN_AS_NODE, '1'); await rejects(() => api.resolveNode('', path.join(root, 'missing-electron.exe')), /Node 运行时不可用/) })
  })
  await test('taskkillArgs：实际参数 /PID /T /F 与无效 PID', async () => {
    assert.deepEqual(api.taskkillArgs(12345), ['/PID', '12345', '/T', '/F'])
    for (const pid of [0, -1, 1.2, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => api.taskkillArgs(pid), /PID 无效/)
  })

  await test('StProcess：并发启动共享一次 HTTP+banner 进程、stdout/stderr 与隔离参数', async () => {
    const config = await fixture(); const st = newProcess()
    try {
      await Promise.all([st.start(config), st.start(config), st.start(config)])
      const pid = st.pid; ownedPids.add(pid); const descendants = await treePids(config)
      assert.ok(st.running()); assert.ok(descendants.every(alive))
      const starts = fs.readFileSync(path.join(config.stRoot, 'starts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(starts.length, 1); assert.equal(starts[0].pid, pid); assert.equal(starts[0].cwd, config.stRoot)
      for (const [flag, value] of [['--dataRoot', path.join(config.stRoot, 'data-nc')], ['--global', 'false'], ['--listen', 'false'], ['--enableIPv4', 'true'], ['--enableIPv6', 'false'], ['--browserLaunchEnabled', 'false'], ['--browserLaunchHostname', '127.0.0.1'], ['--browserLaunchPort', String(config.port)]]) assert.equal(starts[0].argv[starts[0].argv.indexOf(flag) + 1], value)
      assert.equal(await (await fetch(st.info.url)).text(), 'fixture HTTP')
      assert.ok(st.log.snapshot().some(line => line.stream === 'stdout' && line.text === '标准输出中文'))
      assert.ok(st.log.snapshot().some(line => line.stream === 'stderr' && line.text === '标准错误中文'))
      await st.start(config); assert.equal(st.pid, pid)
      await stop(st); await until(() => [pid, ...descendants].every(pid => !alive(pid)))
      assert.equal(st.running(), false); assert.equal(st.pid, null); await api.assertPortAvailable(config.port); st.stop()
    } finally { await stop(st) }
  })
  await test('StProcess：体检进行中 stop 取消并发启动且可重新启动', async () => {
    const config = await fixture(); const st = newProcess()
    try {
      const pending = Promise.allSettled([st.start(config), st.start(config)]); st.stop(); const outcomes = await pending
      assert.ok(outcomes.every(item => item.status === 'rejected' && /取消/.test(String(item.reason)))); assert.equal(st.pid, null)
      assert.equal(fs.existsSync(path.join(config.stRoot, 'starts.jsonl')), false)
      await st.start(config); ownedPids.add(st.pid); const pids = await treePids(config); await stop(st); await until(() => pids.every(pid => !alive(pid)))
    } finally { await stop(st) }
  })
  await test('StProcess：已 spawn 等待就绪中 stop 杀死完整孙进程树', async () => {
    const config = await fixture({ delay: 3000 }); const st = newProcess(); const pending = st.start(config).then(() => ({ ok: true }), error => ({ error }))
    try {
      const descendants = await treePids(config); const pid = st.pid; ownedPids.add(pid)
      await stop(st); const outcome = await pending; assert.match(String(outcome.error), /取消/); await until(() => [pid, ...descendants].every(pid => !alive(pid)))
      assert.equal(st.running(), false); await api.assertPortAvailable(config.port)
    } finally { await stop(st); await pending }
  })
  for (const [name, mode] of [['只有 HTTP 无 banner', { noBanner: true }], ['只有 banner HTTP 非 200', { status: 503 }]]) await test('StProcess：' + name + ' 继续等待，stop 取消并清理树', async () => {
    const config = { ...await fixture(mode), readyTimeoutMs: 100 }; const st = newProcess(); let settled = false
    const pending = st.start(config).then(() => ({ ok: true }), error => ({ error })).finally(() => { settled = true })
    try {
      const descendants = await treePids(config); const pid = st.pid; ownedPids.add(pid)
      await until(async () => { try { const response = await fetch(st.info.url, { signal: AbortSignal.timeout(200) }); await response.body?.cancel(); return response.status === (mode.status || 200) } catch { return false } })
      await sleep(250); assert.equal(settled, false); assert.ok(st.running())
      assert.equal(st.log.snapshot().some(line => line.text.includes('Go to: ' + st.info.url)), !mode.noBanner)
      await stop(st); const outcome = await pending; assert.match(String(outcome.error), /取消/)
      await until(() => [pid, ...descendants].every(pid => !alive(pid))); assert.equal(st.running(), false); await api.assertPortAvailable(config.port)
    } finally { await stop(st); await pending }
  })

  await test('日志：中文 UTF-8 逐字节跨块且无替代字符', async () => {
    const pipe = logpipe('utf8'); const bytes = Buffer.from('你好，纳西妲🌿\n'); await feed(pipe, [...bytes].map(byte => Buffer.from([byte]))); assert.deepEqual(pipe.snapshot().map(line => line.text), ['你好，纳西妲🌿']); assert.equal(fs.readFileSync(pipe.path, 'utf8'), '你好，纳西妲🌿\n')
  })
  await test('日志：ANSI 控制序列跨块过滤', async () => {
    const pipe = logpipe('ansi'); await feed(pipe, ['\x1b[', '31m红色', '\x1b[0', 'm\n', '\x1b]0;窗口', '标题\x07正文\n']); assert.deepEqual(pipe.snapshot().map(line => line.text), ['红色', '正文']); assert.equal(fs.readFileSync(pipe.path, 'utf8'), '红色\n正文\n')
  })
  await test('日志：CRLF 跨块、单 CR、无末尾换行且 close 幂等', async () => {
    const pipe = logpipe('newline'); await feed(pipe, ['一\r', '\n二\r', '三\n尾巴']); pipe.close(); pipe.close(); assert.deepEqual(pipe.snapshot().map(line => line.text), ['一', '二', '三', '尾巴']); assert.equal(fs.readFileSync(pipe.path, 'utf8'), '一\n二\n三\n尾巴\n')
  })
  await test('日志：stdout/stderr 独立 decoder 与尾块；序号有序', async () => {
    const pipe = logpipe('dual'); const out = new PassThrough(); const err = new PassThrough(); const errors = []; const onError = error => errors.push(error)
    pipe.attach(out, 'stdout', onError); pipe.attach(err, 'stderr', onError)
    const first = Buffer.from('输出'); out.write(first.subarray(0, 1)); err.write('错误\r'); out.write(first.subarray(1)); err.write('\n'); out.write('\n尾出'); err.write('尾错'); pipe.close()
    assert.deepEqual(pipe.snapshot().map(({ stream, text }) => [stream, text]), [['stderr', '错误'], ['stdout', '输出'], ['stdout', '尾出'], ['stderr', '尾错']])
    assert.deepEqual(pipe.snapshot().map(line => line.seq), [1, 2, 3, 4]); assert.deepEqual(errors, []); assert.equal(out.listenerCount('data'), 0); assert.equal(err.listenerCount('data'), 0); out.destroy(); err.destroy()
  })
  await test('日志：订阅、退订、订阅者抛错不影响磁盘和其他消费者', async () => {
    const pipe = logpipe('subscription'); const received = []; const bad = pipe.subscribe(() => { throw new Error('fixture listener failure') }); const off = pipe.subscribe(line => received.push(line.text))
    pipe.write('host', '第一条'); off(); off(); pipe.write('stderr', '第二条'); bad(); assert.deepEqual(received, ['第一条']); assert.equal(pipe.snapshot().length, 2); assert.equal(fs.readFileSync(pipe.path, 'utf8'), '第一条\n第二条\n'); const copy = pipe.snapshot(); copy.pop(); assert.equal(pipe.snapshot().length, 2)
  })
  await test('日志：真实 33 MiB 数据轮转 .1、每文件字节上限与全量内存记录', async () => {
    const pipe = logpipe('rotation-33mb'); assert.equal(api.LOG_MAX_BYTES, 32 * 1024 * 1024); const chunk = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 33; i++) pipe.write(i % 2 ? 'stderr' : 'stdout', chunk)
    const old = fs.readFileSync(pipe.path + '.1'); const current = fs.readFileSync(pipe.path)
    assert.equal(old.length, api.LOG_MAX_BYTES); assert.equal(current.length, 1024 * 1024 + 33); assert.equal(pipe.logBytes, current.length); assert.ok(current.length <= api.LOG_MAX_BYTES)
    assert.equal(Buffer.concat([old, current]).equals(Buffer.from((chunk + '\n').repeat(33))), true); assert.equal(pipe.snapshot().length, 33); assert.equal(fs.existsSync(pipe.path + '.2'), false); pipe.close()
  })
  await test('日志：多次轮转只保留 .1，既有文件计数与阈值参数校验', async () => {
    const file = path.join(root, 'existing.log'); fs.writeFileSync(file, '12345678'); const pipe = new api.BridgeLogPipe(file, 8); pipes.add(pipe); pipe.write('host', 'ABCDEFG'); assert.equal(fs.readFileSync(file + '.1', 'utf8'), '12345678'); pipe.write('host', 'next'); assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'ABCDEFG\n'); assert.equal(fs.statSync(file).size, 5); assert.equal(pipe.logBytes, 5)
    for (const limit of [0, -1, 1.5, NaN]) assert.throws(() => new api.BridgeLogPipe(path.join(root, 'invalid.log'), limit), /正整数/)
  })
} catch (error) { checker.check('测试初始化及未捕获异常', false, error.stack || error) }
finally {
  for (const st of managed) { try { await stop(st) } catch (error) { checker.check('夹具托管进程清理', false, error.message) } }
  for (const pid of ownedPids) if (pid && alive(pid)) { try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' }); else process.kill(pid, 'SIGKILL') } catch {} }
  for (const pipe of pipes) pipe.close()
  // Remove only junction entries first; never recurse through the user's ST dependencies.
  for (let i = 1; i <= fixtureIndex; i++) { const link = path.join(root, 'st-' + i, 'node_modules'); try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); checker.check('工作区临时夹具已清理', !fs.existsSync(root)) } catch (error) { checker.check('工作区临时夹具已清理', false, error.message) }
}
checker.done()
