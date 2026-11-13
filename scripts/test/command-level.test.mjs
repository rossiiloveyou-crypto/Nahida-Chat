/**
 * P4：指令系统 + 分级权限（A-01 … A-18）。
 *
 * 三层：
 *  1. 纯函数层（shared/persona.ts）：解析 / 归一化 / 门槛判定 —— 不碰库、不碰盘
 *  2. 执行器层（features/commands/run.ts）：四条指令的行为，落点用**真 MemoryStore**
 *  3. 接线层（features/qq/bridge.ts）：指令不进模型、不建会话、不写 access.json、
 *     统计与旁听 outcome 一致
 *
 * 🔴 为什么第 2 层没有桩一个假 memoryService：本项目已经踩过「桩配了但没生效」的坑
 *    （qq-test-util.mjs 注释里的 alias 抢注）。这里直接让门面连临时 userData 的真库，
 *    「切了没有」是读盘读出来的，不是抄桩记录。
 *
 * 跑法：node scripts/test/command-level.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-command-level-'))
installElectronStub(userData)

// 记忆关掉（本套件不测抽取）；摘要关掉（用户的功能，与本套件无关）
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ memory: { enabled: false, autoExtract: false }, summary: { enabled: false } }),
  'utf8'
)

// 授权文件：私聊账号一个（高等级，供 bridge 层用）+ 群不加白（测「群白名单优先」）
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
        userId: '20002',
        label: '',
        addedAt: 1,
        lastAt: 0,
        permissions: { private: true, group: true, tool: false, level: 'high' }
      },
      {
        channel: 'qq',
        userId: '30003',
        label: '',
        addedAt: 1,
        lastAt: 0,
        permissions: { private: true, group: true, tool: false, level: 'low' }
      }
    ],
    groups: [{ channel: 'qq', chatId: '88888', label: '测试群', addedAt: 1, lastAt: 0 }],
    uins: ['10001']
  }),
  'utf8'
)

const mod = await bundleModule(
  'command-level',
  [
    `export {
      COMMAND_DEFAULT_THRESHOLDS,
      COMMAND_NAMES,
      COMMAND_PREFIX,
      DEFAULT_ACCOUNT_LEVEL,
      canUseCommand,
      levelAtLeast,
      normalizeLevel,
      normalizeThresholds,
      parseCommand
    } from '${p('src/shared/persona.ts')}'`,
    `export { runCommand, unknownCommandReply } from '${p('src/main/features/commands/run.ts')}'`,
    `export { createQqBridge, emptyStats, triggeredOf } from '${p('src/main/features/qq/bridge.ts')}'`,
    `export { MemoryStore } from '${p('src/main/features/rag/store.ts')}'`,
    `export { DEFAULT_QQ_SETTINGS } from '${p('src/shared/qq.ts')}'`
  ].join('\n')
)
const {
  COMMAND_DEFAULT_THRESHOLDS,
  COMMAND_NAMES,
  COMMAND_PREFIX,
  DEFAULT_ACCOUNT_LEVEL,
  canUseCommand,
  levelAtLeast,
  normalizeLevel,
  normalizeThresholds,
  parseCommand,
  runCommand,
  unknownCommandReply,
  createQqBridge,
  emptyStats,
  triggeredOf,
  MemoryStore,
  DEFAULT_QQ_SETTINGS
} = mod

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const THRESHOLDS = normalizeThresholds(undefined)
const ALICE = '20002'
const BOB = '30003'
const SELF = '10001'

/** 每个用户各用各的库行；先清干净，保证套件可重复跑 */
function freshStore() {
  return new MemoryStore()
}

const ctx = (over, extra = {}) => ({
  userId: ALICE,
  chatType: 'private',
  chatId: ALICE,
  level: 'high',
  thresholds: THRESHOLDS,
  args: [],
  ...over
})

/* ── 1 · 解析器（A-01） ─────────────────────────────────────────────────── */

console.log('1 · parseCommand（A-01 / T-02 … T-05）')

