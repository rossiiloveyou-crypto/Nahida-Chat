/**
 * P3 显示层管线 —— 纯 Node 测试（PHASE-3 §三 A2，外加 F-01 的数据源判据）。
 *
 * 跑法：node scripts/test/display-pipeline.test.mjs
 *
 * 三件事分开测，失败时一眼看得出坏在哪一层：
 *   A. 装配（display.ts）：正则通道 / depth / 串联 / HTML 降级 / 空输入；
 *   B. 渲染（render.ts 已由 P1 自测）：这里只断言「产物是净化后的 HTML，不是源码」；
 *   C. 数据源（scripts.ts 的 collectScripts）：多源合并 + 按 id 去重（C-01 的判据）。
 *
 * 🔴 为什么用 esbuild 打包而不是直接 import .ts：
 *    display.ts 走 `@shared/*` 别名，Node 自己不认识；qq-test-util 的 bundleModule 已经配好别名。
 * 🔴 为什么必须注入 jsdom 的 purifier：
 *    render.ts 默认参数是浏览器里的 DOMPurify（Node 里是空壳工厂函数），
 *    不注入就只能测到「降级成转义文本」，等于没测渲染。
 */
import fs from 'node:fs'
import path from 'node:path'
import { bundleModule, p, projectRoot } from './qq-test-util.mjs'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
}

const mod = await bundleModule(
  'display-pipeline',
  [
    `export { displayOf, applyDisplayScripts } from '${p('src/renderer/src/features/chat/markdown/display.ts')}'`,
    `export { collectScripts, resolveStDataDir, DEFAULT_ST_DATA_DIR } from '${p('src/main/features/regex/scripts.ts')}'`
  ].join('\n')
)

const { displayOf, applyDisplayScripts, collectScripts, resolveStDataDir, DEFAULT_ST_DATA_DIR } = mod

const { JSDOM } = await import('jsdom')
const createDOMPurify = (await import('dompurify')).default
const dom = new JSDOM('<!doctype html><html><body></body></html>')
const purify = createDOMPurify(dom.window)
if (!purify || purify.isSupported !== true) {
  console.error('FAIL · DOMPurify 在 jsdom 里没有被正确初始化（后面的渲染断言不可信）')
  process.exit(1)
}

/** 造一条脚本；默认值取「markdown 通道 + AI_OUTPUT」——即显示层真正会跑的那种。 */
const script = (over = {}) => ({
  id: over.id ?? 's',
  scriptName: over.scriptName ?? 's',
  disabled: false,
  runOnEdit: true,
  findRegex: '/x/g',
  replaceString: '',
  trimStrings: [],
  placement: [2],
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
  markdownOnly: true,
  promptOnly: false,
  ...over
})

const render = (mes, scripts, depth) => displayOf(mes, scripts, depth, purify)
const readSource = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8')

console.log('A · 装配：正则通道（markdownOnly 才跑）')

check(
  '1 · 没有脚本 → 原样过 markdown（P1 行为不变）',
  /<strong>粗体<\/strong>/.test(render('**粗体**', [])),
  render('**粗体**', [])
)
check(
  '2 · markdownOnly + placement[2] 在显示层生效',
  applyDisplayScripts('<wave_plan>x</wave_plan>', [
    script({ findRegex: '/<wave_plan>[\\s\\S]*?<\\/wave_plan>/gi', replaceString: '' })
  ]) === '',
  applyDisplayScripts('<wave_plan>x</wave_plan>', [
    script({ findRegex: '/<wave_plan>[\\s\\S]*?<\\/wave_plan>/gi', replaceString: '' })
  ])
)
check(
  '3 · promptOnly 脚本在显示层**不跑**（S1 通道，跑两遍就会改写两次）',
  applyDisplayScripts('x', [script({ promptOnly: true, markdownOnly: false, findRegex: '/x/g', replaceString: 'P' })]) === 'x'
)
check(
  '4 · 两个通道都不是的脚本在显示层不跑（ST 的 else-if 链）',
  applyDisplayScripts('x', [script({ promptOnly: false, markdownOnly: false, replaceString: 'N' })]) === 'x'
)
check(
  '5 · disabled 的脚本不跑',
  applyDisplayScripts('x', [script({ disabled: true, replaceString: 'D' })]) === 'x'
)
check(
  '6 · placement 不含 2 的脚本不跑（同一段文本另有通道）',
  applyDisplayScripts('x', [script({ placement: [1], replaceString: 'U' })]) === 'x'
)

