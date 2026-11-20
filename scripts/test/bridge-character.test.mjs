/** P3/P4.5 production expressions under a page VM; real config roundtrips, no duplicated implementation. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { createChecker, installElectronStub, bundleModule, p } from './qq-test-util.mjs'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p3-character-'))
installElectronStub(dir)
const api = await bundleModule('p3-character', [
  'export * from ' + JSON.stringify(p('src/main/features/bridge/character.ts')),
  'export * from ' + JSON.stringify(p('src/main/features/bridge/override.ts')),
  'export * from ' + JSON.stringify(p('src/main/features/bridge/driver.ts')),
  'export * from ' + JSON.stringify(p('src/main/features/bridge/session.ts')),
  'export { BridgeHost } from ' + JSON.stringify(p('src/main/features/bridge/host.ts')),
  'export { BRIDGE_DEFAULT_CONFIG } from ' + JSON.stringify(p('src/shared/bridge.ts')),
  'export { chatService } from ' + JSON.stringify(p('src/main/features/chat/chatService.ts')),
  'export { promptStore } from ' + JSON.stringify(p('src/main/features/prompt/promptStore.ts')),
  'export { summaryService } from ' + JSON.stringify(p('src/main/features/summary/service.ts'))
].join('\n'))
const { check, done } = createChecker()
async function test(label, fn) { try { await fn(); check(label, true) } catch (e) { check(label, false, e.stack) } }
const card = { name: 'Test Role', avatar: 'Test Role_v2.png' }
function world(cards = [card], selected = 0) {
  const calls = [], requests = []
  const ctx = {
    characters: cards, characterId: selected, groupId: null,
    chat: [], chatMetadata: {}, extensionPrompts: {},
    getRequestHeaders: () => ({ 'x-csrf-token': 'fixture' }),
    generate() {}, eventSource: {}, eventTypes: {},
    async selectCharacterById(id) { calls.push(id); ctx.characterId = id },
    setExtensionPrompt(key, value, position, depth, scan = false, role = 0) { ctx.extensionPrompts[key] = { value, position, depth, scan, role } }
  }
  const sandbox = { SillyTavern: { getContext: () => ({ ...ctx, chat: ctx.chat, extensionPrompts: ctx.extensionPrompts, characters: ctx.characters }) }, Date, setTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); assert.equal(url, '/api/characters/all'); return { ok: true, json: async () => cards } } }
  sandbox.window = sandbox
  const context = vm.createContext(sandbox)
  const page = { eval: async (expr, label) => label === 'chat:drain' ? true : vm.runInContext(expr, context, { timeout: 1000 }), alive: () => true }
  const disk = {
    target(_root, name, avatar) { return { name, avatar, file: name + '.jsonl', directory: path.join(dir, 'chats', 'fixture'), path: path.join(dir, 'chats', 'fixture', name + '.jsonl') } },
    async wait(target, injected) {
      const last = ctx.chat.at(-1)
      assert.equal(ctx.chat.length, injected + 1)
      assert.equal(last?.is_user, false)
      assert.equal(typeof last.mes, 'string')
      return { content: last.mes, actualLines: injected + 2, expectedLines: injected + 2, file: target.file, waitMs: 0 }
    },
    async remove() { return true },
    async backups() { return [] }
  }
  return { ctx, page, calls, requests, disk }
}
await test('01 missing card fails with actionable manual import message', async () => {
  await assert.rejects(api.findCard(world([]).page, card.name), { message: '未找到角色「Test Role」，请先在酒馆中导入对应角色卡' })
})
await test('02 finds PNG filename exactly and never calls import', async () => {
  const w = world(); const found = await api.findCard(w.page, card.name)
  assert.equal(found.avatar, card.avatar); assert.equal(w.requests.length, 1); assert.equal(w.requests[0].url, '/api/characters/all')
  assert.equal(w.requests[0].options.headers['x-csrf-token'], 'fixture')
})
await test('03 ambiguity requires explicit avatar identity', async () => {
  const w = world([card, { ...card, avatar: 'duplicate.png' }]); await assert.rejects(api.findCard(w.page, card.name), /多张同名/)
  assert.equal((await api.findCard(w.page, card.name, card.avatar)).avatar, card.avatar)
})
await test('04 selects actual array index and reads fresh context', async () => {
  const w = world([{ name: 'Other', avatar: 'other.png' }, card]); await api.selectCharacter(w.page, card)
  assert.deepEqual(w.calls, [1]); assert.equal((await api.assertCharacter(w.page, card.name, card.avatar)).avatar, card.avatar)
})
await test('05 missing selection API fails explicitly', async () => {
  const w = world(); delete w.ctx.selectCharacterById; await assert.rejects(api.selectCharacter(w.page, card, 0), /selectCharacterById/)
})
await test('06 selection no-op and wrong avatar fail readback', async () => {
  const w = world([{ name: 'Other', avatar: 'other.png' }, card]); w.ctx.selectCharacterById = async () => {}
  await assert.rejects(api.selectCharacter(w.page, card), /选中校验失败/)
  w.ctx.characterId = 1; await assert.rejects(api.assertCharacter(w.page, card.name, 'other.png'), /与本轮配置的「Test Role」不符。请切回「Test Role」/)
})
await test('07 group selection fails even with matching character', async () => {
  const w = world(); w.ctx.groupId = 'group'; await assert.rejects(api.assertCharacter(w.page, card.name), /与本轮配置的「Test Role」不符。请切回「Test Role」/)
})
await test('08 arbitrary card without rules or lore is found and selected without content requests', async () => {
  const arbitrary = { name: '普通角色 🌱', avatar: 'plain.png' }
  const w = world([arbitrary]); const found = await api.findCard(w.page, arbitrary.name)
  await api.selectCharacter(w.page, found)
  assert.equal((await api.assertCharacter(w.page, arbitrary.name, arbitrary.avatar)).name, arbitrary.name)
  assert.deepEqual(w.calls, [0]); assert.deepEqual(w.requests.map(request => request.url), ['/api/characters/all'])
})
await test('09 duplicate name selection preserves confirmed PNG identity and reads it back', async () => {
  const duplicate = { ...card, avatar: 'confirmed-second.png' }
  const w = world([card, duplicate]); const found = await api.findCard(w.page, card.name, duplicate.avatar)
  await api.selectCharacter(w.page, found)
  assert.equal((await api.assertCharacter(w.page, card.name, duplicate.avatar)).avatar, duplicate.avatar)
  assert.deepEqual(w.calls, [1]); assert.deepEqual(w.requests.map(request => request.url), ['/api/characters/all'])
})
await test('10 first file is zero bytes and repeated ensure preserves edits', () => {
  const file = api.ensureOverrideFile(dir); assert.equal(fs.statSync(file).size, 0)
  fs.writeFileSync(file, 'external'); api.ensureOverrideFile(dir); assert.equal(fs.readFileSync(file, 'utf8'), 'external')
})
await test('11 save/get roundtrip and blank disable', () => {
  assert.equal(api.saveOverride('规则 🌿', dir).active, true); assert.equal(api.getOverride(dir).text, '规则 🌿')
  assert.equal(api.saveOverride('  \n ', dir).active, false)
})
await test('12 9000 characters truncate to 8000 and expose warning', () => {
  const result = api.saveOverride('界'.repeat(9000), dir); assert.equal(result.text.length,8000); assert.equal(result.truncated,true); assert.match(result.warning,/已截断/)
  assert.equal(fs.readFileSync(api.ensureOverrideFile(dir), 'utf8').length,8000)
})
await test('13 external long-file read does not rewrite disk', () => {
  const file=api.ensureOverrideFile(dir); fs.writeFileSync(file,'x'.repeat(9000)); assert.equal(api.getOverride(dir).text.length,8000); assert.equal(fs.statSync(file).size,9000)
})
await test('14 nontext save fails without damaging existing file', () => {
  const file=api.ensureOverrideFile(dir), prior=fs.readFileSync(file,'utf8'); assert.throws(()=>api.saveOverride(null,dir),/文本/); assert.equal(fs.readFileSync(file,'utf8'),prior)
})
await test('15 empty override expression creates no key', async () => {
  const w=world(); await w.page.eval(api.overrideExpr('')); assert.equal(Object.keys(w.ctx.extensionPrompts).length,0)
})
await test('16 override role SYSTEM, IN_CHAT=1, depth=0 then CLEAR removes key', async () => {
  const w=world(); await w.page.eval(api.overrideExpr('mark 🌿')); const prompt=w.ctx.extensionPrompts['nc-bridge:override']; assert.equal(prompt.value,'mark 🌿'); assert.equal(prompt.position,1); assert.equal(prompt.depth,0); assert.equal(prompt.role,0)
  await api.resetSession(w.page); assert.equal(Object.keys(w.ctx.extensionPrompts).length,0)
})
await test('17 per-turn mismatch aborts before generation and reports current role', async () => {
  const w=world([{name:'Other',avatar:'other.png'}]); const labels=[]; const page={...w.page,eval:async(expr,label)=>{labels.push(label);return w.page.eval(expr,label)}}
  let diskCalls=0; const disk={...w.disk,target(...args){diskCalls++;return w.disk.target(...args)},async wait(...args){diskCalls++;return w.disk.wait(...args)}}
  const driver=new api.BridgeDriver({disk,gateway:{ensure:async()=>page,onEvent:()=>()=>{}},config:{cardName:card.name,minIntervalMs:0},readOverride:()=>({text:'',active:false,warning:null,truncated:false})})
  const result=await driver.run({sessionId:'mismatch',messages:[{role:'user',content:'hello'}]}); assert.equal(result.status,'error')
  assert.match(result.error,/ST 当前角色是「Other」，与本轮配置的「Test Role」不符。请切回「Test Role」，或停止 ST 后修改桥接角色再重新打开。/)
  assert.equal(result.content,''); assert.equal(result.raw,''); assert.equal(labels.includes('generate'),false); assert.equal(diskCalls,0)
})
await test('18 bridge payload excludes static compose but keeps dynamic facts and exact history', async () => {
  let called=0; api.promptStore.compose=()=>{called++;return 'STATIC_SENTINEL soul modes styles worldbook'}
  api.summaryService.systemBlock=()=> 'SUMMARY_SENTINEL'; api.summaryService.historyOf=s=>s.messages
  const session={id:'story-test',mode:'story',messages:[{role:'user',content:'user  exact',status:'done'},{role:'assistant',content:'assistant  exact',status:'done'},{role:'narration',content:'narration exact',status:'done'}]}
  const story={background:'BACKGROUND_FACT',profile:'PROFILE_FACT',worldbookDir:null,worldbookMode:'character'}
  const payload=await api.chatService.buildPayload(session,'MEMORY_SENTINEL','TIME_SENTINEL',false,story,'test-persona',true)
  const text=payload.map(m=>m.content).join('\n'); assert.equal(called,0)
  for(const marker of ['TIME_SENTINEL','MEMORY_SENTINEL','SUMMARY_SENTINEL','BACKGROUND_FACT','PROFILE_FACT','user  exact','assistant  exact','narration exact']) assert.ok(text.includes(marker),marker)
  assert.equal(text.includes('STATIC_SENTINEL'),false)
})
await test('19 nonbridge chat, agent, story keep original static compose route', async () => {
  let called=0; api.promptStore.compose=()=>{called++;return 'STATIC_SENTINEL'}
  for(const mode of ['chat','agent','story']) { const payload=await api.chatService.buildPayload({id:mode,mode,messages:[]},'MEMORY','TIME',false,null,'test-persona'); assert.equal(payload[0].content,'STATIC_SENTINEL') }
  assert.equal(called,3)
})
await test('20 resolve after TokenBudgetExceeded fails instead of accepting partial persona', async () => {
  const w=world(); const labels=[]
  const page={...w.page,eval:async(expr,label)=>{labels.push(label);if(label==='generate')return {ok:true,timeout:false,ms:2,value:'partial reply',chatAfter:2,lastMes:'partial reply',toasts:['必要的提示词超过了上下文大小'],error:null};return w.page.eval(expr,label)}}
  const driver=new api.BridgeDriver({disk:w.disk,gateway:{ensure:async()=>page,onEvent:()=>()=>{}},config:{cardName:card.name,minIntervalMs:0},readOverride:()=>({text:'',active:false,warning:null,truncated:false})})
  const result=await driver.run({sessionId:'budget',messages:[{role:'user',content:'hello'}]})
  assert.equal(result.status,'error');assert.match(result.error,/上下文预算不足/);assert.equal(result.content,'');assert.equal(labels.at(-1),'clear')
})

const configFile = path.join(dir, 'nc-bridge', 'config.json')
function seedConfig(saved) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  if (saved === undefined) fs.rmSync(configFile, { force: true })
  else fs.writeFileSync(configFile, JSON.stringify(saved, null, 2), 'utf8')
}
function savedConfig() { return JSON.parse(fs.readFileSync(configFile, 'utf8')) }
async function hostWorld(cards = [card], saved) {
  seedConfig(saved)
  const host = new api.BridgeHost()
  await host.orphanSweep
  const w = world(cards)
  host.eval = w.page.eval
  // Keep production config loading, selection and atomic persistence; only replace Electron launch.
  host.launch = async () => { await host.ensureCard() }
  return { ...w, host }
}
await test('21 new user loads an empty role with no legacy card path default', async () => {
  const { host } = await hostWorld()
  const health = host.health()
  assert.equal(api.BRIDGE_DEFAULT_CONFIG.cardName, ''); assert.equal(Object.hasOwn(api.BRIDGE_DEFAULT_CONFIG, 'cardPath'), false)
  assert.equal(health.config.cardName, ''); assert.equal(health.config.cardAvatar, ''); assert.equal(health.lastError, null)
  assert.equal(fs.existsSync(configFile), false)
})
await test('22 saved config missing role migrates to blank without discarding other settings', async () => {
  const legacy = { stRoot: path.join(dir, 'legacy-st'), port: 8123, nodePath: 'custom-node', generateTimeoutMs: 240000 }
  const { host } = await hostWorld([card], legacy)
  const before = fs.readFileSync(configFile, 'utf8'), health = host.health()
  assert.equal(health.config.cardName, ''); assert.equal(health.config.stRoot, legacy.stRoot)
  assert.equal(health.config.port, legacy.port); assert.equal(health.config.nodePath, legacy.nodePath)
  assert.equal(health.config.generateTimeoutMs, legacy.generateTimeoutMs); assert.equal(health.lastError, null)
  assert.equal(fs.readFileSync(configFile, 'utf8'), before)
})
await test('23 saved role and confirmed avatar survive loading unchanged', async () => {
  const legacy = { cardName: '妲妮娅', cardAvatar: '妲妮娅_v2.png', port: 8124 }
  const { host } = await hostWorld([card], legacy)
  const before = fs.readFileSync(configFile, 'utf8'), health = host.health()
  assert.equal(health.config.cardName, legacy.cardName); assert.equal(health.cardName, legacy.cardName)
  assert.equal(health.config.cardAvatar, legacy.cardAvatar); assert.equal(health.lastError, null)
  assert.equal(fs.readFileSync(configFile, 'utf8'), before)
})
await test('24 legacy card path is preserved on selection but never requested', async () => {
  const legacy = { cardName: '妲妮娅', cardAvatar: 'old.png', cardPath: '../ST导出/妲妮娅.story.json' }
  const w = await hostWorld([card], legacy)
  await w.host.openSt({ cardName: card.name })
  assert.equal(savedConfig().cardPath, legacy.cardPath); assert.equal(savedConfig().cardName, card.name)
  assert.equal(savedConfig().cardAvatar, card.avatar)
  assert.deepEqual(w.requests.map(request => request.url), ['/api/characters/all'])
})
await test('25 openSt selects the configured arbitrary role and persists its confirmed identity across restart', async () => {
  const arbitrary = { name: '普通角色 🌱', avatar: 'arbitrary.png' }
  const w = await hostWorld([card, arbitrary])
  const health = await w.host.openSt({ cardName: '  ' + arbitrary.name + '  ', stRoot: path.join(dir, 'owned-st'), port: 8125 })
  assert.deepEqual(w.calls, [1]); assert.equal(health.cardName, arbitrary.name); assert.equal(health.cardAvatar, arbitrary.avatar)
  assert.equal((await api.assertCharacter(w.page, arbitrary.name, arbitrary.avatar)).avatar, arbitrary.avatar)
  const saved = savedConfig()
  assert.equal(saved.cardName, arbitrary.name); assert.equal(saved.cardAvatar, arbitrary.avatar); assert.equal(saved.port, 8125)
  assert.equal(Object.hasOwn(saved, 'cardPath'), false); assert.equal(fs.existsSync(configFile + '.tmp'), false)
  assert.deepEqual(w.requests.map(request => request.url), ['/api/characters/all'])
  const restarted = new api.BridgeHost(); await restarted.orphanSweep
  assert.equal(restarted.health().cardName, arbitrary.name); assert.equal(restarted.health().cardAvatar, arbitrary.avatar)
})
await test('26 empty role is readable but openSt and ensure reject before launching', async () => {
  const { host, requests } = await hostWorld()
  let launched = 0; host.launch = async () => { launched++ }
  assert.equal(host.health().config.cardName, '')
  await assert.rejects(host.openSt({ cardName: '   ' }), /桥接角色/)
  await assert.rejects(host.ensure(), /桥接角色/)
  assert.equal(launched, 0); assert.equal(requests.length, 0); assert.equal(host.config.cardName, '')
  const existing = await hostWorld([card], { cardName: card.name, cardAvatar: card.avatar })
  existing.host.health(); const before = fs.readFileSync(configFile, 'utf8')
  await assert.rejects(existing.host.openSt({ cardName: '   ' }), /桥接角色/)
  assert.equal(existing.host.config.cardName, card.name); assert.equal(fs.readFileSync(configFile, 'utf8'), before)
  assert.equal(existing.requests.length, 0)
})
await test('27 role changes are locked while ST is running and work after stopping', async () => {
  const other = { name: 'Changed Role', avatar: 'changed.png' }
  const w = await hostWorld([card, other], { cardName: card.name, cardAvatar: card.avatar })
  w.host.health(); const before = fs.readFileSync(configFile, 'utf8')
  w.host.st.running = () => true
  await assert.rejects(w.host.openSt({ cardName: other.name }), /请先停止 ST.*桥接角色/)
  assert.equal(w.host.config.cardName, card.name); assert.equal(fs.readFileSync(configFile, 'utf8'), before)
  assert.equal(w.requests.length, 0); assert.equal(w.calls.length, 0)
  w.host.st.running = () => false
  await w.host.openSt({ cardName: other.name })
  assert.equal(savedConfig().cardName, other.name); assert.equal(savedConfig().cardAvatar, other.avatar)
})
await test('28 role changes are locked during startup without changing saved config', async () => {
  const { host, requests } = await hostWorld([card], { cardName: card.name, cardAvatar: card.avatar })
  host.health(); const before = fs.readFileSync(configFile, 'utf8')
  host.booting = Promise.resolve()
  try { await assert.rejects(host.openSt({ cardName: 'Another Role' }), /请先停止 ST.*桥接角色/) }
  finally { host.booting = null }
  assert.equal(host.config.cardName, card.name); assert.equal(fs.readFileSync(configFile, 'utf8'), before)
  assert.equal(requests.length, 0)
})
await test('29 missing role stops before selection and does not persist a confirmed avatar', async () => {
  const w = await hostWorld([], { cardName: 'Missing Role', cardAvatar: '' })
  await assert.rejects(w.host.openSt(), { message: '未找到角色「Missing Role」，请先在酒馆中导入对应角色卡' })
  assert.deepEqual(w.calls, []); assert.equal(savedConfig().cardAvatar, ''); assert.equal(w.host.config.cardAvatar, '')
  assert.deepEqual(w.requests.map(request => request.url), ['/api/characters/all'])
})
await test('30 selection readback failure never persists an unconfirmed avatar', async () => {
  const w = await hostWorld([{ name: 'Other', avatar: 'other.png' }, card], { cardName: card.name, cardAvatar: '' })
  w.ctx.selectCharacterById = async () => {}
  await assert.rejects(w.host.openSt(), /选中校验失败/)
  assert.equal(savedConfig().cardAvatar, ''); assert.equal(w.host.config.cardAvatar, '')
  assert.deepEqual(w.requests.map(request => request.url), ['/api/characters/all'])
})
await test('31 first ambiguous name fails without choosing the first card', async () => {
  const w = await hostWorld([card, { ...card, avatar: 'duplicate.png' }], { cardName: card.name, cardAvatar: '' })
  await assert.rejects(w.host.openSt(), /有多张同名角色卡.*唯一/)
  assert.deepEqual(w.calls, []); assert.equal(w.host.config.cardAvatar, ''); assert.equal(savedConfig().cardAvatar, '')
})
await test('32 saved avatar resolves duplicate names and selection persists the same identity', async () => {
  const duplicate = { ...card, avatar: 'known-second.png' }
  const w = await hostWorld([card, duplicate], { cardName: card.name, cardAvatar: duplicate.avatar })
  await w.host.openSt()
  assert.deepEqual(w.calls, [1]); assert.equal(savedConfig().cardAvatar, duplicate.avatar)
  assert.equal((await api.assertCharacter(w.page, card.name, duplicate.avatar)).avatar, duplicate.avatar)
  assert.deepEqual(w.requests.map(request => request.url), ['/api/characters/all'])
})
await test('33 previous role avatar cannot resolve a different ambiguous role', async () => {
  const w = await hostWorld([card, { ...card, avatar: 'duplicate.png' }], { cardName: 'Previous Role', cardAvatar: 'previous.png' })
  await assert.rejects(w.host.openSt({ cardName: card.name }), /有多张同名角色卡.*唯一/)
  assert.deepEqual(w.calls, []); assert.equal(w.host.config.cardAvatar, 'previous.png')
})
fs.rmSync(dir,{recursive:true,force:true})
done()
