/**
 * 工具供给闸守卫（ERR-PHASE-01 · T3）。
 *
 * 守的是什么：**「本轮没给模型这个工具」时，模型自己吐出来的 tool_call 不许被执行**。
 *
 * 为什么这不是「再实现一遍」：
 *   本文件不复制 chatService 里的任何判断，而是**真跑 chatService.sendAwait**
 *   → 真 openAiCompatibleProvider → 本地假模型服务（服务端真的回 tool_calls）
 *   → 真 runTool / 真 executeTool。断言看的是「工具到底有没有真的跑」，
 *   而不是「源码里有没有某段字符串」（P14 / P16）。
 *
 * 「执行了」的唯一可观测量：
 *   - runTool 在越过全部闸门、真正开始跑工具时才会写 startedAt（chatService.ts 的
 *     record.startedAt = Date.now()）；被拦下的记录 startedAt 恒为 0。
 *   - 对照物里还额外核对 result 里出现了工作区里那个哨兵文件的**内容**
 *     —— 内容只可能来自 executeTool 真的读了盘。
 *
 * 对照物（P17）：A-01 与 A-03 成对。只有「给的时候真跑」和「不给的时候不跑」同时绿，
 *   才能证明 A-03 的「没跑」不是「这套测试根本跑不起来工具」。
 *
 * 跑法：node scripts/test/tool-supply-gate.test.mjs（或在 pnpm test 链尾）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')
const p = (rel) => path.join(projectRoot, rel).replace(/\\/g, '/')

/** 哨兵文件：内容只可能通过 executeTool 读到。 */
const SENTINEL_NAME = 'sentinel.txt'
const SENTINEL_TEXT = 'SENTINEL-7f3a9c-供给闸对照物'

/** 本轮要用的两个工具名：一个注册过、一个从没注册过。 */
const TOOL_REGISTERED = 'fs.read_file'
const TOOL_UNREGISTERED = 'execute_command'

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

/**
 * 本地假模型服务。
 *
 * 每个请求依次消费 script 里的一步：
 *   { kind: 'tool', name, args }  → 回一段带 tool_calls 的 SSE（模拟「模型吐了个工具调用」）
 *   { kind: 'text', text }        → 回一段纯文本 SSE
 * script 用完之后一律回默认文本，避免「少写一步就挂住」。
 *
 * 🔴 请求体全部留档：A-01 / A-02 的「definitions 几个」是**服务端实测**的
 *    body.tools.length，不是按 settings 推算的。
 */
function startFakeModel() {
  const requests = []
  let script = []
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
      requests.push(body)

      const step = script.shift() ?? { kind: 'text', text: '（脚本用完了，本轮到此为止）' }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      if (step.kind === 'tool') {
        const chunk = {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: step.id || 'call_probe',
                    type: 'function',
                    function: { name: step.name, arguments: JSON.stringify(step.args || {}) }
                  }
                ]
              }
            }
          ]
        }
        res.write('data: ' + JSON.stringify(chunk) + '\n\n')
      } else {
        for (const piece of String(step.text).match(/[\s\S]{1,8}/g) || []) {
          res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] }) + '\n\n')
        }
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
        requests,
        setScript(next) {
          script = next.slice()
        },
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tool-supply-gate-'))
const userData = path.join(sandbox, 'userData')
const workspaceDir = path.join(sandbox, 'workspace')
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(workspaceDir, { recursive: true })
fs.writeFileSync(path.join(workspaceDir, SENTINEL_NAME), SENTINEL_TEXT, 'utf8')

const fake = await startFakeModel()

