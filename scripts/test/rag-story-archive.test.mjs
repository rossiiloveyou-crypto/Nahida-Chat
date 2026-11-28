/** P4.7 pure functions. Run: node scripts/test/rag-story-archive.test.mjs */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-archive-'))
installElectronStub(userData)
const { check, done } = createChecker()
const { splitRounds, sliceRound, contentVersion, StoryArchiveService, MemoryStore,
  storyArchiveStore, storyMemory, closeAllStoryMemory, branchStore, STORY_CHUNK_CHARS, STORY_CHUNK_OVERLAP } =
  await bundleModule('rag-story-archive', [
    "export { splitRounds, sliceRound, contentVersion, StoryArchiveService } from '" + p('src/main/features/rag/storyArchive.ts') + "'",
    "export { MemoryStore } from '" + p('src/main/features/rag/store.ts') + "'",
    "export { storyArchiveStore, storyMemory, closeAllStoryMemory } from '" + p('src/main/features/story/memory.ts') + "'",
    "export { branchStore } from '" + p('src/main/features/story/branches.ts') + "'",
    "export { STORY_CHUNK_CHARS, STORY_CHUNK_OVERLAP } from '" + p('src/shared/constants.ts') + "'"
  ].join('\n'))

function test(label, run) {
  try { run(); check(label, true) } catch (error) { check(label, false, error.message) }
}
function msg(role, content = role, id = role, extra = {}) {
  return { id, role, content, createdAt: 1700000000000, status: 'done', ...extra }
}
function messages(roles) { return roles.map((role, i) => msg(role, role, String(i))) }
const labels = { narration: '【旁白】', user: '【用户】', assistant: '【角色】', system: '【系统】' }
function original(round) {
  return round.messages.map((message) => labels[message.role] + message.content).join('\n')
}
function splitAtPair(text, offset) {
  return /[\uD800-\uDBFF]/.test(text[offset - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')
}
function validate(round) {
  const text = original(round)
  const chunks = sliceRound(round)
  if (!round.messages.length) { assert.deepEqual(chunks, []); return chunks }
  assert.ok(chunks.length > 0)
  assert.equal(chunks[0].startOffset, 0)
  assert.equal(chunks.at(-1).endOffset, text.length)
  let rebuilt = ''
  let covered = 0
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.index, i)
    assert.ok(Number.isInteger(chunk.startOffset) && Number.isInteger(chunk.endOffset))
    assert.ok(chunk.startOffset >= 0 && chunk.endOffset <= text.length)
    assert.ok(chunk.startOffset < chunk.endOffset)
    assert.ok(chunk.text.length <= 1200)
    assert.equal(chunk.text.length, chunk.endOffset - chunk.startOffset)
    assert.equal(chunk.text, text.slice(chunk.startOffset, chunk.endOffset))
    assert.ok(!splitAtPair(text, chunk.startOffset), 'start splits a surrogate pair')
    assert.ok(!splitAtPair(text, chunk.endOffset), 'end splits a surrogate pair')
    assert.ok(chunk.startOffset <= covered, 'gap')
    assert.ok(chunk.endOffset > covered, 'chunk makes no progress')
    if (i > 0) {
      const prev = chunks[i - 1]
      const overlap = prev.endOffset - chunk.startOffset
      assert.ok([0, 160, 161].includes(overlap), 'unexpected overlap: ' + overlap)
      if (overlap) assert.equal(prev.text.slice(-overlap), chunk.text.slice(0, overlap))
      if (overlap === 161) assert.ok(splitAtPair(text, chunk.startOffset + 1))
    }
    rebuilt += chunk.text.slice(covered - chunk.startOffset)
    covered = chunk.endOffset
  })
  assert.equal(rebuilt, text, 'reconstruction must preserve every UTF-16 code unit')
  return chunks
}
function one(content, role = 'assistant') { return { index: 0, messages: [msg(role, content)] } }
function expectRounds(roles, groups, tail = []) {
  const input = messages(roles)
  const actual = splitRounds(input)
  assert.deepEqual(actual.rounds.map((round) => round.messages.map((message) => message.id)), groups)
  assert.deepEqual(actual.trailing.map((message) => message.id), tail)
  assert.deepEqual(actual.rounds.map((round) => round.index), groups.map((_, i) => i))
}

