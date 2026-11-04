/**
 * 模式供给探针（PHASE-0 · T1；PHASE-1 · T5 扩到七场景）。
 *
 * 目的：把「会话模式 + 工具增强配置 -> 本轮真正交给模型的工具目录长度」变成**可重放的数字**，
 *       供 P1 做「改前 / 改后」差集证据（经验库 P8），供 A-02…A-15 做突变验证（P13）。
 *
 * 纪律（只读）：
 *  - 不写真实 userData：userData 指向系统临时目录；
 *  - 不改产品代码：本文件只 import，不 patch；
 *  - 不落盘到仓库：所有中间文件都在 tmpdir。
 *
 * 做法（实跑，不是映射推算）：
 *  真跑 chatService.sendAwait -> 真实 openAiCompatibleProvider -> 本地 mock HTTP 服务，
 *  在**服务端**读 body.tools 的实际长度。所以「tools=0」证明的是模型真的没收到工具目录，
 *  而不是「我们按 session.mode 猜了一下」。
 *
 * 🔴 settings 的切换一律走 settingsStore.save() 真落盘（J-05）：
 *    直接改内存会绕开生产读盘路径，测的就不是真实路径了。
 *
 * 跑法：node scripts/test/probe-mode-supply.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)
const p = (rel) => path.join(projectRoot, rel).replace(/\\/g, '/')

/** 探针统一勾的只读工具：注册表里第一个（fs.list_dir）。 */
const PROBE_TOOL = 'fs.list_dir'
const GROUP_KEY = 'qq:3652864412:group:543627098'
const PRIVATE_KEY = 'qq:3652864412:private:2914636187'

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

/** 本地假模型服务：记录每个请求带来的 tools 长度，再回一段 SSE 文本。 */
function startFakeModel() {
  const seen = []
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !String(req.url || '').includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        body = {}
      }
      seen.push(Array.isArray(body.tools) ? body.tools.length : 0)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      for (const piece of ['探针', '回显']) {
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] }) + '\n\n')
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        baseUrl: 'http://127.0.0.1:' + port + '/v1',
        seen,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

/**
 * 跑一次探针，返回纯数据（供 probe-mode-supply.test.mjs 与 chat-tools-supply.test.mjs 断言）。
 *
 * 每个场景的 tools 都是**服务端实测**的 body.tools.length，-1 表示「这一轮根本没打模型」。
 */
