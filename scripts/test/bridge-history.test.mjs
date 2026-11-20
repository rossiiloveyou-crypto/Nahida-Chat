/** P4: production history conversion, page expression readback and durable trace. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nc-history-test-'))
installElectronStub(root)
const b=await bundleModule('history',[
  [ 'bridge/driver','BridgeDriver' ],[ 'bridge/mapper','mapMessages,roundTripDiff' ],
  [ 'bridge/session','injectChat' ],[ 'bridge/router','toBridgeMessages,toBridgeSystemPrompts' ],
  [ 'chat/chatService','chatService,sessionHistoryToLlm' ],[ 'bridge/stream','setBridgeRunnerForTest' ],
  [ 'chat/sink','HeadlessSink' ],[ 'settings/settingsStore','settingsStore' ],
  [ 'llm/openAiProvider','openAiCompatibleProvider' ],[ 'llm/anthropicProvider','anthropicProvider' ],
  [ 'llm/geminiProvider','geminiProvider' ],[ 'llm/ollamaProvider','ollamaProvider' ]
].map(([file,names])=>'export { '+names+' } from '+JSON.stringify(p('src/main/features/'+file+'.ts'))).join('\n'))
const {check,done}=createChecker()
const history=[{role:'user',content:'old user'},{role:'assistant',content:'old assistant'},{role:'narration',content:'rain sentinel'},{role:'user',content:'current'}]
const payload=b.sessionHistoryToLlm({messages:history})
check('narration is assistant history with explicit prefix',payload[2]?.role==='assistant'&&payload[2].content==='系统旁白：rain sentinel')
check('router preserves all four history entries',b.toBridgeMessages(payload).length===4)
check('narration never enters dynamic system prompts',b.toBridgeSystemPrompts(payload).length===0)
const mapped=b.mapMessages(history).chat
check('direct narration survives coreChat filtering',mapped.filter(m=>!m.is_system).length===4)
check('narration round trip preserves role and content',b.roundTripDiff(history).length===0)
function gateway({fail=false,clearFail=false}={}) {
  const context={chat:[],chatMetadata:{},extensionPrompts:{},characters:[{name:'test',avatar:'test.png',chat:'original-chat'}],powerUserSettings:{},characterId:0,
    setExtensionPrompt(key,value,position,depth,scan=false,role=0){this.extensionPrompts[key]={value,position,depth,scan,role}},
    eventTypes:{},eventSource:{},generate(){},stopGeneration(){}}
  const seen=[]
  const sandbox={SillyTavern:{getContext:()=>context},Date}
  sandbox.window=sandbox
  const world=vm.createContext(sandbox)
  const disk={
    target(_dataDir,name,avatar){return {name,avatar,directory:path.join(root,'chats','test'),file:name+'.jsonl',path:path.join(root,'chats','test',name+'.jsonl')}},
    async wait(target,injected){
      const last=context.chat.at(-1)
      if(last?.is_user!==false||typeof last.mes!=='string'||!last.mes.trim())throw Error('fixture disk assistant missing')
      if(context.chat.length!==injected+1)throw Error('fixture disk count mismatch')
      return {content:last.mes,actualLines:context.chat.length+1,expectedLines:injected+2,file:target.file,waitMs:0}
    },
    async remove(){return true},
    async backups(){return []}
  }
  const page={async eval(expr,label){
    if(label==='character:assert')return {name:'test',avatar:'test.png'}
    if(label==='chat:drain')return true
    if(label==='generate'){seen.push(JSON.parse(JSON.stringify(context)));if(fail)throw Error('test generate failure');context.chat.push({is_user:false,mes:'reply'});return {ok:true,ms:1,value:'reply',lastMes:'reply',toasts:[]}}
    if(label==='clear'&&clearFail&&seen.length)throw Error('test cleanup failure')
    return vm.runInContext(expr,world)
  }}
  return {context,seen,page,disk,ensure:async()=>page,onEvent:()=>()=>{}}
}
const gw=gateway(), driver=new b.BridgeDriver({gateway:gw,disk:gw.disk,config:{minIntervalMs:0},readOverride:()=>({text:'override sentinel',active:true,truncated:false,warning:null})})
for(let round=0;round<2;round++){
  const detail=await driver.runTurn({sessionId:'test-history',historyBefore:5,messages:history})
  check('round '+round+' generates',detail.result.status==='done',detail.result.error)
  check('round '+round+' same-turn counters',detail.trace.historyBefore===5&&detail.trace.historySent===4&&detail.trace.historyInChat===4&&detail.trace.historyInPrompt===4,JSON.stringify(detail.trace))
  check('round '+round+' override remains depth zero',gw.seen.at(-1)?.extensionPrompts['nc-bridge:override']?.depth===0)
  check('round '+round+' cleanup leaves no bridge keys',Object.keys(gw.context.extensionPrompts).length===0&&gw.context.chat.length===0)
}
const traceFile=path.join(root,'nc-bridge/bridge-trace.jsonl')
let rows=fs.readFileSync(traceFile,'utf8').trim().split('\n').map(JSON.parse)
check('two real persisted trace lines',rows.length===2)
check('disk four counters equal sampled values',rows.every(r=>r.before===5&&r.sent===4&&r.inChat===4&&r.inPrompt===4))
check('trace stores completed cleanup steps',rows.every(r=>r.steps.at(-1)==='chat:delete'&&r.steps.includes('clear:after')))
check('trace excludes message and override bodies',!fs.readFileSync(traceFile,'utf8').includes('rain sentinel')&&!fs.readFileSync(traceFile,'utf8').includes('override sentinel'))
const failure=gateway({fail:true}), failed=await new b.BridgeDriver({gateway:failure,disk:failure.disk,config:{minIntervalMs:0}}).runTurn({sessionId:'failure',messages:[{role:'user',content:'fail'}]})
check('generation failure stays error',failed.result.status==='error')
check('failure still clears page',failed.trace.clearedAfter?.chat===0)
const empty=await driver.runTurn({sessionId:'empty',messages:[]})
check('empty input recorded without page injection',empty.result.status==='error'&&empty.trace.historyInChat===0)
rows=fs.readFileSync(traceFile,'utf8').trim().split('\n').map(JSON.parse)
check('failures and empty input each persist once',rows.length===4&&rows.some(r=>r.sessionId==='failure')&&rows.some(r=>r.sessionId==='empty'))
// Real chatService -> stream forwarding, with only the final model runner substituted.
b.settingsStore.save({bridge:{enabled:true},memory:{enabled:false,autoExtract:false},summary:{enabled:false}})
const session=b.chatService.createSession({mode:'story',storyId:'story_test_abc123',title:'history ingress'})
b.chatService.narrate(session.id,'pipeline sentinel')
let captured
b.setBridgeRunnerForTest(async input=>{captured=input;return {result:{status:'done',content:'ok',raw:'ok',error:null,ms:1,warnings:[]},trace:{}}})
await b.chatService.sendAwait({sessionId:session.id,content:'hello'},new b.HeadlessSink())
check('historyBefore crosses real stream facade',captured?.historyBefore===3,JSON.stringify(captured))
check('narration crosses real chatService router',captured?.messages.some(m=>m.role==='assistant'&&m.content==='系统旁白：pipeline sentinel'))
b.setBridgeRunnerForTest(null)
// Exercise actual direct-provider encoders; replace only fetch, never their mapping logic.
const originalFetch=globalThis.fetch
try {
  for(const provider of [b.openAiCompatibleProvider,b.anthropicProvider,b.geminiProvider,b.ollamaProvider]){
    let body
    globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response('',{status:200})}
    for await(const _event of provider.stream({settings:{baseUrl:'http://127.0.0.1:1',apiKey:'fixture',model:'fixture',temperature:0},messages:payload,tools:[]})){}
    const rows=body.messages??body.contents
    const occurrences=JSON.stringify(rows).split('系统旁白：rain sentinel').length-1
    check(provider.id+' preserves narration exactly once in history',occurrences===1)
    check(provider.id+' excludes narration from system instruction',!JSON.stringify(body.system??body.systemInstruction??'').includes('rain sentinel'))
  }
} finally {globalThis.fetch=originalFetch}
const markerGateway=gateway()
await b.injectChat(markerGateway.page,mapped)
check('page expression preserves reversible narration metadata',markerGateway.context.chat[2]?.extra?.ncBridgeNarration===true)
const traceGateway=gateway()
const traceError=await new b.BridgeDriver({gateway:traceGateway,disk:traceGateway.disk,config:{minIntervalMs:0},writeTrace(){throw Error('fixture disk failure')}}).runTurn({sessionId:'trace-error',messages:[{role:'user',content:'hello'}]})
check('trace write failure preserves successful generation',traceError.result.status==='done')
check('trace write failure reaches result and trace warning',traceError.result.warnings.some(w=>w.includes('fixture disk failure'))&&traceError.trace.warnings.some(w=>w.includes('fixture disk failure')))
done()
