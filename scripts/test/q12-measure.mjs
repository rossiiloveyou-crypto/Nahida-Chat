import fs from 'node:fs'
import crypto from 'node:crypto'
import {bundleModule,p} from './qq-test-util.mjs'
const {sanitizeChunkText}=await bundleModule('q12-measure','export {sanitizeChunkText} from '+JSON.stringify(p('src/main/features/rag/sanitize.ts')))
const source=process.argv[2],storyId=process.argv[3]
if(!source||!storyId)throw Error('usage: q12-measure.mjs SOURCE STORY_ID')
const raw=fs.readFileSync(source,'utf8'),parsed=JSON.parse(raw)
const rows=Array.isArray(parsed)?parsed:(parsed.sessions??Object.values(parsed))
const sessions=rows.filter(s=>s.storyId===storyId).map(s=>{
 const messages=s.messages??[]
 const games=messages.flatMap(m=>(m.content??'').match(/<game(?:\s[^>]*)?>[\s\S]*?<\/game\s*>/gi)??[])
 for(const message of messages)for(const game of (message.content??'').match(/<game(?:\s[^>]*)?>[\s\S]*?<\/game\s*>/gi)??[])if(!sanitizeChunkText(message.content).includes(game))throw Error('game content changed')
 const before=messages.reduce((n,m)=>n+(m.content??'').length,0),after=messages.reduce((n,m)=>n+sanitizeChunkText(m.content??'').length,0)
 return {id:s.id,messages:messages.length,gameBlocks:games.length,gameBlocksPreserved:true,before,after,reduction:before?(before-after)/before:0,sourceSha256:crypto.createHash('sha256').update(JSON.stringify(messages.map(m=>[m.id,m.content]))).digest('hex')}
})
if(fs.readFileSync(source,'utf8')!==raw)throw Error('source changed during measurement')
console.log(JSON.stringify({storyId,sessions,readOnlyUnchanged:true},null,2))
