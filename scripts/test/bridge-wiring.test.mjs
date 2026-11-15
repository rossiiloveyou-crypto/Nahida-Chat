/**
 * 桥接接线判据（P6 / PHASE-6 §3 的 A1–A5）。
 *
 * 跑法：node scripts/test/bridge-wiring.test.mjs
 *
 * 测的是**真边界**，不是「再实现一遍」：
 * 1. 分流判定：三条件各缺一条都必须回落旧路径（A2/A3），且判定点只有一处（停止条件 2）；
 * 2. 形状转换：payload → 桥接历史 / system 段，逐字搬运、丢弃有账；
 * 3. 生成器：先做流式增量再以桥接结论为准（M5 落库原稿），失败文案一个字不改；
 * 4. 链路：**真跑 chatService**（esbuild 打 CJS + electron 桩），只把「跑一轮」换成假宿主 ——
 *    收尾、sink、落库、重试仍然是真代码，这才是 A4/A5 的意义。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p, projectRoot } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bridge-wiring-'))
installElectronStub(userData)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false }, bridge: { enabled: true } }),
  'utf8'
)

const mod = await bundleModule(
  'bridge-wiring',
  [
    "export { bridgeEligible, toBridgeMessages, toBridgeSystemPrompts, bridgeStreamOutcome } from '" + p('src/main/features/bridge/router.ts') + "'",
    "export { bridgeStream, setBridgeRunnerForTest } from '" + p('src/main/features/bridge/stream.ts') + "'",
    "export { chatService } from '" + p('src/main/features/chat/chatService.ts') + "'",
    "export { settingsStore } from '" + p('src/main/features/settings/settingsStore.ts') + "'",
    "export { WebContentsSink } from '" + p('src/main/features/chat/sink.ts') + "'",
    "export { bubbleViewOf } from '" + p('src/renderer/src/features/chat/bubble.ts') + "'",
    "export { IPC } from '" + p('src/shared/ipc.ts') + "'"
  ].join('\n')
)

const {
  bridgeEligible,
  toBridgeMessages,
  toBridgeSystemPrompts,
  bridgeStreamOutcome,
  bridgeStream,
  setBridgeRunnerForTest,
  chatService,
  settingsStore,
  WebContentsSink,
  bubbleViewOf,
  IPC
} = mod

const STORY = { id: '3f2a9c1e-0000-4000-8000-000000000001', mode: 'story' }
const CHAT = { id: '3f2a9c1e-0000-4000-8000-000000000002', mode: 'chat' }
const QQ_STORY = { id: 'qq:10001:group:20002', mode: 'story' }

/* ─────────────── 1–5 · 三条件与（A2 / A3） ─────────────── */

console.log('1–5 · 分流判定：三条件与，缺一条都回落旧路径')
check('1 · 三条件全成立 → true', bridgeEligible(STORY, { bridge: { enabled: true } }) === true)
check(
  '2 · mode !== story → false（chat / agent 都不走）',
  bridgeEligible(CHAT, { bridge: { enabled: true } }) === false &&
    bridgeEligible({ id: STORY.id, mode: 'agent' }, { bridge: { enabled: true } }) === false
)
check(
  '3 · 渠道会话 id → false（J-06：保 QQ 安全，即使 mode 写着 story）',
  bridgeEligible(QQ_STORY, { bridge: { enabled: true } }) === false
)
check('4 · 开关缺省（undefined）→ false（老配置升级零行为变化）', bridgeEligible(STORY, {}) === false)
check('5 · 开关显式 false → false', bridgeEligible(STORY, { bridge: { enabled: false } }) === false)

/* ─────────────── 6–8 · 形状转换 ─────────────── */

console.log('6–8 · payload → 桥接历史 / system 段')

