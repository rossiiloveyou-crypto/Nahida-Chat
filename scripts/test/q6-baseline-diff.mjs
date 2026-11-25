import fs from 'node:fs'
import path from 'node:path'
const dir = path.resolve('../DOC/agent--ST桥接重构/task-桥接重构1/baseline')
const summaries = name => fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => /^共 [0-9]+ 项/.test(s))
const current = summaries('q6-full-test-final.log')
const previous = summaries('q5-full-test.log')
const frozen = summaries('../../task-桥接重构/baseline/sup05b-full.log')
const diff = rows => rows.flatMap((before, index) => before === current[index] ? [] : [{ index, before, after: current[index] ?? null }])
const log = fs.readFileSync(path.join(dir, 'q6-full-test-final.log'), 'utf8')
const result = { frozenRows: frozen.length, previousRows: previous.length, currentRows: current.length, frozenDifferences: diff(frozen), previousDifferences: diff(previous), folding: /PASS q6-folding 23\/23/.test(log), scroll: /CHROMIUM_CHECKS 52\/52/.test(log) }
fs.writeFileSync(path.join(dir, 'q6-regression-diff.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
if (result.frozenDifferences.length || result.previousDifferences.length || current.length < previous.length || !result.folding || !result.scroll) process.exitCode = 1
