/**
 * 回写门禁的负向对照（PHASE-0 · T2）。
 *
 * 守的是什么：完成报告 §十「回写清单」里只要还有未勾选的 [ ]，该阶段就不得提交 /
 * 不得宣告完成（规范 §5.1）。这条门禁靠一条 grep 命令实现 —— 而它**曾经假绿过一次**
 * （旧版只匹配列表式 - [ ]，而清单实际是表格行 | [ ] |，于是 4 项全未勾也「无输出」）。
 *
 * 所以本脚本不做「现在是绿的」这种零信息量的报告，而是证明**它能变红**（经验库 P13）：
 *   A 样例：表格里留一个未勾 -> 必须命中 1
 *   B 样例：表格全勾       -> 必须命中 0
 *   C 样例：列表式未勾     -> 必须命中 1
 *   D 样例：空文件         -> 必须命中 0（这是 A/C 的对照物：P17 空样本假通过）
 *
 * 跑法：node scripts/test/gate-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 规范原文（../methodology/BLUEPRINT-撰写规范.md §5.1）里那条命令的模式，逐字符照抄。
 *
 * A-08 突变验证只替换下面的 GATE_PATTERN，**不动这里** ——
 * 于是突变后的日志能直接区分「脚本实现坏了」还是「规范那条命令本身失效」。
 */
export const SPEC_PATTERN = '^\\s*-\\s*\\[ \\]|\\|\\s*\\[ \\]\\s*\\|'

/** 脚本自己的实现。正常情况下必须与 SPEC_PATTERN 同解（A-04 / A-05 就是在验这件事）。 */
export const GATE_PATTERN = '^\\s*-\\s*\\[ \\]|\\|\\s*\\[ \\]\\s*\\|'

export function countHits(text, pattern = GATE_PATTERN) {
  const re = new RegExp(pattern, 'm')
  return text.split('\n').filter((line) => re.test(line)).length
}

const CASES = [
  {
    key: 'A',
    label: '表格含一个未勾 [ ]',
    expect: 1,
    text: [
      '| 触发条件 | 回写目标 | 回写内容一句话 | 已勾选 |',
      '|---|---|---|---|',
      '| T1 判据被修正 | 判据台账 | 追加一行 | [x] |',
      '| T2 基线数值被改写 | 总蓝图 §九 | 写新值 | [ ] |',
      ''
    ].join('\n')
  },
  {
    key: 'B',
    label: '表格全部已勾 [x]',
    expect: 0,
    text: [
      '| 触发条件 | 回写目标 | 回写内容一句话 | 已勾选 |',
      '|---|---|---|---|',
      '| T1 判据被修正 | 判据台账 | 追加一行 | [x] |',
      '| T2 基线数值被改写 | 总蓝图 §九 | 写新值 | [x] |',
      ''
    ].join('\n')
  },
  {
    key: 'C',
    label: '列表式未勾 - [ ]',
    expect: 1,
    text: ['- [ ] 未勾的清单项', '- [x] 已勾的清单项', ''].join('\n')
  },
  {
    key: 'D',
    label: '空文件（A/C 的对照物）',
    expect: 0,
    text: ''
  }
]

/** 用系统 grep 复核一遍：脚本内的 JS 正则必须与规范里那条命令同解。 */
function grepHits(file) {
  const result = spawnSync('grep', ['-cE', SPEC_PATTERN, file], { encoding: 'utf8' })
  if (result.error || result.status === null) return null
  const raw = String(result.stdout || '').trim()
  return raw === '' ? 0 : Number(raw)
}

export function runGateCheck() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-gate-check-'))
  return CASES.map((item) => {
    const file = path.join(dir, 'case-' + item.key + '.md')
    fs.writeFileSync(file, item.text, 'utf8')
    const hits = countHits(item.text)
    const external = grepHits(file)
    return { ...item, hits, external, ok: hits === item.expect && (external === null || external === item.expect) }
  })
}

async function main() {
  const rows = runGateCheck()
  let failed = 0
  for (const row of rows) {
    const ok = row.ok
    if (!ok) failed += 1
    const ext = row.external === null ? 'grep:n/a' : 'grep:' + row.external
    console.log(
      row.key + ': hit=' + row.hits + ' expect=' + row.expect + ' ' + ext + (ok ? ' OK' : ' FAIL') + '  ' + row.label
    )
  }
  if (failed > 0) {
    console.log('GATE_CHECK_FAILED ' + failed + ' 个样例不符合期望')
    process.exit(1)
  }
  console.log('PASS gate-check')
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch((error) => {
    console.error('GATE_CHECK_ERROR ' + (error && error.message ? error.message : String(error)))
    process.exit(1)
  })
}