const PAYLOAD = [
  { role: 'system', content: '人格：你是纳西妲。' },
  { role: 'system', content: '时间：现在是 2026-11-15 11:30。' },
  { role: 'user', content: '第一句：带两个空格  与换行\n第二行' },
  { role: 'assistant', content: '回答里带 emoji 🌱 和 **粗体**' },
  { role: 'tool', content: '工具回执不该进 ST' },
  { role: 'assistant', content: '' },
  { role: 'user', content: '最后一句：触发这一轮' }
]
const bridgeMessages = toBridgeMessages(PAYLOAD)
check(
  '6 · 只搬 user / assistant（system 与 tool 都不进 chat，空正文不搬）',
  bridgeMessages.length === 3 &&
    bridgeMessages.every((m) => m.role === 'user' || m.role === 'assistant') &&
    bridgeMessages.map((m) => m.role).join(',') === 'user,assistant,user',
  JSON.stringify(bridgeMessages.map((m) => m.role))
)
check(
  '7 · 正文逐字搬运（空格 / 换行 / emoji / 标记都不许动，M5）',
  bridgeMessages[0].content === PAYLOAD[2].content &&
    bridgeMessages[1].content === PAYLOAD[3].content &&
    bridgeMessages[2].content === PAYLOAD[6].content
)
const systemPrompts = toBridgeSystemPrompts(PAYLOAD)
check(
  '8 · system 段按 buildPayload 的顺序原样取出（人格 → 时间）',
  systemPrompts.length === 2 &&
    systemPrompts[0] === PAYLOAD[0].content &&
    systemPrompts[1] === PAYLOAD[1].content,
  systemPrompts.length
)

/* ─────────────── 9–11 · 三值映射（A4 的纯规则半边） ─────────────── */

console.log('9–11 · status 三值 → 生成器怎么收场')
const doneOutcome = bridgeStreamOutcome({
  status: 'done',
  content: '正文',
  raw: '正文',
  error: null,
  ms: 1,
  warnings: []
})
check(
  '9 · done → continue，正文取自 result.content',
  doneOutcome.kind === 'continue' && doneOutcome.text === '正文',
  JSON.stringify(doneOutcome)
)
const P5_ERROR = 'ST 返回空回复（可能被渠道截断或审查）：空串；页面提示：模型不可用'
const errOutcome = bridgeStreamOutcome({
  status: 'error',
  content: '',
  raw: '',
  error: P5_ERROR,
  ms: 0,
  warnings: ['auto_continue 已开启，本轮临时关闭（结束立即还原）']
})
check(
  '10 · error → throw，且文案与 P5 逐字一致（P6 不许改写一个字）',
  errOutcome.kind === 'throw' && errOutcome.error === P5_ERROR,
  JSON.stringify(errOutcome)
)
const abortOutcome = bridgeStreamOutcome({
  status: 'aborted',
  content: '',
  raw: '',
  error: null,
  ms: 5,
  warnings: []
})
check('11 · aborted → return（交给既有收尾按 signal 结算）', abortOutcome.kind === 'return')

/* ─────────────── 12–16 · 生成器本体（bridgeStream） ─────────────── */

console.log('12–16 · 生成器：先流式，再以桥接结论为准')

function detailOf(result) {
  return { result, trace: { warnings: result.warnings } }
}

async function collect(input) {
  const chunks = []
  let final = null
  let warnings = null
  for await (const event of bridgeStream({
    ...input,
    onWarnings: (list) => {
      warnings = list
    },
    onFinal: (value) => {
      final = value
    }
  })) {
    chunks.push(event.text)
  }
  return { chunks, final, warnings }
}

{
  setBridgeRunnerForTest(async (input) => {
    input.onToken?.('你')
    input.onToken?.('好')
    return detailOf({ status: 'done', content: '你好，世界', raw: '你好，世界', error: null, ms: 3, warnings: [] })
  })
  const run = await collect({ sessionId: 'w1', messages: [{ role: 'user', content: '在吗' }] })
  check(
    '12 · 增量逐条转成 text 事件（界面因此有逐字效果）',
    run.chunks.join('') === '你好',
    JSON.stringify(run.chunks)
  )
  check(
    '13 · onFinal 是桥接结论（不是流式拼出来的那份）→ 落库原稿（M5）',
    run.final === '你好，世界',
    JSON.stringify(run.final)
  )
}