export async function runProbe() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-probe-mode-'))
  const userData = path.join(sandbox, 'userData')
  fs.mkdirSync(userData, { recursive: true })

  const fake = await startFakeModel()

  // settings.json 必须在任何 settingsStore.get() 之前写好（load 是懒的，第一次 get 才读盘）。
  // memory.enabled=false：探针只关心工具供给，不应触发 embedding 模型。
  // 🔴 故意**不写 chatTools**：这就是「老配置」的形态，缺省必须等于「全部关闭」。
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify(
      {
        provider: 'openai-compatible',
        baseUrl: fake.baseUrl,
        apiKey: 'sk-probe-0123456789',
        model: 'probe-model',
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
  fs.writeFileSync(
    entry,
    [
      "export { chatService } from '" + p('src/main/features/chat/chatService.ts') + "'",
      "export { registerBuiltinTools } from '" + p('src/main/features/tools/builtin.ts') + "'",
      "export { listDefinitions } from '" + p('src/main/features/tools/registry.ts') + "'",
      "export { settingsStore } from '" + p('src/main/features/settings/settingsStore.ts') + "'",
      "export { HeadlessSink } from '" + p('src/main/features/chat/sink.ts') + "'"
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
    'const path = require("node:path")\n' +
      'const userData = ' + JSON.stringify(userData) + '\n' +
      'const appPath = ' + JSON.stringify(projectRoot) + '\n' +
      'module.exports = {\n' +
      '  app: {\n' +
      '    getPath: (key) => (key === "userData" ? userData : path.join(userData, String(key))),\n' +
      '    getAppPath: () => appPath,\n' +
      '    getName: () => "Nahida Chat",\n' +
      '    getVersion: () => "0.1.0",\n' +
      '    isPackaged: false,\n' +
      '    on: () => {},\n' +
      '    whenReady: async () => {}\n' +
      '  },\n' +
      '  shell: { openPath: async () => "", openExternal: async () => "" },\n' +
      '  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },\n' +
      '  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },\n' +
      '  ipcMain: { handle: () => {}, on: () => {} },\n' +
      '  nativeTheme: { shouldUseDarkColors: false, themeSource: "system", on: () => {} }\n' +
      '}\n',
    'utf8'
  )

  const Module = require('node:module')
  const originalResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return electronStub
    return originalResolve.call(this, request, ...rest)
  }

  const mod = require(output)
  const { chatService, registerBuiltinTools, listDefinitions, settingsStore, HeadlessSink } = mod

  // 对照物先就位（经验库 P17）：注册表为空时，任何「工具数 0」都通过得毫无意义。
  registerBuiltinTools()
  const registered = listDefinitions().length

  const oneRound = async (sessionId) => {
    const before = fake.seen.length
    const started = Date.now()
    const sink = new HeadlessSink()
    const outcome = await Promise.race([
      chatService.sendAwait({ sessionId, content: '探针：这一轮不需要工具，请直接回一句话' }, sink),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout 30000ms')), 30_000))
    ])
    const tools = fake.seen.length > before ? fake.seen[fake.seen.length - 1] : -1
    return { tools, status: outcome.status, elapsedMs: Date.now() - started }
  }

  /** 真落盘地改 chatTools（J-05：不走内存，走 settingsStore.save）。 */
  const setChatTools = (chatTools) => {
    settingsStore.save({ chatTools })
    return settingsStore.get().chatTools
  }

  const result = {
    registered,
    chat: { tools: -1, mode: '?' },
    channel: { tools: -1, mode: '?' },
    chatEnhanced: { tools: -1, mode: '?' },
    groupOn: { tools: -1, mode: '?' },
    groupOff: { tools: -1, mode: '?' },
    privateGroupOff: { tools: -1, mode: '?' },
    agent: { tools: -1, mode: '?' }
  }

  try {
    // ① chat + 未开增强（老配置形态：chatTools 缺省）—— 保留原判据
    const chatSession = chatService.createSession({ mode: 'chat' })
    result.chat = { ...(await oneRound(chatSession.id)), mode: chatSession.mode }

    // ② 渠道会话 + 未开增强（生产路径同源：qq/bridge.ts 用 ensureChannelSession 建，不传 mode）
    const channelSession = chatService.ensureChannelSession(GROUP_KEY, { title: 'probe' })
    result.channel = { ...(await oneRound(channelSession.id)), mode: channelSession.mode }

    // ③ chat + 增强开 + 勾 1 个工具
    setChatTools({ enabled: true, tools: { [PROBE_TOOL]: true } })
    const chatEnhancedSession = chatService.createSession({ mode: 'chat' })
    result.chatEnhanced = { ...(await oneRound(chatEnhancedSession.id)), mode: chatEnhancedSession.mode }

    // ④ 群聊 + 增强开 + 群聊开关显式开
    setChatTools({ enabled: true, tools: { [PROBE_TOOL]: true }, groupEnabled: true })
    result.groupOn = { ...(await oneRound(channelSession.id)), mode: channelSession.mode }

    // ⑤ 群聊 + 增强开 + 群聊开关关
    setChatTools({ enabled: true, tools: { [PROBE_TOOL]: true }, groupEnabled: false })
    result.groupOff = { ...(await oneRound(channelSession.id)), mode: channelSession.mode }

    // ⑥ 私聊 + 增强开 + 群聊开关关 —— 群聊开关不得影响私聊
    const privateSession = chatService.ensureChannelSession(PRIVATE_KEY, { title: 'probe' })
    result.privateGroupOff = { ...(await oneRound(privateSession.id)), mode: privateSession.mode }

    // ⑦ agent —— 必须恒为 3（S5 回归哨兵）。
    //    特意放在「chatTools 全开 + groupEnabled:false」之后跑：
    //    此时 agent 仍是 3，才证明 chat 增强没有溢出到 agent（A-15 的对照物）。
    const agentSession = chatService.createSession({ mode: 'agent' })
    result.agent = { ...(await oneRound(agentSession.id)), mode: agentSession.mode }
  } finally {
    await fake.close()
  }

  return { ...result, userData, probeTool: PROBE_TOOL }
}

/** 场景顺序表：CLI 输出与断言都按它走，避免两处各写一份（B2）。 */
export const PROBE_SCENARIOS = [
  { key: 'chat', label: 'mode.chat', expect: 0, why: '未开增强 = 与改动前一致（A-12）' },
  { key: 'channel', label: 'channel.mode', expect: 0, why: '渠道会话未开增强（复现 F01+F02）' },
  { key: 'chatEnhanced', label: 'chat+enhanced', expect: 1, why: '增强开 + 勾 1 个（A-11）' },
  { key: 'groupOn', label: 'group+enhanced+groupOn', expect: 1, why: '群聊开关显式开（A-13）' },
  { key: 'groupOff', label: 'group+enhanced+groupOff', expect: 0, why: '群聊开关关（A-14 前半）' },
  { key: 'privateGroupOff', label: 'private+enhanced+groupOff', expect: 1, why: '群聊开关不影响私聊（A-14 后半）' },
  { key: 'agent', label: 'mode.agent', expect: 3, why: '回归哨兵，必须恒为 3（A-15 / S5）' }
]

async function main() {
  const r = await runProbe()
  console.log('source=live-provider（服务端实测 body.tools.length，不是按 mode 映射推算）')
  console.log('registered=' + r.registered)
  for (const scenario of PROBE_SCENARIOS) {
    const row = r[scenario.key]
    const mark = row.tools === scenario.expect ? '' : '  ← 期望 ' + scenario.expect
    console.log(scenario.label + '=' + row.mode + ' tools=' + row.tools + ' status=' + row.status + mark)
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch((error) => {
    console.error('PROBE_FAILED ' + (error && error.message ? error.message : String(error)))
    process.exit(1)
  })
}
