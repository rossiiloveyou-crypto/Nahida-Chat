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

/**
 * 把「会话键」翻译成 v2 授权配置（P9-R3：授权主体是**人 + 群**，不再是会话）。
 *
 * 测试里仍然想用 qq:<uin>:private:<号> / qq:<uin>:group:<群号> 这种一眼能读懂的字面量，
 * 所以留了这一层翻译：私聊键 → 一个账号（默认 private=true），群键 → 一个群条目。
 * overrides.permissions 里给的位原样套到账号上（群条目没有权限位）。
 */
function entry(key, overrides = {}) {
  const parts = key.split(':')
  const chatType = parts[2]
  const chatId = parts[3]
  const permissions = overrides.permissions || {}
  const label = overrides.label || ''
  return { chatType, chatId, uin: parts[1], permissions, label }
}

/** 把 entry(...) 的数组折成 v2 配置（同一批 uin 也记下来） */
function configOf(list = [], patch = {}) {
  const accounts = []
  const groups = []
  const uins = []
  for (const item of list) {
    if (item.uin && !uins.includes(item.uin)) uins.push(item.uin)
    if (item.chatType === 'private') {
      accounts.push({
        channel: 'qq',
        userId: item.chatId,
        label: item.label,
        addedAt: 1,
        lastAt: 0,
        permissions: {
          private: item.permissions.respond !== false,
          group: true,
          tool: item.permissions.tool === true
        }
      })
    } else {
      groups.push({ channel: 'qq', chatId: item.chatId, label: item.label, addedAt: 1, lastAt: 0 })
    }
  }
  return {
    version: 2,
    groupMemberGate: false,
    toolGate: true,
    accounts,
    groups,
    uins,
    ...patch
  }
}

