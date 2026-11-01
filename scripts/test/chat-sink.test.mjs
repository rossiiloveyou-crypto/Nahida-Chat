/**
 * ChatSink 重构（P3）的无人值守判据：G1–G5 + 渲染层契约不变。
 *
 * 测的是**真实边界**，不是"再实现一遍":
 *  - 真跑 chatService（esbuild 打成 CJS，只把 electron 换成桩），真调 mockProvider 的 stream
 *  - 真 await 一轮（G4 必须真的 await 一次 —— D16：全绿 ≠ 路径被执行）
 *  - 真触发一次 ask 类工具，断言审批"当场拒绝且不挂起"（G5）
 *  - 真给 WebContentsSink 一个假 sender，逐条比对 IPC 通道名与载荷（渲染层零回归）
 *
 * 跑法：pnpm test:chat-sink
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
  results.push({ label, ok })
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

const sandbox = path.join(os.tmpdir(), 'nahida-chatsink-test-' + process.pid + '-' + Date.now())
const userData = path.join(sandbox, 'userData')
fs.mkdirSync(userData, { recursive: true })

/* ── 1. 把主进程模块打成 CJS，electron 换成桩 ──────────────────────────── */

const esbuild = loadEsbuild()
const entry = path.join(sandbox, 'entry.ts')
const p = (rel) => path.join(projectRoot, rel).replace(/\\/g, '/')
fs.writeFileSync(
  entry,
  [
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { registerTool, listDefinitions } from '${p('src/main/features/tools/registry.ts')}'`,
    `export { registerBuiltinTools } from '${p('src/main/features/tools/builtin.ts')}'`,
    `export { HeadlessSink, NullSink, WebContentsSink } from '${p('src/main/features/chat/sink.ts')}'`,
    `export { IPC } from '${p('src/shared/ipc.ts')}'`
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
const appPath = ${JSON.stringify(projectRoot)}
module.exports = {
  app: {
    getPath: (key) => (key === 'userData' ? userData : path.join(userData, String(key))),
    getAppPath: () => appPath,
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

// memory 默认 enabled=true，会去调 embedding 模型；本测试只关心对话链路
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false } }),
  'utf8'
)

const mod = require(output)
const { chatService, registerTool, listDefinitions, registerBuiltinTools, HeadlessSink, WebContentsSink, IPC } = mod
registerBuiltinTools()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── G1 抽象存在且被使用（结构判据，J-07：不看"编译过了"） ─────────────── */

console.log('G1 ChatSink 抽象')
const sinkSrc = fs.readFileSync(path.join(projectRoot, 'src/main/features/chat/sink.ts'), 'utf8')
check('sink.ts 有 ChatSink 接口', /export interface ChatSink/.test(sinkSrc))
check('sink.ts 有 WebContentsSink 类', /export class WebContentsSink/.test(sinkSrc))
check('sink.ts 有 HeadlessSink 类', /export class HeadlessSink/.test(sinkSrc))
check('ChatSink 带 isAlive / canApprove / delta / done / fail / tool / presentApproval', [
  'isAlive(',
  'canApprove(',
  'delta(',
  'done(',
  'fail(',
  'tool(',
  'presentApproval('
].every((sig) => sinkSrc.includes(sig)))
const chatSrc = fs.readFileSync(path.join(projectRoot, 'src/main/features/chat/chatService.ts'), 'utf8')
check('chatService 真的用了 sink（有 sendAwait）', /async sendAwait\(/.test(chatSrc))

/* ── G2 WebContents 归零（硬判据） ─────────────────────────────────────── */

console.log('G2 WebContents 归零')
for (const rel of ['src/main/features/chat/chatService.ts', 'src/main/features/tools/permission.ts']) {
  const hits = fs
    .readFileSync(path.join(projectRoot, rel), 'utf8')
    .split('\n')
    .map((line, i) => ({ line, i: i + 1 }))
    .filter((row) => row.line.includes('WebContents'))
  check(rel + ' 里 WebContents 命中 = 0', hits.length === 0, hits.map((h) => h.i).join(',') || '0 命中')
}

/* ── G3 HeadlessSink 能跑完一整轮 ──────────────────────────────────────── */

console.log('G3 Headless 跑完整轮')
const chatSession = chatService.createSession({ mode: 'chat' })
const headless = new HeadlessSink()
const t0 = Date.now()
const outcome = await chatService.sendAwait({ sessionId: chatSession.id, content: '你好，随便聊聊' }, headless)
const elapsed = Date.now() - t0
check('status === done', outcome.status === 'done', outcome.status)
check('content 非空', typeof outcome.content === 'string' && outcome.content.length > 0, outcome.content.length + ' 字')
check('sink 也拿到了同一份正文', headless.content === outcome.content, headless.content.length === outcome.content.length)
check('done 只触发一次', headless.doneCount === 1, headless.doneCount)
check('确实是流式（多片 delta 拼起来的）', elapsed >= 100 && headless.content.length > 40, elapsed + 'ms')
check('outcome 带 sessionId / messageId', !!outcome.sessionId && !!outcome.messageId)
check('outcome 带耗时', typeof outcome.durationMs === 'number' && outcome.durationMs >= 0, outcome.durationMs)

/* ── G4 能 await 整轮 + turns 不泄漏 ───────────────────────────────────── */

console.log('G4 sendAwait 可 await')
const pending = chatService.sendAwait({ sessionId: chatSession.id, content: '再来一句' }, new HeadlessSink())
check('await 之前 isGenerating === true', chatService.isGenerating(chatSession.id) === true)
const second = await pending
check('await 之后 isGenerating === false（turns 已清理）', chatService.isGenerating(chatSession.id) === false)
check('第二轮的 outcome 也是 done', second.status === 'done', second.status)
check('两轮的 messageId 不同（不是复用同一个）', second.messageId !== outcome.messageId)

/* ── G5 审批恒拒绝，且不挂起 ───────────────────────────────────────────── */

console.log('G5 Headless 审批恒拒绝')
// 把 fs.list_dir 的 readOnly 改成 false —— mockProvider 会主动请求它，
// 这样在 approve 模式下就一定会走 permissionGate.request（ask 分支）。
let toolRuns = 0
registerTool({
  definition: { ...listDefinitions().find((d) => d.name === 'fs.list_dir'), readOnly: false },
  async run() {
    toolRuns += 1
    return { ok: true, output: '不该被执行' }
  }
})
check('fs.list_dir 现在是非只读（会触发 ask）', listDefinitions().find((d) => d.name === 'fs.list_dir').readOnly === false)

const agentSession = chatService.createSession({ mode: 'agent' })
const approveSink = new HeadlessSink()
const tAsk = Date.now()
const askOutcome = await chatService.sendAwait(
  { sessionId: agentSession.id, content: '看看工作区里有啥' },
  approveSink
)
const askElapsed = Date.now() - tAsk
const toolCall = (askOutcome.toolCalls || [])[0]
check('工具调用被记成 denied', !!toolCall && toolCall.status === 'denied', toolCall ? toolCall.status : '没有 toolCall')
check('错误文案是"拒绝或超时"', !!toolCall && /拒|超时/.test(String(toolCall.error)), toolCall ? toolCall.error : '')
check('没有真的执行工具', toolRuns === 0, toolRuns)
check('sink 收到了审批票据（确实走到 ask 分支）', approveSink.approvals.length === 1, approveSink.approvals.length)
check('不挂起：全程远低于 120 s 超时', askElapsed < 15_000, askElapsed + 'ms')
check('被拒之后整轮仍然 done（对话没断）', askOutcome.status === 'done' && askOutcome.content.length > 0, askOutcome.status)

/* ── 渲染层契约不变：WebContentsSink 的通道名与载荷 ────────────────────── */

console.log('渲染层契约（IPC 通道名 / 载荷结构）')
const sent = []
const fakeSender = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) }
const wcSink = new WebContentsSink(fakeSender)
const wsSession = chatService.createSession({ mode: 'chat' })
const wsOutcome = await chatService.sendAwait({ sessionId: wsSession.id, content: '你好' }, wcSink)
const channels = [...new Set(sent.map((s) => s.channel))]
check('通道名只有既有的 chatDelta / chatDone', channels.every((c) => c === IPC.chatDelta || c === IPC.chatDone), channels.join(','))
check('chatDelta 载荷字段 = {sessionId,messageId,delta}', sent
  .filter((s) => s.channel === IPC.chatDelta)
  .every((s) => Object.keys(s.payload).sort().join(',') === 'delta,messageId,sessionId'))
const donePayload = sent.filter((s) => s.channel === IPC.chatDone).pop()
check('chatDone 载荷字段 = {sessionId,messageId,content,toolCalls}', !!donePayload &&
  Object.keys(donePayload.payload).sort().join(',') === 'content,messageId,sessionId,toolCalls')
check('chatDone 的 content 与 outcome 一致', donePayload && donePayload.payload.content === wsOutcome.content)

// 窗口销毁后既不再发消息、也不把生成流程打断（原来 sender.isDestroyed() 那个分支的等价物）
const deadSent = []
const deadSender = { isDestroyed: () => true, send: (channel) => deadSent.push(channel) }
const deadOutcome = await chatService.sendAwait(
  { sessionId: chatSession.id, content: '窗口已经关了' },
  new WebContentsSink(deadSender)
)
check('isDestroyed 的 sender：一条都不发', deadSent.length === 0, deadSent.length)
check('isDestroyed 的 sender：整轮照样跑完并落库', deadOutcome.status === 'done' && deadOutcome.content.length > 0, deadOutcome.status)

/* ── send() 的返回语义没变（同步拿到 SendResult） ──────────────────────── */

console.log('send() 语义')
const s2 = chatService.createSession({ mode: 'chat' })
const result = await chatService.send({ sessionId: s2.id, content: '同步返回' }, fakeSender)
check('返回 userMessage + assistantMessage', !!result.userMessage && !!result.assistantMessage)
check('返回时 assistantMessage 仍是 streaming（生成在后台继续）', result.assistantMessage.status === 'streaming', result.assistantMessage.status)
check('返回时 isGenerating === true', chatService.isGenerating(s2.id) === true)
check('同一会话并发第二发被拒（既有行为不变）', await chatService
  .send({ sessionId: s2.id, content: '并发' }, fakeSender)
  .then(() => false)
  .catch((e) => /仍在生成中/.test(String(e && e.message))))
while (chatService.isGenerating(s2.id)) await sleep(50)
const stored = chatService.listSessions().find((x) => x.id === s2.id)
const lastAssistant = [...stored.messages].reverse().find((m) => m.role === 'assistant')
check('跑完后落库的 assistant 状态是 done', lastAssistant && lastAssistant.status === 'done', lastAssistant && lastAssistant.status)
check('落库正文非空', lastAssistant && lastAssistant.content.length > 0, lastAssistant && lastAssistant.content.length)

/* ── 汇总 ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok)
console.log('')
console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项')
if (failed.length > 0) {
  console.log('失败：')
  for (const f of failed) console.log('  - ' + f.label)
  process.exit(1)
}
console.log('PASS chat-sink')