check('T-01 A-01 普通消息 → null（不是指令，照旧进模型）', parseCommand('你好') === null)
check('T-01b 空串 / 纯空白 → null', parseCommand('') === null && parseCommand('   ') === null)
check('T-01c 非字符串（null / undefined）→ null，不抛', parseCommand(null) === null && parseCommand(undefined) === null)
{
  const hit = parseCommand('//list')
  check('T-02 已知指令 → known:true 且名字对', hit && hit.known === true && hit.command.name === 'list', JSON.stringify(hit))
  check('T-02b prefix 是 //', COMMAND_PREFIX === '//')
}
{
  const upper = parseCommand('//LIST')
  check(
    'T-02c 名字大小写折叠（唯一宽容）',
    upper && upper.known === true && upper.command.name === 'list',
    JSON.stringify(upper)
  )
}
check(
  'T-03 全角斜杠 ／／ 不算指令（不做全角兼容 = 不制造第二种前缀）',
  parseCommand('／／list') === null
)
{
  // 🔴 群聊那条链路实测踩到的坑：inbound.text 把 at 段拼成『@10001//list』（无分隔符），
  //    不剥行首 @ 就永远解析不出指令 —— 只在私聊测的用例全绿也照样坏
  const grouped = parseCommand('@10001//list')
  check(
    'T-03b 行首 @QQ号（群聊必须 @ 才过闸）剥掉后仍能解析',
    grouped && grouped.known === true && grouped.command.name === 'list',
    JSON.stringify(grouped)
  )
  const multi = parseCommand('@10001 @全体成员 //switch 工作')
  check(
    'T-03c 多个行首 @ 一起剥，参数照样解析',
    multi && multi.known && multi.command.name === 'switch' && multi.command.args[0] === '工作',
    JSON.stringify(multi)
  )
  check('T-03d 非数字的 @xxx 不当提及剥（不制造第二套宽松规则）', parseCommand('@小明//list') === null)
}
{
  const empty = parseCommand('//')
  check('T-04 只有 // → known:false 且 name 为空串', empty && empty.known === false && empty.name === '', JSON.stringify(empty))
}
{
  const unknown = parseCommand('//hello 世界')
  check('T-05 未知名 → known:false 且带上名字', unknown && unknown.known === false && unknown.name === 'hello', JSON.stringify(unknown))
}
{
  const args = parseCommand('//switch 测试, 工作 ,')
  check(
    'T-06 参数按空白与半/全角逗号切分，已 trim 去空串',
    args && args.known && JSON.stringify(args.command.args) === JSON.stringify(['测试', '工作']),
    JSON.stringify(args && args.command && args.command.args)
  )
  const full = parseCommand('//add 甲，乙')
  check(
    'T-06b 全角逗号同样切分',
    full && full.known && JSON.stringify(full.command.args) === JSON.stringify(['甲', '乙']),
    JSON.stringify(full && full.command && full.command.args)
  )
}

/* ── 2 · 归一化（A-14 / A-15） ─────────────────────────────────────────── */

console.log('2 · 等级与门槛归一化（A-14 / A-15）')

check('T-17 A-14 非法等级 → low', normalizeLevel('bogus') === 'low' && normalizeLevel(undefined) === 'low')
check('T-17b 合法等级原样保留（含 none）', normalizeLevel('none') === 'none' && normalizeLevel('high') === 'high')
check('T-17c DEFAULT_ACCOUNT_LEVEL 是 low（H-A-07 的默认值）', DEFAULT_ACCOUNT_LEVEL === 'low')
check(
  'T-18 A-15 {list:"none"} → list 真的是 none（没有被 ?? 当成缺省）',
  normalizeThresholds({ list: 'none' }).list === 'none'
)
{
  const norm = normalizeThresholds({ list: 'high', dele: '瞎写' })
  check(
    'T-18b 部分合法：合法的用用户的，非法/缺字段回落出厂值',
    norm.list === 'high' && norm.dele === COMMAND_DEFAULT_THRESHOLDS.dele && norm.add === COMMAND_DEFAULT_THRESHOLDS.add,
    JSON.stringify(norm)
  )
  check('T-18c 非对象输入不抛、全回落', JSON.stringify(normalizeThresholds(null)) === JSON.stringify({ ...COMMAND_DEFAULT_THRESHOLDS }))
}

/* ── 3 · 4×4 矩阵（A-12，16 格） ───────────────────────────────────────── */

