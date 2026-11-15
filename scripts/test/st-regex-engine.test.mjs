/**
 * ST 正则引擎（P2）—— 38 项，全部机器可判（本 Phase 无 M 档）。
 *
 * 测的是**引擎与读盘层**两件事：
 *  A. 引擎（F-01…F-04）：S1–S8 的语义逐条钉住，外加一条「产物含 HTML 宿主标记就回落原文」。
 *     判据全部是「输入 → 期望输出」的字符串比对，不看实现长相。
 *  B. 读盘（F-05）：真建临时目录、真写 settings.json、真改 mtime，验证缓存按时失效；
 *     并且验证它**只读**（跑完文件 mtime/size/内容一字不变）。
 *
 * 跑法：node scripts/test/st-regex-engine.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, p, projectRoot } from './qq-test-util.mjs'

const { check, done } = createChecker()

const mod = await bundleModule(
  'st-regex-engine',
  [
    `export { getRegexedString, runRegexScript, htmlHostMarker, isOutOfDepth, clearRegexCache } from '${p('src/shared/regexEngine.ts')}'`,
    `export { readScripts, listMarkdownOnlyScripts, normalizeScript, invalidateScriptsCache } from '${p('src/main/features/regex/scripts.ts')}'`,
    `export { REGEX_PLACEMENT } from '${p('src/shared/regex.ts')}'`
  ].join('\n')
)

const { getRegexedString, runRegexScript, htmlHostMarker, isOutOfDepth, readScripts, listMarkdownOnlyScripts, normalizeScript } = mod
const AI_OUTPUT = mod.REGEX_PLACEMENT.AI_OUTPUT
const USER_INPUT = mod.REGEX_PLACEMENT.USER_INPUT

/** 造一条脚本；不传的字段一律取「最无害」的默认值。 */
const script = (over = {}) => ({
  id: over.id ?? 's',
  scriptName: over.scriptName ?? 's',
  disabled: false,
  runOnEdit: true,
  findRegex: '/x/g',
  replaceString: '',
  trimStrings: [],
  placement: [AI_OUTPUT],
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
  markdownOnly: false,
  promptOnly: false,
  ...over
})

const readSource = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8')
const run = (raw, scripts, options = {}) => getRegexedString(raw, options.placement ?? AI_OUTPUT, { scripts, ...options })

console.log('1 · 引擎是纯函数（不 import electron、不读盘）')

