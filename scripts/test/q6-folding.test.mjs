/** Four real branch-3 messages, prose redacted before committing; no private disk dependencies. */
import fs from 'node:fs'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import createDOMPurify from 'dompurify'
import {bundleModule,p} from './qq-test-util.mjs'
const fixture=JSON.parse(fs.readFileSync(p('scripts/fixtures/q6-branch3.json'),'utf8'))
const {scripts}=JSON.parse(fs.readFileSync(p('scripts/fixtures/q6-preset.json'),'utf8'))
const api=await bundleModule('q6-folding',[
 'export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/display.ts')),
 'export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/structure.ts')),
 'export * from '+JSON.stringify(p('src/renderer/src/features/chat/markdown/foldedTags.ts')),
 'export * from '+JSON.stringify(p('src/shared/regexEngine.ts'))
].join(';'))
const window=new JSDOM('').window, purify=createDOMPurify(window)
let count=0
const check=(name,fn)=>{fn();console.log('ok Q6 '+(++count)+' - '+name)}
try {
 check('four authentic redacted samples and eight real scripts',()=>{assert.equal(fixture.samples.length,4);assert.equal(scripts.length,8);assert.equal(new Set(fixture.samples.map(x=>x.sourceSha256)).size,4)})
 for(const sample of fixture.samples) {
  const raw=sample.content
  const nodeDefault=api.displayPartsOf(raw,scripts,0)
  console.log('Q6 Node default '+sample.id+' '+JSON.stringify({cards:nodeDefault.filter(x=>x.kind==='card').length,doubleEscaped:nodeDefault.some(x=>x.html?.includes('&amp;lt;'))}))
  check(sample.id+' Node default preserves card admission (no browser DOM)',()=>assert.equal(nodeDefault.filter(x=>x.kind==='card').length,1))
  const stages=[]
  for(let n=1;n<=8;n++) {
   let host=0
   const subset=scripts.slice(0,n)
   const transformed=api.getRegexedString(raw,2,{scripts:subset,isMarkdown:true,depth:0,onDebug:message=>{if(message.includes(api.HOST_FALLBACK_DEBUG))host++}})
   const tokens=api.displayPartsOf(raw,subset,0,purify)
   stages.push({stage:n,host,cards:tokens.filter(x=>x.kind==='card').length,outerEscaped:/&lt;think_nya(?:&gt;|>)/.test(transformed),doubleEscaped:tokens.some(x=>x.html?.includes('&amp;lt;'))})
  }
  console.log('Q6 A/B '+sample.id+' '+JSON.stringify(stages))
  check(sample.id+' A: stage 2 preserves outer tag, stage 3 creates card',()=>{assert.equal(stages[1].outerEscaped,false);assert.equal(stages[1].cards,0);assert.equal(stages[2].cards,1)})
  check(sample.id+' B: actual host event at stages 3 through 8',()=>assert.ok(stages.slice(2).every(x=>x.host>0&&x.cards===1)))
  check(sample.id+' C: card body is exact raw source, not rendered HTML',()=>{
   const card=api.structureOf(raw,scripts,0).find(x=>x.kind==='card')
   assert.ok(card);assert.equal(raw.slice(card.offset,card.offset+card.raw.length),card.raw)
   const open=card.raw.indexOf('>')+1, close=card.raw.lastIndexOf('</')
   assert.equal(card.text,card.raw.slice(open,close))
  })
  check(sample.id+' U04 U05: one closed card and no double escaped tag',()=>{
   const tokens=api.displayPartsOf(raw,scripts,0,purify)
   assert.equal(tokens.filter(x=>x.kind==='card').length,1)
   assert.ok(tokens.filter(x=>x.kind==='text').every(x=>!x.html.includes('&amp;lt;')))
  })
 }
 check('generic custom host tag remains supported without name special cases',()=>{
  const script={id:'generic',findRegex:'/<analysis_custom>([\\s\\S]*?)<\\/analysis_custom>/g',replaceString:'<style>x{color:red}</style><details><summary>Analysis</summary>$1</details>',placement:[2],markdownOnly:true}
  const cards=api.displayPartsOf('<analysis_custom>body</analysis_custom>',[script],0,purify)
  assert.equal(cards[0].kind,'card');assert.equal(cards[0].text,'body')
 })
 check('fallback fold retains exact raw text and escapes once',()=>{
  const raw='<b>text</b> & value'
  const tokens=api.displayPartsOf('<memo>'+raw+'</memo>',[],0,purify,['memo'])
  const dom=new JSDOM(tokens.map(x=>x.html||'').join(''))
  try {assert.equal(dom.window.document.querySelector('.bubble-card__text').textContent,raw);assert.equal(dom.window.document.querySelectorAll('details').length,1)}finally{dom.window.close()}
 })
 console.log('PASS q6-folding '+count+'/'+count)
} finally {window.close()}