console.log('3 · 四级 × 四指令矩阵（A-12 / B4 / P13）')

{
  const levels = ['none', 'low', 'medium', 'high']
  const matrix = []
  for (const level of levels) {
    for (const name of COMMAND_NAMES) {
      matrix.push({ level, name, got: canUseCommand(level, name, THRESHOLDS), want: levelAtLeast(level, THRESHOLDS[name]) })
    }
  }
  check('T-15 矩阵恰好 16 格（4 等级 × 4 指令）', matrix.length === 16, matrix.length)
  check(
    'T-15b 每格 == levelAtLeast 的结果（不是写死的表）',
    matrix.every((cell) => cell.got === cell.want),
    matrix.filter((cell) => cell.got !== cell.want).map((cell) => cell.level + '/' + cell.name).join(',')
  )
  // P13：矩阵里必须**同时**有「应放行」与「应拒绝」，否则它证明不了鉴权真的在看门槛
  const denied = matrix.filter((cell) => cell.got === false)
  const allowed = matrix.filter((cell) => cell.got === true)
  check('T-15c P13 矩阵同时含「放行」与「拒绝」两态', denied.length > 0 && allowed.length > 0, allowed.length + ' 放行 / ' + denied.length + ' 拒绝')
  check(
    'T-15d none 等级一条都过不了（含 list）',
    matrix.filter((cell) => cell.level === 'none').every((cell) => cell.got === false)
  )
  check(
    'T-15e high 等级四条全过',
    matrix.filter((cell) => cell.level === 'high').every((cell) => cell.got === true)
  )
  check(
    'T-15f low 能 list/switch、不能 add/dele（出厂门槛的真实形状）',
    matrix
      .filter((cell) => cell.level === 'low')
      .every((cell) => (cell.name === 'list' || cell.name === 'switch' ? cell.got === true : cell.got === false))
  )
}

/* ── 4 · 四条指令的真实行为（A-04 … A-11） ─────────────────────────────── */

console.log('4 · 指令行为（落点读真库）')

{
  const store = freshStore()
  store.upsertPersona(ALICE, 'default', true)
  store.close()
}
// 让「零人设」那种状态也能被测到：BOB 完全不注册

{
  const store = freshStore()
  const rows = store.listPersonas(ALICE)
  store.close()
  const out = runCommand('list', ctx({}))
  const lines = out.text.split('\n')
  check('T-06b A-04 //list 行数 = listPersonas().length', lines.length === rows.length, lines.length + '/' + rows.length)
  check('T-06c A-04 ★ 恰好一个且落在激活项上', lines.filter((line) => line.startsWith('★ ')).length === 1 && out.text.includes('★ default'), out.text)
  check('T-06d //list 是成功的（ok=true）', out.ok === true)
}

{
  const out = runCommand('list', ctx({ userId: BOB }))
  check('T-07 A-05 零人设 → 提示 //add，且不抛', out.text.includes('//add'), out.text)
}

