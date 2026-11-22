import assert from 'node:assert/strict'
import test from 'node:test'
import { bundleModule, p } from './qq-test-util.mjs'

const { serializeSt, parseSt, sanitizeFileName, uniqueFileName } = await bundleModule('transfer-export', [
  'export * from ' + JSON.stringify(p('src/main/features/transfer/stFormat.ts')),
  'export * from ' + JSON.stringify(p('src/main/features/transfer/names.ts')),
].join('\n'))

test('exports exact ST keys, original content and ISO dates; reports narration fallback', () => {
  const createdAt = 1795277676254
  const messages = ['user', 'assistant', 'system', 'narration'].map((role, i) => ({ id: role, role, status: 'done',
    createdAt: createdAt + i, content: ' ' + role + '\n<game>🧭</game>', reasoning: 'not exported' }))
  const { text, narrationCount } = serializeSt(messages, { userName: 'Reader', characterName: 'Guide' })
  assert.equal(narrationCount, 1)
  assert.equal(text.endsWith('\n'), true)
  const [header, ...rows] = text.trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(header, { chat_metadata: {}, user_name: 'Reader', character_name: 'Guide' })
  assert.deepEqual(rows, messages.map(message => ({
    name: message.role === 'user' ? 'Reader' : 'Guide', is_user: message.role === 'user',
    is_system: message.role === 'system', send_date: new Date(message.createdAt).toISOString(), mes: message.content, extra: {},
  })))
  assert.deepEqual(parseSt(text).sessions[0].messages.map(m => m.role), ['user', 'assistant', 'system', 'assistant'])
})

test('sanitizes punctuation including fullwidth question marks, controls, and reserved basenames', () => {
  assert.equal(sanitizeFileName('章？/节:尾.  '), '章__节_尾')
  assert.equal(sanitizeFileName('a\\:*?"<>|\x00\x7fb'), 'a__________b')
  assert.equal(sanitizeFileName('CON.log'), '_CON.log')
  assert.equal(sanitizeFileName('..'), 'conversation')
  assert.ok(sanitizeFileName('x'.repeat(250)).length <= 120)
  assert.ok(!/[\ud800-\udbff]$/u.test(sanitizeFileName('x'.repeat(119) + '🧭')))
})

test('finds non-overwriting names across case, Unicode normalization, and suffix collisions', () => {
  assert.equal(uniqueFileName('Episode', 'jsonl', []), 'Episode.jsonl')
  assert.equal(uniqueFileName('Episode', '.jsonl', new Set(['episode.JSONL'])), 'Episode-2.jsonl')
  assert.equal(uniqueFileName('Épisode', '.nc.json', ['E\u0301pisode.nc.json', 'épisode-2.nc.json']), 'Épisode-3.nc.json')
  const title = 'x'.repeat(150)
  const original = uniqueFileName(title, '.jsonl', [])
  const next = uniqueFileName(title, '.jsonl', [original])
  assert.ok(original.length <= 120 && next.length <= 120 && next.endsWith('-2.jsonl'))
  assert.throws(() => uniqueFileName('Episode', '../bad', []), /扩展名/)
})
