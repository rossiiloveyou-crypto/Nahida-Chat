/**
 * 端到端（假 host + 假 chat，deps 全可注入）：事件 → 白名单 → 切段 → 逐条发送。
 *
 * P6 改写要点（原 41 项）：
 *  - 注入源从 `bindings()` 换成 `access()`（白名单条目），会话 id 由外部键直接算
 *  - 新增 **no-permission 分叉**：在白名单但 respond=false → 不回复，计数进 droppedNoPermission
 *  - 新增 **会话自动派生**：首次消息用外部键当 sessionId，二次复用同一条
 *  - 原有意图一条不删：「不在白名单的消息被丢弃」就是原来的「未绑定的消息被丢弃」，来源变了而已
 *
 * 跑法：node scripts/test/qq-bridge.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-bridge-test-'))
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false } }),
  'utf8'
)
installElectronStub(userData)

const mod = await bundleModule('bridge', [
  `export { createQqBridge, emptyStats } from '${p('src/main/features/qq/bridge.ts')}'`,
  `export { sessionPolicy } from '${p('src/main/features/chat/sessionPolicy.ts')}'`,
  `export { DEFAULT_QQ_SETTINGS } from '${p('src/shared/qq.ts')}'`
].join('\n'))
const { createQqBridge, sessionPolicy, DEFAULT_QQ_SETTINGS } = mod

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SELF = '10001'

const textSeg = (value) => ({ type: 'text', data: { text: value } })
const PRIVATE_KEY = 'qq:10001:private:20002'
const GROUP_KEY = 'qq:10001:group:88888'

function privateEvent(id, value, overrides = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: id,
    user_id: 20002,
    self_id: SELF,
    message: [textSeg(value)],
    sender: { user_id: 20002, nickname: '小明' },
    ...overrides
  }
}

function groupEvent(id, value, { mentioned = true, overrides = {} } = {}) {
  const message = mentioned ? [{ type: 'at', data: { qq: SELF } }, textSeg(value)] : [textSeg(value)]
  return {
    post_type: 'message',
    message_type: 'group',
    message_id: id,
    group_id: 88888,
    user_id: 20002,
    self_id: SELF,
    message,
    sender: { user_id: 20002, nickname: '小明', card: '小明' },
    ...overrides
  }
}

/** 构造一条白名单条目（key 与 channelKeyOf 同构） */
function entry(key, overrides = {}) {
  const parts = key.split(':')
  return {
    key,
    channel: 'qq',
    uin: parts[1],
    chatType: parts[2],
    chatId: parts[3],
    label: '',
    permissions: { respond: true, tool: false },
    lastAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function harness(options = {}) {
  const state = { calls: [], chatCalls: [], broadcasts: [], handler: null, sessionCalls: [], touched: [] }
  const settings = {
    ...DEFAULT_QQ_SETTINGS,
    segmentDelayMs: 30,
    typingMode: 'text',
    typingText: '正在看…',
    errorReplyText: '（这边卡住了）',
    ...(options.settings || {})
  }
  const host = {
    on: (_name, cb) => {
      state.handler = cb
      return () => {
        state.handler = null
      }
    },
    invokeAction: async (uin, action, params) => {
      state.calls.push({ uin, action, params, at: Date.now() })
      return { ok: true, retcode: 0, messageId: '1', error: null }
    }
  }
  const chat = {
    sendAwait: async (input, sink) => {
      const item = { input, start: Date.now(), end: 0 }
      state.chatCalls.push(item)
      if (options.onChat) await options.onChat(input, sink, state)
      if (options.chatDelayMs) await sleep(options.chatDelayMs)
      item.end = Date.now()
      if (options.status === 'error') {
        return {
          status: 'error',
          sessionId: input.sessionId,
          messageId: 'm',
          content: '',
          toolCalls: [],
          error: 'boom',
          durationMs: 1
        }
      }
      return {
        status: 'done',
        sessionId: input.sessionId,
        messageId: 'm',
        content: options.content === undefined ? '一。二。三。' : options.content,
        toolCalls: [],
        durationMs: 1
      }
    }
  }
  const store = {
    access: () => options.access || [],
    settings: () => settings,
    touchAccess: (key, at) => state.touched.push({ key, at })
  }
  const bridge = createQqBridge({
    host,
    chat,
    store,
    ensureSession: (sessionId, title) => state.sessionCalls.push({ sessionId, title }),
    broadcast: (channel, payload) => state.broadcasts.push({ channel, payload }),
    sleep
  })
  return { bridge, state, settings }
}

const typingCalls = (state, settings) =>
  state.calls.filter(
    (call) =>
      Array.isArray(call.params?.message) &&
      call.params.message.some((segment) => segment.data && segment.data.text === settings.typingText)
  )
const bodyCalls = (state, settings) =>
  state.calls.filter((call) => !typingCalls(state, settings).includes(call))
const bodyText = (call) =>
  (call.params.message || [])
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.data.text)
    .join('')

/* ── 1-4：私聊，一句一句发 ─────────────────────────────────────────────── */

console.log('私聊：切段与节奏')
{
  const h = harness({ access: [entry(PRIVATE_KEY)] })
  await h.bridge.handleEvent(SELF, privateEvent(1, '你好'))
  const body = bodyCalls(h.state, h.settings)
  check('切段后发了 3 条', body.length === 3, body.length)
  check('都是 send_private_msg', body.every((call) => call.action === 'send_private_msg'), body.map((c) => c.action).join(','))
  const joined = body.map(bodyText).join('')
  check('🔴 各段拼接逐字等于原文（J-16）', joined === '一。二。三。', joined)
  const gap1 = body[1].at - body[0].at
  const gap2 = body[2].at - body[1].at
  check('段间延迟 ≥ segmentDelayMs*0.8', gap1 >= 24 && gap2 >= 24, gap1 + '/' + gap2)
  check('送进模型的正文 = 原文', h.state.chatCalls[0].input.content === '你好', h.state.chatCalls[0].input.content)
  check('sendAwait 被调用 1 次（不是 3 次）', h.state.chatCalls.length === 1, h.state.chatCalls.length)
  check('uin 透传正确', h.state.calls.every((call) => call.uin === SELF))
}

/* ── 5：群聊首段 @ 提问者 ─────────────────────────────────────────────── */

console.log('群聊：@ 与发言人前缀')
{
  const h = harness({ access: [entry(GROUP_KEY)], content: '一。二。' })
  await h.bridge.handleEvent(SELF, groupEvent(2, '在吗'))
  const body = bodyCalls(h.state, h.settings)
  check('群聊发 2 条 send_group_msg', body.length === 2 && body.every((call) => call.action === 'send_group_msg'), body.length)
  const first = body[0].params.message[0]
  check(
    '首段是 {type:at, qq:senderId}',
    first && first.type === 'at' && String(first.data.qq) === '20002',
    JSON.stringify(first)
  )
  const second = body[1].params.message[0]
  check('第二段不再 @（只有首段带）', second && second.type === 'text', JSON.stringify(second))
  check(
    '正文前缀带发言人（C2）',
    h.state.chatCalls[0].input.content.startsWith('[群聊 小明(20002)]\n'),
    h.state.chatCalls[0].input.content.slice(0, 24)
  )
}

/* ── 6-8：整轮结束才发 / 空回复 / 生成失败 ─────────────────────────────── */

console.log('时序与边界')
{
  const h = harness({ access: [entry(PRIVATE_KEY)], chatDelayMs: 40 })
  await h.bridge.handleEvent(SELF, privateEvent(3, '慢慢想'))
  // 第 0 条是 typing（本来就该在送进模型之前发）；判据看**正文首段**
  const firstBody = bodyCalls(h.state, h.settings)[0]
  check(
    '🔴 首条正文晚于 sendAwait 返回（J-13：真等整轮结束）',
    Boolean(firstBody) && firstBody.at >= h.state.chatCalls[0].end,
    firstBody ? String(firstBody.at - h.state.chatCalls[0].end) + 'ms' : '没有正文'
  )
}
{
  const h = harness({ access: [entry(PRIVATE_KEY)], content: '' })
  await h.bridge.handleEvent(SELF, privateEvent(4, '说点啥'))
  check('空回复 → 一条正文都不发', bodyCalls(h.state, h.settings).length === 0, bodyCalls(h.state, h.settings).length)
  check('记成 empty-reply', h.bridge.feed().some((item) => item.outcome === 'empty-reply'))
}
{
  const h = harness({ access: [entry(PRIVATE_KEY)], status: 'error' })
  await h.bridge.handleEvent(SELF, privateEvent(5, '出个错'))
  const body = bodyCalls(h.state, h.settings)
  check('生成失败 → 发 1 条', body.length === 1, body.length)
  check('内容是 errorReplyText', bodyText(body[0]) === h.settings.errorReplyText, bodyText(body[0]))
}

/* ── 10-12：自回环 / 不在白名单 / 未 @ ─────────────────────────────────── */

console.log('不该响应的三类')
{
  const h = harness({ access: [entry(PRIVATE_KEY)] })
  await h.bridge.handleEvent(SELF, privateEvent(6, '自己的回声', { post_type: 'message_sent' }))
  check('message_sent → sendAwait 0 次', h.state.chatCalls.length === 0, h.state.chatCalls.length)
  check('计成 dropped-self-echo', h.bridge.feed().some((item) => item.outcome === 'dropped-self-echo'))
}
{
  const h = harness({ access: [] })
  await h.bridge.handleEvent(SELF, privateEvent(7, '没在白名单'))
  check('不在白名单 → sendAwait 0 次', h.state.chatCalls.length === 0, h.state.chatCalls.length)
  check('计成 dropped-unbound', h.bridge.feed().some((item) => item.outcome === 'dropped-unbound'))
  check('也不创建会话', h.state.sessionCalls.length === 0, h.state.sessionCalls.length)
}
{
  const h = harness({ access: [entry(GROUP_KEY)] })
  await h.bridge.handleEvent(SELF, groupEvent(8, '没叫她', { mentioned: false }))
  check('白名单里的群但没 @ → sendAwait 0 次', h.state.chatCalls.length === 0, h.state.chatCalls.length)
  check('计成 dropped-not-mentioned', h.bridge.feed().some((item) => item.outcome === 'dropped-not-mentioned'))
}

/* ── 13-14：typing 仅私聊 ─────────────────────────────────────────────── */

console.log('typing（M12）')
{
  const h = harness({ access: [entry(PRIVATE_KEY)] })
  await h.bridge.handleEvent(SELF, privateEvent(9, '在吗'))
  const typing = typingCalls(h.state, h.settings)
  const body = bodyCalls(h.state, h.settings)
  check('私聊发了一次 typing 文本', typing.length === 1, typing.length)
  check('typing 早于首段正文', typing.length === 1 && body.length > 0 && typing[0].at <= body[0].at)
  check('typing 走 send_private_msg', typing.length === 1 && typing[0].action === 'send_private_msg', typing[0] && typing[0].action)
}
{
  const h = harness({ access: [entry(GROUP_KEY)], content: '嗯。' })
  await h.bridge.handleEvent(SELF, groupEvent(10, '群里'))
  check('群聊不做任何 typing（M12）', typingCalls(h.state, h.settings).length === 0, typingCalls(h.state, h.settings).length)
}
{
  const h = harness({ access: [entry(PRIVATE_KEY)], settings: { typingMode: 'off' }, content: '好。' })
  await h.bridge.handleEvent(SELF, privateEvent(11, '关掉 typing'))
  check('typingMode=off → 0 次 typing 调用', typingCalls(h.state, h.settings).length === 0)
}

/* ── 15-16：去重与串行 ────────────────────────────────────────────────── */

console.log('去重与串行')
{
  const h = harness({ access: [entry(PRIVATE_KEY)], content: '收到。' })
  await h.bridge.handleEvent(SELF, privateEvent(12, '同一句'))
  await h.bridge.handleEvent(SELF, privateEvent(12, '同一句'))
  check('同一 message_id 连发两次 → sendAwait 只 1 次', h.state.chatCalls.length === 1, h.state.chatCalls.length)
  check('计成 dropped-duplicate', h.bridge.feed().some((item) => item.outcome === 'dropped-duplicate'))
}
{
  const h = harness({ access: [entry(GROUP_KEY)], chatDelayMs: 40, content: '收到。' })
  await Promise.all([
    h.bridge.handleEvent(SELF, groupEvent(13, '第一句')),
    h.bridge.handleEvent(SELF, groupEvent(14, '第二句')),
    h.bridge.handleEvent(SELF, groupEvent(15, '第三句'))
  ])
  check('三条不同消息 → sendAwait 3 次', h.state.chatCalls.length === 3, h.state.chatCalls.length)
  check(
    '严格串行：第 2 次开始 ≥ 第 1 次结束',
    h.state.chatCalls[1].start >= h.state.chatCalls[0].end && h.state.chatCalls[2].start >= h.state.chatCalls[1].end,
    [h.state.chatCalls[1].start - h.state.chatCalls[0].end, h.state.chatCalls[2].start - h.state.chatCalls[1].end].join('/')
  )
}

/* ── 限速 / 队列满 ────────────────────────────────────────────────────── */

console.log('限速与队列满')
{
  const h = harness({
    access: [entry(PRIVATE_KEY)],
    content: '嗯。',
    settings: { rateLimitPerUser: 1 }
  })
  await h.bridge.handleEvent(SELF, privateEvent(16, '第一句'))
  await h.bridge.handleEvent(SELF, privateEvent(17, '第二句'))
  check('同一用户 60s 内第 2 条被限速', h.state.chatCalls.length === 1, h.state.chatCalls.length)
  check('计成 dropped-rate-limited', h.bridge.feed().some((item) => item.outcome === 'dropped-rate-limited'))
}
{
  const h = harness({ access: [entry(GROUP_KEY)], chatDelayMs: 20, content: '嗯。' })
  const events = []
  for (let i = 0; i < 12; i += 1) events.push(h.bridge.handleEvent(SELF, groupEvent(100 + i, '刷屏' + String(i))))
  await Promise.all(events)
  check(
    '超过 maxPendingPerKey 的事件被拒绝（不是堆积）',
    h.bridge.feed().filter((item) => item.outcome === 'dropped-queue-full').length >= 1,
    h.bridge.feed().filter((item) => item.outcome === 'dropped-queue-full').length
  )
  check('实际处理的条数 ≤ 8', h.state.chatCalls.length <= 8, h.state.chatCalls.length)
}

/* ── 广播（渲染层零改动的前提：沿用既有频道） ─────────────────────────── */

console.log('广播')
{
  const h = harness({
    access: [entry(PRIVATE_KEY)],
    content: '流式。',
    onChat: async (input, sink) => {
      sink.delta({ sessionId: input.sessionId, messageId: 'm', delta: '流' })
      sink.done({ sessionId: input.sessionId, messageId: 'm', content: '流式。', toolCalls: [] })
    }
  })
  await h.bridge.handleEvent(SELF, privateEvent(18, '流式吗'))
  const channels = h.state.broadcasts.map((item) => item.channel)
  check('广播了 chat:delta', channels.includes('chat:delta'), channels.join(','))
  check('广播了 chat:done', channels.includes('chat:done'))
  check('广播了 qq:event（面板事件流）', channels.includes('qq:event'))
  check(
    'sink 的 sessionId 就是渠道会话 id（外部键）',
    h.state.broadcasts.some((item) => item.channel === 'chat:done' && item.payload.sessionId === PRIVATE_KEY)
  )
}

/* ── 记忆隔离注册（G8 接线） ──────────────────────────────────────────── */

console.log('记忆隔离接线')
{
  harness({ access: [] })
  check('bridge 创建后，渠道会话 id 被标为隔离', sessionPolicy().isMemoryIsolated(PRIVATE_KEY) === true)
  check('桌面 UUID 会话不被隔离', sessionPolicy().isMemoryIsolated('3f2a9c1e-0000-4000-8000-000000000000') === false)
}

/* ── P6 新增：白名单权限位 / 会话自动派生 ─────────────────────────────── */

console.log('P6 · no-permission 分叉')
{
  const h = harness({
    access: [entry(PRIVATE_KEY, { permissions: { respond: false, tool: false } })]
  })
  await h.bridge.handleEvent(SELF, privateEvent(19, '只旁听'))
  check('在白名单但 respond=false → sendAwait 0 次', h.state.chatCalls.length === 0, h.state.chatCalls.length)
  check('计成 dropped-no-permission（不是 unbound）', h.bridge.feed().some((item) => item.outcome === 'dropped-no-permission'))
  check('统计进 droppedNoPermission', h.bridge.stats().droppedNoPermission === 1, h.bridge.stats().droppedNoPermission)
  check('unbound 计数保持 0（两种理由可区分，J-29）', h.bridge.stats().droppedUnbound === 0, h.bridge.stats().droppedUnbound)
  check('也不创建会话（P8 才从这里分叉去旁听）', h.state.sessionCalls.length === 0, h.state.sessionCalls.length)
}

console.log('P6 · 会话自动派生')
{
  const h = harness({ access: [entry(GROUP_KEY, { label: '测试群' })], content: '嗯。' })
  await h.bridge.handleEvent(SELF, groupEvent(20, '第一句'))
  check('首次消息：ensureSession 用外部键建会话', h.state.sessionCalls.length === 1 && h.state.sessionCalls[0].sessionId === GROUP_KEY, JSON.stringify(h.state.sessionCalls))
  check('标题用白名单 label', h.state.sessionCalls[0].title === '测试群', h.state.sessionCalls[0].title)
  check('送进模型的 sessionId 就是外部键', h.state.chatCalls[0].input.sessionId === GROUP_KEY, h.state.chatCalls[0].input.sessionId)
  check('命中后记一次 touchAccess', h.state.touched.length === 1 && h.state.touched[0].key === GROUP_KEY, JSON.stringify(h.state.touched))

  const h2 = harness({ access: [entry(GROUP_KEY, { label: '测试群' })], content: '嗯。' })
  await h2.bridge.handleEvent(SELF, groupEvent(21, '第一句'))
  await h2.bridge.handleEvent(SELF, groupEvent(22, '第二句'))
  check(
    '二次消息复用同一条会话 id（不是每次新建）',
    h2.state.chatCalls.length === 2 && h2.state.chatCalls[0].input.sessionId === h2.state.chatCalls[1].input.sessionId,
    h2.state.chatCalls.map((c) => c.input.sessionId).join(',')
  )
  check('label 为空时标题回落 chatId', (() => {
    const h3 = harness({ access: [entry(PRIVATE_KEY, { label: '' })] })
    void h3.bridge.handleEvent(SELF, privateEvent(23, '在吗'))
    return h3.state.sessionCalls[0].title === '20002'
  })())
}

done()