// settings.json 必须在任何 settingsStore.get() 之前写好（load 是懒的，第一次 get 才读盘）。
// 与真机现场同款：permission.mode 放行、工作区就绪 —— 也就是说，
// 只要供给闸缺席，这些调用**一定会被真的执行**（这正是缺陷现场）。
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify(
    {
      provider: 'openai-compatible',
      baseUrl: fake.baseUrl,
      apiKey: 'sk-gate-0123456789',
      model: 'gate-model',
      temperature: 0,
      defaultCharacterId: 'nahida',
      permission: { mode: 'approve' },
      memory: { enabled: false, autoExtract: false },
      workspaces: [
        { id: 'ws-supply-gate', name: 'gate', dir: workspaceDir, createdAt: 1, updatedAt: 1 }
      ],
      activeWorkspaceId: 'ws-supply-gate',
      // 初值：增强开着、只勾了 fs.read_file（A-01 的对照物要用它）
      chatTools: { enabled: true, tools: { [TOOL_REGISTERED]: true } }
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

const bundle = path.join(sandbox, 'bundle.cjs')
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
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

const { chatService, registerBuiltinTools, listDefinitions, settingsStore, HeadlessSink } = require(bundle)

// 对照物先就位（P17）：注册表为空时，下面所有「工具没跑」都通过得毫无意义。
registerBuiltinTools()
const registered = listDefinitions().length

/** 真落盘地改 chatTools（J-05：不走内存，走 settingsStore.save 的生产路径）。 */
const setChatTools = (chatTools) => {
  settingsStore.save({ chatTools })
  return settingsStore.get().chatTools
}

const TIMEOUT_MS = 30_000

/** 跑一轮：脚本化模型 + HeadlessSink（桌面形态，senderId 恒 null），返回本轮全部请求体与 outcome。 */
async function round(sessionId, script, content) {
  fake.setScript(script)
  const before = fake.requests.length
  const sink = new HeadlessSink()
  const outcome = await Promise.race([
    chatService.sendAwait({ sessionId, content }, sink),
    new Promise((_, reject) => setTimeout(() => reject(new Error('round timeout ' + TIMEOUT_MS + 'ms')), TIMEOUT_MS))
  ])
  return { outcome, requests: fake.requests.slice(before), sink }
}

/** 「真的执行了工具」的唯一可观测量：runTool 越过全部闸门后才写的 startedAt。 */
const executed = (record) => Boolean(record) && Number(record.startedAt) > 0

/** 服务端实测的工具目录长度（请求体里没有 tools 字段 = 0）。 */
const toolsSeen = (body) => (Array.isArray(body && body.tools) ? body.tools.length : 0)

console.log('工具供给闸（真跑 chatService.runStream，服务端实测 tool_calls）')

try {
  // ── 第 1 轮：对照物（供给开着 → 同一个调用必须真的跑）────────────
  const controlSession = chatService.createSession({ mode: 'chat' })
  const control = await round(
    controlSession.id,
    [
      { kind: 'tool', id: 'call_control', name: TOOL_REGISTERED, args: { path: SENTINEL_NAME } },
      { kind: 'text', text: '读到了。' }
    ],
    '看看工作区里的哨兵文件'
  )
  const controlCall = control.outcome.toolCalls[0]
  check(
    'A-01 对照物：增强开着 + 勾 1 个 → 服务端收到 1 个工具，且该调用真的执行（读到哨兵内容）',
    registered > 0 &&
      toolsSeen(control.requests[0]) === 1 &&
      control.outcome.toolCalls.length === 1 &&
      executed(controlCall) &&
      typeof controlCall.result === 'string' &&
      controlCall.result.includes(SENTINEL_TEXT),
    'tools=' + toolsSeen(control.requests[0]) +
      ' status=' + (controlCall && controlCall.status) +
      ' startedAt=' + (controlCall && controlCall.startedAt)
  )

  // ── 第 2 轮：关总开关，同一个会话、同一个调用（历史里已经有 role:'tool'）──
  // 保留 tools 勾选不变，只把 enabled 关掉 —— 与真机 settings.json 现场逐字一致。
  setChatTools({ enabled: false })
  const gated = await round(
    controlSession.id,
    [
      { kind: 'tool', id: 'call_gated', name: TOOL_REGISTERED, args: { path: SENTINEL_NAME } },
      { kind: 'text', text: '好的。' }
    ],
    '再看看那个文件'
  )
  const gatedCall = gated.outcome.toolCalls[0]

  check(
    'A-02 增强关闭 → 本轮交给模型的工具目录为 0',
    toolsSeen(gated.requests[0]) === 0,
    'tools=' + toolsSeen(gated.requests[0])
  )

  check(
    'A-03 本轮目录为空时，模型自己吐的 tool_call 不被执行（startedAt 恒 0）',
    gatedCall !== undefined && !executed(gatedCall) && gatedCall.result === null,
    'executed=' + (gatedCall ? executed(gatedCall) : '缺记录') +
      ' status=' + (gatedCall && gatedCall.status) +
      ' result=' + (gatedCall ? JSON.stringify(gatedCall.result) : '-')
  )

  check(
    'A-04 该记录的 status 是 denied（不是 ok，也不是 error）',
    gatedCall !== undefined && gatedCall.status === 'denied',
    'status=' + (gatedCall && gatedCall.status)
  )

  check(
    'A-05 message.toolCalls 里仍保留这条被拦记录（否则模型会反复重试）',
    gated.outcome.toolCalls.length === 1,
    'length=' + gated.outcome.toolCalls.length
  )

  // A-06 的判据有两面：
  //   ① 记录上的理由（会进 ToolCallRecord.error）
  //   ② 回喂给模型的那条 role:'tool' 消息里**真的带着**这条理由（否则模型只看到空白）
  const INTERNAL_TERMS = ['definitions', 'allowedtools', 'capability', 'resolvesupply', 'toolsupply']
  const reason = gatedCall && gatedCall.error ? String(gatedCall.error) : ''
  const fedBack = (gated.requests[1] && Array.isArray(gated.requests[1].messages)
    ? gated.requests[1].messages.filter((message) => message.role === 'tool')
    : []
  ).map((message) => String(message.content || ''))
  const lowered = reason.toLowerCase()
  const hits = INTERNAL_TERMS.filter((term) => lowered.includes(term))
  check(
    'A-06 拒绝理由可读、不含内部术语，且被回喂给模型（role:tool 里能看到它）',
    reason.length > 0 &&
      hits.length === 0 &&
      fedBack.some((text) => text.includes(reason)) &&
      fedBack.every((text) => !INTERNAL_TERMS.some((term) => text.toLowerCase().includes(term))),
    'hits=' + (hits.length === 0 ? '无' : hits.join('/')) + ' fedBackToolMessages=' + fedBack.length
  )

  // ── A-07：历史回放不构成绕过 ─────────────────────────────
  // 第 1 轮真的执行过，所以第 2 轮的请求体里**必须**还有那条 role:'tool' 回执（回放没被削弱）；
  // 同时第 2 轮新吐出来的调用被供给闸拦下（这正是「改执行侧，不改历史侧」）。
  const replayMessages = Array.isArray(gated.requests[0] && gated.requests[0].messages)
    ? gated.requests[0].messages
    : []
  const replayedToolMessages = replayMessages.filter((message) => message.role === 'tool')
  const replayedAssistantWithCalls = replayMessages.filter(
    (message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
  )
  check(
    'A-07 历史 role:tool 回放仍在，但新 tool_call 被拦（绕过路径不成立）',
    replayedToolMessages.length > 0 &&
      replayedToolMessages.some((message) => String(message.content || '').includes(SENTINEL_TEXT)) &&
      replayedAssistantWithCalls.length > 0 &&
      gatedCall !== undefined &&
      !executed(gatedCall),
    'replayedTool=' + replayedToolMessages.length +
      ' replayedAssistantWithCalls=' + replayedAssistantWithCalls.length +
      ' gatedExecuted=' + (gatedCall ? executed(gatedCall) : '-')
  )

  // ── A-08：未注册工具与注册工具同一条闸 ─────────────────────
  // 现场证据里 execute_command 走的是「未注册」闸（status:error）。
  // 供给关闭后，它连那道闸都走不到：先在供给闸被拦，status 必须是 denied。
  const foreignSession = chatService.createSession({ mode: 'chat' })
  const foreign = await round(
    foreignSession.id,
    [
      { kind: 'tool', id: 'call_foreign', name: TOOL_UNREGISTERED, args: { command: 'powershell -NoProfile -Command Get-ChildItem' } },
      { kind: 'text', text: '好。' }
    ],
    '帮我执行一条命令'
  )
  const foreignCall = foreign.outcome.toolCalls[0]
  check(
    'A-08 未注册工具（execute_command）在供给关闭时也被供给闸拦下 → denied（不是 error）',
    foreignCall !== undefined && !executed(foreignCall) && foreignCall.status === 'denied',
    'status=' + (foreignCall && foreignCall.status) + ' rootCause=' + (foreignCall && foreignCall.error ? '有理由' : '无理由')
  )
} finally {
  await fake.close()
}

const failed = results.filter((row) => !row.ok)
console.log('')
console.log('tool-supply-gate: ' + (results.length - failed.length) + '/' + results.length + ' passed')
console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项')
if (failed.length > 0) {
  console.log('失败：')
  for (const row of failed) console.log('  - ' + row.label)
  process.exit(1)
}
console.log('PASS tool-supply-gate')