{
  const store = freshStore()
  store.upsertPersona(ALICE, 'work', false)
  store.close()

  const out = runCommand('switch', ctx({ args: ['work'] }))
  const after = freshStore()
  const rows = after.listPersonas(ALICE)
  const active = after.activePersona(ALICE)
  after.close()
  check('T-08 A-06 //switch 后 SUM(is_active)=1', rows.filter((row) => row.isActive).length === 1, rows.map((row) => row.personaId + ':' + row.isActive).join(','))
  check('T-08b A-06 激活项就是目标人设', active === 'work', active)
  check('T-08c //switch 回文案含「下一句话」', out.ok === true && out.text.includes('下一句话'), out.text)

  const before = rows.length
  const missOut = runCommand('switch', ctx({ args: ['不存在'] }))
  const after2 = freshStore()
  const rows2 = after2.listPersonas(ALICE)
  after2.close()
  check('T-10 A-08 切到不存在 → 失败且提示 //add', missOut.ok === false && missOut.text.includes('//add'), missOut.text)
  check('T-10b A-08 不自动创建（人设条数不变）', rows2.length === before, rows2.length + '/' + before)

  const addOut = runCommand('add', ctx({ args: ['新设'] }))
  const after3 = freshStore()
  const rows3 = after3.listPersonas(ALICE)
  const active3 = after3.activePersona(ALICE)
  after3.close()
  check('T-11 A-09 //add 成功且条数 +1', addOut.ok === true && rows3.length === before + 1, addOut.text)
  check('T-11b A-09 //add **不改变**激活项', active3 === 'work', active3)
  check('T-11c 重复 //add 同一名字 → 明确失败', runCommand('add', ctx({ args: ['新设'] })).ok === false)

  const delDefault = runCommand('dele', ctx({ args: ['default'] }))
  check('T-12 A-10 //dele default 被拒且条数不变', delDefault.ok === false && delDefault.text.includes('不能删'), delDefault.text)

  // 先切到「新设」，它才成为激活项；再删它必须被拒（「正在使用中」）
  runCommand('switch', ctx({ args: ['新设'] }))
  const delActive = runCommand('dele', ctx({ args: ['新设'] }))
  check('T-13 A-11 //dele 激活项被拒', delActive.ok === false && delActive.text.includes('正在使用中'), delActive.text)

  runCommand('switch', ctx({ args: ['default'] }))
  const delOk = runCommand('dele', ctx({ args: ['新设'] }))
  const after4 = freshStore()
  const rows4 = after4.listPersonas(ALICE)
  after4.close()
  check('T-14 A-11 切走之后可删，条数 −1', delOk.ok === true && rows4.length === rows3.length - 1, delOk.text)
  check(
    'T-14b H-C-04 //dele 的文案必须写明「记忆与历史仍保留」',
    delOk.text.includes('记忆与历史仍保留'),
    delOk.text.replace(/\n/g, ' / ')
  )

  const bad = runCommand('add', ctx({ args: ['带 空格'] }))
  check('T-14c 非法人设名 → 给人话规则，不抛', bad.ok === false && bad.text.includes('1–32'), bad.text)
  const noArg = runCommand('switch', ctx({ args: [] }))
  check('T-14d 缺参数 → 给用法', noArg.ok === false && noArg.text.includes('用法'), noArg.text)
}

/* ── 5 · 门槛可配 + 越权（A-12b / A-13） ───────────────────────────────── */

console.log('5 · 门槛可配（A-13）')

{
  const lowered = ctx({ level: 'low', args: [] })
  check('T-15g 出厂门槛下 low 账号能 //list', runCommand('list', lowered).ok === true)

  const strict = ctx({ level: 'low', thresholds: normalizeThresholds({ list: 'high' }) })
  const denied = runCommand('list', strict)
  check('T-16 A-13 把 list 门槛改成 high → low 账号被拒', denied.ok === false, denied.detail)
  check(
    'T-16b 越权文案**不暴露**门槛等级（暴露即可逐级试探）',
    denied.text === '你的指令权限不够，这条指令需要更高的等级。',
    denied.text
  )
  // 门槛抬到 high 之后，low 账号四条全部过不了（四条各验一次，不是只验 list）
  const elevated = ctx({ level: 'low', thresholds: normalizeThresholds({ list: 'high', switch: 'high', add: 'high', dele: 'high' }), args: ['x'] })
  check(
    'T-16c 四条指令全部被抬高的门槛挡下（逐个验）',
    ['list', 'switch', 'add', 'dele'].every((name) => runCommand(name, elevated).ok === false)
  )
  // 反向对照：门槛设成 none = 「不设门槛」，连 none 等级都能过 ——
  // 与上面那条一起，才证明判定真的在读门槛值，而不是恒拒或恒放
  const noGate = ctx({ level: 'none', thresholds: normalizeThresholds({ list: 'none' }) })
  check('T-16d 门槛设成 none → 连 none 等级都能过（证明判定在读门槛值）', runCommand('list', noGate).ok === true)
}

/* ── 6 · 未知指令文案（A-16） ──────────────────────────────────────────── */

console.log('6 · 未知指令（A-16）')

check(
  'T-19 A-16 未知名 → 含「可用：」且 ok=false',
  (() => {
    const r = unknownCommandReply('hello')
    return r.ok === false && r.text.includes('可用：') && r.text.includes('//hello')
  })()
)
check(
  'T-20 A-16 空指令 → 同样含「可用：」，正文说「空的指令」',
  (() => {
    const r = unknownCommandReply('')
    return r.ok === false && r.text.includes('可用：') && r.text.includes('空的指令')
  })()
)

