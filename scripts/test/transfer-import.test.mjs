/** Real session/story persistence; only the native dialogs are stubbed. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const restart = process.argv[2] === '--restart'
const data = restart ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'nc-transfer-'))
const source = path.join(data, 'input.jsonl')
const sessionsFile = path.join(data, 'sessions.json')
const raw = '  正文\n<game>场景</game><!-- 注释 -->\n'
const rows = [
  { chat_metadata: { ignored: true }, user_name: 'Source', character_name: 'fixture-character' },
  { name: 'Source', is_user: true, is_system: false, mes: raw, send_date: 1700000000 },
  { name: 'fixture-character', is_user: false, mes: '回复', extra: { secret: true } }
]
const sourceText = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const fingerprint = createHash('sha256').update(sourceText).digest('hex').slice(0, 16)
const characterId = 'fixture-character'
const ordinary = { kind: 'session', mode: 'agent', characterId }
const own = (file) => fs.readFileSync(file, 'utf8')
const from = (name, file) => 'export { ' + name + ' } from ' + JSON.stringify(p('src/main/features/' + file + '.ts'))

try {
  installElectronStub(data)
  const { dialog } = createRequire(import.meta.url)('electron')
  let selected = source
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  if (!restart) {
    fs.writeFileSync(source, sourceText)
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ defaultCharacterId: characterId, userName: 'LocalUser' }))
    fs.mkdirSync(path.join(data, 'Prompt', 'characters', characterId), { recursive: true })
  }
  const { transferService, chatService, createStory, listStoryBranches, storiesRoot, storyBranchesPath, promptStore } = await bundleModule('transfer-import', [
    from('transferService', 'transfer/service'), from('chatService', 'chat/chatService'),
    from('createStory, listStoryBranches', 'story/service'), from('storiesRoot, storyBranchesPath', 'story/paths'),
    from('promptStore', 'prompt/promptStore')
  ].join('\n'))
  const pick = () => transferService.pickImport()
  const apply = (token, target, title) => transferService.import({ token, target, title })
  const find = (id) => chatService.listSessions().find((s) => s.id === id)
  if (restart) {
    const { agentId, storyId, branchId, root, oldForkId } = JSON.parse(process.argv[4])
    const beforePreview = own(sessionsFile)
    assert.equal((await pick()).duplicateCount, 3)
    assert.equal(own(sessionsFile), beforePreview, '冷态预览不触发旧会话的中断恢复写盘')
    const agent = find(agentId)
    assert.equal(agent.mode, 'agent')
    assert.deepEqual(agent.messages.map(({ role, content }) => [role, content]), [['user', raw], ['assistant', '回复']])
    assert.equal(agent.importedFrom.fingerprint, fingerprint)
    assert.equal(agent.importedFrom.format, 'st')
    assert.equal(find(branchId).storyId, storyId)
    assert.equal(find(branchId).characterId, characterId)
    assert.equal(find(oldForkId).messages[0].status, 'error')
    assert.deepEqual(new Set(listStoryBranches(storyId).map((b) => b.branchId)), new Set([root, branchId, oldForkId]))
    const file = JSON.parse(own(storyBranchesPath(storyId)))
    assert.equal(file.activeBranchId, oldForkId)
    assert.deepEqual(file.branches.find((b) => b.branchId === branchId).memoryBounds, [{ branchId, maxMessageIndex: null }])
    assert.equal(file.branches.find((b) => b.branchId === branchId).forkedFrom, null)
    console.log('PASS transfer restart read-back')
  } else {
    const preview = await pick()
    assert.equal(preview.messageCount, 2)
    assert.equal(preview.suggestedCharacterId, characterId)
    assert.equal(preview.duplicateCount, 0)
    assert.equal(preview.fileName, 'input.jsonl')
    assert.equal(JSON.stringify(preview).includes(data), false)
    assert.equal(fs.existsSync(sessionsFile), false)
    assert.equal(fs.existsSync(storiesRoot()), false)
    assert.equal((await apply(preview.token, { ...ordinary, mode: 'story' })).ok, false)
    assert.equal((await apply(preview.token, { ...ordinary, characterId: '../missing' })).ok, false)
    assert.equal((await transferService.import({ token: preview.token, target: ordinary, path: source })).ok, false)
    assert.equal(fs.existsSync(sessionsFile), false)
    const first = apply(preview.token, ordinary)
    assert.equal((await apply(preview.token, ordinary)).ok, false)
    const agent = await first
    assert.equal(agent.ok, true, JSON.stringify(agent))
    const [agentId] = agent.sessionIds
    assert.equal((await apply(preview.token, ordinary)).ok, false)
    assert.equal(find(agentId).storyId, undefined)
    assert.equal(find(agentId).importedFrom.fingerprint, fingerprint)
    assert.equal(find(agentId).messages[0].content, raw)
    assert.equal(Object.hasOwn(find(agentId).messages[1], 'extra'), false)
    assert.equal(own(sessionsFile).includes(data), false)

    const changed = await pick()
    fs.appendFileSync(source, ' ')
    assert.match((await apply(changed.token, ordinary)).error, /修改/)
    fs.writeFileSync(source, sourceText)
    const expired = await pick()
    const now = Date.now
    Date.now = () => now() + 11 * 60 * 1000
    try { assert.match((await apply(expired.token, ordinary)).error, /失效/) } finally { Date.now = now }
    const large = path.join(data, 'large.jsonl')
    fs.closeSync(fs.openSync(large, 'w'))
    fs.truncateSync(large, 64 * 1024 * 1024 + 1)
    selected = large
    await assert.rejects(pick(), /67108865.*64 MiB/)
    fs.writeFileSync(large, JSON.stringify(rows[0]) + '\n' + (JSON.stringify(rows[1]) + '\n').repeat(20001))
    await assert.rejects(pick(), /20001.*20000/)
    selected = source

    const next = await pick()
    assert.equal(next.duplicateCount, 1)
    const story = await apply(next.token, { kind: 'new-story', characterId, profile: '画像' }, '故事')
    assert.equal(story.ok, true, JSON.stringify(story))
    const [root] = story.sessionIds
    assert.equal(story.storyId, find(root).storyId)
    const storyDir = path.join(storiesRoot(), story.storyId)
    assert.equal(own(path.join(storyDir, 'profile.md')), '画像')
    assert.equal(fs.existsSync(path.join(storyDir, 'story.json')), true)
    assert.equal(find(root).messages.length, 2)
    const branchFile = storyBranchesPath(story.storyId)
    // Seed a historical fork with inherited memory and a non-root active branch.
    listStoryBranches(story.storyId)
    const oldFork = chatService.createSession({ mode: 'story', storyId: story.storyId, title: '旧分支', characterId })
    const initial = JSON.parse(own(branchFile))
    initial.branches.push({ branchId: oldFork.id, title: oldFork.title, createdAt: oldFork.createdAt,
      forkedFrom: null, memoryBounds: [{ branchId: root, maxMessageIndex: 0 }, { branchId: oldFork.id, maxMessageIndex: null }] })
    initial.activeBranchId = oldFork.id
    fs.writeFileSync(branchFile, JSON.stringify(initial))
    const branchPreview = await pick()
    const target = { kind: 'story-branch', storyId: story.storyId, makeActive: false }
    assert.equal((await apply(branchPreview.token, { ...target, characterId: 'wrong' })).ok, false)
    assert.equal((await apply(branchPreview.token, { ...target, storyId: '../bad' })).ok, false)
    const branch = await apply(branchPreview.token, target, '导入分支')
    assert.equal(branch.ok, true, JSON.stringify(branch))
    const [branchId] = branch.sessionIds
    const visible = listStoryBranches(story.storyId)
    assert.equal(visible.find((b) => b.branchId === branchId).messageCount, 2)
    assert.equal(visible.find((b) => b.branchId === branchId).title, '导入分支')
    assert.deepEqual(JSON.parse(own(branchFile)).branches.slice(0, 2), initial.branches)
    assert.notEqual(find(branchId).messages[0].id, find(root).messages[0].id)

    const backup = own(branchFile)
    const before = own(sessionsFile)
    const failing = await pick()
    fs.writeFileSync(branchFile + '.tmp', 'preserve me')
    assert.equal((await apply(failing.token, target)).ok, false)
    assert.equal(own(branchFile), backup)
    assert.equal(own(branchFile + '.tmp'), 'preserve me')
    assert.equal(own(sessionsFile), before)
    fs.unlinkSync(branchFile + '.tmp')
    fs.unlinkSync(sessionsFile)
    fs.mkdirSync(sessionsFile)
    const dirs = fs.readdirSync(storiesRoot())
    assert.equal((await apply(failing.token, { kind: 'new-story', characterId })).ok, false)
    assert.deepEqual(fs.readdirSync(storiesRoot()), dirs)
    fs.rmdirSync(sessionsFile)
    fs.writeFileSync(sessionsFile, before)
    assert.equal(chatService.listSessions().length, 4)

    const outputName = 'same.jsonl'
    fs.writeFileSync(path.join(data, outputName), 'untouched')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(data, outputName) })
    const written = await transferService.export({ scope: 'current', sessionId: agentId, format: 'st' })
    assert.equal(written.ok, true, JSON.stringify(written))
    assert.deepEqual(written.fileNames, ['same-2.jsonl'])
    assert.equal(own(path.join(data, outputName)), 'untouched')
    const exported = own(path.join(data, written.fileNames[0])).trimEnd().split('\n').map((line) => JSON.parse(line))
    assert.equal(exported[0].user_name, 'LocalUser')
    assert.equal(exported[0].character_name, promptStore.library().characters.find((c) => c.id === characterId).name)
    assert.equal(exported[1].mes, raw)

    const diskSessions = JSON.parse(own(sessionsFile))
    diskSessions.find((session) => session.id === oldFork.id).messages = [{
      id: 'interrupted', role: 'assistant', content: 'partial', createdAt: Date.now(), status: 'streaming'
    }]
    fs.writeFileSync(sessionsFile, JSON.stringify(diskSessions))
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--restart', data,
      JSON.stringify({ agentId, storyId: story.storyId, branchId, root, oldForkId: oldFork.id })], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    console.log(result.stdout.trim())
    console.log('PASS transfer preview, limits, branches, rollback, and export')
  }
} finally {
  if (!restart) fs.rmSync(data, { recursive: true, force: true })
}
