/**
 * 模式供给探针的断言包装（PHASE-0 · T4 → PHASE-1 · T5 扩到七场景）。
 *
 * 把 probe-mode-supply.mjs 的一次性输出变成**守卫**：
 * 一条不进 test 链的守卫等于不存在（PHASE-0 §四 4.2 的理由）。
 *
 * 场景表与期望值只在 probe-mode-supply.mjs 的 PROBE_SCENARIOS 里定义一处（B2）：
 * 本文件不写第二份数字，避免「探针改了、断言没改」这种静默失效。
 *
 * 跑法：node scripts/test/probe-mode-supply.test.mjs  （或 pnpm test 链尾）
 */
import { runProbe, PROBE_SCENARIOS } from './probe-mode-supply.mjs'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok: Boolean(ok) })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
}

console.log('模式供给探针（实跑 provider，服务端实测 tools 长度）')
const probe = await runProbe()

// 对照物：注册表空时，下面每一个「= 0」都通过得毫无意义（P17）。
check('对照物：注册表非空', probe.registered > 0, 'registered=' + probe.registered)

for (const scenario of PROBE_SCENARIOS) {
  const row = probe[scenario.key]
  check(
    scenario.label + ' tools=' + scenario.expect + '（' + scenario.why + '）',
    row.tools === scenario.expect,
    'mode=' + row.mode + ' tools=' + row.tools + ' status=' + row.status
  )
}

// 每轮都必须真的跑完：status 不是 done 时，tools 的 0 可能只是「这一轮炸了」。
const statuses = PROBE_SCENARIOS.map((scenario) => probe[scenario.key].status)
check(
  '每个场景都真的跑完了（没有一轮是失败后被当成 0）',
  statuses.every((status) => status === 'done'),
  statuses.join('/')
)

// 成对判定的显式化（P17）：agent 满 + chat 未开为空，才证明那个 0 不是「函数恒返回空」。
check(
  '成对对照：agent 满 & chat 未开增强为空',
  probe.agent.tools === probe.registered && probe.chat.tools === 0,
  'agent=' + probe.agent.tools + ' registered=' + probe.registered + ' chat=' + probe.chat.tools
)

const failed = results.filter((row) => !row.ok)
console.log('')
console.log('共 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项')
if (failed.length > 0) {
  console.log('失败：')
  for (const row of failed) console.log('  - ' + row.label)
  process.exit(1)
}
console.log('PASS probe-mode-supply')
