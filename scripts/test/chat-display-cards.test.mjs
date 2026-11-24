import fs from 'node:fs'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { bundleModule, p } from './qq-test-util.mjs'
const exports = {
 'src/renderer/src/features/chat/markdown/display.ts':'displayPartsOf',
 'src/renderer/src/features/chat/markdown/structure.ts':'structureOf',
 'src/renderer/src/features/chat/components/BubbleCard.tsx':'BubbleCard',
 'src/main/features/regex/scripts.ts':'collectScripts',
 'node_modules/react/index.js':'createElement',
 'node_modules/react-dom/server.node.js':'renderToStaticMarkup'
}
const mod=await bundleModule('display-cards',Object.entries(exports).map(([file,names])=>'export { '+names+' } from '+JSON.stringify(p(file))).join('\n'))
const window=new JSDOM('').window
const purify=createDOMPurify(window)
const {structureOf,displayPartsOf,BubbleCard,createElement,renderToStaticMarkup,collectScripts}=mod
let count=0
function test(name,fn){fn();console.log('ok '+(++count)+' - '+name)}
const host={id:'host',scriptName:'host',findRegex: /<([a-z_]+)>[\s\S]*?<\/\1>/g.toString(),replaceString:'<!doctype html><style>bad</style>',placement:[2],markdownOnly:true}
const scripts=[host]
const render=(source,list=scripts)=>displayPartsOf(source,list,0,purify).map(part=>part.kind==='card'?renderToStaticMarkup(createElement(BubbleCard,{card:part})):part.html).join('')
const doc=html=>new JSDOM(html).window.document
const raw='<wave_plan>计划</wave_plan>正文「你好」<wave_summary>记事</wave_summary>'
test('card/text/card order',()=>assert.deepEqual(structureOf(raw,scripts).map(x=>x.kind),['card','text','card']))
test('exact reconstruction',()=>assert.equal(structureOf(raw,scripts).map(x=>x.kind==='card'?x.raw:x.text).join(''),raw))
test('unclosed tag preserved',()=>assert.deepEqual(structureOf('<wave_plan>半句',scripts),[{kind:'text',text:'<wave_plan>半句',offset:0}]))
test('repeated tags',()=>assert.equal(structureOf(raw+raw,scripts).filter(x=>x.kind==='card').length,4))
for(const [tag,title] of Object.entries({wave_plan:'创作规划',wave_summary:'本楼记事',wave_review:'成稿回看',wave_options:'行动选项',wave_mind:'内心话',wave_comment:'附页',wave_parallel:'附页',wave_original:'附页'}))test('title '+tag,()=>{const d=doc(render('<'+tag+'>文本</'+tag+'>'));assert.equal(d.querySelector('summary').textContent,title);assert.equal(d.querySelector('details').open,false)})
for(const [name,extra] of [['disabled',{disabled:true}],['prompt',{markdownOnly:false,promptOnly:true}],['placement',{placement:[1]}],['depth',{minDepth:1}],['invalid',{findRegex:'/[/'}],['plain',{replaceString:'纯文本'}]])test('no card '+name,()=>assert.equal(structureOf(raw,[{...host,...extra}],0).filter(x=>x.kind==='card').length,0))
test('no scripts',()=>assert.equal(structureOf(raw,[]).length,1))
test('generic custom tag',()=>assert.equal(structureOf('<custom_note>文本</custom_note>',scripts)[0].tag,'custom_note'))
for(const quote of ['"hello"','“你好”','«你好»','「你好」','『你好』','＂你好＂'])test('quote '+quote,()=>{const d=doc(render(quote,[]));assert.equal(d.querySelector('q')?.textContent,quote);assert.equal(d.body.textContent.trim(),quote)})
const tick=String.fromCharCode(96)
for(const code of [tick+'"code"'+tick,tick.repeat(2)+'a '+tick+' "code"'+tick.repeat(2),tick.repeat(3)+'js\n"code"\n'+tick.repeat(3),'~~~js\n「code」\n~~~','    "code"',tick.repeat(3)+'js\n"unfinished"'])test('code '+JSON.stringify(code),()=>assert.equal(doc(render(code,[])).querySelectorAll('q').length,0))
test('HTML attribute',()=>{const d=doc(render('<a href="https://example.com" title="「title」">text</a>',[]));assert.equal(d.querySelector('a').title,'「title」');assert.equal(d.querySelectorAll('q').length,0)})
test('link destination',()=>assert.equal(doc(render('[link](https://example.com "「title」")',[])).querySelector('a').title,'「title」'))
test('card code fence exempt',()=>assert.equal(structureOf(tick.repeat(3)+'\n'+raw+'\n'+tick.repeat(3),scripts).filter(x=>x.kind==='card').length,0))
test('card inline code exempt',()=>assert.equal(structureOf(tick+raw+tick,scripts).filter(x=>x.kind==='card').length,0))
test('card escaped text',()=>assert.equal(doc(render('<wave_plan><img src=x onerror="bad()"><script>bad()</script></wave_plan>')).querySelectorAll('script,img,iframe,style').length,0))
test('body whitelist',()=>assert.equal(doc(render('<span style="color:red" onclick="bad()">「hi」</span><iframe></iframe><script>bad()</script>',[])).querySelectorAll('[style],[onclick],script,iframe').length,0))
test('M5 immutable source',()=>{const message=Object.freeze({content:raw});render(message.content);assert.equal(message.content,raw)})
test('unclosed tag visible in bubble',()=>assert.equal(doc(render('<wave_plan>半句')).body.textContent.trim(),'<wave_plan>半句'))
test('code keeps literal tags',()=>assert.equal(doc(render(tick+'<wave_plan>x</wave_plan>'+tick)).querySelector('code').textContent,'<wave_plan>x</wave_plan>'))
test('card toggles open and closed',()=>{const d=doc(render(raw)).querySelector('details');d.open=true;assert.equal(d.open,true);d.open=false;assert.equal(d.open,false)})
test('markdown entities retain visible text',()=>assert.equal(doc(render('「A &amp; B」',[])).querySelector('q').textContent,'「A & B」'))
const realScripts=collectScripts(JSON.parse(fs.readFileSync(process.env.ST_SETTINGS_PATH||p('scripts/fixtures/st-settings.json'),'utf8')))
const fixture=fs.readFileSync(p('scripts/fixtures/wave-real.md'),'utf8')
test('real preset 12 scripts',()=>assert.equal(realScripts.length,12))
test('real plan card',()=>assert.ok(displayPartsOf(fixture,realScripts,0,purify).some(x=>x.kind==='card'&&x.tag==='wave_plan')))
test('real HTML excludes tags and hosts',()=>{const html=render(fixture,realScripts);assert.doesNotMatch(html,/<wave_plan>|<!doctype|<style|<iframe/i);assert.ok(doc(html).querySelector('q'))})
const engineSrc=fs.readFileSync(p('src/shared/regexEngine.ts'),'utf8')
const structSrc=fs.readFileSync(p('src/renderer/src/features/chat/markdown/structure.ts'),'utf8')
test('host fallback marker is an exported constant',()=>assert.match(engineSrc,/export const HOST_FALLBACK_DEBUG = '输出含 HTML 宿主标记'/))
test('structure uses the constant, not a literal copy',()=>{assert.match(structSrc,/\bHOST_FALLBACK_DEBUG\b/);assert.doesNotMatch(structSrc,/输出含 HTML 宿主标记/)})
console.log('PASS display-cards '+count+'/'+count)
window.close()