console.log('B · 装配：depth（与 ST 同口径）')

const depthScript = script({ findRegex: '/x/g', replaceString: 'D', maxDepth: 0 })
check('7 · depth 1 超过 maxDepth 0 → 跳过', applyDisplayScripts('x', [depthScript], 1) === 'x')
check('8 · depth 0 命中 maxDepth 0 → 生效', applyDisplayScripts('x', [depthScript], 0) === 'D')
check('9 · depth 缺省（undefined）= 不过滤 → 生效', applyDisplayScripts('x', [depthScript], undefined) === 'D')
const minScript = script({ findRegex: '/x/g', replaceString: 'M', minDepth: 2 })
check('10 · minDepth 未满足 → 跳过', applyDisplayScripts('x', [minScript], 1) === 'x')
check('11 · minDepth 满足 → 生效', applyDisplayScripts('x', [minScript], 2) === 'M')

console.log('C · 装配：串联 / 降级 / 边界')

check(
  '12 · 多条脚本按数组顺序串联（前一条产物是后一条输入）',
  applyDisplayScripts('AAA', [
    script({ id: 'a', findRegex: '/AAA/g', replaceString: 'BBB' }),
    script({ id: 'b', findRegex: '/BBB/g', replaceString: 'CCC' })
  ]) === 'CCC'
)
const htmlHost = applyDisplayScripts('payload', [
  script({ findRegex: '/payload/g', replaceString: '<iframe src="https://example.invalid/x"></iframe>' })
])
check('13 · 产物想当 HTML 宿主 → 本条不生效、回落原文（M9 按形态判定）', htmlHost === 'payload', htmlHost)
check('14 · 空串 → 空串（不留 <p></p>）', render('', [script({ replaceString: 'X' })]) === '')
check(
  '15 · 未闭合标签 / 超长文本不抛异常',
  (() => {
    try {
      render('<'.repeat(5000) + 'x', [script({ findRegex: '/x/g', replaceString: '<b' })])
      return true
    } catch {
      return false
    }
  })()
)

console.log('D · 渲染：产物是净化后的 HTML（F-05 机器可判部分）')

const stripped = render('<content>正文</content>', [
  script({ findRegex: '/<content>([\\s\\S]*?)<\\/content>/gi', replaceString: '$1' })
])
check('16 · 去掉标签后气泡里看不到成对标签原文', !/<content>|<\/content>/.test(stripped) && /正文/.test(stripped), stripped)
const escaped = render('<wave_plan>x</wave_plan>', [
  script({ findRegex: '/<wave_plan>([\\s\\S]*?)<\\/wave_plan>/gi', replaceString: '$1' })
])
check('17 · 标签被替换后内容可见（不是被整段吞掉）', /x/.test(escaped) && !/wave_plan/.test(escaped), escaped)
check(
  '18 · 渲染产物里没有任何 on* 事件属性 / script 标签',
  !/\son[a-z]+=/i.test(stripped) && !/<script/i.test(stripped),
  stripped
)

console.log('E · 数据源：多源合并 + 按 id 去重（C-01 / J-08）')

