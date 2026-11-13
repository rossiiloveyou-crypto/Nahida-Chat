/**
 * P4 行为探针：一条 `//list` 到底进了模型还是被指令层接住。
 *
 * 这套东西**不进主测链**，只产机器可读的 key=value，供 before / after 差集比对。
 *
 * 为什么必须单独存在：P4 之前，`//` 开头的消息会原样送进模型
 * （bridge.ts 的 processInbound 只加群聊前缀，没有任何文本预处理），
 * 模型会一本正经地回答「我不知道 //list 是什么」，而且这句话还会被 P3 的
 * recordHistory 写进人设历史。**只有 before 快照才能证明这条改动真的生效**
 * （经验库 V13：标量基线全绿也可能是没动过）。
 *
 * 跑法：
 *   node scripts/test/probe-command.mjs --mode=before
 *   node scripts/test/probe-command.mjs --mode=after
 *
 * 🔴 顺序铁律（P15）：before 必须在动 bridge.ts **之前**跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const modeArg = process.argv.find((item) => item.startsWith('--mode='))
const MODE = modeArg ? modeArg.slice('--mode='.length) : 'unknown'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-command-probe-'))
installElectronStub(userData)

// 记忆关掉（本探针只关心「指令进不进模型」，不关心抽取）；摘要关掉（那是用户的功能）
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false }, summary: { enabled: false } }),
  'utf8'
)

const SENDER = '20002'
const SELF = '10001'
const COMMAND = '//list'
const PLAIN = '你好'

/* ── 授权文件：这个人必须在白名单里，否则连闸门都过不去 ───────────────── */
fs.mkdirSync(path.join(userData, 'channels'), { recursive: true })
fs.writeFileSync(
  path.join(userData, 'channels', 'access.json'),
  JSON.stringify({
    version: 2,
    groupMemberGate: false,
    toolGate: true,
    accounts: [
      {
        channel: 'qq',
        userId: SENDER,
        label: '探针',
        addedAt: 1,
        lastAt: 0,
        permissions: { private: true, group: true, tool: false }
      }
    ],
    groups: [],
    uins: [SELF]
  }),
  'utf8'
)

const mod = await bundleModule(
  'command-probe',
  [
    `export { createQqBridge } from '${p('src/main/features/qq/bridge.ts')}'`,
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`,
    `export { DEFAULT_QQ_SETTINGS } from '${p('src/shared/qq.ts')}'`
  ].join('\n')
)
const { createQqBridge, MemoryStore, DEFAULT_QQ_SETTINGS } = mod

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const textSeg = (value) => ({ type: 'text', data: { text: value } })

function privateEvent(id, value) {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: id,
    user_id: Number(SENDER),
    self_id: SELF,
    message: [textSeg(value)],
    sender: { user_id: Number(SENDER), nickname: '探针' }
  }
}

/** 一次探测的环境：假 host + 假 chat + 真 store 语义上的计数 */
function makeHarness() {
  const state = { calls: [], chatCalls: [], sessionCalls: [], touched: [], handler: null }
  const settings = { ...DEFAULT_QQ_SETTINGS, segmentDelayMs: 0, typingMode: 'off', errorReplyText: '' }
  const host = {
    on: (_name, cb) => {
      state.handler = cb
      return () => {
        state.handler = null
      }
    },
    invokeAction: async (uin, action, params) => {
      state.calls.push({ uin, action, params })
      return { ok: true, retcode: 0, messageId: '1', error: null }
    }
  }
  const chat = {
    sendAwait: async (input) => {
      state.chatCalls.push({ input })
      return {
        status: 'done',
        sessionId: input.sessionId,
        messageId: 'm',
        content: '收到',
        toolCalls: [],
        durationMs: 1
      }
    }
  }
  const accessConfig = JSON.parse(fs.readFileSync(path.join(userData, 'channels', 'access.json'), 'utf8'))
  const store = {
    access: () => accessConfig,
    settings: () => settings,
    touchAccess: (key, at) => state.touched.push({ key, at }),
    rememberUin: () => {}
  }
  const bridge = createQqBridge({
    host,
    chat,
    store,
    ensureSession: (sessionId, title) => state.sessionCalls.push({ sessionId, title }),
    broadcast: () => {},
    sleep
  })
  return { bridge, state, settings }
}

/** 回给对端的正文（不含 typing）：取 send_private_msg / send_group_msg 的 text 段 */
function bodyTextOf(state) {
  const parts = []
  for (const call of state.calls) {
    if (call.action !== 'send_private_msg' && call.action !== 'send_group_msg') continue
    const segments = Array.isArray(call.params?.message) ? call.params.message : []
    for (const segment of segments) {
      if (segment.type === 'text' && typeof segment.data?.text === 'string') parts.push(segment.data.text)
    }
  }
  return parts.join('')
}

function statsCommands(bridge) {
  const stats = bridge.stats()
  return Number(stats.commands ?? 0)
}

/* ── 预置人设：default 为激活项，另有一个 work（不需要被切） ────────────── */
const seed = new MemoryStore()
seed.upsertPersona(SENDER, 'default', true)
seed.close()

/* ── 场景 1：指令 ───────────────────────────────────────────────────── */
const a = makeHarness()
const sessionsBefore = a.state.sessionCalls.length
await a.bridge.handleEvent(SELF, privateEvent(1, COMMAND))
await sleep(80)
const sessionsAfter = a.state.sessionCalls.length
const MODEL_SAW_COMMAND = a.state.chatCalls.length > 0
const COMMAND_REPLY = Array.from(bodyTextOf(a.state)).slice(0, 40).join('')
const STATS_COMMANDS = statsCommands(a.bridge)
const TOUCHES_AFTER_COMMAND = a.state.touched.length

/* ── 场景 2：自检（普通消息）——两种模式下都必须进模型 ──────────────────── */
const b = makeHarness()
await b.bridge.handleEvent(SELF, privateEvent(2, PLAIN))
await sleep(80)
const MODEL_SAW_PLAIN = b.state.chatCalls.length > 0
const SELFCHECK = MODEL_SAW_PLAIN ? 'ok' : 'FAIL'

/* ── 落点：激活人设（指令不该改它，除了 //switch） ───────────────────────── */
const disc = new MemoryStore()
const ACTIVE_PERSONA_AFTER = disc.activePersona(SENDER) ?? '(none)'
const PERSONAS_AFTER = disc.listPersonas(SENDER).length
disc.close()

console.log('MODE=' + MODE)
console.log('MODEL_SAW_COMMAND=' + String(MODEL_SAW_COMMAND))
console.log('SESSIONS_BEFORE=' + String(sessionsBefore) + ' SESSIONS_AFTER=' + String(sessionsAfter))
console.log('TOUCHES_AFTER_COMMAND=' + String(TOUCHES_AFTER_COMMAND))
console.log('STATS_COMMANDS=' + String(STATS_COMMANDS))
console.log('COMMAND_REPLY=' + COMMAND_REPLY.replace(/\r?\n/g, ' / '))
console.log('MODEL_SAW_PLAIN=' + String(MODEL_SAW_PLAIN))
console.log('ACTIVE_PERSONA_AFTER=' + ACTIVE_PERSONA_AFTER)
console.log('PERSONAS_AFTER=' + String(PERSONAS_AFTER))
console.log('SELFCHECK=' + SELFCHECK)

process.exit(SELFCHECK === 'ok' ? 0 : 1)
