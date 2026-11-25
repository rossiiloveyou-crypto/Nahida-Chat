/** Q4.5: real facade/SQLite/React, isolated source plus A/B copies, offline vectors. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { JSDOM } from 'jsdom'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nc-q45-'))
installElectronStub(root)
fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({provider:'mock',memory:{enabled:false,autoExtract:false},bridge:{enabled:false},summary:{enabled:false}}))
const api=await bundleModule('q45',[
 ['MemoryStore','src/main/features/rag/store.ts'],
 ['MemoryService, memoryService','src/main/features/rag/index.ts'],
 ['recallStory, formatStoryRecall, formatStoryRecallReport, normalizeStoryRecall','src/main/features/rag/retriever.ts'],
 ['splitRounds, sliceRound, contentVersion, storyArchiveService','src/main/features/rag/storyArchive.ts'],
 ['storyRecallStatus','src/main/features/story/recallStatus.ts'],
 ['embedder','src/main/features/rag/embedder.ts'],
 ['estimateTokens','src/main/features/rag/tokenize.ts']
].map(([names,file])=>'export { '+names+' } from '+JSON.stringify(p(file))).join(String.fromCharCode(10)))
const {check,done}=createChecker()
async function test(name,fn){try{await fn();check(name,true)}catch(e){check(name,false,e.stack)}}
const config={...api.normalizeStoryRecall(),n:10,recheckDepth:0,budgetTokens:10000}
api.embedder.embedOne=async()=>Float32Array.from([1,0])
api.embedder.status=()=>({ready:true,lastError:null})
api.embedder.modelInstalled=()=>true
// Suppress unrelated asynchronous archiving in this injection test; the archive is seeded below.
api.storyArchiveService.schedule=()=>{}
const msg=(id,role,content)=>({id,role,content,createdAt:1,status:'done'})
const sourceDir=path.join(root,'stories','story_q45_abcdef')
fs.mkdirSync(sourceDir,{recursive:true})
const source=path.join(sourceDir,'memory.db')
const session={id:'branch',mode:'story',storyId:'story_q45_abcdef',messages:[
 msg('u0','user','hidden ocean'),msg('a0','assistant','silver reef'),
 msg('u1','user','amber moon'),msg('a1','assistant','silent night'),
 msg('u2','user','copper forest'),msg('a2','assistant','green leaves'),
 // The real query retains the last two rounds plus trailing input; round zero has no shared token.
 msg('next','user',('quantum topology ').repeat(80))]}
const seed=new api.MemoryStore(source)
for(const round of api.splitRounds(session.messages).rounds) seed.upsertStoryRound({storyId:session.storyId,branchId:session.id,roundIndex:round.index,tenantUser:'root',tenantPersona:'default',firstMessageId:round.messages[0].id,lastMessageId:round.messages.at(-1).id,contentVersion:api.contentVersion(round.messages),roles:round.messages.map(m=>m.role),startedAt:1,chunks:api.sliceRound(round)})
seed.close()
function sql(file,fn){const db=new DatabaseSync(file);try{return fn(db)}finally{db.close()}}
sql(source,db=>db.prepare('UPDATE story_chunks SET embedding=?').run(Buffer.from(new Float32Array([0.8,0.6]).buffer)))
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const count=file=>sql(file,db=>Number(db.prepare('SELECT COUNT(*) n FROM story_chunks WHERE embedding IS NOT NULL').get().n))
const before={hash:hash(source),count:count(source),files:fs.readdirSync(sourceDir)}
const a=path.join(root,'a.db'),b=path.join(root,'b.db')
fs.copyFileSync(source,a);fs.copyFileSync(source,b)
sql(b,db=>db.exec('UPDATE story_chunks SET embedding=NULL'))
const stores=[]
const options={storyId:session.storyId,branchId:session.id,tenants:[{userId:'root',personaId:'default'}],bounds:new Map([[session.id,null]]),recentMessageIds:new Set()}
async function inject(file,cfg=config){const store=new api.MemoryStore(file);stores.push(store);return new api.MemoryService(store).buildStoryContextBlock(session,cfg,options)}
let textA,textB,reportA,reportB
await test('N-01 initial report is null',()=>assert.equal(api.storyRecallStatus().lastRecall,null))
await test('N-01 actual injection writes exact count and top3 metadata',async()=>{
 textA=await inject(a);reportA=api.storyRecallStatus().lastRecall
 assert.ok(textA);assert.equal(reportA.hitRounds,(textA.match(/【来源：/g)||[]).length)
 assert.equal(reportA.top.length,3);assert.ok(reportA.at>0);assert.equal(reportA.dropped,0)
})
await test('N-03 scores equal hand-computed cosine and zero lexical overlap',()=>{
 for(const h of reportA.top){assert.ok(Math.abs(h.vectorScore-0.8)<1e-6);assert.equal(h.keywordScore,h.roundIndex===0?0:1)}
})
await test('N-04 same query NULL-vector copy changes actual injected text',async()=>{
 textB=await inject(b);reportB=api.storyRecallStatus().lastRecall
 assert.notEqual(textA,textB);assert.equal(reportB.hitRounds,2);assert.ok(reportB.top.every(h=>h.vectorScore===0))
 assert.ok(reportA.top.some(h=>h.vectorScore>0&&h.keywordScore===0))
 const store=stores.at(-1),rs=store.listStoryRounds(session.storyId,options.tenants,[session.id])
 const hits=await api.recallStory(store,'hidden ocean',{config,rounds:rs})
 assert.ok(hits.length);assert.ok(hits.every(h=>h.vectorScore===0));assert.equal(hits[0].keywordScore,1)
})
await test('N-02 three hits one-round budget records both omitted rounds',async()=>{
 const store=stores[0],rs=store.listStoryRounds(session.storyId,options.tenants,[session.id])
 const hits=await api.recallStory(store,'quantum topology',{config,rounds:rs})
 const budget=Math.max(...hits.map(h=>api.estimateTokens(api.formatStoryRecall([h],10000))))
 const formatted=api.formatStoryRecallReport(hits,budget)
 assert.equal(formatted.selected.length,1);assert.equal(formatted.dropped,2)
 const text=await inject(a,{...config,budgetTokens:budget})
 const report=api.storyRecallStatus().lastRecall
 assert.equal(report.hitRounds,1);assert.equal(report.dropped,2);assert.equal(report.budgetLimited,true)
 assert.equal((text.match(/【来源：/g)||[]).length,1)
})
await test('N-03 multi-chunk components belong to winning chunk, not independent maxima',async()=>{
 const round=stores[0].listStoryRounds(session.storyId,options.tenants,[session.id])[0]
 const chunks=[{round_id:round.id,content_version:round.content_version,chunk_index:0,text:'quantum ',start_offset:0,end_offset:8,embedding:new Uint8Array(new Float32Array([0.8,0.6]).buffer)},
 {round_id:round.id,content_version:round.content_version,chunk_index:1,text:'ocean',start_offset:8,end_offset:13,embedding:new Uint8Array(new Float32Array([1,0]).buffer)}]
 const [hit]=await api.recallStory({listStoryChunks:()=>chunks},'quantum',{config,rounds:[round]})
 assert.equal(hit.score,1);assert.equal(hit.vectorScore,1);assert.equal(hit.keywordScore,0)
})
await test('N-02 N limit is not reported as budget loss',async()=>{
 await inject(a,{...config,n:1});assert.equal(api.storyRecallStatus().lastRecall.dropped,0)
})
await test('N-02 recheck chain removed by N is not a budget exclusion',async()=>{
 const base=stores[0].listStoryRounds(session.storyId,options.tenants,[session.id])[0]
 const texts=['xword','xword yword','yword'], vectors=[[1,0],[.85,.5267827],[0,1]]
 const rounds=texts.map((_,i)=>({...base,id:'chain'+i,round_index:i}))
 let dropped=-1
 const hits=await api.recallStory({listStoryChunks:id=>{const i=rounds.findIndex(r=>r.id===id);return [{round_id:id,content_version:base.content_version,chunk_index:0,text:texts[i],start_offset:0,end_offset:texts[i].length,embedding:new Uint8Array(new Float32Array(vectors[i]).buffer)}]}},'xword yword',{
 config:{...config,n:1,recheckDepth:32,keywordWeight:.2,minScore:.01},rounds,onBudgetDropped:n=>{dropped=n}})
 assert.equal(hits.length,0);assert.equal(dropped,0)
})
await test('N-02 budget-excluded newer state also counts suppressed old state',async()=>{
 const base=stores[0].listStoryRounds(session.storyId,options.tenants,[session.id])[0]
 const texts=['xword','xword '+('longstory '.repeat(800))]
 const rounds=texts.map((_,i)=>({...base,id:'budgetchain'+i,round_index:i}))
 let dropped=-1
 const hits=await api.recallStory({listStoryChunks:id=>{const i=rounds.findIndex(r=>r.id===id);return [{round_id:id,content_version:base.content_version,chunk_index:0,text:texts[i],start_offset:0,end_offset:texts[i].length,embedding:null}]}},'xword',{
 config:{...config,n:2,recheckDepth:32,budgetTokens:300},rounds,onBudgetDropped:n=>{dropped=n}})
 assert.equal(hits.length,0);assert.equal(dropped,2)
})
await test('N-01 empty retrieval replaces previous report; stale session does not publish',async()=>{
 await inject(b,{...config,budgetTokens:0})
 assert.equal(api.storyRecallStatus().lastRecall.hitRounds,0)
 const before=api.storyRecallStatus().lastRecall
 const embed=api.embedder.embedOne
 api.embedder.embedOne=async()=>{session.messages.at(-1).content+=' changed';return Float32Array.from([1,0])}
 try{assert.equal(await inject(a),'');assert.deepEqual(api.storyRecallStatus().lastRecall,before)}
 finally{api.embedder.embedOne=embed;session.messages.at(-1).content=session.messages.at(-1).content.replace(' changed','')}
 await inject(a,{...config,n:1})
})
await test('N-01 status returns detached report data',()=>{
 const report=api.storyRecallStatus().lastRecall;report.top[0].vectorScore=-99
 assert.notEqual(api.storyRecallStatus().lastRecall.top[0].vectorScore,-99)
})
await test('N-05/N-06 source hash vectors and sidecars unchanged after A/B and snapshots',()=>{
 for(const store of stores)store.close()
 api.storyRecallStatus()
 assert.deepEqual({hash:hash(source),count:count(source),files:fs.readdirSync(sourceDir)},before)
 const code=fs.readFileSync(p('src/main/features/story/recallStatus.ts'),'utf8')
 assert.ok(code.includes('new DatabaseSync(snapshotDatabase(file, directory)'))
})
await test('N-07/N-08 real React panel empty/zero/populated values preserve targets',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'})
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
 let value={...api.storyRecallStatus(),lastRecall:null}
 window.nahida={story:{recallStatus:async()=>value,onEmbeddingProgress:()=>()=>{}}}
 const ui=await bundleModule('q45-ui',[
 'export { createElement, act } from '+JSON.stringify(p('node_modules/react/index.js')),
 'export { createRoot } from '+JSON.stringify(p('node_modules/react-dom/client.js')),
 'export { StoryRecallPanel } from '+JSON.stringify(p('src/renderer/src/features/settings/sections/StoryRecallPanel.tsx'))].join(String.fromCharCode(10)))
 const renderer=ui.createRoot(document.getElementById('root'))
 try{
 await ui.act(async()=>renderer.render(ui.createElement(ui.StoryRecallPanel,{settings:{},saving:false,save:async()=>true})))
 const targets=[...document.querySelectorAll('[data-ui-target]')].map(e=>e.dataset.uiTarget)
 assert.equal(document.querySelector('.story-recall-last').textContent,'暂无记录')
 value={...value,lastRecall:{...reportB,hitRounds:0,top:[]}}
 await ui.act(async()=>document.querySelector('[data-ui-target="刷新故事召回状态"]').click())
 assert.equal(document.querySelector('.story-recall-last').textContent,'0 轮')
 value={...value,lastRecall:{...reportA,dropped:2,top:[...reportA.top,...reportA.top]}}
 await ui.act(async()=>document.querySelector('[data-ui-target="刷新故事召回状态"]').click())
 assert.match(document.querySelector('.story-recall-last').textContent,/另有 2 轮/)
 assert.equal(document.querySelectorAll('.story-recall-components > div').length,3)
 assert.ok(document.querySelector('.story-recall-components').textContent.includes('向量 0.80 / 关键词 0.00'))
 assert.deepEqual([...document.querySelectorAll('[data-ui-target]')].map(e=>e.dataset.uiTarget),targets)
 }finally{await ui.act(async()=>renderer.unmount());dom.window.close()}
})
console.log('Q4.5 A/B evidence '+JSON.stringify({source:before,a:reportA,b:reportB,textAHash:createHash('sha256').update(textA??'').digest('hex'),textBHash:createHash('sha256').update(textB??'').digest('hex')}))
api.memoryService.dispose()
fs.rmSync(root,{recursive:true,force:true})
done()
// Same bundled React dependency handles as Q4; all owned DBs and DOM are closed first.
process.exit(process.exitCode??0)
