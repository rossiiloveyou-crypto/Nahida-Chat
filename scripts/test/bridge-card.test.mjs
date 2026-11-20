import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createChecker, projectRoot } from './qq-test-util.mjs'
import { buildDaniaCard, checkDaniaCard, restoreQuotes, WORLDBOOK_FILES, serializeCard } from '../cards/build-dania-card.mjs'
const {check,done}=createChecker()
function test(label,fn){try{fn();check(label,true)}catch(e){check(label,false,e.stack)}}
const read=rel=>fs.readFileSync(path.resolve(projectRoot,rel),'utf8')
const root='Prompt/characters/dania/'
const assets={sourceCard:JSON.parse(read('../ST导出/妲妮娅.json')),soul:read(root+'soul.md'),quotes:read(root+'canon/quotes.md'),storyMode:read(root+'modes/story.md'),storyStyle:read(root+'styles/story.md'),tone:read('Prompt/shared/tone.md'),worldbooks:Object.fromEntries(WORLDBOOK_FILES.map(file=>[file,read(root+'worldbook/'+file)]))}
const prior=JSON.stringify(assets),card=buildDaniaCard(assets),d=card.data
const checkCard=c=>checkDaniaCard(c,assets)
test('01 mechanical build passes all integrity checks',()=>assert.equal(checkCard(card).ok,true))
test('02 worldbook has 75 entries and reconstructs four sources byte for byte',()=>{assert.equal(d.character_book.entries.length,75);for(const file of WORLDBOOK_FILES)assert.equal(d.character_book.entries.filter(e=>e.extensions.ncFile===file).map(e=>e.content).join(''),assets.worldbooks[file])})
test('03 builder preserves assets without mutation and greetings exactly',()=>{assert.equal(JSON.stringify(assets),prior);for(const key of ['scenario','first_mes','alternate_greetings'])assert.deepEqual(d[key],assets.sourceCard.data[key])})
test('04 quotes conversion reverses exactly and includes all 81 examples',()=>{assert.equal(restoreQuotes(d.mes_example),assets.quotes);assert.equal(d.mes_example.match(/^<START>$/gm).length,81)})
test('05 story rules preserve boundaries and delete numeric length limits',()=>{for(const word of ['只演','不代演','不推进'])assert.ok(d.system_prompt.includes(word));assert.ok(!/[0-9]+[～~–—-]?[0-9]*\s*字/.test(d.system_prompt+d.post_history_instructions));for(const marker of ['称呼的自然度','信息单次释放原则','禁止每轮结尾固定反问'])assert.ok(d.post_history_instructions.includes(marker),marker)})
test('06 chat and agent distinctive rules do not enter story card',()=>{const staticText=JSON.stringify(d);for(const marker of ['纯日常对话、陪伴与解惑模式。不挂载任何执行工具。','文件操作只在当前工作区内；越界先说明理由','拒绝心理侧写（Anti-Detective Deduction）','语境隔离铁律（No Modern Slang / Code Leak）'])assert.equal(staticText.includes(marker),false,marker)})
test('07 tampering one source entry is detected despite passing byte count',()=>{const copy=structuredClone(card);copy.data.character_book.entries[0].content+=' EXTRA';assert.equal(checkCard(copy).ok,false)})
test('08 removing a quote is detected',()=>{const copy=structuredClone(card);copy.data.mes_example=copy.data.mes_example.replace('<START>','');assert.equal(checkCard(copy).ok,false)})
test('09 artifact equals deterministic build without modifying original',()=>assert.equal(read('../ST导出/妲妮娅.story.json'),serializeCard(card)))
test('10 entry identity keys priority and constant match source mapping',()=>{for(const e of d.character_book.entries.filter(e=>WORLDBOOK_FILES.includes(e.extensions.ncFile))){assert.ok(e.keys.includes(e.name));assert.equal(typeof e.constant,'boolean');assert.equal(e.priority,e.extensions.ncPriority);assert.equal(e.insertion_order,e.priority*10)}})
done()
