import assert from 'node:assert/strict'
import test from 'node:test'
import { bundleModule, p } from './qq-test-util.mjs'

const { parseTransfer, parseNc, serializeNc } = await bundleModule('transfer-roundtrip', [
  'export * from ' + JSON.stringify(p('src/main/features/transfer/stFormat.ts')),
  'export * from ' + JSON.stringify(p('src/main/features/transfer/ncFormat.ts')),
].join('\n'))
const createdAt = Date.parse('2026-11-21T16:14:36.254Z')
const session = (title, messages) => ({ id: title, title, mode: 'story', characterId: 'guide', createdAt, updatedAt: createdAt, messages })
const message = (role, extra = {}) => ({ id: role, role, status: 'done', content: '  文本 📝\r\n', createdAt, ...extra })

test('round trips multiple NC sessions and every persisted message field losslessly', () => {
  const tools = [{ id: 'tool-1', name: 'read', title: 'Read', readOnly: true, arguments: '{"path":"a"}',
    status: 'ok', result: 'result', error: null, startedAt: createdAt, durationMs: 1 }]
  const sessions = [session('First', [message('user'), message('narration', { createdAt: createdAt - 1000 }),
    message('assistant', { status: 'error', reasoning: 'trace', error: 'oops', warnings: ['note'], toolCalls: tools,
      copiedFromMessageId: 'original-id' })]), session('Second', [message('system'), message('assistant', { status: 'streaming' })])]
  const text = serializeNc(sessions, createdAt)
  assert.deepEqual(JSON.parse(text), { format: 'nc-sessions', version: 1, exportedAt: createdAt, sessions })
  const parsed = parseTransfer('\uFEFF' + text)
  assert.equal(parsed.format, 'nc')
  assert.equal(parsed.title, 'First')
  assert.equal(parsed.skippedLines, 0)
  assert.deepEqual(parsed.discardedFields, {})
  assert.deepEqual(parsed.sessions, sessions.map(({ id, ...rest }) => rest))
})

test('rejects unsupported versions and malformed NC messages without leaking their contents', () => {
  assert.throws(() => parseNc('{"format":"nc-sessions","version":2,"sessions":[]}'), /版本 1/)
  const text = serializeNc([session('First', [message('tool', { content: 'SECRET_SENTINEL' })])])
  assert.throws(() => parseNc(text), e => /第 1 条消息/.test(e.message) && !e.message.includes('SECRET_SENTINEL'))
  assert.throws(() => parseNc(serializeNc([session('First', [message('assistant', { toolCalls: [{}] })])])), /第 1 条消息/)
})

test('applies message limit to the whole NC package', () => {
  const messages = Array(10_000).fill(message('assistant'))
  const text = serializeNc([session('First', messages), session('Second', messages)])
  assert.equal(parseNc(text).sessions.length, 2)
  assert.throws(() => parseNc(serializeNc([
    session('First', messages), session('Second', [...messages, message('user')]),
  ])), /20001.*20000/)
})