const dup = { id: 'same', findRegex: '/x/g', replaceString: '', markdownOnly: true, placement: [2] }
const synthetic = {
  extension_settings: { regex: [{ id: 'g1', findRegex: '/g1/g', markdownOnly: true, placement: [2] }] },
  oai_settings: { extensions: { regex_scripts: [{ id: 'o1', findRegex: '/o1/g', markdownOnly: true, placement: [2] }, dup] } },
  kai_settings: {
    extensions: {
      regex_scripts: [{ id: 'k1', findRegex: '/k1/g', promptOnly: true, placement: [2] }, dup],
      SPreset: { RegexBinding: { regexes: [dup, { id: 'd1', findRegex: '/d1/g', markdownOnly: true, placement: [2] }] } }
    }
  },
  regex_scripts: [{ id: 'top1', findRegex: '/t/g', markdownOnly: true, placement: [2] }]
}
const collected = collectScripts(synthetic)
const collIds = collected.map((s) => s.id)
check('19 · 五个候选源都读到（1+2+2+2+1 行）', collected.length === 6, JSON.stringify(collIds))
check('20 · 同 id 只留一条（去重后没有重复 id）', new Set(collIds).size === collIds.length, JSON.stringify(collIds))
check('21 · 全局源排在预设内嵌之前（先到先得）', collIds[0] === 'g1', JSON.stringify(collIds))
check('22 · 没有 findRegex 的行被丢弃（跑不起来的不是脚本）', collectScripts({ regex_scripts: [{ id: 'z' }, { findRegex: '/y/g' }] }).length === 1)
check('23 · 坏数据（null / 数组 / 字符串）不抛，返回空', collectScripts(null).length === 0 && collectScripts([]).length === 0 && collectScripts('x').length === 0)
check(
  '24 · stDir 解析：入参 > 环境变量 > 部署默认值',
  resolveStDataDir('D:/tmp/st') === 'D:/tmp/st' && resolveStDataDir('   ') === DEFAULT_ST_DATA_DIR,
  resolveStDataDir('   ')
)

console.log('F · 分层与真实数据（静态断言）')

const displaySrc = readSource('src/renderer/src/features/chat/markdown/display.ts')
const hookSrc = readSource('src/renderer/src/features/chat/markdown/useDisplayScripts.ts')
const scriptsSrc = readSource('src/main/features/regex/scripts.ts')
check('25 · display.ts 不 import main/（分层铁律）', !/from\s+['"].*main\//.test(displaySrc) && !/@main/.test(displaySrc))
check('26 · display.ts 不直接调 window.nahida（IPC 只归 hook）', !/window\.nahida/.test(displaySrc))
check('27 · 引擎已迁到 shared/，main 侧旧文件不存在', fs.existsSync(path.join(projectRoot, 'src/shared/regexEngine.ts')) && !fs.existsSync(path.join(projectRoot, 'src/main/features/regex/engine.ts')))
check('28 · hook 有模块级缓存（cached + pending 双闸，避免每帧 IPC）', /let cached/.test(hookSrc) && /let pending/.test(hookSrc))
check('29 · 读盘层按 J-08 的五个真实来源读（C-01 已修）', ['extension_settings.regex', 'oai_settings', 'kai_settings', 'SPreset', 'regex_scripts'].every((k) => scriptsSrc.includes(k)))
check('30 · 显示层不出现预设文案 / 脚本名（M9 零预设耦合）', !/浪潮|wave/i.test(displaySrc + hookSrc))

const failed = checks.filter((item) => !item.ok)
for (const item of checks) {
  console.log((item.ok ? 'ok   ' : 'FAIL ') + '· ' + item.name + (item.ok || !item.detail ? '' : ' → ' + item.detail))
}
console.log('')
console.log(`合计 ${checks.length} 项，通过 ${checks.length - failed.length} 项`)
if (failed.length > 0) {
  console.error('FAILED: ' + failed.length)
  process.exit(1)
}
// 真实 settings.json 存在时，把「真脚本条数」也打出来（不作为判据：换机器会变）
const realSettings = path.join(DEFAULT_ST_DATA_DIR, 'settings.json')
if (fs.existsSync(realSettings)) {
  try {
    const real = collectScripts(JSON.parse(fs.readFileSync(realSettings, 'utf8')))
    const mdOnly = real.filter((s) => s.markdownOnly === true && s.disabled !== true && s.placement.includes(2)).length
    console.log(`实测 ${DEFAULT_ST_DATA_DIR}: 唯一脚本 ${real.length} 条（markdownOnly+AI_OUTPUT ${mdOnly} 条）`)
  } catch (error) {
    console.log('实测真实 settings.json 失败（不计入判据）：' + error.message)
  }
}
console.log('PASS')