test('shared chunk constants = 1200 / 160', () => {
  assert.equal(STORY_CHUNK_CHARS, 1200); assert.equal(STORY_CHUNK_OVERLAP, 160)
})
test('A-01 narration,user,assistant,user,assistant = 3+2', () => {
  expectRounds(['narration', 'user', 'assistant', 'user', 'assistant'], [['0', '1', '2'], ['3', '4']])
})
test('A-02 leading narrations belong to first round', () => {
  expectRounds(['narration', 'narration', 'user', 'assistant'], [['0', '1', '2', '3']])
})
test('A-03 consecutive users form one round', () => {
  expectRounds(['user', 'user', 'user', 'assistant'], [['0', '1', '2', '3']])
})
test('A-04 adjacent assistants merge into preceding round', () => {
  expectRounds(['user', 'assistant', 'assistant'], [['0', '1', '2']])
})
test('A-05 trailing user remains outside complete rounds', () => {
  expectRounds(['user', 'assistant', 'user'], [['0', '1']], ['2'])
})
test('empty input has no rounds or trailing', () => assert.deepEqual(splitRounds([]), { rounds: [], trailing: [] }))
test('only non-assistants all remain trailing', () => {
  expectRounds(['system', 'narration', 'user'], [], ['0', '1', '2'])
})
test('assistant-only run is one round', () => expectRounds(['assistant', 'assistant', 'assistant'], [['0', '1', '2']]))
test('narration separates adjacent assistant runs', () => {
  expectRounds(['assistant', 'assistant', 'narration', 'assistant', 'assistant', 'user'], [['0', '1'], ['2', '3', '4']], ['5'])
})
test('status filtering is deliberately left to the scheduler', () => {
  for (const status of ['done', 'streaming', 'error']) {
    const input = [msg('user'), msg('assistant', 'reply', 'a', { status })]
    assert.deepEqual(splitRounds(input).rounds[0].messages, input)
    assert.equal(original({ messages: input }), sliceRound({ index: 0, messages: input })[0].text)
  }
})
test('split arrays are independent; original messages retain identity', () => {
  const input = messages(['user', 'assistant', 'assistant', 'user'])
  const result = splitRounds(input)
  assert.notEqual(result.rounds[0].messages, input)
  assert.notEqual(result.trailing, input)
  assert.equal(result.rounds[0].messages[2], input[2])
  result.rounds[0].messages.pop(); result.trailing.pop()
  assert.equal(input.length, 4)
})
test('empty round yields no chunks', () => validate({ index: 8, messages: [] }))
test('all role labels, empty bodies, whitespace and separators are exact', () => {
  const round = { index: 9, messages: [msg('system', ''), msg('narration', '  原文\r\n'), msg('user', '\t问\n'), msg('assistant', '答  ')] }
  assert.equal(validate(round)[0].text, '【系统】\n【旁白】  原文\r\n\n【用户】\t问\n\n【角色】答  ')
})
test('A-06 3000-character message = >=3 bounded chunks and exact 160 overlap', () => {
  const chunks = validate(one('甲'.repeat(3000)))
  assert.ok(chunks.length >= 3)
  assert.deepEqual(chunks.map((chunk) => [chunk.startOffset, chunk.endOffset]), [[0, 1200], [1040, 2240], [2080, 3004]])
})
for (const punctuation of ['。', '！', '？', '…', '；', '\n']) {
  test('A-07 last sentence boundary retained: ' + JSON.stringify(punctuation), () => {
    const chunks = validate(one('甲'.repeat(1095) + punctuation + '乙'.repeat(2000)))
    assert.equal(chunks[0].endOffset, 1100)
    assert.equal(chunks[0].text.at(-1), punctuation)
    assert.equal(chunks[1].startOffset, 940)
  })
}
test('last sentence end in window wins over earlier ones', () => {
  const chunks = validate(one('甲'.repeat(795) + '。' + '乙'.repeat(299) + '！' + '丙'.repeat(1700)))
  assert.equal(chunks[0].endOffset, 1100)
})
for (const boundary of [799, 800, 1200, 1201]) {
  test('sentence search window boundary ' + boundary, () => {
    const chunks = validate(one('甲'.repeat(boundary - 5) + '。' + '乙'.repeat(2000)))
    assert.equal(chunks[0].endOffset, boundary >= 800 && boundary <= 1200 ? boundary : 1200)
  })
}
test('short total text retains one chunk', () => assert.equal(validate({ index: 0, messages: messages(['user', 'assistant']) }).length, 1))
test('overflow chooses whole-message boundary even if sentence boundary fits', () => {
  const round = { index: 0, messages: [msg('user', '甲'.repeat(696)), msg('assistant', '乙'.repeat(700))] }
  const chunks = validate(round)
  assert.deepEqual(chunks.map((chunk) => [chunk.startOffset, chunk.endOffset]), [[0, 701], [701, 1405]])
  assert.equal(chunks[1].text, '【角色】' + '乙'.repeat(700))
})
test('message exactly 1200 chars stays whole after another message', () => {
  const round = { index: 0, messages: [msg('user', '问'), msg('assistant', '甲'.repeat(1196))] }
  assert.deepEqual(validate(round).map((chunk) => chunk.text), ['【用户】问\n', '【角色】' + '甲'.repeat(1196)])
})
test('exactly full preceding message preserves newline without splitting next body', () => {
  const round = { index: 0, messages: [msg('user', '甲'.repeat(1196)), msg('assistant', '答')] }
  assert.deepEqual(validate(round).map((chunk) => chunk.text), ['【用户】' + '甲'.repeat(1196), '\n【角色】答'])
})
test('long message between short messages reconstructs and overlaps only within it', () => {
  const round = { index: 0, messages: [msg('narration', '开场'), msg('user', '甲'.repeat(4000)), msg('assistant', '收尾')] }
  const chunks = validate(round)
  assert.equal(chunks[0].text, '【旁白】开场\n')
  assert.equal(chunks[1].startOffset, chunks[0].endOffset)
  assert.ok(chunks.at(-1).text.endsWith('\n【角色】收尾'))
})
test('hard boundary protects astral pair at positions 1199/1200', () => {
  const chunks = validate(one('甲'.repeat(1195) + '😀' + '乙'.repeat(2500)))
  assert.equal(chunks[0].endOffset, 1199)
  assert.ok(chunks[1].text.includes('😀'))
})
test('overlap boundary protects astral pair by expanding 160 to 161', () => {
  const chunks = validate(one('甲'.repeat(1035) + '😀' + '乙'.repeat(2500)))
  assert.equal(chunks[0].endOffset, 1200)
  assert.equal(chunks[1].startOffset, 1039)
  assert.equal(chunks[0].endOffset - chunks[1].startOffset, 161)
})
test('emoji, ZWJ, combining marks and CRLF remain byte-for-code-unit exact', () => {
  validate(one('😀👩‍👩‍👧‍👦e\u0301\r\n中文'.repeat(450)))
})
test('existing lone surrogates are preserved rather than replaced', () => {
  validate(one(('甲\ud800乙\udc00').repeat(900)))
})
test('pure operations accept deeply frozen inputs without mutation', () => {
  const input = Object.freeze([
    Object.freeze(msg('narration', ' 原文\n')),
    Object.freeze(msg('user', '甲'.repeat(3000))),
    Object.freeze(msg('assistant', '😀'.repeat(1800))),
    Object.freeze(msg('assistant', '继续')),
    Object.freeze(msg('user', ' trailing '))
  ])
  const before = JSON.stringify(input)
  const result = splitRounds(input)
  for (const round of result.rounds) {
    Object.freeze(round.messages); Object.freeze(round)
    validate(round); contentVersion(round.messages)
  }
  assert.equal(JSON.stringify(input), before)
})
test('chunk indices start at zero independently of round index', () => {
  assert.deepEqual(sliceRound({ index: 99, messages: [msg('user', '短')] })[0], { index: 0, text: '【用户】短', startOffset: 0, endOffset: 5 })
})
test('version is deterministic 64-character lowercase SHA256', () => {
  const input = messages(['user', 'assistant'])
  assert.match(contentVersion(input), /^[0-9a-f]{64}$/)
  assert.equal(contentVersion(input), contentVersion(structuredClone(input)))
  assert.equal(contentVersion([]), createHash('sha256').digest('hex'))
})
for (const [field, changed] of Object.entries({ id: 'edited-id', role: 'narration', content: 'edited content', createdAt: 42, status: 'error' })) {
  test('version includes ' + field, () => {
    const input = [msg('assistant', 'original', 'id')]
    assert.notEqual(contentVersion(input), contentVersion([{ ...input[0], [field]: changed }]))
  })
}
test('version includes every message, count and order', () => {
  const input = messages(['user', 'assistant'])
  assert.notEqual(contentVersion(input), contentVersion(input.toReversed()))
  assert.notEqual(contentVersion(input), contentVersion([...input, input[1]]))
  assert.notEqual(contentVersion(input), contentVersion([{ ...input[0], content: 'changed' }, input[1]]))
})
test('version tuples are delimiter-safe, preserving NUL and newline', () => {
  assert.notEqual(contentVersion([msg('user', 'b:c\n', 'a')]), contentVersion([msg('user', 'c\n', 'a:b')]))
  assert.notEqual(contentVersion([msg('user', '\ud800')]), contentVersion([msg('user', '\ud801')]))
  assert.notEqual(contentVersion([msg('user', '\u0000')]), contentVersion([msg('user', '')]))
})
test('unrelated display metadata does not change version', () => {
  const input = msg('assistant')
  assert.equal(contentVersion([input]), contentVersion([{ ...input, reasoning: 'private', warnings: ['display'], toolCalls: [] }]))
})
test('boundary sweep: 0..2500 content units around exact limits', () => {
  for (const size of [0, 1, 795, 796, 799, 800, 1035, 1036, 1194, 1195, 1196, 1197, 1199, 1200, 1201, 2236, 2396, 2500]) {
    for (const prefix of ['', '😀', 'x😀']) {
      const round = { index: 0, messages: [msg('narration', prefix), msg('assistant', '甲'.repeat(size) + '😀'), msg('user', ' 尾\n')] }
      validate(round)
      assert.equal(JSON.stringify(sliceRound(round)), JSON.stringify(sliceRound(round)))
    }
  }
})
test('deterministic mixed-message corpus: 120 full reconstructions', () => {
  let state = 47
  const random = (max) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max }
  const tokens = ['甲', '😀', '。', '！', '？', '…', '；', '\n', '\r', ' ', '\t', 'e\u0301', '👩‍💻']
  for (let sample = 0; sample < 120; sample += 1) {
    const input = Array.from({ length: 1 + random(6) }, (_, i) => {
      const token = tokens[random(tokens.length)]
      return msg(['narration', 'user', 'assistant', 'system'][random(4)], token.repeat(random(3000)), String(i))
    })
    const before = JSON.stringify(input)
    validate({ index: sample, messages: input })
    assert.equal(JSON.stringify(input), before)
  }
})
test('exhaustive role sequences through length six preserve partition and maximal assistant runs', () => {
  const roles = ['narration', 'user', 'assistant', 'system']
  for (let length = 0; length <= 6; length += 1) {
    for (let pattern = 0; pattern < 4 ** length; pattern += 1) {
      let value = pattern
      const input = Array.from({ length }, (_, i) => { const role = roles[value % 4]; value = Math.floor(value / 4); return msg(role, '', String(i)) })
      const result = splitRounds(input)
      assert.deepEqual([...result.rounds.flatMap((round) => round.messages), ...result.trailing], input)
      const ends = input.filter((message, i) => message.role === 'assistant' && input[i + 1]?.role !== 'assistant')
      assert.deepEqual(result.rounds.map((round) => round.messages.at(-1)), ends)
      assert.ok(result.trailing.every((message) => message.role !== 'assistant'))
      assert.deepEqual(result.rounds.map((round) => round.index), result.rounds.map((_, i) => i))
    }
  }
})