{
  // 旧版 ST 没有流式事件：必须整段回一次，否则界面会一直空到 done
  setBridgeRunnerForTest(async () =>
    detailOf({ status: 'done', content: '整段正文', raw: '整段正文', error: null, ms: 1, warnings: [] })
  )
  const run = await collect({ sessionId: 'w2', messages: [{ role: 'user', content: '在吗' }] })
  check(
    '14 · 没有增量时整段回一次（不是「没反应」）',
    run.chunks.join('') === '整段正文',
    JSON.stringify(run.chunks)
  )
}

{
  setBridgeRunnerForTest(async () => {
    const error = new Error('桥接隐藏窗口启动失败：READY_TIMEOUT 60000ms')
    throw error
  })
  let thrown = ''
  try {
    await collect({ sessionId: 'w3', messages: [{ role: 'user', content: '在吗' }] })
  } catch (cause) {
    thrown = cause instanceof Error ? cause.message : String(cause)
  }
  check(
    '15 · 驱动层抛错原样冒出去（不吞成空回复）',
    thrown === '桥接隐藏窗口启动失败：READY_TIMEOUT 60000ms',
    thrown
  )
}

{
  setBridgeRunnerForTest(async () =>
    detailOf({ status: 'error', content: '', raw: '', error: P5_ERROR, ms: 0, warnings: ['开关被压制'] })
  )
  let thrown = ''
  let warnings = null
  try {
    for await (const _event of bridgeStream({
      sessionId: 'w4',
      messages: [{ role: 'user', content: '在吗' }],
      onWarnings: (list) => {
        warnings = list
      }
    })) {
      // 失败轮不该产出任何正文
    }
  } catch (cause) {
    thrown = cause instanceof Error ? cause.message : String(cause)
  }
  check('16 · error 轮：抛文案原样 + 告警在抛之前已回传', thrown === P5_ERROR && Array.isArray(warnings) && warnings.length === 1, thrown)
}

/* ─────────────── 17–22 · 真链路：chatService × 假 runner（A2–A5） ─────────────── */

console.log('17–22 · chatService 真链路（收尾/落库/sink/重试都是真代码）')

function fakeSender() {
  const seen = []
  return { seen, isDestroyed: () => false, send: (channel, payload) => seen.push({ channel, payload }) }
}

const settings = settingsStore.get()
// 归一化是否「两个调用点都在」读源码判：运行时的 settings.json 里已经写着 true，
// 从 get() 看不出它的**缺省值**是多少（A5 要的正是「老配置升级零行为变化」这一条）。
const storeSrc = fs.readFileSync(p('src/main/features/settings/settingsStore.ts'), 'utf8')
check(
  '17 · bridge 归一化在位，且缺省 false + 两个调用点都在',
  !!settings.bridge &&
    typeof settings.bridge.enabled === 'boolean' &&
    /const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = \{ enabled: false \}/.test(storeSrc) &&
    /next\.bridge = normalizeBridge\(next\.bridge\)/.test(storeSrc) &&
    /bridge: normalizeBridge\(parsed\.bridge \?\? base\.bridge\)/.test(storeSrc),
  JSON.stringify(settings.bridge)
)
settingsStore.save({ bridge: { enabled: true } })

{
  // A2：开关 false → 走旧 provider.stream，桥接一次都不调用
  settingsStore.save({ bridge: { enabled: false } })
  let bridgeCalls = 0
  setBridgeRunnerForTest(async () => {
    bridgeCalls += 1
    return detailOf({ status: 'done', content: '不该出现', raw: '不该出现', error: null, ms: 1, warnings: [] })
  })
  const session = chatService.createSession({ mode: 'story' })
  const sender = fakeSender()
  const outcome = await chatService.sendAwait({ sessionId: session.id, content: '你好' }, new WebContentsSink(sender))
  check(
    '18 · 开关 false：桥接零调用、旧路径照常出字',
    bridgeCalls === 0 && outcome.status === 'done' && outcome.content.length > 0,
    JSON.stringify({ bridgeCalls, status: outcome.status, len: outcome.content.length })
  )
  settingsStore.save({ bridge: { enabled: true } })
}