function harness(options = {}) {
  const state = {
    calls: [],
    chatCalls: [],
    broadcasts: [],
    handler: null,
    sessionCalls: [],
    touched: [],
    uins: []
  }
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
    // P9-R3：授权配置（账号 + 群 + 两个开关）。options.access 仍是一串会话键构造器，
    // 由 configOf 折成 v2 形状；要测「群成员鉴权打开」时给 options.config 覆盖。
    access: () => options.config || configOf(options.access || []),
    settings: () => settings,
    touchAccess: (key, at) => state.touched.push({ key, at }),
    rememberUin: (uin) => state.uins.push(uin)
  }
  // P8：旁听。默认**不注入**（= 不旁听），要测采集的用例显式给 options.observe。
  // 注入的这个假 store 记录每次 append 的整条记录，供断言检查全文与 outcome。
  const observeRecords = []
  const observe =
    options.observe === undefined
      ? undefined
      : options.observe === 'throw'
        ? {
            append: (record) => {
              observeRecords.push(record)
              throw new Error('磁盘满了')
            }
          }
        : {
            append: (record) => {
              observeRecords.push(record)
            }
          }
  const bridge = createQqBridge({
    host,
    chat,
    store,
    ...(observe ? { observe } : {}),
    ensureSession: (sessionId, title) => state.sessionCalls.push({ sessionId, title }),
    broadcast: (channel, payload) => state.broadcasts.push({ channel, payload }),
    sleep
  })
  return { bridge, state, settings, observeRecords }
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
  // P9-R3：私聊**没有「unbound」这个理由了**。私聊准入按**发言人**判，
  // 陌生人私聊记 dropped-not-authorized-member（「不在 QQ 号白名单中」）。
  // unbound 现在只表示「这个群不在群白名单里」。
  const h = harness({ access: [] })
  await h.bridge.handleEvent(SELF, privateEvent(7, '没在白名单'))
  check('陌生人私聊 → sendAwait 0 次', h.state.chatCalls.length === 0, h.state.chatCalls.length)
  check('计成 dropped-not-authorized-member', h.bridge.feed().some((item) => item.outcome === 'dropped-not-authorized-member'))
  check('统计进 droppedNotAuthorizedMember', h.bridge.stats().droppedNotAuthorizedMember === 1, h.bridge.stats().droppedNotAuthorizedMember)
  check('不碰 unbound 计数（两种理由可区分，J-29）', h.bridge.stats().droppedUnbound === 0, h.bridge.stats().droppedUnbound)
  check('也不创建会话', h.state.sessionCalls.length === 0, h.state.sessionCalls.length)
}
{
  const h = harness({ access: [entry(GROUP_KEY)] })
  await h.bridge.handleEvent(SELF, groupEvent(8, '没叫她', { mentioned: false }))
  check('白名单里的群但没 @ → sendAwait 0 次', h.state.chatCalls.length === 0, h.state.chatCalls.length)
  check('计成 dropped-not-mentioned', h.bridge.feed().some((item) => item.outcome === 'dropped-not-mentioned'))
  // 🔴 F-01 已修（P9-R3 §15.6.2 / J-56）：ensureSession / touchAccess 整体后移到
  //    「群白名单 → @ → 成员鉴权」全部判定**之后**。被挡下的消息不建会话、不写盘。
  check('F-01 回归：未 @ 不建会话（副作用排在判定之后）', h.state.sessionCalls.length === 0, h.state.sessionCalls.length)
  check('F-01 回归：未 @ 不 touch 写盘', h.state.touched.length === 0, h.state.touched.length)
  check('F-01 回归：未 @ 也不记 droppedNotAuthorizedMember（顺序对）', h.bridge.stats().droppedNotAuthorizedMember === 0, h.bridge.stats().droppedNotAuthorizedMember)
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

console.log('P9-R3 · 私聊准入改按人（原 P6 的 respond 位已废弃）')
{
  // v1 的「在白名单但 respond=false」在 v2 里就是「账号存在但 private=false」。
  // 两者的**外部表现一致**（不回），但理由变了：现在是「未授予私聊权限」，按人判。
  const h = harness({
    access: [entry(PRIVATE_KEY, { permissions: { respond: false, tool: false } })]
  })
  await h.bridge.handleEvent(SELF, privateEvent(19, '只旁听'))
  check('private=false → sendAwait 0 次', h.state.chatCalls.length === 0, h.state.chatCalls.length)
  check('计成 dropped-not-authorized-member', h.bridge.feed().some((item) => item.outcome === 'dropped-not-authorized-member'))
  check('统计进 droppedNotAuthorizedMember', h.bridge.stats().droppedNotAuthorizedMember === 1, h.bridge.stats().droppedNotAuthorizedMember)
  check('unbound 计数保持 0（两种理由可区分，J-29）', h.bridge.stats().droppedUnbound === 0, h.bridge.stats().droppedUnbound)
  check('也不创建会话（副作用排在判定之后）', h.state.sessionCalls.length === 0, h.state.sessionCalls.length)
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

/* ── P8：旁听采集（§4.3 资格 / §4.4 单点写入） ─────────────────────────── */

console.log('P8 · 旁听采集')
{
  const h = harness({ access: [entry(PRIVATE_KEY)], observe: true, content: '收到。' })
  await h.bridge.handleEvent(SELF, privateEvent(30, '你好呀，今天过得怎么样？'))
  check('1 私聊在白名单 → 采了 1 次', h.observeRecords.length === 1, h.observeRecords.length)
  check(
    '1 record.text 是全文（不是 60 字预览）',
    h.observeRecords[0]?.text === '你好呀，今天过得怎么样？',
    h.observeRecords[0]?.text
  )
  const rec = h.observeRecords[0] || {}
  check('1 allowed=true / triggered=true / outcome=responded', rec.allowed === true && rec.triggered === true && rec.outcome === 'responded', [rec.allowed, rec.triggered, rec.outcome].join('/'))
  check('1 sessionId 与 key 都是外部键', rec.sessionId === PRIVATE_KEY && rec.key === PRIVATE_KEY, rec.key)
  check('1 segmentTypes 是 [text]', JSON.stringify(rec.segmentTypes) === '["text"]', JSON.stringify(rec.segmentTypes))
}
{
  // 2026-11-01「P8 = 群语料」：群聊**全采**，不看白名单、不看区块开关
  const h = harness({ access: [entry(GROUP_KEY)], observe: true, content: '嗯。' })
  await h.bridge.handleEvent(
    SELF,
    groupEvent(31, '没叫她', { mentioned: false, overrides: { group_name: '测试群' } })
  )
  check('2 not-mentioned 的群消息仍被采', h.observeRecords.length === 1, h.observeRecords.length)
  check('2 triggered===false', h.observeRecords[0]?.triggered === false)
  check('2 outcome===dropped-not-mentioned', h.observeRecords[0]?.outcome === 'dropped-not-mentioned', h.observeRecords[0]?.outcome)
  check('2 群名从原始事件取到（chatLabel 非空）', h.observeRecords[0]?.chatLabel === '测试群', h.observeRecords[0]?.chatLabel)
}
{
  // 区块开关在 P8 已不参与采集：没有开关可用，这里验「不在白名单的群照采」
  const h = harness({ access: [], observe: true })
  await h.bridge.handleEvent(SELF, groupEvent(32, '野生群里的闲聊'))
  check('3 不在白名单的群 → **照采**（P8 群语料口径）', h.observeRecords.length === 1, h.observeRecords.length)
  check('3 allowed=false 被如实记下', h.observeRecords[0]?.allowed === false)
  check('3 outcome===dropped-unbound', h.observeRecords[0]?.outcome === 'dropped-unbound', h.observeRecords[0]?.outcome)
}
{
  const h = harness({
    access: [entry(PRIVATE_KEY, { permissions: { respond: false, tool: false } })],
    observe: true
  })
  await h.bridge.handleEvent(SELF, privateEvent(33, '只旁听'))
  check('4 账号存在但没给私聊权限 → 仍采（旁听主场景）', h.observeRecords.length === 1, h.observeRecords.length)
  check('4 outcome===dropped-not-authorized-member', h.observeRecords[0]?.outcome === 'dropped-not-authorized-member', h.observeRecords[0]?.outcome)
}
{
  const h = harness({ access: [], observe: true })
  await h.bridge.handleEvent(SELF, privateEvent(34, '陌生人私聊'))
  check('5 陌生人私聊 → 不采', h.observeRecords.length === 0, h.observeRecords.length)
  check('5 统计记 droppedNotAuthorizedMember', h.bridge.stats().droppedNotAuthorizedMember === 1, h.bridge.stats().droppedNotAuthorizedMember)
  check('5 unbound 计数保持 0（私聊不再产生这个理由）', h.bridge.stats().droppedUnbound === 0, h.bridge.stats().droppedUnbound)
}
{
  const h = harness({ access: [entry(PRIVATE_KEY)], observe: true, content: '收到。' })
  await h.bridge.handleEvent(SELF, privateEvent(35, '同一句'))
  await h.bridge.handleEvent(SELF, privateEvent(35, '同一句'))
  check('6 duplicate → 只采第一次', h.observeRecords.length === 1, h.observeRecords.length)
  check('6 去重计数照常', h.bridge.stats().droppedDuplicate === 1, h.bridge.stats().droppedDuplicate)
}
{
  const h = harness({ access: [entry(PRIVATE_KEY)], observe: 'throw', content: '照发。' })
  await h.bridge.handleEvent(SELF, privateEvent(36, '写盘会炸'))
  const body = bodyCalls(h.state, h.settings)
  check('7 写盘抛错 → 回复照常发出（sendAwait 被调用）', h.state.chatCalls.length === 1, h.state.chatCalls.length)
  check('7 正文仍然发出去了', body.length > 0, body.length)
  check('7 append 确实被调过（不是没走到）', h.observeRecords.length === 1, h.observeRecords.length)
}
{
  const h = harness({ access: [entry(GROUP_KEY)], observe: true, content: '嗯。' })
  await h.bridge.handleEvent(SELF, groupEvent(37, '叫她'))
  check('8 responded → triggered===true', h.observeRecords[0]?.triggered === true && h.observeRecords[0]?.outcome === 'responded', h.observeRecords[0]?.outcome)
  check('8 群名片落库（speakerCard）', h.observeRecords[0]?.speakerCard === '小明', h.observeRecords[0]?.speakerCard)
}
{
  const h = harness({ access: [entry(PRIVATE_KEY)], content: '不管。' })
  await h.bridge.handleEvent(SELF, privateEvent(38, '不注入 observe'))
  check('9 不注入 observe → 一条都不写（默认不旁听）', h.observeRecords.length === 0, h.observeRecords.length)
  check('9 但回复照常', h.state.chatCalls.length === 1, h.state.chatCalls.length)
}
{
  const h = harness({ access: [entry(PRIVATE_KEY)], observe: true, content: '嗯。', settings: { rateLimitPerUser: 1 } })
  await h.bridge.handleEvent(SELF, privateEvent(39, '第一句'))
  await h.bridge.handleEvent(SELF, privateEvent(40, '第二句'))
  check('10 限速挡下的那条也采（outcome=dropped-rate-limited）', h.observeRecords.length === 2 && h.observeRecords[1].outcome === 'dropped-rate-limited', h.observeRecords.map((r) => r.outcome).join(','))
  check('10 被挡的那条 triggered=false', h.observeRecords[1].triggered === false)
}

/* ── P8 附二 B：去重键必须带会话维度（J-59） ────────────────────────────── */

console.log('P8 · 去重键带 chatId')
{
  // 旧的 uin:messageId 会让后到的消息被静默丢弃：群 A 与私聊撞同一个 message_id
  const h = harness({
    access: [entry(GROUP_KEY), entry(PRIVATE_KEY), entry('qq:10001:group:99999')],
    observe: true,
    content: '嗯。'
  })
  await h.bridge.handleEvent(SELF, groupEvent(77, '群里说的'))
  await h.bridge.handleEvent(SELF, privateEvent(77, '私聊说的'))
  await h.bridge.handleEvent(SELF, groupEvent(77, '另一个群说的', { overrides: { group_id: 99999 } }))
  check('不同会话的同 message_id 不互相去重（3 条都进管线）', h.state.chatCalls.length === 3, h.state.chatCalls.length)
  check('三条都被旁听记下', h.observeRecords.length === 3, h.observeRecords.length)
}
{
  const h = harness({ access: [entry(GROUP_KEY), entry(PRIVATE_KEY)], observe: true, content: '嗯。' })
  await h.bridge.handleEvent(SELF, groupEvent(78, '同一句'))
  await h.bridge.handleEvent(SELF, groupEvent(78, '同一句'))
  check('同一会话同一 message_id 仍然去重', h.state.chatCalls.length === 1, h.state.chatCalls.length)
}

/* ── P9-R3：按「人」判的端到端（R3-B1…B9） ─────────────────────────────── */

console.log('P9-R3 · 私聊准入按发言人')
{
  const h = harness({ access: [], content: '嗯。' })
  await h.bridge.handleEvent(SELF, privateEvent(90, '陌生人'))
  check(
    'B1 私聊 + 不在白名单 → sendAwait 0 次、计 droppedNotAuthorizedMember',
    h.state.chatCalls.length === 0 && h.bridge.stats().droppedNotAuthorizedMember === 1,
    h.state.chatCalls.length + '/' + h.bridge.stats().droppedNotAuthorizedMember
  )
}
{
  const h = harness({ access: [entry(PRIVATE_KEY)], content: '嗯。' })
  await h.bridge.handleEvent(SELF, privateEvent(91, '在白名单'))
  check('B2 私聊 + private=true → 回复', h.state.chatCalls.length === 1, h.state.chatCalls.length)
}

console.log('P9-R3 · 群聊三件事')
{
  const h = harness({ access: [], observe: true })
  await h.bridge.handleEvent(SELF, groupEvent(92, '野生群'))
  check(
    'B3 群 + 不在群白名单 → 0 回复、计 droppedUnbound',
    h.state.chatCalls.length === 0 && h.bridge.stats().droppedUnbound === 1,
    h.state.chatCalls.length + '/' + h.bridge.stats().droppedUnbound
  )
  check('B3 旁听仍写一行（M32：未加白的群照样攒语料）', h.observeRecords.length === 1, h.observeRecords.length)
}
{
  const h = harness({ access: [entry(GROUP_KEY)], observe: true })
  await h.bridge.handleEvent(SELF, groupEvent(93, '没叫她', { mentioned: false }))
  check(
    'B4 群 + 在白名单 + 未 @ → 0 回复、计 droppedNotMentioned',
    h.state.chatCalls.length === 0 && h.bridge.stats().droppedNotMentioned === 1,
    h.bridge.stats().droppedNotMentioned
  )
  check('B4 旁听仍写', h.observeRecords.length === 1, h.observeRecords.length)
}
{
  const h = harness({ access: [entry(GROUP_KEY)], content: '嗯。' })
  await h.bridge.handleEvent(SELF, groupEvent(94, '叫她'))
  check('B5 群成员鉴权关闭（默认）→ 发言人不在白名单也回', h.state.chatCalls.length === 1, h.state.chatCalls.length)
}
{
  const config = { ...configOf([entry(GROUP_KEY)]), groupMemberGate: true }
  const h = harness({ config, content: '嗯。' })
  await h.bridge.handleEvent(SELF, groupEvent(95, '叫她'))
  check(
    'B6 群成员鉴权打开 + 发言人不在白名单 → 0 回复、计 droppedNotAuthorizedMember',
    h.state.chatCalls.length === 0 && h.bridge.stats().droppedNotAuthorizedMember === 1,
    h.state.chatCalls.length + '/' + h.bridge.stats().droppedNotAuthorizedMember
  )
}
{
  // 同一个群里两个人不同待遇：A（20002）在名单；B（40004）不在名单
  const config = { ...configOf([entry(GROUP_KEY), entry(PRIVATE_KEY)]), groupMemberGate: true }
  const h = harness({ config, content: '嗯。' })
  await h.bridge.handleEvent(SELF, groupEvent(96, 'A 说话'))
  const afterA = h.state.chatCalls.length
  await h.bridge.handleEvent(
    SELF,
    groupEvent(97, 'B 说话', { overrides: { user_id: 40004, sender: { user_id: 40004, nickname: '小红' } } })
  )
  check(
    'B7 鉴权打开 + 发言人在名单 → 回；不在名单 → 不回（同一群两种待遇）',
    afterA === 1 && h.state.chatCalls.length === 1,
    afterA + '→' + h.state.chatCalls.length
  )
}
{
  const h = harness({ access: [] })
  await h.bridge.handleEvent(SELF, groupEvent(98, '野生群没叫她', { mentioned: false }))
  check(
    'B8 闸门顺序：群未加白 + 未 @ → droppedUnbound（不是 not-mentioned）',
    h.bridge.stats().droppedUnbound === 1 && h.bridge.stats().droppedNotMentioned === 0,
    JSON.stringify({ unbound: h.bridge.stats().droppedUnbound, notMentioned: h.bridge.stats().droppedNotMentioned })
  )
}
{
  const h = harness({ access: [entry(GROUP_KEY)], content: '嗯。' })
  await h.bridge.handleEvent(SELF, groupEvent(99, '叫她'))
  check('B9 机器人登录号被记下来（群白名单要能展开成会话键）', h.state.uins.includes(SELF), JSON.stringify(h.state.uins))
}

done()
