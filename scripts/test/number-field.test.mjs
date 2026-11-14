/**
 * 设置页数字输入框（NumberField）—— N-01…N-13 + 4 条结构守卫。
 *
 * 这一版修的是两个真实报障：
 *  ①「点进去只能打一个字符，得再点一次才能打下一位」
 *  ②「输入小于下限会被立刻改写，想打两位数根本打不进去」
 *
 * 测的东西分两层，都是真边界：
 *  - 纯函数层（clampNumber / parseNumberDraft / formatNumberDraft）：空串、非法、越界、0 是否合法；
 *  - 结构层：设置页不许再出现裸 <input type="number">，数字框不许在存盘期间禁用，
 *    组件的 onChange 只许改草稿（一旦有人在 onChange 里提交，①就会复活）。
 *
 * 跑法：node scripts/test/number-field.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { bundleModule, createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()

const mod = await bundleModule(
  'number-field',
  "export * from '" + p('src/renderer/src/components/numberFieldMath.ts') + "'"
)
const { clampNumber, parseNumberDraft, formatNumberDraft } = mod

/* ───────────────────── 纯函数层 ───────────────────── */

check('N-01 空串 / 纯空格读不出数字（→ null，不是 0）', parseNumberDraft('') === null && parseNumberDraft('   ') === null, JSON.stringify([parseNumberDraft(''), parseNumberDraft('   ')]))
check('N-02 还没打完的半截输入读不出数字', parseNumberDraft('-') === null && parseNumberDraft('1e') === null && parseNumberDraft('abc') === null, JSON.stringify([parseNumberDraft('-'), parseNumberDraft('1e'), parseNumberDraft('abc')]))
check('N-03 正常数字 / 小数 / 科学计数法', parseNumberDraft('12') === 12 && parseNumberDraft(' 0.5 ') === 0.5 && parseNumberDraft('1e3') === 1000, JSON.stringify([parseNumberDraft('12'), parseNumberDraft('0.5'), parseNumberDraft('1e3')]))

check('N-04 低于下限 → 提交时钳到下限', clampNumber('5', 20, 100, 40) === 20, String(clampNumber('5', 20, 100, 40)))
check('N-05 高于上限 → 钳到上限', clampNumber('999', 20, 100, 40) === 100, String(clampNumber('999', 20, 100, 40)))
check('N-06 空 / 非法 → 回退原值（绝不把 0 写进去）', clampNumber('', 20, 100, 40) === 40 && clampNumber('abc', 20, 100, 40) === 40, JSON.stringify([clampNumber('', 20, 100, 40), clampNumber('abc', 20, 100, 40)]))
check('N-07 clampNumber(\'0\') === 0：0 是合法值，别当成空', clampNumber('0', 0, 4000, 400) === 0, String(clampNumber('0', 0, 4000, 400)))
check('N-08 只有下限（token 预算那种）不砍上限', clampNumber('99999', 100, undefined, 1200) === 99999, String(clampNumber('99999', 100, undefined, 1200)))
check('N-09 分数（0–1）照常钳，不取整', clampNumber('0.7', 0, 1, 0.55) === 0.7 && clampNumber('1.4', 0, 1, 0.55) === 1, JSON.stringify([clampNumber('0.7', 0, 1, 0.55), clampNumber('1.4', 0, 1, 0.55)]))
check('N-10 非有限数不做边界比较（NaN 不会漏出输入框）', formatNumberDraft(Number.NaN) === '' && formatNumberDraft(12.5) === '12.5', JSON.stringify([formatNumberDraft(Number.NaN), formatNumberDraft(12.5)]))

// N-11：这条就是「打不进第二个字符」的机制说明 —— 边打字边钳会把中间态毁掉
const typed = ['1', '10', '100']
const midClamped = typed.map((raw) => clampNumber(raw, 20, 4000, 40))
check(
  'N-11 边打字边钳会毁掉中间态（1→20、10→20），只有最终态合法 → 所以只能在提交时钳',
  midClamped[0] === 20 && midClamped[1] === 20 && midClamped[2] === 100,
  JSON.stringify(midClamped)
)
check('N-12 提交时钳一次：12 改 100 得到 100', clampNumber('100', 1, 4000, 12) === 100, String(clampNumber('100', 1, 4000, 12)))

/* ───────────────────── 结构守卫 ───────────────────── */

const root = process.cwd()
const readText = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const sections = [
  'src/renderer/src/features/settings/sections/MemorySection.tsx',
  'src/renderer/src/features/settings/sections/QqSection.tsx',
  'src/renderer/src/features/settings/sections/ModelSection.tsx',
  'src/renderer/src/features/worldbook/WorldbookEditorDialog.tsx'
]
const texts = sections.map((rel) => [rel, readText(rel)])

const rawNumber = texts.filter(([, text]) => /<input[^>]*type="number"|type="number"/.test(text)).map(([rel]) => rel)
check('N-13 设置页没有裸 <input type="number">（一律走 NumberField）', rawNumber.length === 0, rawNumber.join(',') || 'all-clean')

const missing = texts.filter(([rel, text]) => !text.includes('<NumberField')).map(([rel]) => rel)
check('N-14 四个文件都真的用上了 NumberField', missing.length === 0, missing.join(',') || 'all-used')

/** 把每个 <NumberField …/> 块抠出来，逐个检查它不该带的东西 */
const blocks = []
for (const [rel, text] of texts) {
  const re = /<NumberField[\s\S]*?\/>/g
  let hit
  while ((hit = re.exec(text))) blocks.push({ rel, body: hit[0] })
}
check('N-15 17 个数字框全部改到了（9 摘要/记忆 + 5 QQ + 1 模型 + 2 世界书）', blocks.length === 17, String(blocks.length))

const savingDisabled = blocks.filter((item) => /disabled=\{saving\b/.test(item.body)).map((item) => item.rel)
check('N-16 数字框不在存盘期间禁用（禁用 = 丢焦点 = 必须再点一次）', savingDisabled.length === 0, savingDisabled.join(',') || 'none')

const noCommit = blocks.filter((item) => !/onCommit=\{/.test(item.body)).map((item) => item.rel)
check('N-17 每个数字框都走 onCommit（失焦/回车提交）', noCommit.length === 0, noCommit.join(',') || 'all-have-onCommit')

const compText = readText('src/renderer/src/components/NumberField.tsx')
check(
  'N-18 组件的 onChange 只改草稿，不提交、不钳',
  /onChange=\{\(event\) => setDraft\(event\.target\.value\)\}/.test(compText) && !/onChange=\{\(event\)[\s\S]{0,80}onCommit/.test(compText),
  'onChange-body'
)
check(
  'N-19 提交点在 onBlur，且提交时才 clampNumber',
  compText.includes('onBlur') && compText.includes('clampNumber(') && compText.includes('setDraft(formatNumberDraft(value))'),
  'blur-commit'
)
check(
  'N-20 打字期间不被外部值抢焦点：useEffect 有 editing 守卫',
  /if \(!editing\) setDraft\(formatNumberDraft\(value\)\)/.test(compText),
  'editing-guard'
)

done()
