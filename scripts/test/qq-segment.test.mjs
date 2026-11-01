/**
 * A1 切分纯函数（P4 G1）。边界表 7 行**逐行**有断言（蓝图 §4.4）。
 * 跑法：node scripts/test/qq-segment.test.mjs
 */
import { bundleModule, createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const mod = await bundleModule('segment', `export { splitForQq } from '${p('src/main/features/qq/segment.ts')}'`)
const { splitForQq } = mod

function eq(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual))
}

console.log('边界表')
eq('空串 → []', splitForQq(''), [])
eq('纯空白 → []', splitForQq('   \n\t '), [])
eq('一。二。三。', splitForQq('一。二。三。'), ['一。', '二。', '三。'])
eq('maxSegments=3 时末段并入', splitForQq('一。二。三。四。五。', { maxSegments: 3 }), [
  '一。',
  '二。',
  '三。四。五。'
])
eq('A？B！C（末段无断句符也收）', splitForQq('A？B！C'), ['A？', 'B！', 'C'])
eq('段首空白丢弃', splitForQq('  A。  B。'), ['A。', 'B。'])

const long = '啊'.repeat(3000)
const longParts = splitForQq(long)
check('3000 个「啊」→ 两段', longParts.length === 2, longParts.length)
check(
  '每段 ≤ 1500 码点',
  longParts.every((part) => Array.from(part).length <= 1500),
  longParts.map((part) => Array.from(part).length).join('/')
)
check('拼接逐字守恒（J-16）', longParts.join('') === long, longParts.join('').length + ' vs 3000')

console.log('围栏代码块保护')
const fenced = ['看这段：', '```js', 'const a = 1;', 'const b = 2;', '```', '就这样。'].join('\n')
const fenceParts = splitForQq(fenced)
const fencePart = fenceParts.find((part) => part.startsWith('```'))
check('围栏块整体落在同一段', Boolean(fencePart) && fencePart.includes('const a = 1;') && fencePart.includes('const b = 2;'), fencePart && fencePart.length)
check('分号没把代码劈开（段数 = 3：前文本 / 围栏 / 尾文本）', fenceParts.length === 3, fenceParts.length)
check('围栏段不带出后面的正文', Boolean(fencePart) && !fencePart.includes('就这样'), fencePart && fencePart.slice(-8))

console.log('未闭合围栏')
const unclosed = splitForQq('```js\nconst x = 1;\n还没写完')
check('未闭合围栏当普通文本发出去（不丢内容）', unclosed.join('').includes('const x = 1;'), unclosed.length + ' 段')

console.log('码点硬断的断点偏好')
const longSentence = '甲'.repeat(1400) + '。' + '乙'.repeat(300)
const hard = splitForQq(longSentence)
check('断点落在句号后（不是窗口正中）', hard[0].endsWith('。'), hard[0].slice(-2))

// ── A0b 超长围栏块不劈开（X-03）────────────────────────────────────────────
// 判据用「围栏计数为偶数 + 首尾都是围栏 + 去空白后内容守恒」，
// 只数段数会放过「每段都缺尾围栏」这种坏实现（D33：没有对照物的否定判据）。
console.log('超长围栏块按行切（X-03 / A0b）')
const TICK = '```'
const fenceTicks = (part) => part.split(TICK).length - 1
const bigLines = Array.from({ length: 200 }, (_, i) => 'const v' + String(i) + ' = ' + String(i) + ';')
const bigFence = TICK + 'js\n' + bigLines.join('\n') + '\n' + TICK
const bigParts = splitForQq('看看：' + bigFence, { maxChars: 1500 })
const bigFences = bigParts.filter((part) => part.startsWith(TICK))
check('长围栏确实被切成了多段（判据不空转）', bigFences.length >= 2, bigFences.length)
check('每一段的围栏计数都是偶数（A0b-1）', bigFences.every((part) => fenceTicks(part) % 2 === 0), bigFences.map(fenceTicks).join('/'))
check('每一段都以围栏开头、以围栏结尾（A0b-2）', bigFences.every((part) => part.startsWith(TICK) && part.endsWith(TICK)), bigFences.length + ' 段')
const stripFences = (part) =>
  part
    .split('\n')
    .filter((line) => !line.trim().startsWith(TICK))
    .join('')
const reflow = (text) => text.replace(/\s/g, '')
check('各段剥掉围栏后去空白拼接 = 原文内层（A0b-3 / J-16）', reflow(stripFences(bigFences.join(''))) === reflow(bigLines.join('')), String(reflow(stripFences(bigFences.join(''))).length) + ' vs ' + String(reflow(bigLines.join('')).length))

const oneLine = TICK + 'js ' + 'a'.repeat(5000) + TICK
const oneLineParts = splitForQq(oneLine, { maxChars: 1500 })
check('单行 5000 码点围栏：每段围栏计数仍是偶数（A0b-4）', oneLineParts.length >= 2 && oneLineParts.every((part) => fenceTicks(part) % 2 === 0), oneLineParts.map(fenceTicks).join('/'))
check('单行围栏各段都重裹了围栏', oneLineParts.every((part) => part.startsWith(TICK) && part.endsWith(TICK)), oneLineParts.length + ' 段')

const veryLongUnclosed = TICK + 'js\n' + 'x'.repeat(4000)
const unclosedParts = splitForQq(veryLongUnclosed)
check('未闭合围栏仍走文本分支（内容不丢，A0b-5）', reflow(unclosedParts.join('')) === reflow(veryLongUnclosed), unclosedParts.length + ' 段')

const shortFence = TICK + 'js\nconst a = 1;\nconst b = 2;\n' + TICK
const shortParts = splitForQq('前言。' + shortFence)
check('短围栏原样保留（与改动前一致，A0b-6）', shortParts.length === 2 && shortParts[1] === shortFence, JSON.stringify(shortParts))

done()
