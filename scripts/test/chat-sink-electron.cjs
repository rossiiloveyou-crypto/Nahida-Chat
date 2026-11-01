/**
 * ChatSink 重构（P3）的渲染层零回归证据：真 Electron、真 preload、真 IPC。
 *
 * 为什么不满足于纯 Node 测试：chat-sink.test.mjs 证明的是主进程内部逻辑；
 * 而 P3 动过 chatService / permission 的输入口径，真正要防的回归是
 * 「渲染进程拿到的 chat:delta / chat:done 还对不对、还是不是流式」。
 * 这条路径只有起真 Electron（out/main/index.js + preload 的 contextBridge）才走得到。
 *
 * 断言的是**契约**，不是像素：DOM 正在被另一个 agent 改，这里只用 window.nahida。
 *
 * 跑法：pnpm test:chat-sink:electron（需先 pnpm build）
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '..', '..')
const userData = path.join(os.tmpdir(), 'nahida-chatsink-e2e-' + Date.now())
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setAppPath(projectRoot)

const out = []
let failed = 0
function check(label, ok, extra) {
  out.push((ok ? 'ok  ' : 'FAIL') + ' ' + label)
  if (!ok) failed += 1
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
}

if (!fs.existsSync(path.join(projectRoot, 'out', 'main', 'index.js'))) {
  console.log('SKIP：缺 out/main/index.js（先 pnpm build）')
  process.exit(0)
}

require(path.join(projectRoot, 'out', 'main', 'index.js'))

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2200))
  const win = BrowserWindow.getAllWindows()[0]
  check('窗口已创建', !!win)
  win.webContents.on('console-message', (_e, level, message) => {
    console.log('[renderer:' + level + '] ' + String(message).slice(0, 300))
  })
  // 在页面里自己 try/catch：executeJavaScript 的 reject 只给一句笼统的话，
  // 包一层才能看到真正的异常文本（排查渲染层问题时这一句就是全部线索）
  const run = async (expression) => {
    const wrapped =
      '(async () => { try { return { ok: true, value: await (' +
      expression +
      ') } } catch (e) { return { ok: false, error: String((e && e.stack) || e) } } })()'
    const res = await win.webContents.executeJavaScript(wrapped, true)
    if (res && res.ok === false) throw new Error('页面内异常：' + res.error)
    return res ? res.value : undefined
  }
  // 语句块版本：需要多条语句时用（表达式版塞不进 `await (...)`）
  const runBody = async (body) => {
    const wrapped =
      '(async () => { try { return { ok: true, value: await (async () => { ' +
      body +
      ' })() } } catch (e) { return { ok: false, error: String((e && e.stack) || e) } } })()'
    const res = await win.webContents.executeJavaScript(wrapped, true)
    if (res && res.ok === false) throw new Error('页面内异常：' + res.error)
    return res ? res.value : undefined
  }
  check('preload 已注入 window.nahida', (await run('typeof window.nahida')) === 'object', await run('typeof window.nahida'))
  const apiKeys = await run('Object.keys(window.nahida).join(",")')
  console.log('  window.nahida keys: ' + apiKeys)

  try {
    // 1. 关掉记忆（避免真去下载 embedding 模型），权限保持默认 approve
    await run(
      `window.nahida.settings.save({ memory: { enabled: false, autoExtract: false } })`
    )
    const prompts = await run('window.nahida.prompts.library()')
    check('提示词库可读（主进程侧未受影响）', !!(prompts && prompts.characters))

    // 2. 在渲染进程里挂监听，走的是用户点发送时同一条通道
    await runBody(`
      window.__sinkProbe = { deltas: [], done: null, error: null, order: '' }
      window.nahida.chat.onDelta((d) => {
        window.__sinkProbe.deltas.push(d.delta)
        window.__sinkProbe.order += 'd'
      })
      window.nahida.chat.onDone((d) => {
        window.__sinkProbe.done = d
        window.__sinkProbe.order += 'D'
      })
      window.nahida.chat.onError((e) => {
        window.__sinkProbe.error = e
        window.__sinkProbe.order += 'E'
      })
      return true
    `)

    // 3. 建会话并发送（与左侧栏「新建对话 -> 输入 -> 发送」完全等价）
    const session = await run("window.nahida.chat.createSession({ mode: 'chat' })")
    check('会话已创建', !!(session && session.id))

    const sent = await run(
      `window.nahida.chat.send({ sessionId: ${JSON.stringify(session.id)}, content: '你好，说说你自己' })`
    )
    check('send 同步返回 userMessage / assistantMessage', !!(sent && sent.userMessage && sent.assistantMessage))
    check('返回时 assistant 仍是 streaming', sent && sent.assistantMessage.status === 'streaming', sent && sent.assistantMessage.status)

    // 4. 等 done（最多 30 s）
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const probe = await run('window.__sinkProbe.done === null && window.__sinkProbe.error === null')
      if (!probe) break
      await new Promise((r) => setTimeout(r, 100))
    }

    const probe = await run('window.__sinkProbe')
    const joined = (probe.deltas || []).join('')

    check('收到了多片 chat:delta（流式没退化成一次性）', (probe.deltas || []).length > 3, (probe.deltas || []).length + ' 片')
    check('没有触发 chat:error', probe.error === null, probe.error && probe.error.message)
    check('收到了 chat:done', !!probe.done)
    check('done 晚于全部 delta（没有提前收尾）', /^d+D$/.test(probe.order || ''), probe.order && probe.order.slice(-6))
    check('delta 拼起来 === done.content（增量与全文一致）', probe.done && joined === probe.done.content, joined.length + ' vs ' + (probe.done ? probe.done.content.length : '-'))
    check('正文非空', !!probe.done && probe.done.content.length > 0, probe.done && probe.done.content.length)
    check('done 带 toolCalls 数组', !!probe.done && Array.isArray(probe.done.toolCalls))
    check('done.sessionId / messageId 与发送时一致',
      !!probe.done && probe.done.sessionId === session.id && probe.done.messageId === sent.assistantMessage.id)

    // 5. 落库一致：会话列表里那条 assistant 已经 done
    const sessions = await run('window.nahida.chat.listSessions()')
    const stored = (sessions || []).find((s) => s.id === session.id)
    const lastAssistant = stored && [...stored.messages].reverse().find((m) => m.role === 'assistant')
    check('落库的 assistant 状态是 done', lastAssistant && lastAssistant.status === 'done', lastAssistant && lastAssistant.status)
    check('落库正文 === done.content', lastAssistant && probe.done && lastAssistant.content === probe.done.content)
  } catch (error) {
    check('e2e 全程无异常', false, error && error.message)
  }

  console.log('')
  console.log('共 ' + (out.length) + ' 项，失败 ' + failed + ' 项')
  app.exit(failed === 0 ? 0 : 1)
})