/* ── 7 · 接线层：不进模型 / 不建会话 / 统计与旁听（A-02 / A-03 / A-17 / A-18） ── */

console.log('7 · 接线层（bridge）')

function harness(options = {}) {
  const state = { calls: [], chatCalls: [], sessionCalls: [], touched: [], handler: null, observe: [] }
  const settings = {
    ...DEFAULT_QQ_SETTINGS,
    segmentDelayMs: 0,
    typingMode: 'off',
    errorReplyText: '',
    ...(options.settings || {})
  }
  const access = options.access || JSON.parse(fs.readFileSync(path.join(userData, 'channels', 'access.json'), 'utf8'))
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
      return { status: 'done', sessionId: input.sessionId, messageId: 'm', content: '收到', toolCalls: [], durationMs: 1 }
    }
  }
  const store = {
    access: () => access,
    settings: () => settings,
    touchAccess: (key, at) => state.touched.push({ key, at }),
    rememberUin: () => {}
  }
  const bridge = createQqBridge({
    host,
    chat,
    store,
    observe: { append: (record) => state.observe.push(record) },
    ensureSession: (sessionId, title) => state.sessionCalls.push({ sessionId, title }),
    broadcast: () => {},
    sleep
  })
  return { bridge, state, settings }
}

const privateEvent = (id, text, userId = ALICE) => ({
  post_type: 'message',
  message_type: 'private',
  message_id: id,
  user_id: Number(userId),
  self_id: SELF,
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: Number(userId), nickname: '测试' }
})

const bodyText = (state) =>
  state.calls
    .filter((call) => call.action === 'send_private_msg' || call.action === 'send_group_msg')
    .flatMap((call) => (Array.isArray(call.params?.message) ? call.params.message : []))
    .filter((segment) => segment.type === 'text' && typeof segment.data?.text === 'string')
    .map((segment) => segment.data.text)
    .join('')

{
  const h = harness()
  const sessionsBefore = h.state.sessionCalls.length
  const touchesBefore = h.state.touched.length
  await h.bridge.handleEvent(SELF, privateEvent(1, '//list'))
  await sleep(60)
  // 🔴 这三条必须在**发普通消息之前**取：普通消息本来就会建会话 + 写 access.json，
  //    混在一起量，两边都被污染，判据就变成恒假（P17 的同类坑）
  const sessionsAfterCommand = h.state.sessionCalls.length
  const touchesAfterCommand = h.state.touched.length
  check('T-21 A-02 指令不进模型（sendAwait 调用 0 次）', h.state.chatCalls.length === 0, h.state.chatCalls.length)
  check('T-23b A-03 指令不建会话（ensureSession 0 次）', sessionsAfterCommand === sessionsBefore, sessionsAfterCommand)
  check('T-23c A-03 指令不写 access.json（touchAccess 0 次）', touchesAfterCommand === touchesBefore, touchesAfterCommand)
  // P17：没有对照物时「收不到」恒真 —— 同一条用例里必须证明桩是通的
  await h.bridge.handleEvent(SELF, privateEvent(2, '你好'))
  await sleep(60)
  check('T-21b P17 对照：同一条普通消息确实进了模型（桩是通的）', h.state.chatCalls.length === 1, h.state.chatCalls.length)
  check(
    'T-23d 对照：普通消息**会**建会话 + 写 access.json（证明上面两条不是恒真）',
    h.state.sessionCalls.length === sessionsBefore + 1 && h.state.touched.length === touchesBefore + 1,
    h.state.sessionCalls.length + '/' + h.state.touched.length
  )
  const stats = h.bridge.stats()
  check('T-22 A-17 成功指令 → stats.commands +1', stats.commands === 1 && stats.commandsFailed === 0, stats.commands + '/' + stats.commandsFailed)
  check(
    'T-22b A-17 旁听 outcome 落成 command-handled',
    h.state.observe.some((record) => record.outcome === 'command-handled'),
    h.state.observe.map((record) => record.outcome).join(',')
  )
  check(
    'T-22c A-18 command-handled **不属于 triggered**（它没进模型）',
    triggeredOf('command-handled') === false && triggeredOf('command-failed') === false
  )
  check(
    'T-22d A-18 对照：responded 仍属于 triggered（不是把整张表写死成 false）',
    triggeredOf('responded') === true
  )
  const observed = h.state.observe.filter((record) => record.outcome === 'command-handled')[0]
  check('T-22e 旁听行的 triggered 位确实是 false', observed && observed.triggered === false)
  check('T-23 指令回复真的发出去了（正文含人设名）', bodyText(h.state).includes('default'), bodyText(h.state))
}

