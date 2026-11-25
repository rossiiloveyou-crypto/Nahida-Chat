import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
const root=process.cwd(), base=path.resolve(root,'../DOC/agent--ST桥接重构/task-桥接重构1/baseline')
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'))
const names=[...pkg.scripts.test.matchAll(/pnpm run (test:[\w-]+)/g)].map(x=>x[1])
const rows=[]; const log=fs.openSync(path.join(base,'q36-test-all.log'),'w')
for(const name of names){fs.writeSync(log,'\n=== '+name+' ===\n');const start=Date.now();const run=spawnSync(pkg.scripts[name],{shell:true,stdio:['ignore',log,log],timeout:180000});const row={name,exitCode:run.status,signal:run.signal,error:run.error?.message,ms:Date.now()-start};rows.push(row);fs.writeFileSync(path.join(base,'q36-test-all-results.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify(row))}
fs.closeSync(log);process.exitCode=rows.some(x=>x.exitCode!==0)?1:0
