import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

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

const placeholders = ['unused', 'UNUSED', ' unknown ', 'null', 'undefined', 'n/a', 'na', 'none', '-', '—', 'character', '角色', 'assistant']
const namedStem = '示例角色？ 1.0'
const datedStem = namedStem + ' - 2026-11-21@11h07m3'

test('Y-01..04: title fallback strips ST suffixes and rejects every placeholder', () => {
  for (const character_name of placeholders) {
    const result = parseTransfer(JSON.stringify({ ...header, character_name }), { fallbackTitle: datedStem })
    assert.equal(result.title, namedStem)
    assert.equal(result.sessions[0].title, namedStem)
    assert.equal(result.characterName, character_name.trim(), '原始名字仍保留供诊断')
    assert.equal(parseTransfer(JSON.stringify({ ...header, character_name })).title, '导入的对话')
  }
  assert.equal(parseTransfer(JSON.stringify({ ...header, character_name: ' 示例角色 ' }), { fallbackTitle: datedStem }).title, '示例角色')
  for (const fallbackTitle of [undefined, '', ' ', 'unused', ' - 2026-11-21@11h07m3']) {
    assert.equal(parseTransfer('{"chat_metadata":{}}', { fallbackTitle }).title, '导入的对话')
  }
  assert.equal(parseTransfer('{"chat_metadata":{}}', { fallbackTitle: namedStem + ' - yesterday@11:07:03 imported' }).title, namedStem)
  assert.equal(parseTransfer('{"chat_metadata":{}}', { fallbackTitle: '通信 - user@example.com' }).title, '通信 - user@example.com')
})

test('Y-04: real preview shares title normalization and never matches placeholder names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nc-transfer-title-'))
  try {
    installElectronStub(dir)
    const { dialog } = createRequire(import.meta.url)('electron')
    let selected
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    const { transferService, promptStore } = await bundleModule('transfer-title-preview', [
      'export { transferService } from ' + JSON.stringify(p('src/main/features/transfer/service.ts')),
      'export { promptStore } from ' + JSON.stringify(p('src/main/features/prompt/promptStore.ts')),
    ].join('\n'))
    const originalLibrary = promptStore.library
    promptStore.library = () => ({ characters: [
      { id: 'placeholder', name: 'unused' }, { id: 'real', name: namedStem }, { id: 'header', name: '正常头行' },
    ] })
    try {
      for (const character_name of placeholders) {
        selected = join(dir, 'unused.jsonl')
        writeFileSync(selected, JSON.stringify({ ...header, character_name }))
        const preview = await transferService.pickImport()
        assert.equal(preview.title, '导入的对话')
        assert.equal(preview.characterMatched, false)
      }
      selected = join(dir, datedStem + '.jsonl')
      writeFileSync(selected, JSON.stringify({ ...header, character_name: 'unused' }))
      const matched = await transferService.pickImport()
      assert.equal(matched.title, namedStem)
      assert.equal(matched.characterMatched, true)
      assert.equal(matched.suggestedCharacterId, 'real')
      writeFileSync(selected, JSON.stringify({ ...header, character_name: '正常头行' }))
      const preferred = await transferService.pickImport()
      assert.equal(preferred.title, '正常头行')
      assert.equal(preferred.suggestedCharacterId, 'header')
    } finally { promptStore.library = originalLibrary }
  } finally { rmSync(dir, { recursive: true, force: true }) }
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
    const fallbackTitle = basename(sample).replace(/\.jsonl$/i, '')
    const parsed = parseTransfer(text, { mtimeMs, fallbackTitle })
    const sha256After = sha256(readFileSync(sample))
    assert.equal(sha256After, sha256Before)
    const counts = { user: 0, assistant: 0, system: 0, narration: 0 }
    const messages = parsed.sessions[0].messages
    for (const msg of messages) counts[msg.role]++
    assert.equal(parsed.skippedLines, 0)
    assert.equal(messages.every((m, i) => !i || m.createdAt >= messages[i - 1].createdAt), true)
    if (process.env.NC_TRANSFER_ST_EXPECT_53 === '1') {
      assert.equal(parsed.title, fallbackTitle.replace(/ - \d{4}-\d{2}-\d{2}@.*$/, ''))
      assert.notEqual(parsed.title.toLowerCase(), 'unused')
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
