/** Q7: real archive/import/store and worker; only model and Electron are fixtures. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { bundleModule, installElectronStub, p, createChecker } from './qq-test-util.mjs'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nc-q7-'))
installElectronStub(root)
const api=await bundleModule('q7-archive', [
 ['MemoryStore','rag/store'],['StoryArchiveService','rag/storyArchive'],['embedder','rag/embedder'],
 ['configureEmbeddingThrottle,requestEmbeddingBackfill,startEmbeddingBackfill,cancelEmbeddingBackfill,waitForEmbeddingBackfill,embeddingProgress,onEmbeddingProgress','rag/embedPendings'],
 ['storyRecallStatus','story/recallStatus'],['recallStory','rag/retriever'],
 ['transferService','transfer/service'],['chatService','chat/chatService'],
 ['storyMemory,closeAllStoryMemory','story/memory']
].map(([names,file])=>'export { '+names+' } from '+JSON.stringify(p('src/main/features/'+file+'.ts'))).join(String.fromCharCode(10)))
const {check,done}=createChecker()
const vector=()=>Float32Array.from({length:1024},(_,i)=>i===0?1:0)
let calls=0,ensures=0,hook=null,order=[],seq=0
api.embedder.status=()=>({ready:true,dimensions:1024,lastError:null})
api.embedder.modelInstalled=()=>true
api.embedder.ensure=async()=>{ensures++;return {}}
api.embedder.embed=async texts=>{calls++;order.push(...texts);if(hook)await hook();return texts.map(vector)}
api.embedder.embedOne=async()=>null
const guard=setTimeout(()=>{console.error('Q7 timeout');process.exit(1)},30000);guard.unref()
const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function until(fn,timeout=5000){const end=performance.now()+timeout;while(!fn()){assert.ok(performance.now()<end,'condition deadline');await tick()}}
const sql=(f,fn)=>{const db=new DatabaseSync(f.file);try{return fn(db)}finally{db.close()}}
const nulls=f=>sql(f,db=>db.prepare("SELECT 1 FROM sqlite_master WHERE name='story_chunks'").get()?Number(db.prepare('SELECT count(*) n FROM story_chunks WHERE embedding IS NULL').get().n):0)
function input(id,i,branch='b',time=i){return {storyId:id,branchId:branch,roundIndex:i,tenantUser:'root',tenantPersona:'default',firstMessageId:'u'+i,lastMessageId:'a'+i,contentVersion:'v'+i,roles:['user','assistant'],startedAt:time,chunks:[{index:0,text:'ocean waves '+branch+' '+i,startOffset:0,endOffset:15}]}}
function fixture(count=0){const id='story_q7'+(++seq)+'_abcdef',directory=path.join(root,'stories',id);fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'memory.db'),store=new api.MemoryStore(file);for(let i=0;i<count;i++)store.upsertStoryRound(input(id,i));store.close();return {id,file,directory}}
async function test(name,fn){try{await fn();check(name,true)}catch(e){check(name,false,e.stack)}finally{hook=null;api.cancelEmbeddingBackfill();await api.waitForEmbeddingBackfill()}}
try {
 // Exercise untouched production defaults before opting legacy cases into 16/0.
 await test('Y-01/Y-02/Y-06 default batches and breathing gaps preserve progress',async()=>{
  const f=fixture(10),events=[],sizes=[],times=[],before=calls
  hook=()=>{sizes.push(order.length-(sizes.reduce((a,b)=>a+b,0)));times.push(performance.now())}
  order=[]
  const off=api.onEmbeddingProgress(e=>events.push({time:performance.now(),state:e}))
  try {
   api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()
   assert.deepEqual(sizes,[4,4,2]);assert.equal(calls-before,3)
   const completed=events.filter(e=>e.state.backfilling?.done>0)
   assert.deepEqual(completed.map(e=>e.state.backfilling.done),[4,8,10])
   const gaps=completed.slice(1).map((e,i)=>e.time-completed[i].time)
   assert.ok(gaps.every(gap=>gap>=120),JSON.stringify(gaps))
   assert.equal(events.at(-1).state.backfilling,null);assert.equal(nulls(f),0)
   assert.equal(api.storyRecallStatus().pendingChunks,0)
   console.log('Q75_DEFAULT',JSON.stringify({sizes,gaps}))
  } finally {off()}
 })
 await test('Y-05 cancel during breathing gap preserves first committed batch',async()=>{
  const f=fixture(10),before=calls;let cancellation
  const off=api.onEmbeddingProgress(e=>{
   if(e.backfilling?.done===4&&!cancellation)cancellation=setImmediate(()=>api.cancelEmbeddingBackfill())
  })
  try {
   api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()
   assert.equal(calls-before,1);assert.equal(nulls(f),6)
   assert.equal(api.embeddingProgress().backfilling,null)
  } finally {off();if(cancellation)clearImmediate(cancellation)}
  hook=null;api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill();assert.equal(nulls(f),0)
 })
 await test('Y-03 configured 16/0 uses one batch and setImmediate rather than sleep',async()=>{
  api.configureEmbeddingThrottle({batch:16,gapMs:0})
  const f=fixture(10),before=calls,original=globalThis.setTimeout;let timers=0
  globalThis.setTimeout=(...args)=>{timers++;return original(...args)}
  try {api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()}finally{globalThis.setTimeout=original}
  assert.equal(calls-before,1);assert.equal(timers,0);assert.equal(nulls(f),0)
 })
 await test('Y-04 invalid throttle values leave current batch and gap unchanged',async()=>{
  for(const invalid of [{batch:0},{batch:-1},{batch:2.5},{gapMs:-1},{batch:NaN},{batch:Infinity},{gapMs:2.5}]){
   api.configureEmbeddingThrottle({batch:4,gapMs:150});api.configureEmbeddingThrottle(invalid)
   const f=fixture(10),before=calls,times=[];hook=()=>{times.push(performance.now())}
   api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()
   assert.equal(calls-before,3,JSON.stringify(invalid));assert.equal(nulls(f),0)
   assert.ok(times.slice(1).every((t,i)=>t-times[i]>=120),JSON.stringify(invalid))
  }
  api.configureEmbeddingThrottle({batch:16,gapMs:0})
 })
 api.configureEmbeddingThrottle({batch:16,gapMs:0})
 // Legacy checks assert global counters, so remove only the new cadence fixtures.
 fs.rmSync(path.join(root,'stories'),{recursive:true,force:true})
 await test('X-01/X-02 archive writes NULL without embed calls',async()=>{
  const f=fixture(),store=new api.MemoryStore(f.file),service=new api.StoryArchiveService(()=>store),before=calls
  service.schedule({id:'b',storyId:f.id,messages:[{id:'u',role:'user',content:'ocean',createdAt:1,status:'done'},{id:'a',role:'assistant',content:'waves',createdAt:2,status:'done'}]},{storyId:f.id},{userId:'root',personaId:'default'})
  await until(()=>nulls(f)===1);assert.equal(calls,before);assert.equal(api.storyRecallStatus().pendingChunks,1);assert.equal(api.embeddingProgress().backfilling,null);store.close()
  await api.waitForEmbeddingBackfill();assert.equal(nulls(f),0);assert.equal(api.storyRecallStatus().vectorRounds,1)
 })
 await test('X-03/X-06 delayed ten-request burst starts exactly one automatic pass',async()=>{
  const f=fixture(2),before=calls,start=ensures,t=performance.now()
  for(let i=0;i<10;i++)assert.equal(api.requestEmbeddingBackfill({storyId:f.id,branchId:'b'}),undefined)
  assert.equal(calls,before);assert.equal(api.embeddingProgress().backfilling,null)
  await api.waitForEmbeddingBackfill();assert.ok(performance.now()-t>=950);assert.equal(ensures-start,1);assert.equal(calls-before,1);assert.equal(nulls(f),0)
 })
 await test('X-04 newest rounds first with deterministic id ties',async()=>{
  const f=fixture(),store=new api.MemoryStore(f.file)
  for(const i of [2,0,1])store.upsertStoryRound(input(f.id,i,'b',i===0?1:3))
  store.close();order=[];api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()
  assert.deepEqual(order,['ocean waves b 1','ocean waves b 2','ocean waves b 0'])
 })
 await test('X-05 preferred story and branch precede newer other branches',async()=>{
  const other=fixture(1),f=fixture(),store=new api.MemoryStore(f.file)
  store.upsertStoryRound(input(f.id,0,'other',999));store.upsertStoryRound(input(f.id,1,'current',1));store.close();order=[]
  api.requestEmbeddingBackfill({storyId:f.id,branchId:'current'});await api.waitForEmbeddingBackfill()
  assert.deepEqual(order,['ocean waves current 1','ocean waves other 0','ocean waves b 0']);assert.equal(nulls(other),0)
 })
 await test('X-07 second pass has zero writes and zero inference',async()=>{
  const f=fixture(2);api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()
  const before=sql(f,db=>db.prepare('SELECT * FROM story_chunks ORDER BY id').all()),n=calls
  api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill();assert.equal(calls,n);assert.deepEqual(sql(f,db=>db.prepare('SELECT * FROM story_chunks ORDER BY id').all()),before)
 })
 await test('X-11 WAL is truncated while a writable connection stays open',async()=>{
  const f=fixture(33),db=new DatabaseSync(f.file);db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE story_chunks SET embedding=NULL')
  try{api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill();assert.equal(nulls(f),0);assert.equal(fs.existsSync(f.file+'-wal')?fs.statSync(f.file+'-wal').size:0,0)}finally{db.close()}
 })
 await test('X-12 NULL vectors retain keyword score',async()=>{
  const f=fixture(1),store=new api.MemoryStore(f.file)
  try {const rounds=sql(f,db=>db.prepare('SELECT * FROM story_rounds').all());const hits=await api.recallStory(store,'ocean waves b 0',{rounds,config:{enabled:true,n:1,minScore:.01,keywordWeight:.5,budgetTokens:4000,recheckDepth:0}});assert.equal(hits.length,1);assert.ok(hits[0].score>0&&hits[0].score<=.5)}finally{store.close()}
  api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()
 })
 await test('X-17 wait returns after captured pass, dirty requests are preserved',async()=>{
  const f=fixture(1);let release,entered=false
  hook=()=>{entered=true;return new Promise(r=>{release=r})}
  api.startEmbeddingBackfill();await until(()=>entered)
  for(let i=0;i<10;i++)api.requestEmbeddingBackfill({storyId:f.id,branchId:'b'})
  const start=ensures,waiting=api.waitForEmbeddingBackfill();hook=null;release();await waiting
  assert.equal(ensures,start,'wait must not follow delayed pass')
  const store=new api.MemoryStore(f.file);store.upsertStoryRound(input(f.id,2));store.close()
  await api.waitForEmbeddingBackfill();assert.equal(ensures,start+1);assert.equal(nulls(f),0)
 })
 async function importedRecall(count){
  const characterId='q7-fixture',source=path.join(root,'import.jsonl')
  fs.mkdirSync(path.join(root,'Prompt','characters',characterId),{recursive:true})
  fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({defaultCharacterId:characterId,userName:'User'}))
  const rows=[{user_name:'User',character_name:characterId}]
  for(let i=0;i<count;i++)rows.push({name:'User',is_user:true,mes:'question '+i,send_date:1700000000+i*2},{name:characterId,is_user:false,mes:('ocean answer '+i+' ').repeat(60),send_date:1700000001+i*2})
  fs.writeFileSync(source,rows.map(x=>JSON.stringify(x)).join(String.fromCharCode(10)))
  const {dialog}=createRequire(import.meta.url)('electron');dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]})
  const preview=await api.transferService.pickImport(),before=calls,t=performance.now()
  const result=await api.transferService.import({token:preview.token,target:{kind:'new-story',characterId},title:'Q7 import'})
  const importMs=+(performance.now()-t).toFixed(2)
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.messageCount,count*2);assert.equal(calls,before)
  const f={file:path.join(root,'stories',result.storyId,'memory.db')}
  const session=api.chatService.listSessions().find(s=>s.id===result.sessionIds[0])
  assert.ok(session);assert.equal(session.mode,'story')
  const roundCount=()=>sql(f,db=>db.prepare("SELECT 1 FROM sqlite_master WHERE name='story_rounds'").get()?Number(db.prepare('SELECT count(*) n FROM story_rounds').get().n):0)
  const memory=api.storyMemory(result.storyId),histogram=monitorEventLoopDelay({resolution:20})
  histogram.enable()
  // Prime the monitor before work; the measured interval includes the final drain yield.
  await new Promise(resolve=>setTimeout(resolve,25))
  const archiveStart=performance.now()
  try {
   await memory.buildStoryContextBlock(session,
    {enabled:true,n:3,minScore:.4,keywordWeight:.5,budgetTokens:4000},
    {storyId:result.storyId,branchId:session.id,tenants:[{userId:'root',personaId:'default'}],bounds:new Map([[session.id,null]]),recentMessageIds:new Set()})
   await until(()=>roundCount()===count,30000)
   await tick()
  } finally {histogram.disable()}
  const archiveMs=+(performance.now()-archiveStart).toFixed(2),maxBlockMs=+(histogram.max/1e6).toFixed(2)
  console.log('Q7_FIRST_SEND',JSON.stringify({rounds:count,importMs,archiveMs,maxBlockMs,embedCalls:calls-before}))
  assert.equal(calls,before,'archive path must not infer vectors')
  assert.ok(nulls(f)>=count);assert.ok(archiveMs<3000,'archive target is below 3 seconds; review evidence on failure')
  assert.ok(maxBlockMs<1000,'continuous event-loop block must stay below one second')
  await api.waitForEmbeddingBackfill();assert.equal(nulls(f),0);assert.ok(calls>before)
  assert.equal(api.storyRecallStatus().pendingChunks,0)
 }
 await test('X-13 real import then production recall archives and automatically backfills 30 rounds',()=>importedRecall(30))
 await test('X-18/X-19 first recall archives 250 rounds without inference or long event-loop blocks',()=>importedRecall(250))
} finally {api.cancelEmbeddingBackfill();await api.waitForEmbeddingBackfill();clearTimeout(guard);api.closeAllStoryMemory()}
done()