// Integration: real SQLite files, actual MemoryStore and StoryArchiveService from the same bundle.
let fixtureNumber = 0
const tenant = { userId: 'archive-user', personaId: 'archive-persona' }
function fixture() {
  const file = path.join(userData, 'sqlite-' + (++fixtureNumber) + '.db')
  return { file, store: new MemoryStore(file) }
}
function sql(file, run) {
  const db = new DatabaseSync(file)
  try { return run(db) } finally { db.close() }
}
function rows(file, table) {
  assert.ok(['story_rounds', 'story_chunks', 'memories'].includes(table))
  return sql(file, (db) => db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all())
}
function inputFor(round, extra = {}) {
  return { storyId: 'story_fixture_abcdef', branchId: 'branch-a', roundIndex: round.index,
    tenantUser: tenant.userId, tenantPersona: tenant.personaId,
    firstMessageId: round.messages[0].id, lastMessageId: round.messages.at(-1).id,
    contentVersion: contentVersion(round.messages), roles: round.messages.map((message) => message.role),
    startedAt: round.messages[0].createdAt, chunks: sliceRound(round), ...extra }
}
function session(id, body = messages(['user', 'assistant']), storyId = 'story_service_abcdef') {
  return { id, storyId, messages: body }
}
async function settle() {
  // Each archived round yields setImmediate; these fixtures contain at most eight queued rounds.
  for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve))
}
async function asyncTest(label, run) {
  try { await run(); check(label, true) } catch (error) { check(label, false, error.stack) }
}
function withStore(run) {
  const current = fixture()
  try { return run(current.store, current.file) } finally { current.store.close() }
}

