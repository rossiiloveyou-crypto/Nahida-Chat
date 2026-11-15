import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import gates from './release-resources.cjs'
const source = path.resolve(process.argv[2] || 'release/win-unpacked')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nahida-release-copy-'))
const appDir = path.join(sandbox, 'App With Spaces')
fs.cpSync(source, appDir, { recursive: true, dereference: true })
const resources = path.join(appDir, 'resources')
const integrity = gates.verifyResources(resources)
const output = path.join(sandbox, 'result.json')
const env = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:/Windows', 'System32'), NAHIDA_RELEASE_SMOKE: '1', NAHIDA_RELEASE_SMOKE_RESULT: output }
for (const key of ['NC_SL_HOST_DIR', 'NC_SL_HOME', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'NODE_PATH', 'npm_execpath', 'PNPM_HOME']) delete env[key]
let tail = ''
const child = spawn(path.join(appDir, 'Nahida Chat.exe'), [], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { tail = (tail + chunk).slice(-6000) })
let timeout
try {
  const code = await new Promise((resolve, reject) => {
    timeout = setTimeout(() => { child.kill(); reject(Error('发布包启动验证超时')) }, 60000)
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
  if (!fs.existsSync(output)) {
    const hostOk = gates.verifyResources(resources)
    console.error('无法从无控制台的打包程序取回自检结果（exit=' + code + '）；宿主资源校验通过：' + JSON.stringify(hostOk))
    console.error('请改为手动启动安装包确认界面；或用 NC_SL_HOST_DIR 指向随包宿主跑 qq-host 测试。')
    process.exit(2)
  }
  const result = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(code, 0, JSON.stringify(result))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.packaged, true)
  assert.equal(result.hostDir, path.join(resources, 'snowluma-host'))
  assert.equal(result.promptRoot, path.join(resources, 'prompt'))
  assert.equal(result.renderer.api, true)
  assert.equal(result.renderer.mounted, true)
  assert.equal(result.hostStopped, true)
  assert.equal(result.hostExit.code, 0)
  const evidence = path.resolve('release/verification.json')
  fs.writeFileSync(evidence, JSON.stringify({ verifiedAt: new Date().toISOString(), source, isolatedCopy: appDir, pathContainsOnlyWindowsSystem32: true, integrity, result }, null, 2))
  console.log('PASS release: real packaged app + renderer/preload + bundled host handshake/RPC/shutdown')
  console.log('Evidence: ' + evidence)
} finally {
  clearTimeout(timeout)
  if (child.exitCode === null) child.kill()
}
