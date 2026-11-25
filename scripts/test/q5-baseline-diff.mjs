import fs from 'node:fs'
import path from 'node:path'
const dir=path.resolve('../DOC/agent--ST桥接重构/task-桥接重构1/baseline')
const summaries=file=>fs.readFileSync(file,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>/^共 [0-9]+ 项/.test(s))
const frozen=summaries(path.join(dir,'../../task-桥接重构/baseline/sup05b-full.log'))
const previous=summaries(path.join(dir,'q45-full-test.log'))
const current=summaries(path.join(dir,'q5-full-test.log'))
const diff=rows=>rows.flatMap((before,i)=>before===current[i]?[]:[{index:i,before,after:current[i]??null}])
const content=fs.readFileSync(path.join(dir,'q5-full-test.log'),'utf8')
const result={frozenSuites:frozen.length,frozenCases:2273,previousSummaryRows:previous.length,currentSummaryRows:current.length,frozenDifferences:diff(frozen),previousDifferences:diff(previous),storage:/Settings encryption: 23 passed, 0 failed/.test(content),ui:/PASS settings-encryption-ui 8\/8/.test(content)}
fs.writeFileSync(path.join(dir,'q5-regression-diff.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result))
if(result.frozenDifferences.length||result.previousDifferences.length||current.length!==previous.length||!result.storage||!result.ui)process.exitCode=1
