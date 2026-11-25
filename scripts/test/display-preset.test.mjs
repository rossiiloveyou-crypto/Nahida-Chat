import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { bundleModule, p, installElectronStub } from './qq-test-util.mjs'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-q3-'))
installElectronStub(tmp)
let count = 0
function check(name, fn) { fn(); console.log('ok ' + (++count) + ' - ' + name) }
const host = path.join(tmp, 'host.ts')
fs.writeFileSync(host, 'export const bridgeHost = { health: () => ({config:{stDataDir:globalThis.__q3Dir}}) }')
const main = await bundleModule('q3-main', 'export * from '+JSON.stringify(p('src/main/ipc/regex.ts')), [{name:'host',setup(build){build.onResolve({filter:/bridge\/host$/},()=>({path:host}))}}])
const display = await bundleModule('q3-display', 'export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/display.ts'))+'; export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/foldedTags.ts')))
const st = path.join(tmp, 'st')
fs.mkdirSync(path.join(st, 'OpenAI Settings'), {recursive:true})
const fixture = JSON.parse(fs.readFileSync(p('scripts/fixtures/st-settings.json'),'utf8')).oai_settings.extensions.regex_scripts
function preset(name,scripts) { fs.writeFileSync(path.join(st,'OpenAI Settings',name+'.json'),JSON.stringify({regex_scripts:scripts})) }
function select(name) { fs.writeFileSync(path.join(st,'settings.json'),JSON.stringify({oai_settings:{preset_settings_openai:name},extension_settings:{regex:[]}})) }
globalThis.__q3Dir=st
preset('one',fixture); select('one')
check('G-01 host-derived directory returns 12 preset scripts',()=>assert.equal(main.readDisplayScriptsState().scripts.length,12))
select('two'); preset('two',[{...fixture[0],replaceString:'changed'}])
check('G-05 selected preset changes without restart',()=>assert.equal(main.readDisplayScriptsState().scripts[0].replaceString,'changed'))
select('one')
const scripts=main.readDisplayScriptsState({refresh:true}).scripts
check('G-04 missing directory reports warning and empty scripts',()=>{const s=main.readDisplayScriptsState({stDir:path.join(tmp,'missing')});assert.equal(s.scripts.length,0);assert.ok(s.warning)})
const merge=await bundleModule('q3-merge','export * from '+JSON.stringify(p('src/main/features/regex/scripts.ts')))
check('G-02 preset wins duplicate id',()=>{const s=merge.mergeDisplayScripts([fixture[0]],[{...fixture[0],replaceString:'preset'}]);assert.equal(s.length,1);assert.equal(s[0].replaceString,'preset')})
const window=new JSDOM('').window, purify=createDOMPurify(window)
check('G-03 think_nya produces preset card',()=>assert.equal(display.displayPartsOf('<think_nya>text</think_nya>',scripts,0,purify)[0].kind,'card'))
check('G-06 fallback tag folds without scripts',()=>assert.match(display.displayPartsOf('<memo>text</memo>',[],0,purify,['memo'])[0].html,/<details/))
check('G-06 preset wins without double fold',()=>{const parts=display.displayPartsOf('<think_nya>text</think_nya>',scripts,0,purify,['think_nya']);assert.equal(parts.length,1);assert.equal(parts[0].kind,'card')})
check('preset details replacement is not nested in fallback',()=>{const plain={...fixture[0],findRegex:'/<memo>([\\s\\S]*?)<\\/memo>/g',replaceString:'<details><summary>Preset</summary>$1</details>'};const html=display.displayPartsOf('<memo>x</memo>',[plain],0,purify,['memo'])[0].html;assert.equal((html.match(/<details/g)||[]).length,1)})
check('unclosed and inline code tags remain visible',()=>{assert.equal(display.splitFoldedTags('<memo>x',['memo'])[0].tag,undefined);assert.equal(display.splitFoldedTags(String.fromCharCode(96)+'<memo>x</memo>'+String.fromCharCode(96),['memo'])[0].tag,undefined)})
check('unclosed fallback remains visibly literal',()=>assert.match(display.displayPartsOf('<memo>x',[],0,purify,['memo'])[0].html,/&lt;memo&gt;/))
check('fenced code is never folded',()=>assert.equal(display.splitFoldedTags('~~~xml\n<memo>x</memo>\n~~~',['memo'])[0].tag,undefined))
check('literal code is not entity-double-escaped',()=>{const html=display.displayPartsOf('~~~xml\n<memo>x</memo>\n~~~',[],0,purify,['memo'])[0].html;assert.match(html,/&lt;memo&gt;/);assert.doesNotMatch(html,/&amp;lt;/)})
check('nested same-tag folding remains one outer block',()=>assert.equal(display.splitFoldedTags('<memo>a<memo>b</memo>c</memo>',['memo']).filter(x=>x.tag).length,1))
check('escaped tag is not folded',()=>assert.equal(display.splitFoldedTags(String.fromCharCode(92)+'<memo>x</memo>',['memo'])[0].tag,undefined))
check('normalization deduplication and cap',()=>{assert.deepEqual(display.normalizeFoldedTags('<MEMO>, memo\n<note>'),['memo','note']);assert.equal(display.normalizeFoldedTags(Array.from({length:25},(_,i)=>'a'+i)).length,20)})
const file=path.join(tmp,'message.json'), raw='<memo>原稿</memo>'
fs.writeFileSync(file,JSON.stringify({content:raw}))
check('G-07 rendering preserves disk content',()=>{display.displayPartsOf(raw,[],0,purify,['memo']);assert.equal(JSON.parse(fs.readFileSync(file)).content,raw)})
check('G-08 fallback has no ui target',()=>assert.doesNotMatch(display.displayPartsOf(raw,[],0,purify,['memo'])[0].html,/data-ui-target/))
const storeMod = await bundleModule('q3-settings', 'export { settingsStore } from '+JSON.stringify(p('src/main/features/settings/settingsStore.ts')))
storeMod.settingsStore.save({bridge:{enabled:false,foldedTags:['<MEMO>','memo','note']}})
const restarted = await bundleModule('q3-settings-restart', 'export { settingsStore } from '+JSON.stringify(p('src/main/features/settings/settingsStore.ts')))
check('folded preference survives fresh store load',()=>assert.deepEqual(restarted.settingsStore.get().bridge.foldedTags,['memo','note']))
check('G-12 bridge settings has no path fields',()=>assert.deepEqual(Object.keys(restarted.settingsStore.get().bridge).sort(),['enabled','foldedTags']))
const hook = await bundleModule('q3-cache', 'export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/useDisplayScripts.ts')))
let oldResolve, newResolve
let calls=0
globalThis.window={nahida:{regex:{scriptsState:()=>new Promise(resolve=>{if(calls++===0)oldResolve=resolve;else newResolve=resolve})}}}
const oldRequest=hook.loadDisplayScripts()
hook.resetDisplayScriptsCache()
const newRequest=hook.loadDisplayScripts()
const next={scripts:[{id:'new'}],stDir:'new',preset:'new',warning:null}
newResolve(next);await newRequest
oldResolve({scripts:[{id:'old'}],stDir:'old',preset:'old',warning:null});await oldRequest
const finalState=await hook.loadDisplayScripts()
check('G-11 late old response never overwrites new cache',()=>assert.equal(finalState.preset,'new'))
check('cache reuses completed request',()=>assert.equal(calls,2))
delete globalThis.window
// Mount the production hook twice: publish/reset must notify both consumers.
const dom = new JSDOM('<div id="root"></div>',{url:'http://localhost'})
globalThis.window=dom.window;globalThis.document=dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT=true
const mounted=await bundleModule('q3-mounted',[
 'export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/useDisplayScripts.ts')),
 'export {createElement,act} from '+JSON.stringify(p('node_modules/react/index.js')),
 'export {createRoot} from '+JSON.stringify(p('node_modules/react-dom/client.js')),
 'export {MemoryRouter} from '+JSON.stringify(p('node_modules/react-router-dom/dist/index.js')),
 'export {BridgeSection} from '+JSON.stringify(p('src/renderer/src/features/settings/sections/BridgeSection.tsx'))
].join(';'))
let resolveMounted, resolves=[], requestCount=0
dom.window.nahida={regex:{scriptsState:()=>{requestCount++;return new Promise(r=>{resolveMounted=r;resolves.push(r)})}}}
function Probe({id}) {const s=mounted.useDisplayScriptsState();return mounted.createElement('p',{id},s.warning||s.preset)}
const root=mounted.createRoot(document.getElementById('root'))
await mounted.act(async()=>root.render(mounted.createElement('div',null,mounted.createElement(Probe,{id:'a'}),mounted.createElement(Probe,{id:'b'}))))
await mounted.act(async()=>resolveMounted({...next,preset:'first'}))
check('mounted consumers share one request',()=>{assert.equal(requestCount,1);assert.equal(document.getElementById('a').textContent,'first');assert.equal(document.getElementById('b').textContent,'first')})
await mounted.act(async()=>mounted.resetDisplayScriptsCache())
check('mounted reset publishes empty state immediately',()=>assert.equal(document.getElementById('a').textContent,''))
await mounted.act(async()=>resolveMounted({...next,preset:'second',warning:'directory warning'}))
check('mounted consumers receive visible warning',()=>assert.equal(document.getElementById('b').textContent,'directory warning'))
await mounted.act(async()=>dom.window.dispatchEvent(new dom.window.Event('focus')))
await mounted.act(async()=>resolveMounted({...next,preset:'focus-refreshed'}))
check('returning to app refreshes selected preset',()=>assert.equal(document.getElementById('a').textContent,'focus-refreshed'))
const preferences={bridge:{enabled:false,foldedTags:[]}}
dom.window.nahida.settings={get:async()=>preferences,save:async patch=>Object.assign(preferences,patch)}
dom.window.nahida.bridge={health:async()=>({config:{stRoot:'fixture',stDataDir:'fixture/data-nc/default-user',cardName:'fixture',port:8000,generateTimeoutMs:180000},stRunning:false,processes:[],busy:false}),override:{get:async()=>({text:''})}}
dom.window.nahida.story={recallStatus:async()=>({databaseErrors:[],archivedRounds:0,vectorReady:false})}
await mounted.act(async()=>root.render(mounted.createElement(mounted.MemoryRouter,null,mounted.createElement(mounted.BridgeSection))))
await mounted.act(async()=>resolveMounted({...next,scripts:[],warning:'目录不存在，请检查 ST 数据目录'}))
check('G-04 production settings exposes readable alert',()=>assert.match(document.querySelector('[role="alert"]').textContent,/目录不存在/))
const input=[...document.querySelectorAll('textarea')].find(x=>x.placeholder.includes('think_nya'))
await mounted.act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(input,'<MEMO>, memo, note, comment');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
await mounted.act(async()=>[...document.querySelectorAll('button')].find(x=>x.textContent==='保存折叠标签').click())
check('production settings saves normalized fallback tags',()=>assert.deepEqual(preferences.bridge.foldedTags,['memo','note','comment']))
await mounted.act(async()=>root.unmount())
delete globalThis.window;delete globalThis.document
dom.window.close()
window.close()
console.log('PASS display-preset '+count+'/'+count)
fs.rmSync(tmp,{recursive:true,force:true})
await import('./option-cards.test.mjs')
// React scheduler MessagePorts can keep Node alive after all roots and windows close.
process.exit(0)
