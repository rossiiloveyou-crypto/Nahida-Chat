/** Q1 pagination: real Chromium DOM, instrumented production component, symmetric mount benchmark.
 * Run: node scripts/test/message-pagination.test.mjs
 * Only temporary build/userData files and timestamped task-baseline evidence are written.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { loadEsbuild, p, projectRoot } from './qq-test-util.mjs'

const require = createRequire(import.meta.url)
const chatpageMode = process.argv.includes('--chatpage-benchmark')
const baselineDir = path.resolve(projectRoot, '../DOC/agent--ST桥接重构/task-桥接重构1/baseline')
const beforePath = path.join(baselineDir, 'MessageList.before.tsx')
const currentPath = p('src/renderer/src/features/chat/components/MessageList.tsx')
const originalDir = path.dirname(currentPath)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-message-pagination-'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const evidencePath = path.join(baselineDir, `${chatpageMode ? 'message-pagination-chatpage' : 'message-pagination'}-${stamp}.json`)
const summaryPath = path.join(baselineDir, `${chatpageMode ? 'message-pagination-chatpage' : 'message-pagination'}-${stamp}.md`)
const hash = text => crypto.createHash('sha256').update(text).digest('hex')
const sourceBefore = fs.readFileSync(beforePath, 'utf8')
const sourceCurrent = fs.readFileSync(currentPath, 'utf8').replace(
 process.argv.includes('--q6-negative-control') ? '}, [messages.length, tailLength])' : '__NO_Q6_MUTATION__',
 '}, [messages.length, tailLength, focusMessageId])'
)
const actionsStart = sourceCurrent.indexOf('const actionsFor')
const actionsEnd = sourceCurrent.indexOf('const isUser', actionsStart)
assert.ok(actionsStart >= 0 && actionsEnd > actionsStart, 'A06 actionsFor source section found')
assert.doesNotMatch(sourceCurrent.slice(actionsStart, actionsEnd), /messages\.(?:slice|some)\s*\(/, 'A06 actionsFor contains no per-row messages.slice/some scans')
console.log('PASS A06 actionsFor has no per-row array scans')
const styles = ['tokens.css', 'global.css'].map(name => fs.readFileSync(p('src/renderer/src/styles/' + name), 'utf8')).join(String.fromCharCode(10))
const fixture = Array.from({ length: 122 }, (_, index) => ({
 id: `pagination-${index + 1}`, role: index % 2 ? 'assistant' : index % 18 === 0 ? 'narration' : 'user',
 content: `第 ${index + 1} 条原始消息。\n\n**可验证的长故事片段**：雨落钟楼，旅人继续前行。\n\n` + (index % 2 && index < 114 ? '<game>钟楼线索与角色状态</game>\n\n' : ''),
 createdAt: index + 1, status: 'done', toolCalls: []
}))
const totalChars = 218706
let remaining = totalChars - fixture.reduce((sum, m) => sum + m.content.length, 0)
for (let i = 0; i < fixture.length; i++) {
 const length = Math.floor(remaining / (fixture.length - i))
 fixture[i].content += '雨夜的钟楼记录着旅行与对话，灯光照见旧路。 '.repeat(Math.ceil(length / 24)).padEnd(length, '。').slice(0, length)
 remaining -= length
}
assert.equal(fixture.reduce((sum, m) => sum + m.content.length, 0), totalChars)
assert.equal(fixture.filter(m => m.content.includes('<game>')).length, 57)
const buildConfig = { bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' } }
const evidence = { generatedAt: new Date().toISOString(), fixture: { synthetic: true, messages: 122, utf16Chars: totalChars, gameBlocks: 57, sha256: hash(JSON.stringify(fixture)) }, source: { beforePath, currentPath, beforeSha256: hash(sourceBefore), currentSha256: hash(sourceCurrent), cssSha256: hash(styles) }, buildConfig, scope: 'MessageList keyed subtree mount-to-two-animation-frames cost; not full ChatPage/IPC session navigation', checks: [], errors: [] }

async function browserSuite() {
 const h = window.paginationHarness
 const checks = [], errors = [], timings = { before: [], after: [] }
 const check = (name, ok, detail = null) => { checks.push({ name, ok: Boolean(ok), detail }); console.log('CHECK ' + name + ' ' + Boolean(ok)); if (!ok) console.error('FAIL ' + name + ' ' + JSON.stringify(detail)) }
 const frame = () => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Chromium animation-frame timeout')), 12000); requestAnimationFrame(() => { clearTimeout(timer); resolve() }) })
 const settle = async () => { await frame(); await frame() }
 const rest = async () => { await settle(); await new Promise(resolve => setTimeout(resolve, 230)); await settle() }
 const rows = () => [...document.querySelectorAll('.message-list [data-message-id]')]
 const ids = () => rows().map(n => n.dataset.messageId)
 const list = () => document.querySelector('.message-list')
 const more = () => document.querySelector('[data-ui-target="加载更多消息"]')
 const select = id => document.querySelector('[data-message-id="' + id + '"]')
 const mount = async (variant = 'after', props = {}, key = 'session-a') => { h.mount(variant, props, key); await rest() }
 const run = async (name, fn) => { try { await fn() } catch (error) { errors.push({ name, message: error.message, stack: error.stack }); check(name + ' completed', false, error.message) } }
 await run('A08 symmetric benchmark', async () => {
  // Warm shared parser/JIT/module state equally, then alternate variants on the same renderer.
  for (const variant of ['before', 'after']) { h.mount(variant, {}, 'warm-' + variant); await rest(); h.unmount(); await settle() }
  for (let round = 0; round < 3; round++) {
   for (const variant of round % 2 ? ['after', 'before'] : ['before', 'after']) {
    h.unmount(); await settle()
    const start = performance.now(); h.mount(variant, {}, 'bench-' + round + variant); await settle()
    timings[variant].push({ ms: performance.now() - start, rows: rows().length })
    await rest()
   }
  }
  check('A08 before mounts 122 / after mounts 10', timings.before.every(x => x.rows === 122) && timings.after.every(x => x.rows === 10), timings)
 })
 await run('A01/A04 initial DOM', async () => {
  await mount()
  check('A01 exactly 10 rows', rows().length === 10, ids())
  check('A01 remaining 112 label', more()?.textContent === '加载更多（还有 112 条）', more()?.textContent)
  check('A01 final row retained', ids().at(-1) === 'pagination-122', ids().at(-1))
  let gap = list().scrollHeight - list().clientHeight - list().scrollTop
  for (let attempt = 0; attempt < 20 && Math.abs(gap) > 2; attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); gap = list().scrollHeight - list().clientHeight - list().scrollTop }
  check('A04 enters at latest <=2px', Math.abs(gap) <= 2, { gap, listBottom: list().getBoundingClientRect().bottom, tailBottom: rows().at(-1).getBoundingClientRect().bottom, sentinelBottom: document.querySelector('.message-list__inner').lastElementChild.getBoundingClientRect().bottom, padding: getComputedStyle(list()).paddingBottom })
  const button = more().getBoundingClientRect(), box = list().getBoundingClientRect()
  check('A04 top button does not cover latest viewport', button.bottom <= box.top || button.top >= box.bottom, { buttonTop: button.top, buttonBottom: button.bottom, viewportTop: box.top })
  check('A05 absolute message operations 122', Boolean(document.querySelector('[data-ui-target="消息操作 122"]')))
 })
 await run('A02/A03 pagination geometry', async () => {
  for (const [index, scroll] of [0, 190].entries()) {
   list().scrollTop = scroll; await rest()
   const box = list().getBoundingClientRect()
   const anchor = rows().find(node => node.getBoundingClientRect().bottom > box.top + 1)
   const id = anchor.dataset.messageId, beforeTop = anchor.getBoundingClientRect().top
   const beforeScroll = list().scrollTop, beforeHeight = list().scrollHeight
   more().click(); await rest()
   const afterTop = select(id).getBoundingClientRect().top
   check('A02 +10 rows ' + (index + 1), rows().length === 20 + 10 * index, rows().length)
   check('A03 anchor <=2px at ' + (scroll === 0 ? 'top' : 'scrolled'), Math.abs(afterTop - beforeTop) <= 2, { id, beforeTop, afterTop, delta: afterTop - beforeTop, beforeScroll, afterScroll: list().scrollTop, beforeHeight, afterHeight: list().scrollHeight })
  }
  check('A05 absolute message operations 100', Boolean(document.querySelector('[data-ui-target="消息操作 100"]')))
  for (let page = 0; page < 13 && more(); page++) { more().click(); await rest() }
  check('A02 load-more exhausted within 13 clicks', !more(), { count: rows().length })
  const actual = ids(), expected = h.fixture.map(m => m.id)
  check('A02 exhaust all 122 unique ordered messages', actual.length === 122 && new Set(actual).size === 122 && JSON.stringify(actual) === JSON.stringify(expected), { count: actual.length, unique: new Set(actual).size, last: actual.at(-1) })
 })
 await run('session key reset and search', async () => {
  await mount('after', {}, 'session-b')
  check('session key switch resets visible to 10', rows().length === 10, rows().length)
  h.patch({ focusMessageId: 'pagination-3' }); await rest()
  check('focus hidden old message expands window', Boolean(select('pagination-3')?.classList.contains('is-focus')) && rows().length === 120, { count: rows().length, focus: Boolean(select('pagination-3')) })
  await new Promise(resolve => setTimeout(resolve, 1200)); await settle()
  const focusedTop = list().scrollTop
  const focusedMessages = h.props().messages
  h.patch({ messages: [...focusedMessages, { ...focusedMessages.at(-1), id: 'focus-new', content: 'new focused message' }] }); await rest()
  check('U03 new message while focused preserves jump', Math.abs(list().scrollTop - focusedTop) <= 2, { focusedTop, actual: list().scrollTop })
  h.patch({ focusMessageId: null }); await rest()
  const clearedTop = list().scrollTop
  await new Promise(resolve => setTimeout(resolve, 3100)); await settle()
  check('U01 clearing focus stays at jump after 3 seconds', Math.abs(clearedTop - focusedTop) <= 2 && Math.abs(list().scrollTop - focusedTop) <= 2, { focusedTop, clearedTop, delayedTop: list().scrollTop })
  check('clearing focus retains expanded history', Boolean(select('pagination-3')) && rows().length === 121, rows().length)
  h.patch({ messages: [...h.props().messages, { ...focusedMessages.at(-1), id: 'unfocused-new', content: 'new unfocused message' }] }); await rest()
  check('U02 new message without focus scrolls to latest', Math.abs(list().scrollHeight - list().clientHeight - list().scrollTop) <= 2)
  list().scrollTop = 0
  h.patch({ messages: h.props().messages.map(m => m.id === 'unfocused-new' ? { ...m, content: m.content + ' streamed delta' } : m) }); await rest()
  check('U02 streaming tail without focus scrolls to latest', Math.abs(list().scrollHeight - list().clientHeight - list().scrollTop) <= 2)
  await mount('after', {}, 'session-a')
  check('switching back resets visible to 10', rows().length === 10, rows().length)
 })
 await run('Q6 real preset browser rendering', async () => {
  for (const sample of h.foldFixture.samples) {
   const parts = h.displayPartsOf(sample.content, h.foldScripts, 0)
   check('U04/U05 browser default purifier ' + sample.id, parts.filter(p => p.kind === 'card').length === 1 && parts.filter(p => p.kind === 'text').every(p => !p.html.includes('&amp;lt;')))
   await mount('after', { messages: [{ id: sample.id, role: 'assistant', content: sample.content, status: 'done', createdAt: 1 }], displayScripts: h.foldScripts }, 'fold-' + sample.id)
   const card = document.querySelector('.bubble-card')
   check('U05 real bubble closed and expandable ' + sample.id, Boolean(card) && !card.open)
   card?.querySelector('summary')?.click(); await settle()
   check('U05 real bubble opens ' + sample.id, Boolean(card?.open))
  }
 })
 await run('A07 actual MessageBubble render counts', async () => {
  const messages = h.fixture.map(m => m.id === 'pagination-122' ? { ...m, status: 'streaming', reasoning: '起始思考' } : m)
  await mount('after', { messages, isStreaming: true }, 'stream-session')
  for (const kind of ['delta', 'reasoning', 'tool']) {
   h.clearCounts()
   const oldIds = ids(), previous = h.props().messages
   const next = previous.map(m => m.id !== 'pagination-122' ? m : kind === 'delta' ? { ...m, content: m.content + '新增字符' } : kind === 'reasoning' ? { ...m, reasoning: m.reasoning + '继续思考' } : { ...m, toolCalls: [{ id: 'fixture-tool', name: 'fixture_read', readOnly: true, status: 'running', arguments: '{}', result: null, error: null, durationMs: null }] })
   h.patch({ messages: next }); await rest() // Host creates fresh inline retry/remove adapters every patch.
   const counts = h.counts(), other = oldIds.filter(id => id !== 'pagination-122').map(id => [id, counts[id] || 0])
   check('A07 ' + kind + ' only tail renders once', counts['pagination-122'] === 1 && other.every(([, count]) => count === 0), { counts, unchanged: other, tailContent: select('pagination-122').textContent.slice(-80) })
  }
  check('A07 reasoning and tool DOM updated', Boolean(document.querySelector('.reasoning')) && Boolean(document.querySelector('.tool-item')), { reasoning: document.querySelector('.reasoning')?.textContent, tool: document.querySelector('.tool-item')?.textContent })
 })
 await run('retry narration boundary and current inline callback', async () => {
  const m = (id, role, content) => ({ id, role, content, createdAt: 1, status: 'done' })
  for (const [name, messages, expected] of [
   ['narration after assistant', [m('a', 'assistant', '先前回答'), m('n', 'narration', '继续故事'), m('tail', 'assistant', '回答')], true],
   ['narration before previous assistant', [m('n', 'narration', '旧旁白'), m('a', 'assistant', '旧回答'), m('tail', 'assistant', '回答')], false],
   ['whitespace narration', [m('a', 'assistant', '旧回答'), m('n', 'narration', '   '), m('tail', 'assistant', '回答')], false],
   ['global user preserved', [m('u', 'user', '输入'), m('a', 'assistant', '旧回答'), m('tail', 'assistant', '回答')], true]
  ]) {
   await mount('after', { messages }, 'boundary-' + name)
   const button = document.querySelector('[aria-label="重试这一轮"]')
   check('retry boundary: ' + name, Boolean(button) === expected, { expected, found: Boolean(button) })
   if (button) { h.patch({}); await rest(); document.querySelector('[aria-label="重试这一轮"]').click(); await settle(); check('retry callback is latest adapter: ' + name, h.events().at(-1)?.revision === h.revision(), h.events().at(-1)) }
  }
 })
 await run('edit/delete/copy production DOM', async () => {
  await mount('after', {}, 'actions')
  const user = rows().find(n => n.querySelector('[aria-label="编辑这条"]'))
  const id = user.dataset.messageId
  user.querySelector('[aria-label="编辑这条"]').click(); await rest()
  const input = document.querySelector('.message-editor textarea'), raw = '  精确原文\n<game>保留</game>  '
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, raw)
  input.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  document.querySelector('[data-ui-target="保存不发送"]').click(); await rest()
  check('edit submits exact source', h.events().some(e => e.kind === 'update' && e.id === id && e.content === raw), h.events())
  select(id).querySelector('[aria-label="删除这条"]').click(); await rest()
  document.querySelector('[data-ui-target="确认消息操作"]').click(); await rest()
  check('delete confirms selected id', h.events().some(e => e.kind === 'remove' && e.id === id), h.events())
  select('pagination-122').querySelector('[data-ui-target="复制原稿"]').click(); await rest()
  check('copy uses unmodified source', h.copied() === h.fixture.at(-1).content, { copiedChars: h.copied()?.length })
  h.patch({ readOnly: true }); await rest()
  check('readOnly removes mutation toolbar', document.querySelectorAll('.message-actions button').length === 0)
 })
 h.unmount(); await settle()
 return { checks, errors, timings, environment: { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio, theme: document.documentElement.dataset.theme } }
}

async function browserChatPageSuite() {
 const h=window.paginationHarness,checks=[],errors=[],timings={before:[],after:[]}
 const frame=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('ChatPage RAF timeout')),12000);requestAnimationFrame(()=>{clearTimeout(timer);resolve()})})
 const settle=async()=>{await frame();await frame()}
 const pause=async()=>{await settle();await new Promise(resolve=>setTimeout(resolve,220));await settle()}
 const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log('CHECK '+name+' '+ok)}
 try {
  await h.setupChatPage();await pause()
  check('ChatPage and production Composer mounted',Boolean(document.querySelector('.chat-page'))&&Boolean(document.querySelector('.composer')),{activeId:h.activeId(),body:document.body.innerHTML.slice(0,500),rendererErrors:window.__paginationErrors})
  for(const variant of ['before','after']){h.selectSession('empty');await pause();window.__benchVariant=variant;h.selectSession('target');await pause()}
  for(let round=0;round<3;round++)for(const variant of round%2?['after','before']:['before','after']){
   h.selectSession('empty');await pause();window.__benchVariant=variant
   const start=performance.now();h.selectSession('target');await settle()
   const rows=document.querySelectorAll('.message-list [data-message-id]')
   timings[variant].push({ms:performance.now()-start,rows:rows.length,activeId:h.activeId(),last:rows[rows.length-1]?.dataset.messageId,composer:Boolean(document.querySelector('.composer'))});await pause()
  }
  for(const variant of ['before','after'])check('A08 real ChatPage store.select '+variant,timings[variant].every(x=>x.activeId==='target'&&x.rows===(variant==='before'?122:10)&&x.last==='pagination-122'&&x.composer),timings[variant])
  check('IPC fixtures loaded through real hooks',h.ipcReads().sessions===1&&h.ipcReads().settings===1&&h.ipcReads().regex===1,h.ipcReads())
 }catch(error){errors.push({message:error.message,stack:error.stack});check('real ChatPage benchmark completed',false,error.message)}
 check('ChatPage renderer raised no errors',window.__paginationErrors.length===0,window.__paginationErrors)
 h.unmount();await settle();return{checks,errors,timings,environment:{userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],devicePixelRatio}}
}

async function browserUnderflowSuite(height) {
 const h = window.paginationHarness, checks = []
 const wait = async () => { await new Promise(r => setTimeout(r, 250)); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) }
 const messages = Array.from({length:32}, (_, index) => ({id:'short-'+index,role:'narration',content:'短句',createdAt:index,status:'done'}))
 h.mount('after',{messages,readOnly:true},'short-'+height); await wait()
 const list=document.querySelector('.message-list'), anchor=document.querySelector('[data-message-id]')
 const before={top:anchor.getBoundingClientRect().top,height:list.scrollHeight,client:list.clientHeight,scroll:list.scrollTop}
 document.querySelector('[data-ui-target="加载更多消息"]').click(); await wait()
 const after={top:anchor.getBoundingClientRect().top,height:list.scrollHeight,client:list.clientHeight,scroll:list.scrollTop}
 const geometry=height>2000?after.height<=after.client+1:before.height<=before.client+1&&after.height>after.client+1
 checks.push({name:'A03 short '+(height>2000?'underfill to underfill':'underfill crossing overflow')+' fixture confirmed',ok:geometry,detail:{height,before,after}})
 checks.push({name:'A03 short anchor <=2px at height '+height,ok:Math.abs(after.top-before.top)<=2,detail:{delta:after.top-before.top,before,after}})
 h.unmount(); await wait(); return checks
}

try {
 if(chatpageMode)evidence.scope='Production ChatPage mounted once; production useChatStore.getState().select(empty -> target activeId) to two animation frames; stable IPC fixtures, no real backend IPC latency'
 const esbuild = loadEsbuild()
 let injected = 0
 const entry = `import React from ${JSON.stringify(p('node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(p('node_modules/react-dom/client.js'))};
import {flushSync} from ${JSON.stringify(p('node_modules/react-dom/index.js'))};
import {MessageList as Before} from 'pagination:before'; import {MessageList as After} from 'pagination:after';
import {ChatPage} from ${JSON.stringify(p('src/renderer/src/features/chat/ChatPage.tsx'))};
import {useChatStore} from ${JSON.stringify(p('src/renderer/src/features/chat/store.ts'))};
import {displayPartsOf} from ${JSON.stringify(p('src/renderer/src/features/chat/markdown/display.ts'))};
import foldFixture from ${JSON.stringify(p('scripts/fixtures/q6-branch3.json'))};
import foldPreset from ${JSON.stringify(p('scripts/fixtures/q6-preset.json'))};
const fixture=${JSON.stringify(fixture)};let root=null,props={},variant='after',key='a',revision=0,events=[],copied=null;
const rootNode=document.getElementById('root');window.__paginationRenderCounts={};window.__paginationErrors=[];window.addEventListener('error',event=>{window.__paginationErrors.push(event.error?.stack||event.message);console.log('RENDER_ERROR '+event.message)});
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{copied=text}},configurable:true});
const onUpdate=async(id,content)=>{events.push({kind:'update',id,content});return true};
const onResend=async(id,content)=>{events.push({kind:'resend',id,content});return true};
const onEditingChange=()=>{};
const scripts=[{id:'game-host',scriptName:'game-host',findRegex:'/<game>[\\s\\S]*?<\\/game>/g',replaceString:'<!doctype html><style>host</style>',placement:[2],markdownOnly:true}];
function Host(){const rev=revision;return React.createElement(variant==='before'?Before:After,{key,messages:fixture,displayScripts:scripts,onUpdate,onResend,onEditingChange,...props,onRetry:id=>events.push({kind:'retry',id,revision:rev}),onRemove:id=>events.push({kind:'remove',id,revision:rev})})}
function render(){if(!root)root=createRoot(rootNode);flushSync(()=>root.render(React.createElement(Host)))}
const ipcReads={sessions:0,settings:0,regex:0,profiles:0,prompts:0,workspaces:0};
const baseSession={mode:'chat',title:'Benchmark',characterId:null,modelProfileId:'profile',modelId:'model',createdAt:1,updatedAt:1};
const sessions=[{...baseSession,id:'empty',messages:[]},{...baseSession,id:'target',messages:fixture}];
const settings={provider:'mock',model:'model',theme:'light',fontSize:15,bridge:{enabled:false},agent:{},memory:{enabled:false},toolSupply:{},permissionMode:'ask',permission:{mode:'approve'}};
const off=()=>()=>{};
window.nahida={initialTheme:'light',settings:{get:async()=>{ipcReads.settings++;return settings},save:async()=>settings},modelProfiles:{list:async()=>{ipcReads.profiles++;return{profiles:[{id:'profile',name:'Profile',provider:'mock',models:['model'],defaultModel:'model'}],defaultProfileId:'profile'}}},prompts:{library:async()=>{ipcReads.prompts++;return{characters:[]}}},workspaces:{list:async()=>{ipcReads.workspaces++;return{workspaces:[],activeWorkspaceId:null}}},regex:{listScripts:async()=>{ipcReads.regex++;return scripts}},chat:{listSessions:async()=>{ipcReads.sessions++;return sessions},onDelta:off,onReasoning:off,onTool:off,onApproval:off,onDone:off,onError:off}};
window.paginationHarness={displayPartsOf,foldFixture,foldScripts:foldPreset.scripts,async setupChatPage(){if(root){flushSync(()=>root.unmount());root=null}await useChatStore.getState().init();rootNode.className='';root=createRoot(rootNode);window.__benchVariant='after';flushSync(()=>root.render(React.createElement(ChatPage)));},selectSession:id=>useChatStore.getState().select(id),activeId:()=>useChatStore.getState().activeId,ipcReads:()=>({...ipcReads}),fixture,mount(v,next,k){variant=v;props=next;key=k;revision++;render()},patch(next){props={...props,...next};revision++;render()},unmount(){if(root){flushSync(()=>root.unmount());root=null}},props:()=>({messages:fixture,...props}),revision:()=>revision,events:()=>events,copied:()=>copied,clearCounts(){window.__paginationRenderCounts={}},counts:()=>({...window.__paginationRenderCounts})};`
 await esbuild.build({ ...buildConfig, stdin: { contents: entry, resolveDir: projectRoot, sourcefile: 'message-pagination-entry.tsx', loader: 'tsx' }, outfile: path.join(work, 'browser.js'), alias: { '@shared': p('src/shared') }, plugins: [{ name: 'pagination-source-and-assets', setup(build) {
  build.onResolve({filter:/^\.\/components\/MessageList$/},args=>path.resolve(args.importer)===path.resolve(p('src/renderer/src/features/chat/ChatPage.tsx'))?{path:'pagination:wrapper',namespace:'pagination'}:undefined)
  build.onResolve({ filter: /^pagination:/ }, args => ({ path: args.path, namespace: 'pagination' }))
  build.onLoad({ filter: /.*/, namespace: 'pagination' }, args => {
   if(args.path==='pagination:wrapper')return{contents:'import React from '+JSON.stringify(p('node_modules/react/index.js'))+';import {MessageList as Before} from \"pagination:before\";import {MessageList as After} from \"pagination:after\";export function MessageList(props){return React.createElement(window.__benchVariant===\"before\"?Before:After,props)}',loader:'tsx',resolveDir:originalDir}
   let contents = args.path === 'pagination:before' ? sourceBefore : sourceCurrent
   if (args.path === 'pagination:after') {
    const marker = /const MessageBubble\s*=\s*memo\(function MessageBubble\([\s\S]*?\}: MessageBubbleProps\)\s*\{/
    assert.equal((contents.match(marker) || []).length > 0, true, 'MessageBubble function body instrumentation target exists')
    contents = contents.replace(marker, match => { injected++; return match + '\nwindow.__paginationRenderCounts[message.id]=(window.__paginationRenderCounts[message.id]||0)+1;\n' })
   }
   return { contents, loader: 'tsx', resolveDir: originalDir }
  })
  build.onLoad({ filter: /[/\\]settings[/\\]useTheme\.ts$/ }, () => ({ contents: 'export const useTheme=()=>({resolved: "light"})', loader: 'js' }))
  build.onLoad({ filter: /\.(png|svg)$/ }, () => ({ contents: 'export default "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="', loader: 'js' }))
 } }] })
 assert.equal(injected, 1, 'exactly one current bubble probe injected')
 // Both variants share this exact real stylesheet and fixed application-height host.
 fs.writeFileSync(path.join(work, 'style.css'), styles)
 fs.writeFileSync(path.join(work, 'index.html'), '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root" class="chat-body" style="height:100%;width:100%"></div><script src="browser.js"></script></body></html>')
 const resultFile = path.join(work, 'result.json')
 const runner = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(work, 'user-data'))});app.commandLine.appendSwitch('disable-gpu');app.commandLine.appendSwitch('force-device-scale-factor','1');app.commandLine.appendSwitch('disable-renderer-backgrounding');app.commandLine.appendSwitch('disable-background-timer-throttling');app.whenReady().then(async()=>{let win;const errors=[];try{win=new BrowserWindow({width:1280,height:860,useContentSize:true,show:true,skipTaskbar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',(_event,_level,message)=>{if(/^(FAIL|CHECK|RENDER_ERROR)/.test(String(message)))console.log(message)});win.webContents.on('render-process-gone',(_event,detail)=>errors.push(detail));await win.loadFile(${JSON.stringify(path.join(work, 'index.html'))});win.show();win.focus();win.moveTop();win.webContents.focus();const result=await win.webContents.executeJavaScript(${JSON.stringify('(' + (chatpageMode ? browserChatPageSuite : browserSuite).toString() + ')()')},true);for(const height of ${JSON.stringify(chatpageMode ? [] : [2600,1000])}){win.setContentSize(1280,height);const extra=await win.webContents.executeJavaScript('('+${JSON.stringify(browserUnderflowSuite.toString())}+')('+height+')',true);result.checks.push(...extra)}result.processErrors=errors;result.electron=process.versions;fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result,null,2));console.log('CHROMIUM_CHECKS '+result.checks.filter(x=>x.ok).length+'/'+result.checks.length);app.exit(result.checks.every(x=>x.ok)&&result.errors.length===0&&errors.length===0?0:1)}catch(error){fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({fatal:{message:error.message,stack:error.stack},processErrors:errors}));console.error(error);app.exit(2)}});`
 fs.writeFileSync(path.join(work, 'runner.cjs'), runner)
 const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
 const spawnElectron = () => new Promise((resolve, reject) => {
  const child = spawn(require('electron'), [path.join(work, 'runner.cjs')], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', chunk => { log += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk) })
  const timer = setTimeout(() => { child.kill(); }, 110000)
  child.on('error', error => { clearTimeout(timer); reject(error) })
  child.on('close', status => { clearTimeout(timer); evidence.electronLog = log; resolve(status) })
 })
 let code = await spawnElectron()
 // 一帧都没送来时这不是产品问题：链尾负载下窗口可能始终没被合成。只对这一个可证明的环境条件重跑一次，重跑记录进证据。
 let frameRetry = 0
 if (code !== 0 && /animation-frame timeout|RAF timeout/.test(evidence.electronLog || '')) {
  frameRetry = 1
  try { fs.rmSync(resultFile, { force: true }) } catch {}
  code = await spawnElectron()
 }
 evidence.frameRetry = frameRetry
 evidence.exitCode = code
 if (fs.existsSync(resultFile)) Object.assign(evidence, JSON.parse(fs.readFileSync(resultFile, 'utf8')))
 else evidence.errors.push({ message: 'Electron exited without result file', code })
 const median = list => [...list].sort((a,b) => a-b)[Math.floor(list.length / 2)]
 if (evidence.timings) evidence.performance = { beforeMedianMs: median(evidence.timings.before.map(x=>x.ms)), afterMedianMs: median(evidence.timings.after.map(x=>x.ms)), method: evidence.scope, rounds: 3, warmup: 'one mount per variant; alternating measured variant order; one shared production bundle' }
 if (code !== 0) process.exitCode = 1
} catch (error) { evidence.errors.push({ message: error.message, stack: error.stack }); process.exitCode = 1 }
finally {
 evidence.passed = process.exitCode !== 1 && evidence.checks.length > 0 && evidence.checks.every(x=>x.ok) && evidence.errors.length === 0
 fs.mkdirSync(baselineDir, { recursive: true })
 fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
 if (evidence.passed) fs.writeFileSync(path.join(baselineDir, chatpageMode ? 'q1-pagination-chatpage-evidence.json' : 'q1-pagination-evidence.json'), JSON.stringify(evidence, null, 2))
 fs.writeFileSync(summaryPath, '# Message pagination Chromium evidence\n\n' + (evidence.passed ? 'PASS' : 'FAIL') + ' — ' + evidence.checks.filter(x=>x.ok).length + '/' + evidence.checks.length + ' checks.\n\nSynthetic fixture: 122 messages, 218706 UTF-16 characters, 57 game blocks.\n\n' + evidence.scope + '.\n\n' + JSON.stringify(evidence.performance || {}, null, 2) + '\n\n' + evidence.checks.map(x=>(x.ok?'PASS ':'FAIL ')+x.name+' '+JSON.stringify(x.detail)).join('\n') + '\n\nErrors: '+JSON.stringify(evidence.errors)+'\n')
 console.log(JSON.stringify({ passed:evidence.passed, checks:evidence.checks.filter(x=>x.ok).length, total:evidence.checks.length, performance:evidence.performance, evidencePath, summaryPath }))
 fs.rmSync(work, { recursive: true, force: true })
}
