import fs from 'node:fs'
import path from 'node:path'
const root=path.resolve('../DOC/agent--ST桥接重构'), base=path.join(root,'task-桥接重构1/baseline')
const summaries=p=>fs.readFileSync(p,'utf8').split(/\r?\n/).map(x=>x.trim()).filter(x=>/^共 \d+ 项/.test(x))
const before=summaries(path.join(root,'task-桥接重构/baseline/sup05b-full.log'))
const after=summaries(path.join(base,'q36-test-all.log'))
const diff=before.flatMap((text,i)=>text===after[i]?[]:[{index:i+1,before:text,after:after[i]??null}])
const result={baselineSuites:before.length,observedSuites:after.length,differences:diff,extra:after.slice(before.length)}
fs.writeFileSync(path.join(base,'q36-regression-diff.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
