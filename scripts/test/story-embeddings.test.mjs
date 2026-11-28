/** Q4: real archive/store/snapshot/retriever + controlled offline embedder. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { JSDOM } from 'jsdom'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-q4-'))
installElectronStub(root)
const api = await bundleModule('q4-embeddings', [
 ['MemoryStore','src/main/features/rag/store.ts'],
 ['StoryArchiveService','src/main/features/rag/storyArchive.ts'],
 ['embedder','src/main/features/rag/embedder.ts'],
 ['configureEmbeddingThrottle, startEmbeddingBackfill, cancelEmbeddingBackfill, waitForEmbeddingBackfill, embeddingProgress, onEmbeddingProgress, autoEmbeddingBackfill, embedStoryChunks','src/main/features/rag/embedPendings.ts'],
 ['storyRecallStatus','src/main/features/story/recallStatus.ts'],
 ['recallStory','src/main/features/rag/retriever.ts']
].map(([names,file])=>'export { '+names+' } from '+JSON.stringify(p(file))).join(String.fromCharCode(10)))
api.configureEmbeddingThrottle({ batch: 16, gapMs: 0 })
const { check, done } = createChecker()
async function test(name, fn) { try { await fn(); check(name,true) } catch (e) { check(name,false,e.stack) } }
const dims=1024, vec=()=>Float32Array.from({length:dims},(_,i)=>i===0?1:0)
let mode='ready', calls=0, hook=null
api.embedder.status=()=>({ready:mode==='ready',dimensions:dims,lastError:mode==='ready'?null:'fixture model offline'})
api.embedder.modelInstalled=()=>mode==='ready'
api.embedder.ensure=async()=>mode==='ready'?{}:null
api.embedder.embed=async texts=>{calls++;if(hook)await hook();return mode==='ready'?texts.map(vec):null}
api.embedder.embedOne=async()=>vec()
let seq=0
function fixture(count=1) {
 const id='story_q4'+(++seq)+'_abcdef', directory=path.join(root,'stories',id)
 fs.mkdirSync(directory,{recursive:true}); const file=path.join(directory,'memory.db'), store=new api.MemoryStore(file)
 for(let i=0;i<count;i++) store.upsertStoryRound(input(id,i))
 store.close();return {id,file,directory}
}
function input(id,i=0) {return {storyId:id,branchId:'branch',roundIndex:i,tenantUser:'root',tenantPersona:'default',firstMessageId:'u'+i,lastMessageId:'a'+i,contentVersion:'v'+i,roles:['user','assistant'],startedAt:1,chunks:[{index:0,text:'hidden ocean '+i,startOffset:0,endOffset:13+i.toString().length}]}}
function sql(f,run){const db=new DatabaseSync(f.file);try{return run(db)}finally{db.close()}}
const nulls=f=>sql(f,db=>Number(db.prepare('SELECT COUNT(*) n FROM story_chunks WHERE embedding IS NULL').get().n))
const rounds=f=>sql(f,db=>db.prepare('SELECT * FROM story_rounds ORDER BY id').all())
async function fill(){api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()}
const settle=async()=>{for(let i=0;i<100;i++)await new Promise(resolve=>setImmediate(resolve))}
let archiveFixture
await test('D-01 archive defers embeddings then backfill increments vector rounds',async()=>{
 const initialCalls=calls
 archiveFixture=fixture(0);const store=new api.MemoryStore(archiveFixture.file)
 const service=new api.StoryArchiveService(()=>store)
 const messages=[{id:'u',role:'user',content:'ocean',createdAt:1,status:'done'},{id:'a',role:'assistant',content:'waves',createdAt:2,status:'done'}]
 service.schedule({id:'branch',storyId:archiveFixture.id,messages},{storyId:archiveFixture.id},{userId:'root',personaId:'default'})
 await settle();store.close();assert.equal(nulls(archiveFixture),1);assert.equal(calls,initialCalls)
 assert.equal(api.storyRecallStatus().pendingChunks,1)
 await api.waitForEmbeddingBackfill();assert.equal(nulls(archiveFixture),0);assert.equal(rounds(archiveFixture).length,1)
 assert.equal(api.storyRecallStatus().vectorRounds,1)
})
let offline
await test('D-02 unavailable model preserves archive with visible pending reason',async()=>{
 mode='offline';offline=fixture(0);const store=new api.MemoryStore(offline.file),service=new api.StoryArchiveService(()=>store)
 service.schedule({id:'branch',storyId:offline.id,messages:[{id:'u',role:'user',content:'offline',createdAt:1,status:'done'},{id:'a',role:'assistant',content:'saved',createdAt:2,status:'done'}]},{storyId:offline.id},{userId:'root',personaId:'default'})
 await settle();store.close();assert.equal(rounds(offline).length,1);assert.equal(nulls(offline),1)
 assert.match(api.storyRecallStatus().pendingError,/offline/);mode='ready';assert.equal(api.storyRecallStatus().pendingRounds,1)
})
const many=fixture(35)
await test('D-03/D-09 all historical NULL chunks filled with observable progress',async()=>{
 const events=[];const off=api.onEmbeddingProgress(e=>events.push(e));const before=api.storyRecallStatus();assert.equal(before.pendingChunks,36)
 await fill();off();assert.equal(nulls(many),0);assert.equal(nulls(offline),0)
 assert.equal(api.storyRecallStatus().pendingChunks,0);assert.equal(api.storyRecallStatus().vectorRounds,37)
 assert.ok(events.some(e=>e.backfilling?.done>0));assert.equal(events.at(-1).backfilling,null)
})
await test('D-04 second run has zero embed calls and leaves all rows/timestamps unchanged',async()=>{
 const before=sql(many,db=>db.prepare('SELECT * FROM story_chunks').all()), previous=calls
 await fill();assert.equal(calls,previous);assert.deepEqual(sql(many,db=>db.prepare('SELECT * FROM story_chunks').all()),before)
})
await test('D-05 concurrent changed content version is skipped',async()=>{
 const f=fixture();hook=async()=>{hook=null;sql(f,db=>db.prepare("UPDATE story_chunks SET content_version='new',text='changed'").run())}
 await fill();assert.equal(nulls(f),1);assert.equal(sql(f,db=>db.prepare('SELECT content_version FROM story_chunks').get().content_version),'new')
 await fill();assert.equal(nulls(f),0)
})
await test('D-06 cancellation preserves committed batches and resumes',async()=>{
 const f=fixture(40);let once=false;const off=api.onEmbeddingProgress(e=>{if(!once&&e.backfilling?.done>=16){once=true;api.cancelEmbeddingBackfill()}})
 await fill();off();assert.equal(nulls(f),24);await fill();assert.equal(nulls(f),0)
})
await test('D-07 concurrent trigger reports running and starts only one job',async()=>{
 fixture();let release;hook=()=>new Promise(resolve=>{release=resolve})
 assert.equal(api.startEmbeddingBackfill().started,true);assert.deepEqual(api.startEmbeddingBackfill(),{started:false,reason:'正在补算'})
 while(!release)await new Promise(resolve=>setImmediate(resolve));hook=null;release();await api.waitForEmbeddingBackfill()
})
await test('D-08 no keyword overlap still produces semantic score',async()=>{
 const store=new api.MemoryStore(many.file),hits=await api.recallStory(store,'unrelated query',{rounds:rounds(many),config:{enabled:true,n:1,minScore:.4,keywordWeight:.5,budgetTokens:4000,recheckDepth:0}})
 store.close();assert.equal(hits.length,1);assert.ok(hits[0].score>.99)
})
await test('D-10/D-11 rows and versions unchanged; integrity and no new sidecars',async()=>{
 const f=fixture(18),before=rounds(f);assert.equal(fs.existsSync(f.file+'-wal'),false)
 await fill();assert.deepEqual(rounds(f),before);assert.equal(sql(f,db=>db.prepare('PRAGMA integrity_check').get().integrity_check),'ok')
 assert.equal(fs.existsSync(f.file+'-wal'),false);assert.equal(fs.existsSync(f.file+'-shm'),false)
 const beforeFiles=fs.readdirSync(f.directory);api.storyRecallStatus();assert.deepEqual(fs.readdirSync(f.directory),beforeFiles)
})
await test('D-02 malformed model result writes no partial batch and supports retry',async()=>{
 const f=fixture(2),original=api.embedder.embed;api.embedder.embed=async()=>[vec()]
 await fill();assert.equal(nulls(f),2);assert.match(api.embeddingProgress().pendingError,/数量/)
 api.embedder.embed=original;await fill();assert.equal(nulls(f),0)
})
await test('S3 different existing dimensions stop before any pending writes',async()=>{
 const f=fixture(2);sql(f,db=>db.prepare('UPDATE story_chunks SET embedding=? WHERE chunk_index=0 AND round_id LIKE ?').run(Buffer.alloc(8),'%:0'))
 await fill();assert.equal(nulls(f),1);assert.match(api.embeddingProgress().pendingError,/维度/)
 sql(f,db=>db.prepare('UPDATE story_chunks SET embedding=NULL').run());await fill()
})
await test('startup pass automatically fills existing pending rows',async()=>{
 const f=fixture();await api.autoEmbeddingBackfill();assert.equal(nulls(f),0)
})
await test('archive persists before inference; forget never rolls back written rounds',async()=>{
 const f=fixture(0),store=new api.MemoryStore(f.file),service=new api.StoryArchiveService(()=>store)
 let release;hook=()=>new Promise(resolve=>{release=resolve})
 const session={id:'b',storyId:f.id,messages:[{id:'a',role:'assistant',content:'old',createdAt:1,status:'done'}]}
 service.schedule(session,{storyId:f.id},{userId:'root',personaId:'default'})
 // Q7 persists before inference; forget prevents future archive writes, not committed history.
 await settle();assert.equal(rounds(f).length,1)
 while(!release)await new Promise(resolve=>setImmediate(resolve))
 service.forget(f.id);hook=null;release();await api.waitForEmbeddingBackfill();store.close()
 assert.equal(rounds(f).length,1);assert.equal(fs.existsSync(f.directory),true)
})
await test('successful archive retry publishes cleared model error',async()=>{
 const events=[],off=api.onEmbeddingProgress(e=>events.push(e));mode='offline'
 await api.embedStoryChunks('retry', ['x']);assert.ok(events.at(-1).pendingError)
 mode='ready';await api.embedStoryChunks('retry',['x']);assert.equal(events.at(-1).pendingError,null);off()
})
await test('same-version foreground vector survives late backfill',async()=>{
 const f=fixture(),other=vec();other[1]=0.5
 hook=async()=>{hook=null;sql(f,db=>db.prepare('UPDATE story_chunks SET embedding=?').run(Buffer.from(other.buffer)))}
 await fill();assert.deepEqual(sql(f,db=>db.prepare('SELECT embedding FROM story_chunks').get().embedding),new Uint8Array(other.buffer))
})
await test('deleted database is never recreated by an in-flight batch',async()=>{
 const f=fixture();hook=async()=>{hook=null;fs.rmSync(f.directory,{recursive:true,force:true})}
 await fill();assert.equal(fs.existsSync(f.directory),false);assert.ok(api.embeddingProgress().pendingError)
})
await test('startup malformed DB error is contained and reported',async()=>{
 const directory=path.join(root,'stories','story_corrupt_abcdef');fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'memory.db'),'broken')
 await api.autoEmbeddingBackfill();assert.ok(api.embeddingProgress().pendingError);fs.rmSync(directory,{recursive:true,force:true})
})
await test('D-09 real panel renders counters/progress and unsubscribes on unmount',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'})
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
 let listener,unsubscribed=false,triggered=0
 window.nahida={story:{recallStatus:async()=>({...api.storyRecallStatus(),pendingRounds:3,pendingChunks:8}),backfillEmbeddings:async()=>{triggered++;return {started:true}},onEmbeddingProgress:fn=>{listener=fn;return ()=>{unsubscribed=true}}}}
 const ui=await bundleModule('q4-panel',[ 'export { createElement, act } from '+JSON.stringify(p('node_modules/react/index.js')), 'export { createRoot } from '+JSON.stringify(p('node_modules/react-dom/client.js')), 'export { StoryRecallPanel } from '+JSON.stringify(p('src/renderer/src/features/settings/sections/StoryRecallPanel.tsx'))].join(String.fromCharCode(10)))
 const renderer=ui.createRoot(document.getElementById('root'));await ui.act(async()=>renderer.render(ui.createElement(ui.StoryRecallPanel,{settings:{},saving:false,save:async()=>true})))
 assert.match(document.body.textContent,/3（8 个分片）/)
 await ui.act(async()=>{document.querySelector('[data-ui-target="补算故事向量"]').click()});assert.equal(triggered,1)
 window.nahida.story.recallStatus=async()=>({...api.storyRecallStatus(),pendingRounds:3,pendingChunks:8,backfilling:{done:16,total:40}})
 await ui.act(async()=>listener({backfilling:{done:16,total:40},pendingError:null}))
 assert.ok(document.body.textContent.includes('16 / 40'));assert.ok(document.querySelector('[data-ui-target="补算故事向量"]').disabled)
 await ui.act(async()=>renderer.unmount());assert.ok(unsubscribed);dom.window.close()
})
fs.rmSync(root,{recursive:true,force:true})
done()
// The existing bundled UI graph holds library handles after unmount (same harness as option-cards).
process.exit(process.exitCode ?? 0)
