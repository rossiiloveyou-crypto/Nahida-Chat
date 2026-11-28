import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { JSDOM } from 'jsdom'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nc-q12-'))
installElectronStub(root)
const api=await bundleModule('q12', [
 ['sanitizeChunkText','rag/sanitize'],['sliceRound,storyArchiveService,contentVersion','rag/storyArchive'],
 ['rebuildStoryArchive','story/service'],['storyStore','story/store'],['closeAllStoryMemory,storyMemory,storyArchiveStore','story/memory'],['embedder','rag/embedder'],
 ['storyDbPath','story/paths'],['cancelEmbeddingBackfill,waitForEmbeddingBackfill,startEmbeddingBackfill','rag/embedPendings']
].map(([names,file])=>'export { '+names+' } from '+JSON.stringify(p('src/main/features/'+file+'.ts'))).join('\n'))
const guard=setTimeout(()=>{console.error('Q12 timeout');process.exit(1)},30000);guard.unref()
let count=0
const test=async(name,fn)=>{await fn();console.log('PASS '+name);count++}
const fence=String.fromCharCode(96).repeat(3)
try {
 const s=api.sanitizeChunkText
 const code=body=>fence+'json\n'+body+'\n'+fence
 await test('fenced bodies removed',()=>assert.equal(s('before\n'+code('{}')+'\nafter'),'before\nafter'))
 await test('summary and comment removed, game retained',()=>assert.equal(s('<summary>x</summary><game>正文</game><comment>y</comment>'),'<game>正文</game>'))
 await test('inline fence preserved',()=>assert.equal(s('story '+fence+' literal'),'story '+fence+' literal'))
 await test('unclosed fence preserved',()=>assert.equal(s('before\n'+fence+'json\n{}'),'before\n'+fence+'json\n{}'))
 await test('exact options only',()=>assert.equal(s('<optionsHint>x</optionsHint>story<OPTIONS a="b">bad</OPTIONS>after'),'<optionsHint>x</optionsHint>storyafter'))
 await test('unclosed options preserved',()=>assert.equal(s('<options>keep'),'<options>keep'))
 await test('whitespace normalized',()=>assert.equal(s(' a  \n\n\n b\t'),'a\n\n b'))
 await test('all final blocks and HTML comments removed before fence fallback',()=>{
   const raw='<think_nya>thinking</think_nya><!--</think>--><StatusBlock role="status">'+fence+'md\nstate'+ '</StatusBlock><options>x</options><summary>x</summary><comment>x</comment><game>real plot</game>'
   assert.equal(s(raw),'<game>real plot</game>')
 })
 await test('case insensitive attributes and exact tag names',()=>{
   assert.equal(s('<THINK_TEST>x</THINK_TEST><STATUSBLOCK x="1">x</STATUSBLOCK><SUMMARY x="1">x</SUMMARY><COMMENT x="1">x</COMMENT><game>keep</game>'),'<game>keep</game>')
   const near='<StatusBlockHint>x</StatusBlockHint><summaryHint>x</summaryHint><commentHint>x</commentHint><thinking>text</thinking>'
   assert.equal(s(near),near)
 })
 await test('unclosed final blocks remain verbatim',()=>{
   for(const tag of ['think_nya','StatusBlock','options','summary','comment'])assert.equal(s('<'+tag+'>keep'),'<'+tag+'>keep')
   assert.equal(s('<!--keep'),'<!--keep')
 })
 await test('summary shell removed without deleting following narrative',()=>assert.equal(s('<summary>内心-晓</summary>卡外正文<game>剧情</game>'),'卡外正文<game>剧情</game>'))
 await test('game narrative byte-for-byte preserved',()=>{
   const game='<game>段一\n\n段二，<b>人物</b>说：好。\n</game>'
   assert.equal(s('<think_nya>x</think_nya>'+game+'<summary>x</summary>'),game)
 })
 await test('game protects nested cards fences and original whitespace',()=>{
   const game='<game>剧情  \n\n\n<details><summary>标题</summary>正文</details><comment>台词</comment>\n'+fence+'\n剧情代码\n'+fence+'\n</game>'
   assert.equal(s('<summary>外部卡</summary>'+game+'<comment>外部留言</comment>'),game)
 })
 await test('S10 original counterexamples remain correct',()=>{
   const text='正文解释：三个反引号 '+fence+' 表示围栏，这句话仍是剧情。'
   assert.equal(s(text),text)
   assert.equal(s('<optionsHint>剧情线索</optionsHint>正文<options>候选</options>后文'),'<optionsHint>剧情线索</optionsHint>正文后文')
 })
 await test('S07 fixed authentic redacted fixture exceeds fifty percent',()=>{
   const fixture=JSON.parse(fs.readFileSync(p('scripts/fixtures/q6-branch3.json'),'utf8'))
   const before=fixture.samples.reduce((n,m)=>n+m.content.length,0)
   const after=fixture.samples.reduce((n,m)=>n+s(m.content).length,0)
   assert.ok((before-after)/before>=0.5)
   for(const sample of fixture.samples){for(const game of sample.content.match(/<game>[\s\S]*?<\/game>/g)??[])assert.ok(s(sample.content).includes(game))}
   console.log('Q12_FIXED_SAMPLE',JSON.stringify({messages:fixture.samples.length,before,after,reduction:(before-after)/before}))
 })
 const message=(role,content,i)=>({id:'m'+i,role,content,createdAt:i,status:'done'})
 await test('pure-code messages produce no chunks',()=>assert.deepEqual(api.sliceRound({index:0,messages:[message('user',code('x'),1),message('assistant',code('y'),2)]},{sanitize:true}),[]))
 await test('legacy slicing unchanged',()=>assert.equal(api.sliceRound({index:0,messages:[message('assistant',code('x'),1)]})[0].text,'【角色】'+code('x')))
 await test('sanitized offsets exact',()=>{const body='narrative'.repeat(800)+'\n'+code('noise')+'\nEND';const chunks=api.sliceRound({index:0,messages:[message('assistant',body,1)]},{sanitize:true});const text='【角色】'+s(body);for(const c of chunks)assert.equal(c.text,text.slice(c.startOffset,c.endOffset));assert.equal(chunks.at(-1).endOffset,text.length)})
 const meta=api.storyStore.create({title:'Q12 synthetic'},{characterId:'fixture'})
 const id=meta.storyId,file=api.storyDbPath(id)
 const session={id:'branch-q12',storyId:id,mode:'story',messages:[message('user','story',1),message('assistant','answer\n'+code('{}'),2)]}
 const schedule=async()=>{api.storyArchiveService.schedule(session,{storyId:id},{userId:'root',personaId:'default'});await api.storyArchiveService.flush(id);api.cancelEmbeddingBackfill();await api.waitForEmbeddingBackfill()}
 const sql=fn=>{const db=new DatabaseSync(file);try{return fn(db)}finally{db.close()}}
 api.embedder.embedOne=async()=>null
 await schedule()
 await test('scheduler persists clean text',()=>assert.equal(sql(db=>db.prepare('SELECT text FROM story_chunks').get().text),'【用户】story\n【角色】answer'))
 sql(db=>db.exec("CREATE TABLE q12_sentinel (value TEXT); INSERT INTO q12_sentinel VALUES ('unchanged')"))
 api.storyArchiveStore(id).upsert({content:'preserve fact',userId:'root',personaId:'default',sourceSessionId:session.id,sourceMessageId:'m1',sourceMessageIndex:0,embedding:null})
 const factsBefore=sql(db=>db.prepare('SELECT * FROM memories').all())
 await test('raw message version retained',()=>assert.equal(sql(db=>db.prepare('SELECT content_version FROM story_rounds').get().content_version),api.contentVersion(session.messages)))
 await test('production context accepts sanitized archive',async()=>{const block=await api.storyMemory(id).buildStoryContextBlock(session,{enabled:true,minScore:0,keywordWeight:0.8,budgetTokens:32000,n:8},{storyId:id,branchId:session.id,tenants:[{userId:'root',personaId:'default'}],bounds:new Map([[session.id,null]]),recentMessageIds:new Set()});assert.ok(block.includes('answer'));assert.ok(!block.includes(fence));await api.storyArchiveService.flush(id)})
 const metadata=fs.readFileSync(path.join(path.dirname(file),'story.json'))
 await test('invalid story rejects',async()=>assert.rejects(api.rebuildStoryArchive('../bad'),/故事不存在/))
 await test('rebuild clears archive only',async()=>{assert.ok(Number.isInteger((await api.rebuildStoryArchive(id)).removed));assert.equal(sql(db=>db.prepare('SELECT count(*) n FROM story_chunks').get().n),0);assert.equal(sql(db=>db.prepare('SELECT count(*) n FROM story_rounds').get().n),0);assert.equal(sql(db=>db.prepare('SELECT value FROM q12_sentinel').get().value),'unchanged');assert.deepEqual(fs.readFileSync(path.join(path.dirname(file),'story.json')),metadata);assert.deepEqual(sql(db=>db.prepare('SELECT * FROM memories').all()),factsBefore)})
 await test('empty rebuild idempotent',async()=>assert.ok(Number.isInteger((await api.rebuildStoryArchive(id)).removed)))
 await test('future schedule rebuilds',async()=>{await schedule();assert.equal(sql(db=>db.prepare('SELECT count(*) n FROM story_rounds').get().n),1)})
 await test('queued archive cancelled',async()=>{api.storyArchiveService.schedule(session,{storyId:id},{userId:'root',personaId:'default'});assert.ok(Number.isInteger((await api.rebuildStoryArchive(id)).removed));await api.storyArchiveService.flush(id);assert.equal(sql(db=>db.prepare('SELECT count(*) n FROM story_rounds').get().n),0)})
 await test('next schedule backfills vectors to zero pending',async()=>{
   api.embedder.status=()=>({ready:true,dimensions:1024,lastError:null})
   api.embedder.modelInstalled=()=>true
   api.embedder.ensure=async()=>({})
   api.embedder.embed=async texts=>texts.map(()=>Float32Array.from({length:1024},(_,i)=>i===0?1:0))
   await schedule();api.startEmbeddingBackfill();await api.waitForEmbeddingBackfill()
   assert.equal(sql(db=>db.prepare('SELECT count(*) n FROM story_chunks WHERE embedding IS NULL').get().n),0)
   assert.ok(sql(db=>db.prepare('SELECT count(*) n FROM story_chunks').get().n)>0)
 })
 await test('transaction failure rolls back chunks and rounds',async()=>{
   const before=sql(db=>db.prepare('SELECT count(*) n FROM story_chunks').get().n)
   sql(db=>db.exec("CREATE TRIGGER q12_fail BEFORE DELETE ON story_rounds BEGIN SELECT RAISE(ABORT, 'q12 forced failure'); END"))
   await assert.rejects(api.rebuildStoryArchive(id),/q12 forced failure/)
   assert.equal(sql(db=>db.prepare('SELECT count(*) n FROM story_chunks').get().n),before)
   sql(db=>db.exec('DROP TRIGGER q12_fail'))
 })
 await test('duplicate rebuild is rejected',async()=>{
   const first=api.rebuildStoryArchive(id)
   await assert.rejects(api.rebuildStoryArchive(id),/正在重建/)
   await first
 })
 await test('empty story database rebuild is harmless',async()=>{
   const empty=api.storyStore.create({title:'Q12 empty'},{characterId:'fixture'})
   assert.equal((await api.rebuildStoryArchive(empty.storyId)).removed,0)
 })
 await test('another story archive is unchanged',async()=>{
   const other=api.storyStore.create({title:'Q12 other'},{characterId:'fixture'})
   const otherSession={...session,id:'other-branch',storyId:other.storyId}
   api.storyArchiveService.schedule(otherSession,{storyId:other.storyId},{userId:'root',personaId:'default'})
   await api.storyArchiveService.flush(other.storyId);api.cancelEmbeddingBackfill();await api.waitForEmbeddingBackfill()
   const rows=()=>{const db=new DatabaseSync(api.storyDbPath(other.storyId));try{return db.prepare('SELECT * FROM story_chunks').all()}finally{db.close()}}
   const before=rows();assert.ok(before.length)
   await api.rebuildStoryArchive(id)
   assert.deepEqual(rows(),before)
 })
 await test('cancelled completion receipt survives next schedule',async()=>{
   api.storyArchiveService.schedule(session,{storyId:id},{userId:'root',personaId:'default'},{messageId:'m2',interrupted:true})
   await api.rebuildStoryArchive(id)
   await schedule()
   assert.equal(api.storyArchiveStore(id).getStoryMessageState(session.id,'m2',api.contentVersion([session.messages[1]])),true)
 })
 await test('real React confirmation, cancel, duplicate guard and completion',async()=>{
   const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'})
   globalThis.window=dom.window;globalThis.document=dom.window.document
   globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true
   let calls=0,resolve
   window.nahida={story:{recallStatus:async()=>({archivedRounds:2,vectorRounds:0,pendingRounds:2,pendingChunks:2,vectorReady:false,databaseErrors:[],stories:[{storyId:id,title:'Q12 fixture',archivedRounds:2,vectorRounds:0,pendingRounds:2,pendingChunks:2}]}),rebuildArchive:async()=>{calls++;return await new Promise(r=>{resolve=r})}}}
   const ui=await bundleModule('q12-ui',[
     'export {createElement,act} from '+JSON.stringify(p('node_modules/react/index.js')),
     'export {createRoot} from '+JSON.stringify(p('node_modules/react-dom/client.js')),
     'export {StoryRecallPanel} from '+JSON.stringify(p('src/renderer/src/features/settings/sections/StoryRecallPanel.tsx'))
   ].join('\n'),[{name:'jsx',setup(build){build.initialOptions.jsx='automatic'}}])
   const root=ui.createRoot(document.getElementById('root'))
   const click=async node=>ui.act(async()=>{node.click()})
   try {
     await ui.act(async()=>root.render(ui.createElement(ui.StoryRecallPanel,{settings:{},saving:false,save:async()=>true})))
     const button=()=>document.querySelector('[data-ui-target="重建故事归档"]')
     await click(button());assert.equal(calls,0);assert.ok(document.querySelector('[role="alertdialog"]'))
     await click([...document.querySelectorAll('button')].find(b=>b.textContent==='取消'));assert.equal(calls,0)
     await click(button());await click(document.querySelector('[data-ui-target="确认重建故事归档"]'))
     assert.equal(calls,1);assert.equal(button().disabled,true)
     await ui.act(async()=>resolve({removed:2}));assert.ok(document.body.textContent.includes('已清空 2 轮归档'))
     assert.equal(document.querySelector('[role="alertdialog"]'),null)
   } finally {await ui.act(async()=>root.unmount());dom.window.close();for(const handle of process._getActiveHandles())if(handle.constructor.name==='MessagePort')handle.unref()}
 })
 console.log('Q12 '+count+'/'+count+' passed')
} finally {api.cancelEmbeddingBackfill();await api.waitForEmbeddingBackfill();api.closeAllStoryMemory();fs.rmSync(root,{recursive:true,force:true})}
