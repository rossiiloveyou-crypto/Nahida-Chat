import fs from 'node:fs'
import path from 'node:path'
const base=path.resolve('../DOC/agent--ST桥接重构/task-桥接重构1/baseline')
const summaries=file=>fs.readFileSync(file,'utf8').split(String.fromCharCode(10)).map(s=>s.trim()).filter(s=>/^共 [0-9]+ 项/.test(s))
const frozen=summaries(path.resolve(base,'../../task-桥接重构/baseline/sup05b-full.log'))
const prior=summaries(path.join(base,'q4-final-test.log'))
const current=summaries(path.join(base,'q45-full-test.log'))
const diff=expected=>expected.flatMap((s,i)=>s===current[i]?[]:[{index:i,before:s,after:current[i]??null}])
const result={baselineSuites:frozen.length,baselineCases:2273,currentSummaryRows:current.length,differences:diff(frozen),q4Differences:diff(prior),extraSummaries:current.slice(prior.length)}
fs.writeFileSync(path.join(base,'q45-regression-diff.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result))
if(result.differences.length||result.q4Differences.length||current.length!==prior.length+1)process.exitCode=1