{
  // A3：三条件各缺一条 → 都走旧路径
  let bridgeCalls = 0
  setBridgeRunnerForTest(async () => {
    bridgeCalls += 1
    return detailOf({ status: 'done', content: '不该出现', raw: '不该出现', error: null, ms: 1, warnings: [] })
  })
  const chatSession = chatService.createSession({ mode: 'chat' })
  await chatService.sendAwait({ sessionId: chatSession.id, content: '你好' }, new WebContentsSink(fakeSender()))
  check('19 · mode !== story → 桥接零调用（chat 会话照旧）', bridgeCalls === 0, bridgeCalls)
  settingsStore.save({ bridge: { enabled: false } })
  const storySession = chatService.createSession({ mode: 'story' })
  await chatService.sendAwait({ sessionId: storySession.id, content: '你好' }, new WebContentsSink(fakeSender()))
  check('20 · 开关 false 的故事会话 → 桥接零调用', bridgeCalls === 0, bridgeCalls)
  settingsStore.save({ bridge: { enabled: true } })
}

{
  // A4 + A5：done 路径 —— warnings 落到消息上、不进 content；正文以桥接结论为准
  const WARN = 'auto_continue 已开启，本轮临时关闭（结束立即还原）'
  setBridgeRunnerForTest(async (input) => {
    input.onToken?.('半句')
    return detailOf({ status: 'done', content: '完整的正文，不是流式拼出来的那份', raw: '完整的正文，不是流式拼出来的那份', error: null, ms: 2, warnings: [WARN] })
  })
  const session = chatService.createSession({ mode: 'story' })
  const sender = fakeSender()
  const outcome = await chatService.sendAwait({ sessionId: session.id, content: '你好' }, new WebContentsSink(sender))
  const listed = chatService.listSessions().find((item) => item.id === session.id)
  const message = listed.messages[listed.messages.length - 1]
  check('21 · done：outcome.status = done', outcome.status === 'done', outcome.status)
  check(
    '22 · 落库正文 = 桥接结论（不是流式拼接的半句）',
    message.content === '完整的正文，不是流式拼出来的那份',
    JSON.stringify(message.content)
  )
  check(
    '23 · warnings 落在消息上，且**不混进** content',
    Array.isArray(message.warnings) && message.warnings[0] === WARN && !message.content.includes(WARN),
    JSON.stringify(message.warnings)
  )
  const donePayload = sender.seen.filter((item) => item.channel === IPC.chatDone).pop()
  check(
    '24 · done 广播带 warnings（渲染层才有得画）',
    !!donePayload && Array.isArray(donePayload.payload.warnings) && donePayload.payload.warnings[0] === WARN,
    donePayload ? JSON.stringify(donePayload.payload.warnings) : '没有 done',
  )
}

{
  // A4 的 error 半边：文案原样落 on outcome.error 与 message.error
  setBridgeRunnerForTest(async () =>
    detailOf({ status: 'error', content: '', raw: '', error: P5_ERROR, ms: 0, warnings: [] })
  )
  const session = chatService.createSession({ mode: 'story' })
  const outcome = await chatService.sendAwait({ sessionId: session.id, content: '你好' }, new WebContentsSink(fakeSender()))
  const listed = chatService.listSessions().find((item) => item.id === session.id)
  const message = listed.messages[listed.messages.length - 1]
  check(
    '25 · error：status/文案与 P5 逐字一致（P6 不改写）',
    outcome.status === 'error' && outcome.error === P5_ERROR && message.status === 'error' && message.error === P5_ERROR,
    JSON.stringify({ status: outcome.status, error: outcome.error })
  )
  check(
    '26 · error 轮的气泡是 failed 且可重试（不卡在三个点）',
    bubbleViewOf(message, { isLive: false, isTail: true }).phase === 'failed' &&
      bubbleViewOf(message, { isLive: false, isTail: true }).canRetry === true
  )
}

