/**
 * A7（真 Electron 版）：真 BrowserWindow + 真 IPC 通道 + 真 preload。
 *
 * 纯 Node 版（qq-bridge.test.mjs）证明的是编排逻辑；这里要证明的是
 * 「QqSink 广播 + qq:event 推送确实能穿过 contextIsolation 到渲染进程」——
 * 这条路径只有在 Electron 里才走得到（P3 的 D16 同源教训）。
 *
 * 跑法：pnpm test:qq-bridge:electron
 * 说明：为了不把 @huggingface/transformers 拖进测试，chatService 被换成了空壳
 *       （本用例只喂假 chat，从不调用它）。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '..', '..')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-bridge-e2e-'))
const userData = path.join(sandbox, 'userData')
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setAppPath(projectRoot)

const results = []
let failed = 0
function check(label, ok, extra) {
  results.push({ label, ok: Boolean(ok) })
  if (!ok) failed += 1
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function main() {
  const chatStub = path.join(sandbox, 'chat-stub.ts')
  fs.writeFileSync(chatStub, 'export const chatService = null as unknown as never\n', 'utf8')

  const bundlePath = path.join(sandbox, 'bridge.cjs')
  // 插件只能在异步 build 里用（buildSync 会直接抛 "Cannot use plugins in synchronous API calls"）
  await loadEsbuild().build({
    entryPoints: [path.join(projectRoot, 'src/main/features/qq/bridge.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    external: ['electron'],
    alias: { '@shared': path.join(projectRoot, 'src/shared') },
    plugins: [
      {
        name: 'stub-chat-service',
        setup(build) {
          build.onResolve({ filter: /chatService$/ }, (args) => {
            if (args.importer.endsWith('bridge.ts')) return { path: chatStub }
            return null
          })
        }
      }
    ],
    logLevel: 'silent'
  })

  const preloadPath = path.join(sandbox, 'probe-preload.js')
  fs.writeFileSync(
    preloadPath,
    [
      'const { ipcRenderer, contextBridge } = require("electron")',
      'const events = []',
      'for (const channel of ["chat:delta", "chat:done", "chat:error", "chat:todo", "qq:event"]) {',
      '  ipcRenderer.on(channel, (_event, payload) => events.push({ channel, payload }))',
      '}',
      'contextBridge.exposeInMainWorld("probe", { events: () => events })'
    ].join('\n'),
    'utf8'
  )

  const { createQqBridge, broadcastToWindows } = require(bundlePath)

  const bodyCalls = []
  const chatCalls = []
  // P6：白名单条目（不再是绑定表）。会话 id 由外部键直接算出。
  const KEY = 'qq:10001:private:20002'
  const ensureCalls = []
  const store = {
    access: () => [
      {
        key: KEY,
        channel: 'qq',
        uin: '10001',
        chatType: 'private',
        chatId: '20002',
        label: '',
        permissions: { respond: true, tool: false },
        lastAt: 0,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    settings: () => ({
      typingMode: 'text',
      typingText: '正在看…',
      typingEventType: 1,
      groupRequireMention: true,
      atOnGroupReply: true,
      segmentDelayMs: 20,
      maxSegments: 10,
      maxCharsPerSegment: 1500,
      rateLimitPerUser: 20,
      rateLimitPerChannel: 60,
      errorReplyText: ''
    }),
    touchAccess: () => {}
  }

  const host = {
    on: () => () => {},
    invokeAction: async (uin, action, params) => {
      bodyCalls.push({ uin, action, params, at: Date.now() })
      return { ok: true, retcode: 0, messageId: '1', error: null }
    }
  }

  const chat = {
    sendAwait: async (input, sink) => {
      chatCalls.push(input)
      sink.delta({ sessionId: input.sessionId, messageId: 'm', delta: '一。' })
      sink.done({ sessionId: input.sessionId, messageId: 'm', content: '一。二。', toolCalls: [] })
      return { status: 'done', sessionId: input.sessionId, messageId: 'm', content: '一。二。', toolCalls: [], durationMs: 1 }
    }
  }

  await app.whenReady()

  const window = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  })
  await window.loadURL('data:text/html,<html><body><h1>probe</h1></body></html>')

  const run = async (expression) => window.webContents.executeJavaScript(expression, true)

  check('窗口与 preload 就绪', (await run('typeof window.probe')) === 'object', await run('typeof window.probe'))

  const bridge = createQqBridge({
    host,
    chat,
    store,
    ensureSession: (sessionId, title) => ensureCalls.push({ sessionId, title }),
    broadcast: broadcastToWindows,
    sleep
  })
  check('bridge 创建成功（真 Electron 主进程内）', Boolean(bridge))

  const event = {
    post_type: 'message',
    message_type: 'private',
    message_id: 1,
    user_id: 20002,
    self_id: '10001',
    message: [{ type: 'text', data: { text: '你好' } }],
    sender: { user_id: 20002, nickname: '小明' }
  }
  await bridge.handleEvent('10001', event)
  await sleep(200)

  const events = await run('window.probe.events()')
  const channels = events.map((item) => item.channel)
  check('渲染进程收到 chat:delta', channels.includes('chat:delta'), channels.join(','))
  check('渲染进程收到 chat:done', channels.includes('chat:done'))
  check('渲染进程收到 qq:event', channels.includes('qq:event'))

  const feed = events.filter((item) => item.channel === 'qq:event').pop()
  check('qq:event 的判定是 responded', feed && feed.payload.outcome === 'responded', feed && feed.payload.outcome)
  check('qq:event 携带外部会话标识', feed && feed.payload.chatId === '20002' && feed.payload.chatType === 'private')

  const done = events.filter((item) => item.channel === 'chat:done').pop()
  check('chat:done 的 sessionId 是外部键（P6：会话 id = 外部键）', done && done.payload.sessionId === KEY, done && done.payload.sessionId)
  check('首次消息自动派生会话（ensureSession 用外部键 + label 回落 chatId）', ensureCalls.length === 1 && ensureCalls[0].sessionId === KEY && ensureCalls[0].title === '20002', JSON.stringify(ensureCalls))

  const sends = bodyCalls.filter(
    (call) => Array.isArray(call.params.message) && call.params.message.some((s) => s.data && s.data.text !== '正在看…')
  )
  check('逐段发送 2 条', sends.length === 2, sends.length)
  const joined = sends
    .map((call) => call.params.message.filter((s) => s.type === 'text').map((s) => s.data.text).join(''))
    .join('')
  check('拼接等于原文（J-16）', joined === '一。二。', joined)
  check('第 0 条调用是 typing', bodyCalls.length > 0 && JSON.stringify(bodyCalls[0].params.message).includes('正在看…'))
  check('chat.sendAwait 只调了 1 次', chatCalls.length === 1, chatCalls.length)

  bridge.stop()
  window.destroy()
  console.log('')
  console.log('共 ' + String(results.length) + ' 项，失败 ' + String(failed) + ' 项')
  app.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  check('e2e 全程无异常', false, error && error.message)
  app.exit(1)
})