console.log('真实 SQLite / 调度集成')
test('A-08 same version is a strict no-op preserving embedding and both timestamps', () => withStore((store, file) => {
  const round = one('甲'.repeat(3000))
  const input = inputFor(round)
  assert.equal(store.upsertStoryRound(input), true)
  const stored = store.getStoryRound(input.storyId, input.branchId, 0)
  assert.equal(stored.id, input.storyId + ':' + input.branchId + ':0')
  assert.equal(stored.first_message_id, round.messages[0].id)
  assert.equal(stored.last_message_id, round.messages.at(-1).id)
  assert.deepEqual(JSON.parse(stored.roles), ['assistant'])
  assert.equal(stored.tenant_user, tenant.userId)
  assert.equal(stored.tenant_persona, tenant.personaId)
  assert.equal(stored.started_at, round.messages[0].createdAt)
  assert.equal(stored.valid, 1)
  sql(file, (db) => {
    db.prepare('UPDATE story_rounds SET indexed_at = 12345 WHERE id = ?').run(stored.id)
    db.prepare('UPDATE story_chunks SET indexed_at = 54321, embedding = ? WHERE round_id = ?').run(new Uint8Array([1, 2, 3, 254]), stored.id)
  })
  const beforeRounds = rows(file, 'story_rounds')
  const beforeChunks = rows(file, 'story_chunks')
  assert.equal(store.upsertStoryRound(structuredClone(input)), false)
  assert.deepEqual(rows(file, 'story_rounds'), beforeRounds)
  assert.deepEqual(rows(file, 'story_chunks'), beforeChunks)
  assert.equal(store.listStoryChunks(stored.id).length, input.chunks.length)
  for (const chunk of store.listStoryChunks(stored.id)) {
    assert.equal(chunk.content_version, input.contentVersion)
    assert.deepEqual([...chunk.embedding], [1, 2, 3, 254])
  }
}))
test('A-09 changed content replaces old chunks and invalidates old embeddings', () => withStore((store, file) => {
  const input = inputFor(one('甲'.repeat(3000)))
  store.upsertStoryRound(input)
  const id = store.getStoryRound(input.storyId, input.branchId, 0).id
  sql(file, (db) => db.prepare('UPDATE story_chunks SET embedding = ?').run(new Uint8Array([8, 9])))
  const changed = inputFor(one('changed 😀 body'))
  assert.notEqual(changed.contentVersion, input.contentVersion)
  assert.equal(store.upsertStoryRound(changed), true)
  assert.equal(rows(file, 'story_rounds').length, 1)
  const chunks = store.listStoryChunks(id)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, '【角色】changed 😀 body')
  assert.equal(chunks[0].embedding, null)
  assert.equal(chunks[0].content_version, changed.contentVersion)
  assert.equal(store.getStoryRound(input.storyId, input.branchId, 0).content_version, changed.contentVersion)
}))
test('SQLite close/reopen preserves round, chunk bytes and no-op behavior', () => {
  const { store, file } = fixture()
  const input = inputFor(one('归档😀\r\n'.repeat(500)))
  let reopened
  try {
    store.upsertStoryRound(input)
    const beforeRounds = rows(file, 'story_rounds')
    const beforeChunks = rows(file, 'story_chunks')
    store.close()
    reopened = new MemoryStore(file)
    assert.deepEqual(rows(file, 'story_rounds'), beforeRounds)
    assert.equal(reopened.getStoryRound(input.storyId, input.branchId, 0).content_version, input.contentVersion)
    assert.deepEqual(reopened.listStoryChunks(beforeRounds[0].id), beforeChunks)
    assert.equal(reopened.upsertStoryRound(input), false)
    assert.deepEqual(rows(file, 'story_chunks'), beforeChunks)
  } finally { reopened?.close(); store.close() }
})
test('pre-P4.7 real database retains existing fact rows and embedding after archive schema creation', () => {
  const { store, file } = fixture()
  sql(file, (db) => {
    db.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, persona_id TEXT NOT NULL, content TEXT NOT NULL,
      seg_text TEXT NOT NULL, source_session_id TEXT, source_message_id TEXT, source_message_index INTEGER,
      weight REAL NOT NULL DEFAULT 1.0, embedding BLOB, created_at INTEGER NOT NULL,
      last_hit_at INTEGER, hit_count INTEGER NOT NULL DEFAULT 0)`)
    db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-fact', 'legacy-user', 'legacy-persona', '原有事实正文', '原有 事实 正文', 'old-session', 'old-message', 7, 1.25, new Uint8Array([0, 0, 128, 63]), 123, 456, 9)
    db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(seg_text, content='memories', content_rowid='rowid', tokenize='unicode61')")
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')")
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH '事实'").get().n, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('story_rounds','story_chunks')").get().n, 0)
  })
  try {
    const before = rows(file, 'memories')
    store.upsertStoryRound(inputFor(one('新增归档')))
    assert.deepEqual(rows(file, 'memories'), before)
    assert.equal(store.count(), 1)
    assert.equal(store.list()[0].content, '原有事实正文')
    assert.equal(sql(file, (db) => db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH '事实'").get().n), 1)
    store.close()
    const reopened = new MemoryStore(file)
    try { assert.equal(reopened.healthy(), true); assert.deepEqual(rows(file, 'memories'), before) }
    finally { reopened.close() }
  } finally { store.close() }
})
test('duplicate chunk index rolls back replacement of existing round atomically', () => withStore((store, file) => {
  const before = inputFor(one('原文'.repeat(1700)))
  store.upsertStoryRound(before)
  const beforeRounds = rows(file, 'story_rounds')
  const beforeChunks = rows(file, 'story_chunks')
  const changed = inputFor(one('新正文'))
  changed.chunks = [changed.chunks[0], { ...changed.chunks[0], text: 'duplicate' }]
  assert.throws(() => store.upsertStoryRound(changed), /UNIQUE|constraint/i)
  assert.deepEqual(rows(file, 'story_rounds'), beforeRounds)
  assert.deepEqual(rows(file, 'story_chunks'), beforeChunks)
  assert.equal(store.upsertStoryRound(inputFor(one('恢复写入'))), true)
}))
test('duplicate chunk index rolls back insertion of a new round completely', () => withStore((store, file) => {
  const input = inputFor(one('新轮'))
  input.chunks = [input.chunks[0], { ...input.chunks[0] }]
  assert.throws(() => store.upsertStoryRound(input), /UNIQUE|constraint/i)
  assert.equal(rows(file, 'story_rounds').length, 0)
  assert.equal(rows(file, 'story_chunks').length, 0)
}))
test('tenant mismatch does not overwrite existing archived content', () => withStore((store, file) => {
  const input = inputFor(one('属于原租户'))
  store.upsertStoryRound(input)
  const before = rows(file, 'story_rounds')
  assert.throws(() => store.upsertStoryRound({ ...input, tenantUser: 'another-user' }), /租户/)
  assert.deepEqual(rows(file, 'story_rounds'), before)
}))
await asyncTest('A-12 missing branch/story/tenant never opens a store or creates a database', async () => {
  let calls = 0
  const service = new StoryArchiveService(() => { calls += 1; throw new Error('must remain unopened') })
  for (const id of ['', '   ', undefined]) service.schedule(session(id), { storyId: 'story_service_abcdef' }, tenant)
  service.schedule(session('b'), { storyId: null }, tenant)
  service.schedule(session('b'), { storyId: 'story_mismatch_abcdef' }, tenant)
  service.schedule(session('b'), { storyId: 'story_service_abcdef' }, { ...tenant, userId: '' })
  service.schedule(session('b'), { storyId: 'story_service_abcdef' }, { ...tenant, personaId: ' ' })
  const realStory = 'story_missing_abcdef'
  new StoryArchiveService().schedule(session('', undefined, realStory), { storyId: realStory }, tenant)
  assert.equal(calls, 0)
  await settle()
  assert.equal(calls, 0)
  assert.equal(fs.existsSync(path.join(userData, 'stories', realStory)), false)
})
await asyncTest('schedule defers opening SQLite until after caller returns', async () => {
  const { store, file } = fixture()
  let calls = 0
  try {
    const service = new StoryArchiveService(() => { calls += 1; return store })
    assert.equal(service.schedule(session('branch-defer'), { storyId: 'story_service_abcdef' }, tenant), undefined)
    assert.equal(calls, 0)
    assert.equal(fs.existsSync(file), false)
    await settle()
    assert.equal(calls, 1)
    assert.equal(rows(file, 'story_rounds').length, 1)
  } finally { store.close() }
})
await asyncTest('historical backfill archives every completed round and leaves trailing outside SQLite', async () => {
  const { store, file } = fixture()
  try {
    const body = messages(['narration', 'narration', 'user', 'assistant', 'user', 'assistant', 'assistant', 'narration', 'user'])
    body[0].createdAt = 77
    body[7].content = 'TRAILING_NARRATION_ONLY'
    body[8].content = 'TRAILING_USER_ONLY'
    const before = JSON.stringify(body)
    const service = new StoryArchiveService(() => store)
    service.schedule(session('history', body), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    const saved = rows(file, 'story_rounds')
    assert.equal(saved.length, 2)
    assert.deepEqual(saved.map((round) => round.round_index), [0, 1])
    assert.equal(saved[0].first_message_id, '0'); assert.equal(saved[0].last_message_id, '3')
    assert.equal(saved[1].first_message_id, '4'); assert.equal(saved[1].last_message_id, '6')
    assert.equal(saved[0].started_at, 77)
    assert.deepEqual(JSON.parse(saved[0].roles), ['narration', 'narration', 'user', 'assistant'])
    assert.deepEqual(JSON.parse(saved[1].roles), ['user', 'assistant', 'assistant'])
    for (const round of splitRounds(body).rounds) {
      const stored = saved[round.index]
      assert.equal(stored.content_version, contentVersion(round.messages))
      assert.deepEqual(store.listStoryChunks(stored.id).map((chunk) => chunk.text), sliceRound(round).map((chunk) => chunk.text))
    }
    assert.equal(JSON.stringify(body), before)
    assert.ok(rows(file, 'story_chunks').every((chunk) => !chunk.text.includes('TRAILING_')))
  } finally { store.close() }
})
await asyncTest('error/streaming rounds stay excluded while later complete rounds retain stable indices', async () => {
  const { store, file } = fixture()
  try {
    const body = messages(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'assistant'])
    body[1].status = 'error'; body[3].status = 'streaming'; body[7].status = 'error'
    new StoryArchiveService(() => store).schedule(session('status', body), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    const saved = rows(file, 'story_rounds')
    assert.deepEqual(saved.map((round) => round.round_index), [2])
    assert.equal(saved[0].last_message_id, '5')
    assert.equal(store.getStoryRound('story_service_abcdef', 'status', 0), null)
    assert.equal(store.getStoryRound('story_service_abcdef', 'status', 1), null)
    assert.equal(store.getStoryRound('story_service_abcdef', 'status', 3), null)
  } finally { store.close() }
})
await asyncTest('trailing-only and failed-only sessions never ask for a store', async () => {
  let calls = 0
  const service = new StoryArchiveService(() => { calls += 1; throw new Error('unexpected open') })
  service.schedule(session('trailing', messages(['narration', 'user'])), { storyId: 'story_service_abcdef' }, tenant)
  service.schedule(session('failed', [msg('assistant', '', 'bad', { status: 'error' })]), { storyId: 'story_service_abcdef' }, tenant)
  await settle(); assert.equal(calls, 0)
})
await asyncTest('same-story concurrent branch snapshots all persist, including enqueue during write', async () => {
  const { store, file } = fixture()
  try {
    let service
    let injected = false
    const wrapped = { upsertStoryRound(input) {
      if (!injected) {
        injected = true
        service.schedule(session('branch-c'), { storyId: 'story_service_abcdef' }, tenant)
      }
      return store.upsertStoryRound(input)
    } }
    service = new StoryArchiveService(() => wrapped)
    service.schedule(session('branch-a'), { storyId: 'story_service_abcdef' }, tenant)
    service.schedule(session('branch-b'), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    assert.deepEqual(rows(file, 'story_rounds').map((round) => round.branch_id).sort(), ['branch-a', 'branch-b', 'branch-c'])
    assert.equal(rows(file, 'story_chunks').length, 3)
  } finally { store.close() }
})
await asyncTest('same-branch coalescing retains latest history rather than dropping the new round', async () => {
  const { store, file } = fixture()
  try {
    const service = new StoryArchiveService(() => store)
    service.schedule(session('latest'), { storyId: 'story_service_abcdef' }, tenant)
    service.schedule(session('latest', messages(['user', 'assistant', 'user', 'assistant'])), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    assert.equal(rows(file, 'story_rounds').length, 2)
    assert.equal(store.getStoryRound('story_service_abcdef', 'latest', 1).last_message_id, '3')
  } finally { store.close() }
})
await asyncTest('mutated live history discards stale snapshot and next schedule rebuilds with isolated tenant', async () => {
  const { store } = fixture()
  try {
    const service = new StoryArchiveService(() => store)
    const body = messages(['user', 'assistant'])
    const expectedVersion = contentVersion(body)
    const mutableTenant = { ...tenant }
    const mutable = session('snapshot', body)
    service.schedule(mutable, { storyId: mutable.storyId }, mutableTenant)
    body[1].content = 'mutated'; body.push(msg('user', 'new', 'next')); mutableTenant.personaId = 'mutated'
    await settle()
    assert.equal(store.getStoryRound(mutable.storyId, 'snapshot', 0), null)
    const rebuildTenant = { ...tenant }
    service.schedule(mutable, { storyId: mutable.storyId }, rebuildTenant)
    rebuildTenant.personaId = 'mutated-after-schedule'
    await settle()
    const saved = store.getStoryRound(mutable.storyId, 'snapshot', 0)
    assert.notEqual(saved.content_version, expectedVersion)
    assert.equal(saved.content_version, contentVersion(splitRounds(mutable.messages).rounds[0].messages))
    assert.equal(saved.tenant_persona, tenant.personaId)
    assert.ok(store.listStoryChunks(saved.id)[0].text.includes('mutated'))
  } finally { store.close() }
})
await asyncTest('write throw logs once, stays nonthrowing, and next schedule retries historical round', async () => {
  const { store, file } = fixture()
  const warnings = []
  const previousWarn = console.warn
  let failed = false
  console.warn = (...args) => warnings.push(args)
  try {
    const service = new StoryArchiveService(() => ({ upsertStoryRound(input) {
      if (!failed) { failed = true; throw new Error('fixture write failure') }
      return store.upsertStoryRound(input)
    } }))
    assert.doesNotThrow(() => service.schedule(session('retry'), { storyId: 'story_service_abcdef' }, tenant))
    await settle()
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0][0]), /story-archive/)
    assert.match(String(warnings[0][1]), /fixture write failure/)
    service.schedule(session('retry', messages(['user', 'assistant', 'user', 'assistant'])), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    assert.equal(warnings.length, 1)
    assert.equal(rows(file, 'story_rounds').length, 2)
    assert.equal(store.getStoryRound('story_service_abcdef', 'retry', 0).last_message_id, '1')
    assert.equal(store.getStoryRound('story_service_abcdef', 'retry', 1).last_message_id, '3')
  } finally { console.warn = previousWarn; store.close() }
})
await asyncTest('real service rearchive is no-op and edited reply replaces derived chunks', async () => {
  const { store, file } = fixture()
  try {
    const service = new StoryArchiveService(() => store)
    const body = messages(['user', 'assistant'])
    service.schedule(session('service-idempotent', body), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    sql(file, (db) => { db.exec('UPDATE story_rounds SET indexed_at=123'); db.exec("UPDATE story_chunks SET indexed_at=456, embedding=X'2728'") })
    const beforeRounds = rows(file, 'story_rounds'); const beforeChunks = rows(file, 'story_chunks')
    service.schedule(session('service-idempotent', body), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    assert.deepEqual(rows(file, 'story_rounds'), beforeRounds)
    assert.deepEqual(rows(file, 'story_chunks'), beforeChunks)
    body[1].content = 'edited'.repeat(600)
    service.schedule(session('service-idempotent', body), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    assert.equal(rows(file, 'story_rounds').length, 1)
    assert.notEqual(rows(file, 'story_rounds')[0].content_version, beforeRounds[0].content_version)
    assert.ok(rows(file, 'story_chunks').length > 1)
    assert.ok(rows(file, 'story_chunks').every((chunk) => chunk.embedding === null))
  } finally { store.close() }
})
await asyncTest('storyMemory and archive reuse one store; cache close/reopen retains SQLite data', async () => {
  const storyId = 'story_cache_abcdef'
  const cached = storyMemory(storyId)
  const store = storyArchiveStore(storyId)
  assert.equal(storyMemory(storyId), cached)
  assert.equal(storyArchiveStore(storyId), store)
  assert.equal(cached.store, store)
  const fact = store.upsert({ userId: tenant.userId, personaId: tenant.personaId, content: '保留的事实记忆' })
  assert.ok(fact)
  new StoryArchiveService().schedule(session('cache-branch', undefined, storyId), { storyId }, tenant)
  await settle()
  assert.equal(store.count(), 1)
  const before = store.getStoryRound(storyId, 'cache-branch', 0)
  assert.ok(before)
  closeAllStoryMemory()
  const reopened = storyArchiveStore(storyId)
  assert.notEqual(reopened, store)
  assert.equal(reopened.count(), 1)
  assert.equal(reopened.list()[0].content, '保留的事实记忆')
  assert.deepEqual(reopened.getStoryRound(storyId, 'cache-branch', 0), before)
  assert.equal(reopened.listStoryChunks(before.id).length, 1)
  closeAllStoryMemory()
})

// Review regressions exercise the real persistence seams, not a second implementation.
test('SQLite preserves lone surrogates and NUL via lossless exceptional storage', () => withStore((store, file) => {
  const round = one('a\ud800b\udc00c\0tail😀'.repeat(400))
  const input = inputFor(round)
  store.upsertStoryRound(input)
  const chunks = store.listStoryChunks(input.storyId + ':' + input.branchId + ':0')
  let rebuilt = ''; let end = 0
  for (const chunk of chunks) { rebuilt += chunk.text.slice(Math.max(0, end - chunk.start_offset)); end = chunk.end_offset }
  assert.equal(rebuilt, original(round))
  assert.ok(sql(file, db => db.prepare("SELECT COUNT(*) n FROM story_chunks WHERE typeof(text)='blob'").get()).n > 0)
}))
await asyncTest('archive retries same MemoryStore after transient database-open failure', async () => {
  const blocker = path.join(userData, 'temporary-parent')
  fs.writeFileSync(blocker, 'blocked')
  const store = new MemoryStore(path.join(blocker, 'memory.db'))
  const service = new StoryArchiveService(() => store)
  const warn = console.warn; const error = console.error
  const warnings = []
  console.warn = (...args) => warnings.push(args); console.error = () => {}
  try {
    service.schedule(session('open-retry'), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    assert.equal(warnings.length, 1)
    fs.rmSync(blocker); fs.mkdirSync(blocker)
    service.schedule(session('open-retry'), { storyId: 'story_service_abcdef' }, tenant)
    await settle()
    assert.ok(store.getStoryRound('story_service_abcdef', 'open-retry', 0))
    assert.equal(warnings.length, 1)
  } finally { console.warn = warn; console.error = error; store.close() }
})
await asyncTest('persona switch preserves old round owner and archives new round under current owner', async () => {
  const {store} = fixture()
  try {
    const service = new StoryArchiveService(() => store)
    const first = session('persona-switch')
    service.schedule(first, { storyId:first.storyId }, tenant); await settle()
    const second = session(first.id, [...first.messages, ...messages(['user','assistant']).map(m=>({...m,id:'next-'+m.id}))])
    service.schedule(second, { storyId:second.storyId }, {...tenant,personaId:'other-persona'}); await settle()
    assert.equal(store.getStoryRound(first.storyId, first.id, 0).tenant_persona, tenant.personaId)
    assert.equal(store.getStoryRound(first.storyId, first.id, 1).tenant_persona, 'other-persona')
  } finally {store.close()}
})
await asyncTest('abort receipt survives reopen and retry success can replace the interrupted version', async () => {
  const {store,file}=fixture(); const first=session('aborted-history')
  new StoryArchiveService(()=>store).schedule(first,{storyId:first.storyId},tenant,{messageId:first.messages.at(-1).id,interrupted:true})
  await settle()
  assert.equal(rows(file,'story_rounds').length,0)
  store.close()
  const reopened=new MemoryStore(file)
  try {
    const next=session(first.id,[...first.messages,...messages(['user','assistant']).map(m=>({...m,id:'next-'+m.id}))])
    const service=new StoryArchiveService(()=>reopened)
    service.schedule(next,{storyId:next.storyId},tenant);await settle()
    assert.equal(reopened.getStoryRound(first.storyId,first.id,0),null)
    assert.ok(reopened.getStoryRound(first.storyId,first.id,1))
    service.schedule(first,{storyId:first.storyId},tenant,{messageId:first.messages.at(-1).id,interrupted:false});await settle()
    assert.ok(reopened.getStoryRound(first.storyId,first.id,0))
  }finally{reopened.close()}
})

await asyncTest('failed abort receipt is retained until a later successful retry', async () => {
  const {store}=fixture(); let fail=true
  const service=new StoryArchiveService(()=>{if(fail)throw Error('receipt-open-failed');return store})
  const previousWarn=console.warn;console.warn=()=>{}
  try {
    const first=session('receipt-retry')
    service.schedule(first,{storyId:first.storyId},tenant,{messageId:first.messages.at(-1).id,interrupted:true});await settle()
    fail=false
    const next=session(first.id,[...first.messages,...messages(['user','assistant']).map(m=>({...m,id:'next-'+m.id}))])
    service.schedule(next,{storyId:next.storyId},tenant);await settle()
    assert.equal(store.getStoryRound(first.storyId,first.id,0),null)
    assert.ok(store.getStoryRound(first.storyId,first.id,1))
  }finally{console.warn=previousWarn;store.close()}
})

await asyncTest('queued cross-persona snapshot absorbs abort receipt from preceding failed snapshot', async () => {
  const {store}=fixture();let attempts=0
  const service=new StoryArchiveService(()=>{if(++attempts===1)throw Error('queued-receipt-open-failed');return store})
  const warn=console.warn;const warnings=[];console.warn=(...args)=>warnings.push(args)
  try {
    const first=session('queued-receipt')
    const next=session(first.id,[...first.messages,...messages(['user','assistant']).map(m=>({...m,id:'next-'+m.id}))])
    service.schedule(first,{storyId:first.storyId},tenant,{messageId:first.messages.at(-1).id,interrupted:true})
    service.schedule(next,{storyId:next.storyId},{...tenant,personaId:'next-persona'},
      {messageId:next.messages.at(-1).id,interrupted:false})
    await settle()
    assert.equal(warnings.length,1)
    assert.equal(store.getStoryRound(first.storyId,first.id,0),null)
    assert.equal(store.getStoryRound(first.storyId,first.id,1).tenant_persona,'next-persona')
    assert.equal(service.retryReceipts.size,0)
  }finally{console.warn=warn;store.close()}
})

test('round metadata query enforces story tenant branch validity and ascending order', () => withStore((store, file) => {
  const base = inputFor(one('原文'))
  for (const extra of [{ roundIndex: 3 }, { roundIndex: 1 }, { roundIndex: 2, tenantUser: 'other' },
    { branchId: 'other-branch' }, { storyId: 'other-story' }, { roundIndex: 4 }, { roundIndex: 5 }]) {
    const identity = String(extra.roundIndex ?? 0) + '-' + (extra.branchId ?? base.branchId)
    store.upsertStoryRound({ ...base, firstMessageId: identity + '-first', lastMessageId: identity + '-last', ...extra })
  }
  sql(file, (db) => {
    db.exec('UPDATE story_rounds SET valid=0 WHERE round_index=4')
    db.exec("UPDATE story_rounds SET first_message_id='' WHERE round_index=5")
  })
  const found = store.listStoryRounds(base.storyId, [tenant], [base.branchId])
  assert.deepEqual(found.map((row) => row.round_index), [1, 3])
  assert.ok(found.every((row) => !('text' in row)))
  for (const args of [[base.storyId, [], [base.branchId]], [base.storyId, [tenant], []],
    ['', [tenant], [base.branchId]], [base.storyId, [{ ...tenant, userId: '' }], [base.branchId]],
    [base.storyId, [tenant], [' ']]]) assert.deepEqual(store.listStoryRounds(...args), [])
}))
await asyncTest('invalidate is memory-only and one branch never cancels another branch', async () => {
  const { store } = fixture(); let opens = 0
  const service = new StoryArchiveService(() => { opens++; return store })
  const first = session('invalidated-branch'), other = session('unrelated-branch')
  try {
    service.schedule(first, { storyId: first.storyId }, tenant, { messageId: '1', interrupted: true })
    service.schedule(other, { storyId: other.storyId }, tenant)
    service.invalidate(first)
    assert.equal(opens, 0)
    await settle()
    assert.equal(store.getStoryRound(first.storyId, first.id, 0), null)
    assert.ok(store.getStoryRound(other.storyId, other.id, 0))
    assert.equal(store.isStoryMessageInterrupted(first.id, '1', contentVersion([first.messages[1]])), false)
    service.schedule(first, { storyId: first.storyId }, tenant)
    await settle()
    assert.equal(store.isStoryMessageInterrupted(first.id, '1', contentVersion([first.messages[1]])), true)
    assert.equal(store.getStoryRound(first.storyId, first.id, 0), null)
    assert.equal(service.jobs.size, 0)
    assert.equal(service.latest.size, 0)
    assert.equal(service.generations.size, 0)
    service.invalidate(first)
    assert.equal(service.generations.size, 0)
  } finally { store.close() }
})
await asyncTest('live mutation between round writes blocks later stale upsert without an invalidate hook', async () => {
  const { store } = fixture()
  const live = session('live-retry', messages(['user', 'assistant', 'user', 'assistant']))
  let writes = 0
  const service = new StoryArchiveService(() => ({
    getStoryRound: (...args) => store.getStoryRound(...args),
    upsertStoryRound(input) {
      const result = store.upsertStoryRound(input)
      if (++writes === 1) live.messages[3].content = 'replacement'
      return result
    }
  }))
  try {
    service.schedule(live, { storyId: live.storyId }, tenant)
    await settle()
    assert.equal(writes, 1)
    assert.equal(store.getStoryRound(live.storyId, live.id, 1), null)
    service.schedule(live, { storyId: live.storyId }, tenant)
    await settle()
    const saved = store.getStoryRound(live.storyId, live.id, 1)
    assert.equal(saved.content_version, contentVersion(live.messages.slice(2)))
    assert.ok(store.listStoryChunks(saved.id)[0].text.includes('replacement'))
  } finally { store.close() }
})
await asyncTest('invalidation during store acquisition blocks receipts and upsert before write', async () => {
  const live = session('open-race'); let service, receipts = 0, writes = 0
  service = new StoryArchiveService(() => {
    service.invalidate(live)
    return { setStoryMessageState() { receipts++ }, upsertStoryRound() { writes++ } }
  })
  service.schedule(live, { storyId: live.storyId }, tenant, { messageId: '1', interrupted: false })
  await settle()
  assert.equal(receipts, 0); assert.equal(writes, 0)
  assert.equal(service.retryReceipts.size, 1)
})

await asyncTest('forget cancels queued and draining work and blocks late finally schedules', async () => {
  const { store, file } = fixture(); const live = session('delete-drain', messages(['user', 'assistant', 'user', 'assistant']))
  let writes = 0, service
  service = new StoryArchiveService(() => ({ upsertStoryRound(input) {
    store.upsertStoryRound(input); writes++
    service.forget(live.storyId)
    store.close(); fs.rmSync(file)
  } }))
  service.schedule(live, { storyId: live.storyId }, tenant)
  service.schedule(session('queued-delete'), { storyId: live.storyId }, tenant)
  await settle()
  assert.equal(writes, 1); assert.equal(fs.existsSync(file), false)
  service.schedule(live, { storyId: live.storyId }, tenant, { messageId: '3', interrupted: false })
  service.invalidate(live)
  await settle()
  assert.equal(writes, 1); assert.equal(fs.existsSync(file), false)
  assert.equal(service.jobs.size, 0); assert.equal(service.latest.size, 0)
  assert.equal(service.generations.size, 0); assert.equal(service.retryReceipts.size, 0)
})

for (const state of [true, false, null]) {
  await asyncTest('new copied ids propagate source receipt through two generations: ' + state, async () => {
    const { store } = fixture(); const storyId = 'story_copy' + String(state) + '_abcdef'
    const source = messages(['user', 'assistant'])
    const copy = (body, prefix) => body.map((message) => ({ ...message, id: prefix + message.id,
      copiedFromMessageId: message.id, status: 'done' }))
    const child = session('copy-child', copy(source, 'child-'), storyId)
    const grandchild = session('copy-grandchild', copy(child.messages, 'grand-'), storyId)
    branchStore.write(storyId, { version: 2, activeBranchId: grandchild.id, branches: [
      { branchId: child.id, title: 'child', createdAt: 1, forkedFrom: null, memoryBounds: [
        { branchId: child.id, maxMessageIndex: null }, { branchId: 'deleted-parent', maxMessageIndex: 1 }] },
      { branchId: grandchild.id, title: 'grandchild', createdAt: 2, forkedFrom: null, memoryBounds: [
        { branchId: grandchild.id, maxMessageIndex: null }, { branchId: child.id, maxMessageIndex: 1 },
        { branchId: 'deleted-parent', maxMessageIndex: 1 }] }
    ] })
    try {
      if (state === false) store.upsertStoryRound(inputFor({ index: 0, messages: source },
        { storyId, branchId: 'deleted-parent' }))
      if (state !== null) store.setStoryMessageState('deleted-parent', source[1].id, contentVersion([source[1]]), state)
      assert.equal(store.getStoryMessageState('deleted-parent', source[1].id, 'wrong-version'), null)
      const service = new StoryArchiveService(() => store)
      service.schedule(child, { storyId }, tenant); await settle()
      service.schedule(grandchild, { storyId }, tenant); await settle()
      for (const live of [child, grandchild]) {
        assert.equal(store.getStoryMessageState(live.id, live.messages[1].id, contentVersion([live.messages[1]])), state)
        assert.equal(Boolean(store.getStoryRound(storyId, live.id, 0)), state === false)
      }
    } finally { store.close() }
  })
}
await asyncTest('copied legacy round requires exact complete archived source and visible fork boundary', async () => {
  const { store } = fixture(); const storyId = 'story_copylegacy_abcdef'
  const source = messages(['user', 'assistant'])
  const body = source.map((message) => ({ ...message, id: 'copy-' + message.id, copiedFromMessageId: message.id }))
  store.upsertStoryRound(inputFor({ index: 0, messages: source }, { storyId, branchId: 'legacy-parent' }))
  const service = new StoryArchiveService(() => store)
  try {
    for (const [branchId, bound, altered] of [['legacy-good', 1, false], ['legacy-cut', 0, false], ['legacy-edited', 1, true]]) {
      branchStore.write(storyId, { version: 2, activeBranchId: branchId, branches: [
        { branchId, title: branchId, createdAt: 1, forkedFrom: null, memoryBounds: [
          { branchId, maxMessageIndex: null }, { branchId: 'legacy-parent', maxMessageIndex: bound }] }
      ] })
      const live = session(branchId, structuredClone(body), storyId)
      if (altered) live.messages[1].content += 'edited'
      service.schedule(live, { storyId }, tenant); await settle()
      assert.equal(Boolean(store.getStoryRound(storyId, branchId, 0)), branchId === 'legacy-good')
      assert.equal(store.getStoryMessageState(branchId, live.messages[1].id, contentVersion([live.messages[1]])),
        branchId === 'legacy-good' ? false : null)
    }
    const noBounds = session('no-bounds', structuredClone(body), 'story_copynobounds_abcdef')
    service.schedule(noBounds, { storyId: noBounds.storyId }, tenant); await settle()
    assert.equal(store.getStoryRound(noBounds.storyId, noBounds.id, 0), null)
  } finally { store.close() }
})

await asyncTest('verified copied assistant receipt permits child user edits but still blocks exact local interruption', async () => {
  const { store } = fixture(); const storyId = 'story_copyedit_abcdef'
  const source = messages(['user', 'assistant'])
  const live = session('verified-child', source.map((message) => ({ ...message,
    id: 'child-' + message.id, copiedFromMessageId: message.id })), storyId)
  branchStore.write(storyId, { version: 2, activeBranchId: live.id, branches: [
    { branchId: live.id, title: 'child', createdAt: 1, forkedFrom: null, memoryBounds: [
      { branchId: live.id, maxMessageIndex: null }, { branchId: 'legacy-parent', maxMessageIndex: 1 }] }
  ] })
  store.upsertStoryRound(inputFor({ index: 0, messages: source }, { storyId, branchId: 'legacy-parent' }))
  const service = new StoryArchiveService(() => store)
  try {
    service.schedule(live, { storyId }, tenant); await settle()
    const first = store.getStoryRound(storyId, live.id, 0).content_version
    assert.equal(store.getStoryMessageState(live.id, live.messages[1].id, contentVersion([live.messages[1]])), false)
    live.messages[0].content = 'edited copied user only'
    service.invalidate(live); service.schedule(live, { storyId }, tenant); await settle()
    const rebuilt = store.getStoryRound(storyId, live.id, 0)
    assert.notEqual(rebuilt.content_version, first)
    assert.equal(rebuilt.content_version, contentVersion(live.messages))
    store.setStoryMessageState(live.id, live.messages[1].id, contentVersion([live.messages[1]]), true)
    live.messages[0].content += 'another edit'
    service.schedule(live, { storyId }, tenant); await settle()
    assert.equal(store.getStoryRound(storyId, live.id, 0).content_version, rebuilt.content_version)
    assert.equal(store.getStoryMessageState(live.id, live.messages[1].id, contentVersion([live.messages[1]])), true)
  } finally { store.close() }
})
await asyncTest('derived copied ids inherit original tenant rather than current scheduling persona', async () => {
  const { store } = fixture(); const storyId = 'story_copyowner_abcdef'
  const source = messages(['user', 'assistant'])
  const live = session('different-persona-child', source.map((message) => ({ ...message,
    id: 'child-' + message.id, copiedFromMessageId: message.id })), storyId)
  branchStore.write(storyId, { version: 2, activeBranchId: live.id, branches: [
    { branchId: live.id, title: 'child', createdAt: 1, forkedFrom: null, memoryBounds: [
      { branchId: live.id, maxMessageIndex: null }, { branchId: 'deleted-parent', maxMessageIndex: 1 }] }
  ] })
  store.upsertStoryRound(inputFor({ index: 0, messages: source }, { storyId, branchId: 'deleted-parent' }))
  const otherTenant = { ...tenant, personaId: 'tenant-b' }
  try {
    const service = new StoryArchiveService(() => store)
    service.schedule(live, { storyId }, otherTenant); await settle()
    assert.deepEqual(store.listStoryRounds(storyId, [otherTenant], [live.id]), [])
    assert.equal(store.listStoryRounds(storyId, [tenant], [live.id]).length, 1)
    assert.equal(store.getStoryMessageOwners(storyId, live.id, [live.messages[1].id])[0].tenant_persona, tenant.personaId)
    live.messages[0].content += 'edited by child'
    service.schedule(live, { storyId }, otherTenant); await settle()
    assert.equal(store.getStoryRound(storyId, live.id, 0).content_version, contentVersion(live.messages))
    assert.equal(store.listStoryRounds(storyId, [tenant], [live.id]).length, 1)
    assert.deepEqual(store.listStoryRounds(storyId, [otherTenant], [live.id]), [])
    const unowned = session('unowned-child', source.map((message) => ({ ...message,
      id: 'unknown-' + message.id, copiedFromMessageId: 'missing-' + message.id })), storyId)
    branchStore.write(storyId, { version: 2, activeBranchId: unowned.id, branches: [
      { branchId: unowned.id, title: 'unowned', createdAt: 1, forkedFrom: null, memoryBounds: [
        { branchId: unowned.id, maxMessageIndex: null }, { branchId: 'deleted-parent', maxMessageIndex: 1 }] }
    ] })
    store.setStoryMessageState(unowned.id, unowned.messages[1].id, contentVersion([unowned.messages[1]]), false)
    service.schedule(unowned, { storyId }, otherTenant); await settle()
    assert.equal(store.getStoryRound(storyId, unowned.id, 0), null)
  } finally { store.close() }
})
await asyncTest('deleting an early tenant round preserves shifted later tenant ownership across reopen', async () => {
  const { store, file } = fixture(); const live = session('tenant-shift')
  const tenantB = { ...tenant, personaId: 'tenant-b' }, tenantC = { ...tenant, personaId: 'tenant-c' }
  const service = new StoryArchiveService(() => store)
  try {
    service.schedule(live, { storyId: live.storyId }, tenant); await settle()
    live.messages.push(...messages(['user', 'assistant']).map((message) => ({ ...message, id: 'b-' + message.id })))
    service.schedule(live, { storyId: live.storyId }, tenantB); await settle()
    live.messages.push(...messages(['user', 'assistant']).map((message) => ({ ...message, id: 'c-' + message.id })))
    service.schedule(live, { storyId: live.storyId }, tenantC); await settle()
    // Simulate an older archive DB whose stable-owner ledger has not yet been populated.
    sql(file, (db) => db.exec('DELETE FROM story_message_owners'))
    live.messages.splice(0, 2); service.invalidate(live)
    service.schedule(live, { storyId: live.storyId }, tenant); await settle()
    assert.equal(store.getStoryRound(live.storyId, live.id, 0).tenant_persona, tenantB.personaId)
    assert.equal(store.getStoryRound(live.storyId, live.id, 1).tenant_persona, tenantC.personaId)
    assert.deepEqual(store.listStoryRounds(live.storyId, [tenant], [live.id]), [])
    store.close()
    const reopened = new MemoryStore(file)
    try {
      const stable = reopened.getStoryMessageOwners(live.storyId, live.id, ['b-1', 'c-1'])
      assert.ok(stable.some((row) => row.message_id === 'b-1' && row.tenant_persona === tenantB.personaId))
      assert.ok(stable.some((row) => row.message_id === 'c-1' && row.tenant_persona === tenantC.personaId))
      const shifted = reopened.getStoryRound(live.storyId, live.id, 0)
      assert.throws(() => reopened.upsertStoryRound({ ...inputFor(splitRounds(live.messages).rounds[0]),
        storyId: live.storyId, branchId: live.id, tenantPersona: tenant.personaId }), /租户/)
      assert.equal(reopened.getStoryRound(live.storyId, live.id, 0).tenant_persona, shifted.tenant_persona)
    } finally { reopened.close() }
  } finally { store.close() }
})
await asyncTest('deleting a round separator never merges different tenant bodies into one owner', async () => {
  const { store } = fixture(); const live = session('tenant-merge')
  const service = new StoryArchiveService(() => store)
  try {
    service.schedule(live, { storyId: live.storyId }, tenant); await settle()
    live.messages.push(...messages(['user', 'assistant']).map((message) => ({ ...message, id: 'b-' + message.id })))
    service.schedule(live, { storyId: live.storyId }, { ...tenant, personaId: 'tenant-b' }); await settle()
    const before = store.getStoryRound(live.storyId, live.id, 0).content_version
    live.messages.splice(2, 1)
    service.schedule(live, { storyId: live.storyId }, tenant); await settle()
    assert.equal(store.getStoryRound(live.storyId, live.id, 0).content_version, before)
    assert.notEqual(before, contentVersion(live.messages))
  } finally { store.close() }
})

// A-11: run the actual chat finally hook with a deliberately failing archive store.
fs.writeFileSync(path.join(userData,'settings.json'),JSON.stringify({
  provider:'mock',memory:{enabled:false,autoExtract:false},bridge:{enabled:false}
}))
const chatMod=await bundleModule('story-archive-chat',[
  'export { chatService } from '+JSON.stringify(p('src/main/features/chat/chatService.ts')),
  'export { storyArchiveService } from '+JSON.stringify(p('src/main/features/rag/storyArchive.ts')),
  'export { memoryService } from '+JSON.stringify(p('src/main/features/rag/index.ts')),
  'export { storyArchiveStore, closeAllStoryMemory } from '+JSON.stringify(p('src/main/features/story/memory.ts')),
  'export { createStory, deleteStory } from '+JSON.stringify(p('src/main/features/story/service.ts')),
  'export { storyStore } from '+JSON.stringify(p('src/main/features/story/store.ts'))
].join('\n'))
const {chatService,storyArchiveService}=chatMod
await asyncTest('actual story deletion cancels pending archive and late completion without recreating directory', async () => {
  const created = chatMod.createStory({ title: 'archive deletion race', characterId: 'nahida' })
  const storyId = created.meta.storyId
  const live = session('deleted-story-pending', undefined, storyId)
  const dir = chatMod.storyStore.dirPathOf(storyId)
  storyArchiveService.schedule(live, { storyId }, tenant)
  const result = chatMod.deleteStory(storyId, { confirmed: true })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(dir), false)
  await settle()
  storyArchiveService.schedule(live, { storyId }, tenant, { messageId: '1', interrupted: false })
  await settle()
  assert.equal(fs.existsSync(dir), false)
})
function sinkFor(onDelta=()=>{}) {
  return {kind:'headless',senderId:null,isAlive:()=>true,canApprove:()=>false,
    delta:onDelta,reasoning:()=>{},done:()=>{},fail:()=>{},tool:()=>{},presentApproval:()=>{}}
}
await asyncTest('A-11 real chat stays done and persisted when archive write throws once', async()=>{
  const chat=chatService.createSession({storyId:'story_chat_abcdef',mode:'story'})
  const originalStore=storyArchiveService.getStore
  const previousWarn=console.warn;const warnings=[];let attempts=0
  storyArchiveService.getStore=()=>({upsertStoryRound(){attempts++;throw Error('forced-archive-write')}})
  console.warn=(...args)=>{if(String(args[0]).startsWith('[story-archive]'))warnings.push(args);else previousWarn(...args)}
  try {
    const outcome=await chatService.sendAwait({sessionId:chat.id,content:'归档失败测试'},sinkFor())
    assert.equal(outcome.status,'done');assert.ok(outcome.content.length>0)
    await settle()
    assert.equal(attempts,1);assert.equal(warnings.length,1)
    const saved=JSON.parse(fs.readFileSync(path.join(userData,'sessions.json'),'utf8')).find(s=>s.id===chat.id)
    assert.equal(saved.messages.at(-1).status,'done');assert.equal(saved.messages.at(-1).content,outcome.content)
  } finally{storyArchiveService.getStore=originalStore;console.warn=previousWarn}
})
await asyncTest('real aborted chat remains excluded after next successful round backfill', async()=>{
  const chat=chatService.createSession({storyId:'story_abort_abcdef',mode:'story'})
  let stopped=false
  const outcome=await chatService.sendAwait({sessionId:chat.id,content:'中止半截回复'},sinkFor(()=>{
    if(!stopped){stopped=true;chatService.stop(chat.id)}
  }))
  assert.equal(outcome.status,'aborted');assert.ok(outcome.content.length>0);await settle()
  const store=chatMod.storyArchiveStore(chat.storyId)
  assert.equal(store.getStoryRound(chat.storyId,chat.id,0),null)
  const next=await chatService.sendAwait({sessionId:chat.id,content:'下一轮正常完成'},sinkFor())
  assert.equal(next.status,'done');await settle()
  assert.equal(store.getStoryRound(chat.storyId,chat.id,0),null)
  assert.ok(store.getStoryRound(chat.storyId,chat.id,1))
})
chatMod.closeAllStoryMemory()
chatMod.memoryService.dispose()

closeAllStoryMemory()
fs.rmSync(userData, { recursive: true, force: true })
done()
await import('./q12-archive.test.mjs')
