/**
 * A4 入站过滤（P4 G4）—— 本 Phase 最重要的一组。
 * 跑法：node scripts/test/qq-inbound.test.mjs
 */
import { bundleModule, createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const mod = await bundleModule(
  'inbound',
  `export { normalizeInbound, inboundOutcome, isMentionedSelf, textFromSegments } from '${p('src/main/features/qq/inbound.ts')}'`
)
const { normalizeInbound, inboundOutcome, isMentionedSelf, textFromSegments } = mod

const SELF = '10001'
const text = (value) => ({ type: 'text', data: { text: value } })
const at = (qq) => ({ type: 'at', data: { qq } })

function event(overrides = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: 123,
    user_id: 20002,
    self_id: SELF,
    message: [text('你好')],
    sender: { user_id: 20002, nickname: '小明', card: '' },
    ...overrides
  }
}

console.log('🔴 自回环（J-15）')
check(
  'post_type=message_sent → null',
  normalizeInbound(SELF, event({ post_type: 'message_sent' }), SELF) === null
)
{
  const result = inboundOutcome(SELF, event({ post_type: 'message_sent' }), SELF)
  check('message_sent 计为 self-echo（不是普通噪声）', result.ok === false && result.reason === 'self-echo', result.reason)
}
check(
  'post_type=message 但 user_id === self_id → null',
  normalizeInbound(SELF, event({ user_id: Number(SELF) }), SELF) === null
)

console.log('@ 判定')
check('群里 @ 自己 → true', isMentionedSelf([at(SELF), text(' 在吗')], SELF) === true)
check('@全体成员 → false（否则群里每句话都回）', isMentionedSelf([at('all'), text(' 开会')], SELF) === false)
check('@别人 → false', isMentionedSelf([at('30003')], SELF) === false)
check('selfId 为空 → false（不做猜测）', isMentionedSelf([at('')], '') === false)

console.log('过滤步骤')
{
  const imageOnly = event({ message: [{ type: 'image', data: { file: 'x.jpg' } }] })
  const result = inboundOutcome(SELF, imageOnly, SELF)
  check('纯图片 → null', normalizeInbound(SELF, imageOnly, SELF) === null)
  check('且计为 non-text（面板要显示"已忽略 N 条非文本"）', result.ok === false && result.reason === 'non-text', result.reason)
}
{
  let threw = false
  let result = null
  try {
    result = inboundOutcome(SELF, event({ message_type: 'group', group_id: undefined }), SELF)
  } catch {
    threw = true
  }
  check('group_id 缺失 → 不抛', threw === false)
  check('且返回 bad-chat', result !== null && result.ok === false && result.reason === 'bad-chat', result && result.reason)
}
{
  const result = inboundOutcome(SELF, { foo: 1 }, SELF)
  check('畸形事件 → not-message', result.ok === false && result.reason === 'not-message', result.reason)
}

console.log('归一化字段')
{
  const inbound = normalizeInbound(SELF, event(), SELF, 111)
  check('私聊 chatId = user_id', inbound.chatType === 'private' && inbound.chatId === '20002', inbound.chatType + '/' + inbound.chatId)
  check('messageId 字符串化', inbound.messageId === '123', inbound.messageId)
  check('senderName 取 nickname', inbound.senderName === '小明', inbound.senderName)
  check('at 用注入的 now', inbound.at === 111, inbound.at)
  check('mentioned=false（私聊没有 at 段）', inbound.mentioned === false)
}
{
  const group = event({
    message_type: 'group',
    group_id: 88888,
    message: [at(SELF), text(' 今天吃啥'), { type: 'image', data: {} }],
    sender: { user_id: 20002, nickname: '小明', card: '群名片' }
  })
  const inbound = normalizeInbound(SELF, group, SELF)
  check('群聊 chatId = group_id', inbound.chatId === '88888', inbound.chatId)
  check('群名片优先于昵称', inbound.senderName === '群名片', inbound.senderName)
  check('mentioned=true', inbound.mentioned === true)
  check('文本拼装含 @ 与 [图片]', inbound.text.includes('@' + SELF) && inbound.text.includes('[图片]'), inbound.text)
}
{
  const inbound = normalizeInbound(SELF, event({ message_id: undefined, message_seq: 456 }), SELF)
  check('message_id 缺省时回落到 message_seq', inbound.messageId === '456', inbound.messageId)
}
{
  const inbound = normalizeInbound(SELF, event({ message: '来自 string 格式的一条' }), SELF)
  check('string 格式当一段 text（不解析 CQ 码）', inbound.text === '来自 string 格式的一条', inbound.text)
}
check('文本为空 → 返回空串', textFromSegments([{ type: 'reply', data: { id: '1' } }]) === '')

done()