{
  // A4 的 aborted 半边：中途停止 → outcome 是 aborted，不是 done、也不是 error
  let started
  const startedPromise = new Promise((resolve) => {
    started = resolve
  })
  setBridgeRunnerForTest(async (input) => {
    started()
    await new Promise((resolve) => {
      if (input.signal?.aborted) return resolve()
      input.signal?.addEventListener('abort', () => resolve(), { once: true })
      return undefined
    })
    return detailOf({ status: 'aborted', content: '', raw: '', error: null, ms: 1, warnings: [] })
  })
  const session = chatService.createSession({ mode: 'story' })
  const turn = chatService.sendAwait({ sessionId: session.id, content: '你好' }, new WebContentsSink(fakeSender()))
  await startedPromise
  chatService.stop(session.id)
  const outcome = await turn
  check('27 · aborted：outcome.status = aborted（穿过既有收尾）', outcome.status === 'aborted', outcome.status)
}

setBridgeRunnerForTest(null)

/* ─────────────── 28–30 · 判定点单点（停止条件 2） ─────────────── */

console.log('28–30 · 判定点只有一处')

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === 'out') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(item.name)) {
      out.push(full)
    }
  }
  return out
}
const srcFiles = walk(p('src'))
const rel = (full) => path.relative(projectRoot, full).split(path.sep).join('/')
const readSrc = (full) => fs.readFileSync(full, 'utf8')

const eligibleUsers = srcFiles.filter((file) => /bridgeEligible\s*\(/.test(readSrc(file))).map(rel)
check(
  '28 · 主进程与模型锁共用 shared 纯判定（仅两个调用方）',
  eligibleUsers.length === 3 &&
    eligibleUsers.includes('src/main/features/chat/chatService.ts') &&
    eligibleUsers.includes('src/shared/bridge.ts') &&
    eligibleUsers.includes('src/renderer/src/features/chat/ChatPage.tsx'),
  eligibleUsers.join(',')
)

const switchReaders = srcFiles
  .filter((file) => /settings\.bridge|stored\.bridge|\.bridge\?\.enabled/.test(readSrc(file)))
  .map(rel)
  .filter((item) => item !== 'src/shared/bridge.ts' && item !== 'src/main/features/settings/settingsStore.ts' && item !== 'src/shared/types.ts' && item !== 'src/renderer/src/features/settings/sections/BridgeSection.tsx')
check('29 · 开关的读取点除路由器/归一化/设置页外为零', switchReaders.length === 0, switchReaders.join(','))

{
  // 停止条件 2 的原文是「bridgeEligible 之外任何一处再出现 mode === 'story' 与桥接开关的
  // 组合判断」。所以判的是**组合**，不是「mode === 'story' 出现几次」——
  // chatService 里另有两处 mode 判断（旁白只许用于故事区、storyPromptOf 以 mode 为准），
  // 它们与桥接无关；把它们算成违规只会让守卫变成「谁都不敢碰 mode」。
  const combos = srcFiles
    .filter((file) => {
      const text = readSrc(file)
      const hasModeStory = /mode\s*[!=]==\s*'story'/.test(text)
      // 「组合」= 同一个文件里既判 mode 又**自己读**桥接开关。
      // 只判 mode 的文件（chatService 的旁白守卫、storyPromptOf）不算；
      // 调用 bridgeEligible 也不算 —— 它把判定委托出去了，那正是单点该有的样子。
      const readsBridgeSwitch = /\.bridge\s*(\?\.)?\.?\s*enabled|\.bridge\b\s*(\?)?\./.test(text)
      return hasModeStory && readsBridgeSwitch
    })
    .map(rel)
  check(
    '30 · 「mode === story + 自己读桥接开关」只在 shared/bridge.ts 一处',
    combos.length === 1 && combos[0] === 'src/shared/bridge.ts',
    combos.join(',')
  )
}

done()