{
  const h = harness()
  // 低等级账号发 //add → 越权
  await h.bridge.handleEvent(SELF, privateEvent(3, '//add 试探', BOB))
  await sleep(60)
  const stats = h.bridge.stats()
  check('T-24 越权指令 → commandsFailed +1、commands 不变', stats.commandsFailed === 1 && stats.commands === 0, stats.commands + '/' + stats.commandsFailed)
  check('T-24b 越权也回话（用户看得到被拒原因）', bodyText(h.state).includes('权限不够'), bodyText(h.state))
  check(
    'T-24c 越权旁听 outcome 落成 command-failed',
    h.state.observe.some((record) => record.outcome === 'command-failed'),
    h.state.observe.map((record) => record.outcome).join(',')
  )
  check('T-24d 越权同样不进模型、不建会话', h.state.chatCalls.length === 0 && h.state.sessionCalls.length === 0)
}

{
  const h = harness()
  await h.bridge.handleEvent(SELF, privateEvent(4, '//不认识的指令'))
  await sleep(60)
  check('T-25 未知指令 → 回可读文案，且 ok=false（记进 commandsFailed）', bodyText(h.state).includes('可用：') && h.bridge.stats().commandsFailed === 1, bodyText(h.state))
}

{
  // M11：群聊里不 @ 就一个字都不回（既有闸门在指令之前，位置没被改坏）
  const h = harness()
  const groupEvent = (id, text, mentioned) => ({
    post_type: 'message',
    message_type: 'group',
    message_id: id,
    group_id: 88888,
    user_id: Number(ALICE),
    self_id: SELF,
    message: mentioned
      ? [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }],
    sender: { user_id: Number(ALICE), nickname: '测试', card: '测试' }
  })
  await h.bridge.handleEvent(SELF, groupEvent(5, '//list', false))
  await sleep(60)
  check('T-26 A-21 群里没 @ → 指令也不响应（不绕过既有闸门）', h.state.calls.length === 0 && h.bridge.stats().commands === 0, h.state.calls.length)
  await h.bridge.handleEvent(SELF, groupEvent(6, '//list', true))
  await sleep(60)
  check('T-26b A-21 群里 @ 了 → 正常响应', h.bridge.stats().commands === 1, h.bridge.stats().commands)
}

{
  // 未加白的群：指令也不该生效（M11 的另一半）
  const h = harness()
  const unboundGroupEvent = {
    post_type: 'message',
    message_type: 'group',
    message_id: 7,
    group_id: 99999,
    user_id: Number(ALICE),
    self_id: SELF,
    message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: '//list' } }],
    sender: { user_id: Number(ALICE), nickname: '测试' }
  }
  await h.bridge.handleEvent(SELF, unboundGroupEvent)
  await sleep(60)
  check('T-26c 未加白的群 → 指令不响应', h.state.calls.length === 0 && h.bridge.stats().commands === 0)
}

{
  // 门槛从 settings 读：把 list 门槛改成 high，低等级账号被拒
  const h = harness({ settings: { commandThresholds: normalizeThresholds({ list: 'high' }) } })
  await h.bridge.handleEvent(SELF, privateEvent(8, '//list', BOB))
  await sleep(60)
  check('T-27 A-13 门槛改了 → bridge 真的按新门槛判（低等级被拒）', h.bridge.stats().commandsFailed === 1 && bodyText(h.state).includes('权限不够'), bodyText(h.state))
}

check('emptyStats() 含 commands / commandsFailed 两个字段且初值 0', emptyStats().commands === 0 && emptyStats().commandsFailed === 0)

done()
