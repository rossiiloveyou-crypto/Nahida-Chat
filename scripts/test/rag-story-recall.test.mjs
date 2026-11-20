/** P4.8: real SQLite + real facade + real chat mutation boundaries. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-recall-'))
installElectronStub(dir)
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ provider:'mock', memory:{enabled:false,autoExtract:false}, bridge:{enabled:false}, summary:{enabled:false} }))
const api = await bundleModule('story-recall', [
  ['MemoryStore','src/main/features/rag/store.ts'],
  ['MemoryService, memoryService, buildStoryQuery','src/main/features/rag/index.ts'],
  ['recallStory, formatStoryRecall, normalizeStoryRecall','src/main/features/rag/retriever.ts'],
  ['splitRounds, sliceRound, contentVersion, StoryArchiveService, storyArchiveService','src/main/features/rag/storyArchive.ts'],
  ['storyMemory, storyArchiveStore, closeStoryMemory, closeAllStoryMemory','src/main/features/story/memory.ts'],
  ['branchVisibility','src/main/features/story/visibility.ts'],
  ['branchStore','src/main/features/story/branches.ts'],
  ['storyStore','src/main/features/story/store.ts'],
  ['createStory, deriveBranch, deleteStory','src/main/features/story/service.ts'],
  ['chatService','src/main/features/chat/chatService.ts'],
  ['summaryService','src/main/features/summary/service.ts'],
  ['settingsStore','src/main/features/settings/settingsStore.ts'],
  ['embedder','src/main/features/rag/embedder.ts'],
  ['estimateTokens','src/main/features/rag/tokenize.ts'],
  ['DEFAULT_STORY_RECALL, MEMORY_STORE_MAX_CHARS, MEMORY_EXTRACT_MAX_CHARS','src/shared/constants.ts']
].map(([names,file])=>'export { '+names+' } from '+JSON.stringify(p(file))).join('\n'))
const {check,done} = createChecker()
async function test(name, fn) { try { await fn();check(name,true) } catch(error) { check(name,false,error.stack) } }
const msg=(id,role,content=id,extra={})=>({id,role,content,createdAt:1700000000000,status:'done',...extra})
const tenant={userId:'root',personaId:'default'}
const config=api.normalizeStoryRecall()
const stores=[]
const settle=async()=>{for(let i=0;i<60;i++)await new Promise(resolve=>setImmediate(resolve))}
const session=(id,body,storyId='story_recall_abcdef')=>({id,mode:'story',storyId,messages:body})
const pairs=(contents)=>contents.flatMap((text,i)=>[msg('u'+i,'user',text),msg('a'+i,'assistant',text)])
function fixture(body=pairs(['钥匙交给甲保管','月亮照着河岸','继续寻找钥匙'])) {
  const file=path.join(dir,'fixture-'+stores.length+'.db')
  const store=new api.MemoryStore(file);stores.push(store)
  const s=session('branch-'+stores.length,body)
  archive(store,s)
  return {store,file,s,service:new api.MemoryService(store)}
}
function archive(store,s,who=tenant) {
  for(const round of api.splitRounds(s.messages).rounds) {
    store.upsertStoryRound({storyId:s.storyId,branchId:s.id,roundIndex:round.index,
      tenantUser:who.userId,tenantPersona:who.personaId,firstMessageId:round.messages[0].id,
      lastMessageId:round.messages.at(-1).id,contentVersion:api.contentVersion(round.messages),
      roles:round.messages.map(m=>m.role),startedAt:round.messages[0].createdAt,chunks:api.sliceRound(round)})
  }
}
const rows=(f,tenants=[tenant],branches=[f.s.id])=>f.store.listStoryRounds(f.s.storyId,tenants,branches)
const recall=(f,query='钥匙',cfg=config,extra={})=>api.recallStory(f.store,query,{config:cfg,rounds:rows(f),...extra})
const options=(s,overrides={})=>({storyId:s.storyId,branchId:s.id,tenants:[tenant],bounds:new Map([[s.id,null]]),recentMessageIds:new Set(),...overrides})
const block=(f,opts=options(f.s),cfg=config)=>f.service.buildStoryContextBlock(f.s,cfg,opts)
function sql(file,fn){const db=new DatabaseSync(file);try{return fn(db)}finally{db.close()}}
await test('R-01 calibrated defaults keep null embedding keyword path alive',()=>{
  assert.equal(config.minScore,.4);assert.ok(config.minScore<config.keywordWeight)
  assert.equal(api.MEMORY_STORE_MAX_CHARS,300);assert.equal(api.MEMORY_EXTRACT_MAX_CHARS,300)
})
await test('R-01 all-null real SQLite returns hits without loading embedder',async()=>{
  const f=fixture();const old=api.embedder.embedOne;let called=0
  api.embedder.embedOne=async()=>{called++;throw Error('must not load')}
  try{assert.ok((await recall(f)).length);assert.equal(called,0)}finally{api.embedder.embedOne=old}
})
await test('configuration normalization clamps invalid values and preserves independent switch',()=>{
  const c=api.normalizeStoryRecall({enabled:false,n:-1,minScore:1,keywordWeight:.1,recheckDepth:Infinity,candidateMultiplier:-4,budgetTokens:-1})
  assert.equal(c.enabled,false);assert.equal(c.n,1);assert.ok(c.minScore<c.keywordWeight)
  assert.equal(c.budgetTokens,0);assert.ok(c.recheckDepth<=256);assert.equal(c.candidateMultiplier,1)
})
await test('R-02 three overlapping chunks merge exactly and consume one round',async()=>{
  const f=fixture(pairs(['钥匙'+ '长篇剧情'.repeat(650)]));const r=rows(f)[0]
  assert.ok(f.store.listStoryChunks(r.id).length>=3)
  const hits=await recall(f,'钥匙',{...config,n:1});assert.equal(hits.length,1)
  assert.equal(hits[0].content,'【用户】'+f.s.messages[0].content+'\n【角色】'+f.s.messages[1].content)
})
await test('R-03 composite query preserves current short input and recent background',async()=>{
  const f=fixture();f.s.messages.push(msg('next','user','继续'))
  const query=api.buildStoryQuery(f.s.messages);assert.ok(query.includes('寻找钥匙'));assert.ok(query.endsWith('继续'))
  assert.ok((await recall(f,query)).length)
})
await test('R-03 narration-only queued input builds nonempty query',()=>{
  assert.equal(api.buildStoryQuery([msg('n','narration','钥匙又被交还。')]),'钥匙又被交还。')
})
await test('composite query is capped at 1200 and drops failed/streaming bodies',()=>{
  const q=api.buildStoryQuery([...pairs(['背景'.repeat(1000)]),msg('x','user','当前'.repeat(900)),msg('bad','assistant','FAILED_MARK',{status:'error'}),msg('half','assistant','HALF_MARK',{status:'streaming'})])
  assert.ok(q.length<=1200);assert.ok(!q.includes('FAILED_MARK'));assert.ok(!q.includes('HALF_MARK'));assert.ok(q.endsWith('当前'))
})
await test('R-04 endpoint history dedup removes the whole round',async()=>{
  const f=fixture(pairs(['钥匙']));assert.deepEqual(await recall(f,'钥匙',config,{recentMessageIds:new Set(['u0'])}),[])
})
await test('R-04 facade dedups any middle narration, not only first/last id',async()=>{
  const f=fixture([msg('u','user','钥匙'),msg('n','narration','钥匙在甲手里'),msg('a','assistant','钥匙已收好')])
  assert.equal(await block(f,options(f.s,{recentMessageIds:new Set(['n'])})), '')
})
await test('R-05 older seed and newer key transfer both survive and render chronologically',async()=>{
  const f=fixture(pairs(['钥匙在谁手里？钥匙在甲手里','月色','河水','晚风','钥匙后来交给乙']))
  const hits=await recall(f,'钥匙在谁手里',{...config,n:2});assert.deepEqual(hits.map(h=>h.round.round_index),[0,4])
  const text=api.formatStoryRecall(hits);assert.ok(text.indexOf('第 1 轮')<text.indexOf('第 5 轮'));assert.ok(text.includes('交给乙'))
})
await test('R-05 N=1 keeps newer state ahead of stale seed',async()=>{
  const f=fixture(pairs(['钥匙在谁手里？钥匙在甲手里','晚风','钥匙后来交给乙']))
  assert.equal((await recall(f,'钥匙在谁手里',{...config,n:1}))[0].round.round_index,2)
})
await test('newer-state recheck honors zero depth and stays within exact branch/tenant',async()=>{
  const f=fixture(pairs(['钥匙在谁手里？钥匙在甲手里','晚风','钥匙后来交给乙']))
  const hits=await recall(f,'钥匙在谁手里',{...config,n:1,recheckDepth:0});assert.equal(hits[0].round.round_index,0)
})
await test('budget includes heading source labels and conflict rule; no empty shell',async()=>{
  const f=fixture(pairs(['钥匙']));assert.deepEqual(await recall(f,'钥匙',{...config,budgetTokens:1}),[])
  assert.equal(api.formatStoryRecall([],8000),'');assert.equal(api.formatStoryRecall(await recall(f),1),'')
  const text=api.formatStoryRecall(await recall(f));assert.ok(api.estimateTokens(text)<=config.budgetTokens)
})
await test('oversized newer state suppresses its stale seed instead of injecting known obsolete state',async()=>{
  const f=fixture(pairs(['钥匙在甲手里','钥匙交给乙。'+'无关长文'.repeat(500)]))
  assert.deepEqual(await recall(f,'钥匙在甲手里',{...config,n:1,budgetTokens:400}),[])
})
await test('formatting a smaller budget never falls back from oversized new state to old state',async()=>{
  const f=fixture(pairs(['钥匙在甲手里','钥匙交给乙。'+'无关长文'.repeat(500)]))
  const hits=await recall(f,'钥匙在甲手里',{...config,n:2,budgetTokens:10000})
  assert.equal(hits.length,2);assert.equal(api.formatStoryRecall(hits,400),'')
})
await test('plain unrelated query has no lexical hits',async()=>{
  assert.deepEqual(await recall(fixture(),'quantum topology superconductivity'),[])
})
await test('UTF-16LE BLOB original decodes only through listStoryChunks and remains exact',async()=>{
  const f=fixture(pairs(['钥匙\ud800星空']));const hits=await recall(f);assert.ok(hits[0].content.includes('\ud800'))
})
await test('bad/mismatched embedding degrades to keywords',async()=>{
  const f=fixture();sql(f.file,db=>db.exec("UPDATE story_chunks SET embedding=X'000102'"));assert.ok((await recall(f)).length)
})
await test('hybrid vector path computes query once and cosine can retrieve a synonym',async()=>{
  const f=fixture(pairs(['密门的铜锁由守卫掌管']))
  sql(f.file,db=>db.prepare('UPDATE story_chunks SET embedding=?').run(Buffer.from(new Float32Array([1,0]).buffer)))
  const old=api.embedder.embedOne;let count=0;api.embedder.embedOne=async()=>{count++;return new Float32Array([1,0])}
  try{assert.equal((await recall(f,'locksmith')).length,1);assert.equal(count,1)}finally{api.embedder.embedOne=old}
})
await test('vector query exception still falls back to lexical hits',async()=>{
  const f=fixture();sql(f.file,db=>db.prepare('UPDATE story_chunks SET embedding=?').run(Buffer.from(new Float32Array([1,0]).buffer)))
  const old=api.embedder.embedOne;api.embedder.embedOne=async()=>{throw Error('offline')}
  try{assert.ok((await recall(f)).length)}finally{api.embedder.embedOne=old}
})
await test('R-07 interrupted rounds are excluded before any chunk text read',async()=>{
  const f=fixture(pairs(['钥匙半句话']));const assistant=f.s.messages.at(-1)
  f.store.setStoryMessageState(f.s.id,assistant.id,api.contentVersion([assistant]),true)
  const original=f.store.listStoryChunks;let reads=0;f.store.listStoryChunks=()=>{reads++;throw Error('must not read')}
  try{assert.equal(await block(f),'');assert.equal(reads,0)}finally{f.store.listStoryChunks=original}
})
await test('R-07 receipt is version-matched; edited complete message can return after rebuild',async()=>{
  const f=fixture(pairs(['钥匙半句话']));const a=f.s.messages.at(-1)
  f.store.setStoryMessageState(f.s.id,a.id,api.contentVersion([a]),true)
  a.content='钥匙完整新版本';archive(f.store,f.s)
  assert.ok((await block(f)).includes('完整新版本'))
})
await test('R-09 SQL metadata primitive enforces exact user/persona pairs and branch',()=>{
  const f=fixture();assert.equal(rows(f,[{userId:'root',personaId:'other'}]).length,0)
  assert.equal(rows(f,[{userId:'other',personaId:'default'}]).length,0)
  assert.equal(rows(f,[tenant],['other']).length,0);assert.equal(rows(f,[],[]).length,0)
})
await test('R-09 missing branch metadata fails closed without opening chunk text',async()=>{
  const f=fixture();assert.equal(await block(f,options(f.s,{bounds:new Map()})),'')
  assert.equal(await block(f,options(f.s,{branchId:''})), '');assert.equal(await block(f,options(f.s,{tenants:[]})), '')
})
await test('R-09 fork sees only copied source prefix through inclusive message bound',async()=>{
  const f=fixture(pairs(['钥匙给甲','钥匙给乙','钥匙给丙']));const child=session('fork',f.s.messages.map(m=>({...m})),f.s.storyId)
  const opts=options(child,{bounds:new Map([[child.id,null],[f.s.id,1]])})
  const text=await f.service.buildStoryContextBlock(child,config,opts)
  assert.ok(text.includes('钥匙给甲'));assert.ok(!text.includes('钥匙给乙'));assert.ok(!text.includes('钥匙给丙'))
})
await test('R-02 inherited prefix archived twice consumes one round and prefers self source',async()=>{
  const f=fixture(pairs(['钥匙复制前缀']))
  const child=session('child',f.s.messages.map(m=>({...m})),f.s.storyId);archive(f.store,child)
  const text=await f.service.buildStoryContextBlock(child,config,options(child,{bounds:new Map([[child.id,null],[f.s.id,1]])}))
  assert.equal((text.match(/【第 1 轮/g)||[]).length,1)
  assert.ok(text.includes('/ 分支 child /'))
})
await test('R-07 forked aborted prefix never resurfaces under a child archive row',async()=>{
  const f=fixture(pairs(['钥匙半句话']))
  const a=f.s.messages.at(-1);f.store.setStoryMessageState(f.s.id,a.id,api.contentVersion([a]),true)
  const child=session('child',f.s.messages.map(m=>({...m})),f.s.storyId);archive(f.store,child)
  const text=await f.service.buildStoryContextBlock(child,config,options(child,{bounds:new Map([[child.id,null],[f.s.id,1]])}))
  assert.equal(text,'')
})
await test('R-09 malformed boundary and missing source ids fail closed',async()=>{
  const f=fixture();assert.equal(await block(f,options(f.s,{bounds:new Map([[f.s.id,undefined]])})), '')
  sql(f.file,db=>db.exec("UPDATE story_rounds SET last_message_id=''"));assert.equal(await block(f),'')
})
await test('R-09 old facts visibility remains fail-open while new path needs bounds',()=>{
  const v=api.branchVisibility('story_missing_abcdef','missing');assert.equal(v.visible({sourceSessionId:null}),true);assert.equal(v.bounds.size,0)
})
await test('disabled story config returns empty regardless of memory enabled',async()=>{
  const f=fixture();assert.equal(await block(f,options(f.s),{...config,enabled:false}), '')
  assert.ok((await block(f)).includes('故事回顾'))
})
await test('R-10 edit while embedding awaits causes no stale prompt injection',async()=>{
  const f=fixture();sql(f.file,db=>db.prepare('UPDATE story_chunks SET embedding=?').run(Buffer.from(new Float32Array([1,0]).buffer)))
  const old=api.embedder.embedOne;let release;let started
  const entered=new Promise(r=>started=r);api.embedder.embedOne=()=>{started();return new Promise(r=>release=r)}
  try{const pending=block(f);await entered;f.s.messages[0].content='新内容';release(new Float32Array([1,0]));assert.equal(await pending,'')}finally{api.embedder.embedOne=old}
})
await test('facade lookup catches unavailable database and chat keeps working',async()=>{
  const service=new api.MemoryService({listStoryRounds(){throw Error('unavailable')}})
  const warn=console.warn;console.warn=()=>{}
  try{assert.equal(await service.buildStoryContextBlock(session('x',pairs(['钥匙'])),config,options(session('x',[]))),'')}finally{console.warn=warn}
})
await test('storyRecall settings survives save/reload JSON without borrowing memory switches',()=>{
  api.settingsStore.save({storyRecall:{...config,n:3},memory:{enabled:false,autoExtract:false,topK:5,minScore:.55,budgetTokens:1200}})
  assert.equal(api.settingsStore.get().storyRecall.n,3)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).storyRecall.enabled,true)
})
// Real chat seam: only short explicit history is passed, as summaryService would supply.
function chatFixture(body) {
  const chat=api.chatService.createSession({storyId:'story_live_abcdef',mode:'story'})
  api.chatService.appendMessages(chat.id,body)
  const live=api.chatService.sessions.find(s=>s.id===chat.id)
  const store=api.storyArchiveStore(chat.storyId);archive(store,live)
  api.branchStore.write(chat.storyId,{version:2,activeBranchId:chat.id,branches:[{branchId:chat.id,title:'test',createdAt:1,forkedFrom:null,memoryBounds:[{branchId:chat.id,maxMessageIndex:null}]}]})
  return {s:live,store,service:api.storyMemory(chat.storyId)}
}
await test('R-06 real buildPayload order is facts, story, summary, exact history',async()=>{
  const f=chatFixture(pairs(['钥匙放在柜子里','大家寻找钥匙']))
  const old=api.summaryService.systemBlock;api.summaryService.systemBlock=()=> 'SUMMARY_MARK'
  try{const payload=await api.chatService.buildPayload(f.s,'FACT_MARK','TIME',false,null,'default',false,[f.s.messages.at(-1)])
    const fact=payload.findIndex(m=>m.content==='FACT_MARK'),story=payload.findIndex(m=>m.content.startsWith('【故事回顾')),
      summary=payload.findIndex(m=>m.content==='SUMMARY_MARK')
    assert.ok(fact<story && story<summary && summary<payload.length-1)
    assert.ok(payload[story].content.includes('更靠后的原文 > 更靠后的摘要 > 更早的原文'))
    assert.equal(payload.at(-1).content,f.s.messages.at(-1).content)
  }finally{api.summaryService.systemBlock=old}
})
await test('R-06 empty result injects no heading and ordinary chat never asks story facade',async()=>{
  const payload=await api.chatService.buildPayload({id:'ordinary',mode:'chat',characterId:'nahida',messages:[]},'FACT','TIME',false,null,'default')
  assert.ok(!payload.some(m=>m.content.includes('故事回顾')))
  const f=chatFixture(pairs(['钥匙']));const full=await api.chatService.buildPayload(f.s,'','',false,null,'default',false,f.s.messages)
  assert.ok(!full.some(m=>m.content.startsWith('【故事回顾')))
})
for(const operation of ['edit','delete','retry','resend'])await test('R-08 '+operation+' invalidates stale content without synchronous archive write',async()=>{
  const f=chatFixture(pairs(['旧钥匙_MARK','后轮钥匙_MARK']))
  const originalGet=api.storyArchiveService.getStore;let opens=0;api.storyArchiveService.getStore=()=>{opens++;throw Error('sync archive forbidden')}
  const originalRun=api.chatService.runStream
  api.chatService.runStream=()=>Promise.resolve({status:'done',content:''})
  try{
    if(operation==='edit')api.chatService.updateMessage(f.s.id,'u0','新位置')
    if(operation==='delete')api.chatService.deleteMessage(f.s.id,'a0')
    if(operation==='retry')api.chatService.retry(f.s.id,'a1',{isDestroyed:()=>false,send(){}})
    if(operation==='resend')api.chatService.resendFrom(f.s.id,'u0','重新开始',{isDestroyed:()=>false,send(){}})
    assert.equal(opens,0)
    const text=await block(f)
    if(operation==='retry')assert.ok(!text.includes('后轮钥匙_MARK'))
    else assert.ok(!text.includes('旧钥匙_MARK'))
    if(operation==='resend')assert.ok(!text.includes('后轮钥匙_MARK'))
  }finally{api.storyArchiveService.getStore=originalGet;api.chatService.runStream=originalRun;api.chatService.inflight.delete(f.s.id);api.chatService.turns.delete(f.s.id)}
})
await settle()
await test('R-08 lazy next access rebuilds edited round and only new version can return',async()=>{
  const f=chatFixture(pairs(['钥匙原来在甲']))
  api.chatService.updateMessage(f.s.id,'u0','钥匙现在交给乙')
  assert.equal(await block(f),'');await settle()
  assert.ok((await block(f)).includes('钥匙现在交给乙'))
})
await settle()
// Use the production deriveBranch: copied IDs are different and copiedFrom retains one hop.
function realParent(body) {
  const {meta,sessionId}=api.createStory({title:'recall-real-derive'})
  api.chatService.appendMessages(sessionId,body)
  const s=api.chatService.sessions.find(s=>s.id===sessionId)
  const store=api.storyArchiveStore(meta.storyId);archive(store,s)
  api.branchStore.ensure(meta.storyId,[{id:s.id,title:s.title,createdAt:s.createdAt}])
  return {s,store,service:api.storyMemory(meta.storyId)}
}
function derive(f,index=f.s.messages.length-1) {
  const {sessionId}=api.deriveBranch({storyId:f.s.storyId,fromSessionId:f.s.id,fromMessageId:f.s.messages[index].id})
  const s=api.chatService.sessions.find(s=>s.id===sessionId)
  return {s,store:f.store,service:f.service}
}
const realOptions=f=>options(f.s,{bounds:api.branchVisibility(f.s.storyId,f.s.id).bounds})
await test('real derive rekeys messages and recalls only source prefix before child indexing',async()=>{
  const parent=realParent(pairs(['钥匙_PREFIX','钥匙_SOURCE_SUFFIX']))
  const child=derive(parent,1)
  assert.notEqual(child.s.messages[0].id,parent.s.messages[0].id)
  assert.equal(child.s.messages[0].copiedFromMessageId,parent.s.messages[0].id)
  const text=await block(child,realOptions(child))
  assert.ok(text.includes('钥匙_PREFIX'));assert.ok(!text.includes('钥匙_SOURCE_SUFFIX'))
  await settle()
  const indexed=await block(child,realOptions(child))
  assert.equal((indexed.match(/【第 1 轮/g)||[]).length,1)
})
await settle()
await test('real derive and second generation never recall aborted source body',async()=>{
  const parent=realParent(pairs(['钥匙_ABORTED']))
  const a=parent.s.messages[1];parent.store.setStoryMessageState(parent.s.id,a.id,api.contentVersion([a]),true)
  const child=derive(parent)
  assert.equal(await block(child,realOptions(child)),'');await settle()
  assert.equal(child.store.getStoryMessageState(child.s.id,child.s.messages[1].id,api.contentVersion([child.s.messages[1]])),true)
  const grandchild=derive(child)
  assert.equal(await block(grandchild,realOptions(grandchild)),'');await settle()
  assert.equal(await block(grandchild,realOptions(grandchild)),'')
})
await settle()
await test('real derive source version is rejected immediately after child edit, then lazily rebuilt',async()=>{
  const parent=realParent(pairs(['钥匙_OLD_SOURCE']))
  const child=derive(parent);await block(child,realOptions(child));await settle()
  api.chatService.updateMessage(child.s.id,child.s.messages[0].id,'钥匙_NEW_CHILD')
  assert.equal(await block(child,realOptions(child)),'');await settle()
  const text=await block(child,realOptions(child));assert.ok(text.includes('钥匙_NEW_CHILD'),JSON.stringify({text,query:api.buildStoryQuery(child.s.messages),rows:child.store.listStoryRounds(child.s.storyId,[tenant],[child.s.id])}))
  assert.ok(text.includes('【用户】钥匙_NEW_CHILD'))
})
await settle()
await test('streaming placeholder does not consume current-input query budget',()=>{
  const q=api.buildStoryQuery([...pairs(['钥匙背景'.repeat(100)]),msg('next','user','CURRENT_INPUT'),msg('pending','assistant','',{status:'streaming'})])
  assert.ok(q.endsWith('CURRENT_INPUT'));assert.ok(q.length<=1200)
})
await test('real delete during embedding await leaves no resurrected directory or prompt',async()=>{
  const f=realParent(pairs(['钥匙_DELETE_RACE']))
  const file=path.join(dir,'stories',f.s.storyId,'memory.db')
  sql(file,db=>db.prepare('UPDATE story_chunks SET embedding=?').run(Buffer.from(new Float32Array([1,0]).buffer)))
  let release,entered;const ready=new Promise(r=>entered=r);const old=api.embedder.embedOne
  api.embedder.embedOne=()=>{entered();return new Promise(r=>release=r)}
  try{
    const pending=block(f,realOptions(f));await ready
    const deletion=api.deleteStory(f.s.storyId,{confirmed:true});assert.equal(deletion.ok,true,JSON.stringify(deletion))
    release(new Float32Array([1,0]));assert.equal(await pending,'');await settle()
    assert.equal(fs.existsSync(path.dirname(file)),false)
  }finally{api.embedder.embedOne=old}
})
await settle()
await test('deleting story removes all tables with physical database through existing cleanup',()=>{
  const f=chatFixture(pairs(['钥匙待删除']))
  api.closeStoryMemory(f.s.storyId)
  api.chatService.deleteSessionsByStory(f.s.storyId)
  assert.equal(api.storyStore.removeDir(f.s.storyId),true)
  assert.equal(fs.existsSync(path.join(dir,'stories',f.s.storyId,'memory.db')),false)
})
await settle()
for(const store of stores)store.close()
api.closeAllStoryMemory();api.memoryService.dispose()
fs.rmSync(dir,{recursive:true,force:true})
done()