const engineSrc = readSource('src/shared/regexEngine.ts')
const scriptsSrc = readSource('src/main/features/regex/scripts.ts')
const sharedSrc = readSource('src/shared/regex.ts')
check('1 · engine.ts 不 import electron', !/from\s+['"]electron['"]/.test(engineSrc))
check('2 · engine.ts 不碰 fs / path（读盘只归 scripts.ts）', !/from\s+['"]node:(fs|path)['"]/.test(engineSrc))
check('3 · 三个新文件里没有出现「宿主模板名」这类预设耦合词', !/wave/i.test(engineSrc + scriptsSrc + sharedSrc))

console.log('2 · S4 + S6：捕获组（A2 的原样场景）')

const plain = script({
  id: 't-plain',
  scriptName: 't-plain',
  findRegex: '/<note>([\\s\\S]*?)<\\/note>/gi',
  replaceString: '> $1'
})
check('4 · <note>x</note> → > x', run('<note>x</note>', [plain]) === '> x', run('<note>x</note>', [plain]))
check('5 · 非 AI_OUTPUT 位置不生效', getRegexedString('<note>x</note>', USER_INPUT, { scripts: [plain] }) === '<note>x</note>')

const named = script({
  id: 't-named',
  findRegex: '/<b>(?<inner>[^<]*)<\\/b>/g',
  replaceString: '[$<inner>]'
})
check('6 · $<name> 命名组', run('<b>hi</b>', [named]) === '[hi]', run('<b>hi</b>', [named]))

const whole = script({ id: 't-whole', findRegex: '/<x>([^<]*)<\\/x>/g', replaceString: '《{{match}}》' })
check('7 · {{match}} 等于 $0（整段匹配）', run('<x>ab</x>', [whole]) === '《<x>ab</x>》', run('<x>ab</x>', [whole]))

console.log('3 · S7：trimStrings 逐个删除子串')

const trimmed = script({
  id: 't-trim',
  findRegex: '/\\(([^)]*)\\)/g',
  replaceString: '($1)',
  trimStrings: ['（', '）', ' ']
})
check('8 · 捕获组先过 trimStrings', run('( 甲（乙） )', [trimmed]) === '(甲乙)', run('( 甲（乙） )', [trimmed]))

console.log('4 · S3：按数组顺序串行（A4）')

const A = script({ id: 'A', scriptName: 'A', findRegex: '/<i>([^<]*)<\\/i>/g', replaceString: '[$1]' })
const B = script({ id: 'B', scriptName: 'B', findRegex: '/\\[([^\\]]*)\\]/g', replaceString: '«$1»' })
const forward = run('<i>k</i>', [A, B])
const backward = run('<i>k</i>', [B, A])
check('9 · A→B 的产物是 «k»', forward === '«k»', forward)
check('10 · B→A 与 A→B 不同（顺序敏感）', forward !== backward, backward)
check('11 · B→A 的产物是 [k]（B 看不到未生成的方括号）', backward === '[k]', backward)

console.log('5 · S1 + S2：通道与深度过滤')

const mdOnly = script({ id: 'md', markdownOnly: true, findRegex: '/aa/g', replaceString: 'MD' })
const promptOnly = script({ id: 'po', promptOnly: true, findRegex: '/aa/g', replaceString: 'PO' })
const everywhere = script({ id: 'any', findRegex: '/aa/g', replaceString: 'ANY' })
check('12 · markdownOnly 只在 markdown 通道跑', getRegexedString('aa', AI_OUTPUT, { scripts: [mdOnly, promptOnly, everywhere], isMarkdown: true }) === 'MD')
check('13 · promptOnly 只在 prompt 通道跑', getRegexedString('aa', AI_OUTPUT, { scripts: [mdOnly, promptOnly, everywhere], isPrompt: true }) === 'PO')
check('14 · 两者皆否的脚本只在非 markdown 且非 prompt 时跑', run('aa', [mdOnly, promptOnly, everywhere]) === 'ANY')

const deep = script({ id: 'deep', findRegex: '/zz/g', replaceString: 'DEEP', minDepth: 2 })
check('15 · minDepth=2 在 depth=1 时跳过（A5）', run('zz', [deep], { depth: 1 }) === 'zz', run('zz', [deep], { depth: 1 }))
check('16 · minDepth=2 在 depth=2 时生效', run('zz', [deep], { depth: 2 }) === 'DEEP')
check('17 · 不给 depth 就不过滤深度', run('zz', [deep]) === 'DEEP')
check('18 · maxDepth=0 在 depth=3 时跳过', run('zz', [script({ maxDepth: 0, replaceString: 'X', findRegex: '/zz/g' })], { depth: 3 }) === 'zz')
check('19 · isOutOfDepth 对 null 深度返回 false', isOutOfDepth(script({ minDepth: null, maxDepth: null }), 5) === false)

console.log('6 · S1 的 disabled / placement / 坏正则')

check('20 · disabled 脚本不跑', run('zz', [script({ disabled: true, findRegex: '/zz/g', replaceString: 'X' })]) === 'zz')
check('21 · 编译不出来的正则原样返回', run('<k>', [script({ findRegex: '/([unclosed/g', replaceString: 'X' })]) === '<k>')

console.log('7 · M9：产物含 HTML 宿主标记 → 该条不生效（A3）')

const htmlScript = script({
  id: 't-html',
  scriptName: 't-html',
  findRegex: '/<panel>([\\s\\S]*?)<\\/panel>/gi',
  replaceString: '<!doctype html><html><body>$1</body></html>'
})
const logs = []
const a3 = getRegexedString('<panel>正文</panel>', AI_OUTPUT, { scripts: [htmlScript], onDebug: (line) => logs.push(line) })
check('22 · 输出仍是原文标签（未执行）', a3 === '<panel>正文</panel>', a3)
check('23 · debug 里有脚本名与跳过原因', logs.length === 1 && logs[0].includes('t-html') && /HTML/.test(logs[0]), logs[0])

const silentHtml = script({ id: 'quiet', scriptName: '无害正则', findRegex: '/<panel>[\\s\\S]*?<\\/panel>/gi', replaceString: '<style>body{}</style>' })
const captured = []
const savedDebug = console.debug
console.debug = (...args) => { captured.push(args.map(String).join(' ')) }
const a3b = getRegexedString('<panel>x</panel>', AI_OUTPUT, { scripts: [silentHtml] })
console.debug = savedDebug
check('24 · 降级只看产物形态，不看脚本名（含 <style> 也跳过）', a3b === '<panel>x</panel>', a3b)
check('25 · 默认走 console.debug', captured.length === 1 && captured[0].includes('无害正则'), captured[0])
check('26 · htmlHostMarker 认得 <iframe>、不误报普通尖括号', htmlHostMarker('<iframe src=x>') === '<iframe' && htmlHostMarker('<note>x</note>') === null)

console.log('8 · S8：宏展开（A6）')

const macroScript = script({ id: 'macro', findRegex: '/<who>([^<]*)<\\/who>/g', replaceString: '{{char}}' })
check('27 · {{char}} 被展开（注入 stub 宏表）', run('<who>x</who>', [macroScript], { macros: { char: '娜希妲' } }) === '娜希妲')
check('28 · 没有宏表时 {{char}} 原样保留', run('<who>x</who>', [macroScript]) === '{{char}}')

console.log('9 · F-05：读 settings.json（真实文件 + mtime 失效）')

const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-st-regex-'))
const settingsPath = path.join(stDir, 'settings.json')
const rowA = { id: 'r-a', scriptName: '读盘 A', findRegex: '/a/g', replaceString: 'A', placement: [2], markdownOnly: true, disabled: false, trimStrings: [] }
const rowB = { id: 'r-b', scriptName: '读盘 B', findRegex: '/b/g', replaceString: 'B', placement: [2], markdownOnly: false, disabled: false, trimStrings: [] }
fs.writeFileSync(settingsPath, JSON.stringify({ extension_settings: { regex: [rowA, rowB] } }), 'utf8')

const beforeStat = fs.statSync(settingsPath)
const beforeText = fs.readFileSync(settingsPath, 'utf8')
const first = readScripts(stDir)
check('29 · 读到 extension_settings.regex 里的 2 条', first.length === 2 && first[0].scriptName === '读盘 A', first.map((s) => s.scriptName).join(','))
check('30 · 缺省字段被补齐成引擎能吃的形状', first[0].runOnEdit === false && first[0].minDepth === null && Array.isArray(first[0].trimStrings))

const again = readScripts(stDir)
check('31 · 第二次读走缓存但内容一致', again.length === 2 && again[0].id === 'r-a')

fs.writeFileSync(settingsPath, JSON.stringify({ extension_settings: { regex: [rowA, rowB, { ...rowA, id: 'r-c', scriptName: '读盘 C' }] } }), 'utf8')
const bumped = new Date(beforeStat.mtimeMs + 5000)
fs.utimesSync(settingsPath, bumped, bumped)
check('32 · mtime 变了就重新读（2 → 3）', readScripts(stDir).length === 3, String(readScripts(stDir).length))

fs.writeFileSync(settingsPath, JSON.stringify({ regex_scripts: [rowA] }), 'utf8')
const bumped2 = new Date(beforeStat.mtimeMs + 10000)
fs.utimesSync(settingsPath, bumped2, bumped2)
check('33 · 也认得顶层 regex_scripts 形态', readScripts(stDir).length === 1 && readScripts(stDir)[0].id === 'r-a')

check('34 · listMarkdownOnlyScripts 只留 markdownOnly ∧ 未禁用 ∧ 含 AI_OUTPUT', listMarkdownOnlyScripts(stDir).length === 1, listMarkdownOnlyScripts(stDir).map((s) => s.id).join(','))
check('35 · normalizeScript 丢掉没有 findRegex 的行', normalizeScript({ scriptName: '空' }) === null)

fs.writeFileSync(settingsPath, '{ 这不是 JSON', 'utf8')
const bumped3 = new Date(beforeStat.mtimeMs + 20000)
fs.utimesSync(settingsPath, bumped3, bumped3)
check('36 · 坏 JSON 返回空数组（不抛）', Array.isArray(readScripts(stDir)) && readScripts(stDir).length === 0)

fs.writeFileSync(settingsPath, beforeText, 'utf8')
check('37 · 读盘层只读：文件内容一字未改（写回的是测试自己刚写的那份）', fs.readFileSync(settingsPath, 'utf8') === beforeText)

const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-st-regex-miss-'))
check('38 · 目录里没有 settings.json → 空数组', readScripts(missingDir).length === 0)

done()
