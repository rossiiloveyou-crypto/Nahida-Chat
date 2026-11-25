/** Q3.5 integration: measured v2 excerpt + real ChatPage/Composer, isolated disk. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {JSDOM} from 'jsdom'
import createDOMPurify from 'dompurify'
import {bundleModule,installElectronStub,p} from './qq-test-util.mjs'
installElectronStub(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-q35-stub-')))
const items=["😏 走到沙发旁坐下，端起水杯喝一口，顺便打量屋里的陈设","🥺 站在茶几旁有点拘谨，轻声问她一个人住这么大的房子习不习惯","😂 笑着指了指茶几上的打火机和指甲刀，调侃她平时还挺会享受生活"]
const raw='<options>\n'+items.map(s=>'<option>'+s+'</option>').join('\n')+'\n</options>'
const msg=(id,role,content=id,extra={})=>({id,role,content,status:'done',createdAt:1,...extra})
let count=0
async function test(name,fn){await fn();console.log('ok Q35 '+(++count)+' - '+name)}
const display=await bundleModule('options-parser','export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/display.ts'))+';export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/optionCards.ts')))
const pw=new JSDOM('').window, purify=createDOMPurify(pw)
const parts=(s,scripts=[],tags=[])=>display.displayPartsOf(s,scripts,0,purify,tags)
await test('K01 measured excerpt exact parse',()=>assert.deepEqual(display.parseOptionCard(raw),{items,consumed:true}))
for(const s of ['<options><option>unfinished','<options></options>','<options><option>x</options>after','<options><option>x</option>stray</options>']) await test('K13 malformed preserved '+s,()=>{const out=parts(s);assert.ok(out.every(p=>p.kind!=='options'));const d=new JSDOM(out.map(p=>p.html).join(''));assert.equal(d.window.document.body.textContent.replace(/\n/g,''),s.replace(/\n/g,''));d.window.close()})
await test('ordinary numbered prose is not options',()=>assert.equal(display.parseOptionCard('01 hello\n02 world').consumed,false))
await test('multiple blocks retain surrounding text',()=>assert.deepEqual(parts('before'+raw+'middle'+raw+'after').map(p=>p.kind),['text','options','text','options','text']))
await test('inline and fenced code never become buttons',()=>{for(const s of ['unused-sentinel',String.fromCharCode(96)+raw+String.fromCharCode(96),'~~~xml\n'+raw+'\n~~~'])assert.ok(parts(s).every(p=>p.kind!=='options'))})
await test('K12 builtins closed and exact content',()=>{const d=new JSDOM(parts('<summary>小结🌱</summary><comment>留言</comment>').map(p=>p.html).join(''));assert.deepEqual([...d.window.document.querySelectorAll('details')].map(x=>[x.open,x.querySelector('summary').textContent,x.textContent.trim()]),[[false,'剧情小总结','剧情小总结小结🌱'],[false,'小猫留言','小猫留言留言']]);d.window.close()})
await test('builtin malformed and code blocks stay literal',()=>{for(const raw of ['<summary>unfinished','<comment>unfinished','`<summary>x</summary>`','~~~xml\n<comment>x</comment>\n~~~']){const d=new JSDOM(parts(raw).map(p=>p.html).join(''));assert.equal(d.window.document.querySelectorAll('details').length,0);assert.ok(d.window.document.body.textContent.includes(raw.includes('~~~') ? '<comment>x</comment>' : raw.replace(/^`|`$/g,'')));d.window.close()}})
await test('K14 preset wins over builtin and custom',()=>{const script={id:'preset',findRegex:'/<summary>([\\s\\S]*?)<\\/summary>/g',replaceString:'<details><summary>Preset</summary>$1</details>',placement:[2],markdownOnly:true};const html=parts('<summary>x</summary>',[script],['summary']).map(p=>p.html).join('');assert.equal((html.match(/<details/g)||[]).length,1);assert.ok(html.includes('Preset'));assert.ok(!html.includes('剧情小总结'));const d=new JSDOM(html);assert.equal(d.window.document.querySelector('summary')?.textContent,'Preset');d.window.close()})

// Q3.6: production fallback path, with an opt-in real-session probe (no private text logged).
const hostScript = { id:'q36-host', findRegex:'/<(summary|comment|memo)>([\\s\\S]*?)<\\/\\1>/g', replaceString:'<style>body{color:red}</style><details><summary>Host</summary>$2</details>', placement:[2], markdownOnly:true }
const htmlOf = (text, scripts=[], tags=[]) => parts(text,scripts,tags).filter(p=>p.kind==='text').map(p=>p.html).join('')
await test('K15 K16 host fallback yields named builtins, no orphan details',()=>{
 const d=new JSDOM(htmlOf('<summary>inner</summary><comment>note</comment>',[hostScript]));
 assert.deepEqual([...d.window.document.querySelectorAll('details')].map(x=>x.firstElementChild.textContent),['剧情小总结','小猫留言']);
 assert.doesNotMatch(d.window.document.body.textContent,/<\/?(?:summary|comment)>/);
 assert.ok([...d.window.document.querySelectorAll('details')].every(x=>x.firstElementChild.tagName==='SUMMARY'&&!x.open));d.window.close()
})
await test('K17 user comment wins, unrelated custom tag folds under host fallback',()=>{
 for(const tag of ['comment','memo']){const d=new JSDOM(htmlOf('<'+tag+'>note</'+tag+'>',[hostScript],[tag]));assert.equal(d.window.document.querySelector('details > summary')?.textContent,tag);assert.equal(d.window.document.querySelectorAll('details').length,1);d.window.close()}
})
await test('K18 fold content stays exact plain text including nested labels',()=>{
 const text='~~x~~ ~x~ **bold** _em_\n[link](https://example.com)\n~~~js\ncode\n~~~\n<summary>nested</summary><img src=x onerror=alert(1)>';
 const d=new JSDOM(htmlOf('<comment>'+text+'</comment>',[hostScript]));
 assert.equal(d.window.document.querySelector('.bubble-card__text').textContent,text);
 assert.equal(d.window.document.querySelectorAll('s,del,strong,em,a,code,pre,img,details details').length,0);assert.doesNotMatch(d.window.document.body.innerHTML,/line-through/);d.window.close()
})
await test('K19 usable preset details remains one layer with user overlap',()=>{
 const script={...hostScript,replaceString:'<details><summary>Preset</summary>$2</details>'};
 const d=new JSDOM(htmlOf('<summary>x</summary>',[script],['summary']));assert.equal(d.window.document.querySelectorAll('details').length,1);assert.equal(d.window.document.querySelector('summary').textContent,'Preset');d.window.close()
})
await test('non-folding rewrite does not suppress custom folding',()=>{
 for (const script of [{...hostScript,findRegex:'/note/g',replaceString:'changed'}, {...hostScript,replaceString:'<details>broken</details>'}]) {
 const d=new JSDOM(htmlOf('<memo>note</memo>',[script],['memo']));assert.equal(d.window.document.querySelector('.bubble-card__text').textContent,'note');d.window.close()
 }
})
await test('K16 native details keeps its own summary beside builtin folds',()=>{
 const d=new JSDOM(htmlOf('<details><summary>Native</summary>body</details><summary>outside</summary>',[hostScript]));
 assert.deepEqual([...d.window.document.querySelectorAll('details')].map(x=>x.querySelector('summary')?.textContent),['Native','剧情小总结']);d.window.close()
})
if(process.env.Q36_REAL_SESSIONS && process.env.Q36_REAL_PRESET) {
 const bytes=fs.readFileSync(process.env.Q36_REAL_SESSIONS), presetBytes=fs.readFileSync(process.env.Q36_REAL_PRESET);
 const sessions=JSON.parse(bytes.toString()), preset=JSON.parse(presetBytes.toString());
 const scripts=preset.regex_scripts||preset.extensions?.regex_scripts||preset.oai_settings?.extensions?.regex_scripts;
 assert.ok(scripts?.length,'real preset scripts present');
 const samples=sessions.flatMap(s=>s.messages||[]).filter(m=>/<summary>[\s\S]*?<\/summary>/i.test(m.content||'')&&/<comment>[\s\S]*?<\/comment>/i.test(m.content||''));
 assert.ok(samples.length,'real paired samples present');
 await test('K15 K16 real messages and real preset all fold without orphan details',()=>{
  for(const m of samples){const d=new JSDOM(htmlOf(m.content,scripts));const ds=[...d.window.document.querySelectorAll('details')];if (/<summary>/.test(m.content.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi,''))) assert.ok(ds.some(x=>x.firstElementChild?.textContent==='剧情小总结'),'standalone summary: '+m.id);assert.ok(ds.every(x=>x.firstElementChild?.tagName==='SUMMARY'),JSON.stringify({id:m.id,details:ds.map(x=>({children:[...x.children].map(y=>y.tagName),childCount:x.children.length}))}));assert.doesNotMatch(d.window.document.body.textContent,/<\/?(?:summary|comment)>/);d.window.close()}
  assert.deepEqual(fs.readFileSync(process.env.Q36_REAL_SESSIONS),bytes);assert.deepEqual(fs.readFileSync(process.env.Q36_REAL_PRESET),presetBytes);console.log('Q36 real paired samples verified: '+samples.length)
 })
}

// React DOM uses the production components/store; only browser assets and backend APIs are fixtures.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1' })
globalThis.window = dom.window; globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
const callbacks = {}
const uiSession = { id: 'ui', mode: 'story', storyId: undefined, messages: [msg('ui-u', 'user', '用户原文'), msg('ui-n', 'narration', '旁白原文'), msg('ui-a', 'assistant', '助手正文')] }
const defaults = await bundleModule('q35-defaults', 'export { defaultSettings } from '+JSON.stringify(p('src/main/features/settings/settingsStore.ts')))
let uiSettings = { ...defaults.defaultSettings(), bridge: { ...defaults.defaultSettings().bridge, enabled: false, foldedTags: [] } }
let modelWrites = 0, sendCalls = 0
window.nahida = {
 initialTheme: 'light',
 settings: { get: async () => uiSettings, save: async patch => (uiSettings = { ...uiSettings, ...patch }) },
 modelProfiles: { list: async () => ({ profiles: [{ id: 'profile', name: 'Profile', provider: 'mock', models: ['model'], defaultModel: 'model' }], defaultProfileId: 'profile' }) },
 prompts: { library: async () => ({ characters: [] }) },
 workspaces: { list: async () => ({ workspaces: [], activeWorkspaceId: null }) },
 regex: { scriptsState: async () => ({scripts:[], warning:null}) },
 chat: {
   listSessions: async () => [structuredClone(uiSession)],
   updateSession: async () => { modelWrites++; return uiSession },
   update: async (_sid, mid, content) => ({ ...uiSession.messages.find(m => m.id === mid), content }),
   send: async () => { sendCalls++; throw Error('fixture') },
   onDelta: fn => (callbacks.delta = fn, () => {}), onReasoning: fn => (callbacks.reasoning = fn, () => {}),
   onTool: fn => (callbacks.tool = fn, () => {}), onApproval: fn => (callbacks.approval = fn, () => {}),
   onDone: fn => (callbacks.done = fn, () => {}), onError: fn => (callbacks.error = fn, () => {})
 }
}
const ui = await bundleModule('option-cards-dom', [
 'export { createElement, act } from ' + JSON.stringify(p('node_modules/react/index.js')),
 'export { createRoot } from ' + JSON.stringify(p('node_modules/react-dom/client.js')),
 'export { MessageList } from ' + JSON.stringify(p('src/renderer/src/features/chat/components/MessageList.tsx')),
 'export { ChatPage } from ' + JSON.stringify(p('src/renderer/src/features/chat/ChatPage.tsx')),
 'export { useChatStore } from ' + JSON.stringify(p('src/renderer/src/features/chat/store.ts')),
 'export { useSettings } from ' + JSON.stringify(p('src/renderer/src/features/settings/useSettings.ts')),
 'export { bridgeEligible } from ' + JSON.stringify(p('src/shared/bridge.ts'))
].join(String.fromCharCode(10)), [{ name: 'fixture-assets', setup(build) { build.onLoad({ filter: new RegExp('[.](png|svg)$') }, () => ({ contents: 'export default "asset"', loader: 'js' })) } }])
const { act, createElement: h, createRoot } = ui
const root = createRoot(document.getElementById('root'))
const mount = async (Component, props) => act(async () => { root.render(h(Component, props)) })
const buttons = () => [...document.querySelectorAll('button')]
const findButton = text => buttons().find(b => b.textContent === text)
const click = async b => { assert.ok(b, 'button exists'); await act(async () => b.click()) }
const input = async (node, value) => act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new window.Event('input', { bubbles: true })) })
uiSession.messages=[msg('ui-u','user','用户原文'),msg('ui-a','assistant',raw+'<summary>小结</summary><comment>留言</comment>')]
await test('markup and entities stay inert plain text in options',()=>{const out=parts('<options><option><img src=x onerror=alert(1)>hello &lt;script&gt;</option></options>');assert.equal(out[0].kind,'options');assert.equal(out[0].items[0],'hello &lt;script&gt;')})
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'q35-disk-')),file=path.join(temp,'sessions.json')
fs.writeFileSync(file,JSON.stringify([uiSession]));const before=fs.readFileSync(file)
window.nahida.chat.listSessions=async()=>JSON.parse(fs.readFileSync(file,'utf8'))
const choices=()=>[...document.querySelectorAll('.option-card__item')]
await mount(ui.ChatPage)
await test('K02 K11 three native buttons with exact item text',()=>{assert.equal(choices().length,3);assert.deepEqual(choices().map(b=>b.lastElementChild.textContent),items);assert.deepEqual(choices().map(b=>b.firstElementChild.textContent),['01','02','03']);assert.equal(document.querySelector('.option-card').hasAttribute('data-ui-target'),false)})
await click(choices()[1])
const textarea=()=>document.querySelector('.composer__input')
await test('K03 K04 fill focus caret at end',()=>{assert.equal(textarea().value,items[1]);assert.equal(document.activeElement,textarea());assert.equal(textarea().selectionStart,items[1].length);assert.equal(textarea().selectionEnd,items[1].length)})
let copiedRaw;Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async text=>{copiedRaw=text}},configurable:true});await click([...document.querySelectorAll('[data-ui-target="复制原稿"]')].at(-1));await test('K08 copy uses exact raw message',()=>assert.equal(copiedRaw,uiSession.messages[1].content))
await test('K05 K08 no sends no persistence no stream',()=>{assert.equal(sendCalls,0);assert.deepEqual(fs.readFileSync(file),before);assert.equal(ui.useChatStore.getState().streamingId,null);assert.equal(ui.useChatStore.getState().sessions[0].messages.length,2)})
window.confirm=()=>{throw Error('untouched choice should not confirm')}
await click(choices()[0]);assert.equal(textarea().value,items[0])
let confirmations=0
window.confirm=()=>{confirmations++;return false}
await input(textarea(),'手打草稿')
await click(choices()[1])
await test('K07 cancel preserves manually typed draft',()=>{assert.equal(confirmations,1);assert.equal(textarea().value,'手打草稿')})
window.confirm=()=>{confirmations++;return true}
await click(choices()[1])
await test('K07 accept replaces draft',()=>{assert.equal(confirmations,2);assert.equal(textarea().value,items[1])})
await click(findButton('编辑这条'))
await test('K06 editing disables all options without side effect',async()=>{assert.ok(choices().every(b=>b.disabled&&b.title.includes('编辑')));await click(choices()[0]);assert.equal(textarea().value,items[1]);assert.equal(sendCalls,0)})
await click(findButton('取消编辑'))
await act(async()=>ui.useChatStore.setState({streamingId:ui.useChatStore.getState().activeId}))
await test('K06 streaming disables options',async()=>{assert.ok(choices().every(b=>b.disabled&&b.title.includes('生成')));await click(choices()[0]);assert.equal(textarea().value,items[1])})
await act(async()=>ui.useChatStore.setState({streamingId:null,sessions:[{...ui.useChatStore.getState().sessions[0],id:'qq:1:private:2'}],activeId:'qq:1:private:2'}))
await test('K06 channel read-only disables options',async()=>{assert.ok(choices().every(b=>b.disabled&&b.title.includes('只读')));await click(choices()[0]);assert.equal(sendCalls,0)})
await act(async()=>ui.useChatStore.setState({sessions:[{...uiSession,mode:'chat',preSend:true}],activeId:uiSession.id}))
await click(choices()[2])
await test('presend still only fills',()=>{assert.equal(textarea().value,items[2]);assert.equal(sendCalls,0);assert.deepEqual(fs.readFileSync(file),before)})
await mount(ui.MessageList,{messages:[msg('literal','user',raw)]})
await test('user messages never produce choices',()=>assert.equal(choices().length,0))
await act(async()=>root.unmount());dom.window.close();pw.close();fs.rmSync(temp,{recursive:true,force:true})
delete globalThis.window;delete globalThis.document
console.log('PASS option-cards '+count+'/'+count)
// React 调度器会保持事件循环（同 message-edit 的处理）：跑完就显式结束，否则挂进 pnpm test 会卡死整条链。
process.exit(process.exitCode ?? 0)
