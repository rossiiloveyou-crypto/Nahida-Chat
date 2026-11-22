import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import test from 'node:test'
import { bundleModule, p } from './qq-test-util.mjs'

const { parseTransfer, sniffTransferFormat, MAX_TRANSFER_BYTES, MAX_TRANSFER_MESSAGES } = await bundleModule('transfer-st-format', [
  'export * from ' + JSON.stringify(p('src/main/features/transfer/stFormat.ts')),
  'export * from ' + JSON.stringify(p('src/shared/transfer.ts')),
].join('\n'))
const header = { chat_metadata: { secret: 'ignored' }, user_name: 'Reader', character_name: 'Guide' }
const jsonl = (rows) => [header, ...rows].map(row => JSON.stringify(row)).join('\r\n')

test('detects formats by structure, not strings or file names', () => {
  assert.equal(sniffTransferFormat('\uFEFF\r\n' + jsonl([])), 'st')
  assert.equal(sniffTransferFormat('{"character_name":"Guide"}'), 'st')
  assert.equal(sniffTransferFormat('{ "format": "nc-sessions", "version": 1 }'), 'nc')
  assert.equal(sniffTransferFormat('{\n  "format": "nc-sessions"\n}'), 'nc')
  assert.throws(() => sniffTransferFormat('{"other":"chat_metadata format: nc-sessions"}'), /chat_metadata.*nc-sessions/)
  assert.throws(() => sniffTransferFormat('random plaintext'), /chat_metadata.*nc-sessions/)
  assert.throws(() => parseTransfer('{"chat_metadata":\uFFFD}\n{"mes":"valid body"}'), /chat_metadata.*nc-sessions/)
})

test('uses strict boolean role mapping, preserves content, and counts bad lines and dropped fields', () => {
  const content = '  <game>🧭</game>\r\n<!-- keep -->\n<options><option>A</option></options>\n<summary>B</summary>  '
  const encoded = jsonl([
    { is_user: true, is_system: true, mes: content, name: 'Reader', extra: { reasoning: 'ignored' }, swipes: ['old'] },
    { is_user: false, is_system: false, mes: 'A', name: 'Guide', extra: null, swipe_id: 0 },
    { is_user: false, mes: 'B', force_avatar: '', swipe_info: [], title: null, gen_started: '', gen_finished: '' },
    { is_user: 'true', is_system: 1, mes: null },
    { is_system: true, mes: 'system' },
  ]) + '\r\n{bad\r\nnot json\r\n{}\r\n[]\r\n\r\n'
  const parsed = parseTransfer(encoded)
  const { messages } = parsed.sessions[0]
  assert.equal(parsed.title, 'Guide')
  assert.equal(parsed.userName, 'Reader')
  assert.equal(parsed.skippedLines, 4)
  assert.deepEqual(parsed.discardedFields, {
    chat_metadata: 1, extra: 2, name: 2, swipes: 1, swipe_id: 1,
    swipe_info: 1, force_avatar: 1, title: 1, gen_started: 1, gen_finished: 1,
  })
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'assistant', 'assistant', 'system'])
  assert.deepEqual(Buffer.from(messages[0].content), Buffer.from(content))
  assert.equal(messages[3].content, '')
  assert.equal(new Set(messages.map(m => m.id)).size, 5)
  for (const msg of messages) {
    assert.match(msg.id, /^[a-f\d]{8}-[a-f\d-]{27}$/)
    assert.equal(msg.status, 'done')
    assert.deepEqual(Object.keys(msg).sort(), ['content', 'createdAt', 'id', 'role', 'status'])
  }
})

test('parses ISO, localized dates, seconds, milliseconds, and fallback without changing order', () => {
  const base = Date.parse('2026-11-21T16:14:36.000Z')
  const localized = 'November 22, 2026 12:00:00 GMT+0000'
  const inputs = [undefined, '2026-11-21T16:14:36.000Z', (base + 1000) / 1000, base + 2000,
    'invalid', base - 1000, localized]
  const { messages } = parseTransfer(jsonl(inputs.map((send_date, i) => ({ mes: String(i), send_date }))), {
    mtimeMs: base - 1000,
  }).sessions[0]
  assert.deepEqual(messages.map(m => m.createdAt), [base - 1000, base, base + 1000, base + 2000,
    base + 3000, base + 3000, Date.parse(localized)])
  assert.deepEqual(messages.map(m => m.content), inputs.map((_, i) => String(i)))
})

test('admits 20,000 messages; rejects overflow and reports actual counts and UTF-8 bytes', () => {
  const line = '{"mes":""}\n'
  const prefix = jsonl([]) + '\n'
  assert.equal(parseTransfer(prefix + line.repeat(MAX_TRANSFER_MESSAGES)).sessions[0].messages.length, 20_000)
  assert.throws(() => parseTransfer(prefix + line.repeat(MAX_TRANSFER_MESSAGES + 1)), /20001.*20000/)
  assert.throws(() => parseTransfer(prefix + line.repeat(MAX_TRANSFER_MESSAGES + 2)), /20002.*20000/)
  const full = prefix + ' '.repeat(MAX_TRANSFER_BYTES - Buffer.byteLength(prefix))
  assert.equal(parseTransfer(full).format, 'st')
  assert.throws(() => parseTransfer('界'.repeat(Math.floor(MAX_TRANSFER_BYTES / 3) + 1)), /67108866.*67108864/)
})

// Real user data is read solely for aggregate checks, with no text or file-name output.
const sample = process.env.NC_TRANSFER_ST_SAMPLE
if (sample) {
  test('parses the selected real ST sample read-only', () => {
    const mtimeMs = statSync(sample).mtimeMs
    const bytes = readFileSync(sample)
    const text = bytes.toString('utf8')
    const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
    const sha256Before = sha256(bytes)
    const parsed = parseTransfer(text, { mtimeMs })
    const sha256After = sha256(readFileSync(sample))
    assert.equal(sha256After, sha256Before)
    const counts = { user: 0, assistant: 0, system: 0, narration: 0 }
    const messages = parsed.sessions[0].messages
    for (const msg of messages) counts[msg.role]++
    assert.equal(parsed.skippedLines, 0)
    assert.equal(messages.every((m, i) => !i || m.createdAt >= messages[i - 1].createdAt), true)
    if (process.env.NC_TRANSFER_ST_EXPECT_53 === '1') {
      assert.deepEqual(counts, { user: 26, assistant: 27, system: 0, narration: 0 })
    }
    console.log('Real ST sample:', JSON.stringify({
      ...(process.env.NC_TRANSFER_ST_AUDIT === '1' ? { path: sample, sha256Before, sha256After,
        lines: (text.match(/\n/g) ?? []).length + Number(!text.endsWith('\n')) } : {}),
      messages: messages.length, roleCounts: counts, skippedLines: parsed.skippedLines,
      discardedFields: parsed.discardedFields,
    }))
  })
}
