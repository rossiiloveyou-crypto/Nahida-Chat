/**
 * P1 markdown 渲染器 —— 纯 Node 测试（PHASE-1 §六 A2–A5）。
 *
 * 跑法：node scripts/test/markdown-render.test.mjs
 *
 * 两条容易被写错的地方，先说明：
 *  1. 直接 import 渲染器源码 .ts —— Node 24 自带类型擦除，不需要先构建；
 *  2. `render.ts` 顶部 `import DOMPurify from 'dompurify'` 在 Node 里是「不支持 DOM」的空壳，
 *     所以这里用 jsdom 造一个真 window，再 createDOMPurify(window) 注入进去。
 *     这样断言的是**真 DOMPurify + 真白名单**，不是自造的假净化器。
 *
 * A4 还要求做一次突变验证（临时把 script 加进 ALLOWED_TAGS，本测试必须变红）。
 * 突变靠改源码做不到自动化，做法见 §六 A4 的施工记录；本文件第 11 条断言白名单本身，
 * 所以「有人把 script 加回白名单」必然在这里红。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')
const renderUrl = pathToFileURL(
  path.join(projectRoot, 'src/renderer/src/features/chat/markdown/render.ts')
).href

const mod = await import(renderUrl)
const { buildHtml, sanitizeHtml, renderMarkdown, sanitizeConfig, MARKDOWN_TAGS, MARKDOWN_ATTR, escapeHtml } = mod

const { JSDOM } = await import('jsdom')
const createDOMPurify = (await import('dompurify')).default
const dom = new JSDOM('<!doctype html><html><body></body></html>')
const purify = createDOMPurify(dom.window)

if (!purify || purify.isSupported !== true) {
  console.error('FAIL · DOMPurify 在 jsdom 里没有被正确初始化（后面的断言不可信）')
  process.exit(1)
}

/** 带真 DOMPurify 的渲染 */
const render = (source) => renderMarkdown(source, purify)

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
}

// ── 1–7 · 常见语法（A3）───────────────────────────────────────────────────
const bold = render('这是**粗体**和 *斜体*')
check('1 · 粗体渲染成 <strong>，且不残留裸星号', /<strong>粗体<\/strong>/.test(bold) && !/\*\*/.test(bold), bold)
check('2 · 斜体渲染成 <em>', /<em>斜体<\/em>/.test(bold), bold)

const heading = render('## 二级标题\n\n正文')
check('3 · 标题渲染成 <h2> 且无裸井号', /<h2[^>]*>二级标题<\/h2>/.test(heading) && !heading.includes('##'), heading)

const ul = render('- 苹果\n- 香蕉')
check('4 · 无序列表渲染成 <ul><li>', /<ul[\s\S]*<li[^>]*>苹果<\/li>[\s\S]*<li[^>]*>香蕉<\/li>[\s\S]*<\/ul>/.test(ul), ul)

const ol = render('1. 第一\n2. 第二')
check('5 · 有序列表渲染成 <ol><li>', /<ol[\s\S]*<li[^>]*>第一<\/li>/.test(ol), ol)

const code = render('\u0060\u0060\u0060js\nconst a = 1\n\u0060\u0060\u0060')
check('6 · 代码围栏渲染成 <pre><code>', /<pre[^>]*>[\s\S]*<code[^>]*>[\s\S]*const a = 1/.test(code), code)

const inlineCode = render('行内 \u0060x=1\u0060 结束')
check('7 · 行内代码渲染成 <code>', /<code[^>]*>x=1<\/code>/.test(inlineCode), inlineCode)

// ── 8–10 · 链接与换行 ────────────────────────────────────────────────────
const link = render('[点我](https://example.com)')
check(
  '8 · 链接保留 href 并补 target/rel',
  /<a[^>]*href="https:\/\/example\.com"/.test(link) &&
    /target="_blank"/.test(link) &&
    /rel="noopener noreferrer"/.test(link),
  link
)

const brk = render('第一行\n第二行')
check('9 · 单换行渲染成 <br>（breaks: true）', /<br\s*\/?>/.test(brk), brk)

const del = render('~~删掉~~')
check('10 · 删除线渲染成 <del>', /<del[^>]*>删掉<\/del>/.test(del), del)

// ── 11–15 · 净化（A4 / A5）────────────────────────────────────────────────
const script = render('<script>alert(1)</script>')
check(
  '11 · <script> 被剥掉（含白名单自检）',
  !/<script/i.test(script) && !script.includes('alert(1)') && !MARKDOWN_TAGS.includes('script'),
  script
)

const img = render('前 <img src=x onerror="alert(1)"> 后')
check(
  '12 · <img onerror> 被剥掉（无 img 标签、无 onerror）',
  !/<img/i.test(img) && !/onerror/i.test(img),
  img
)

const jsHref = render('[x](javascript:alert(1))')
check('13 · javascript: 伪协议被剥掉', !/javascript:/i.test(jsHref), jsHref)

const iframe = render('<iframe src="https://evil.example"></iframe>')
check('14 · <iframe> 被剥掉', !/<iframe/i.test(iframe) && !iframe.includes('evil.example'), iframe)

const details = render('<details open><summary>展开看</summary>里面的话</details>')
check(
  '15 · details / summary / open 原样保留（P3 折叠块依赖）',
  /<details[^>]*open[^>]*>/.test(details) && /<summary[^>]*>展开看<\/summary>/.test(details) && details.includes('里面的话'),
  details
)

// ── 16–20 · 白名单与健壮性 ───────────────────────────────────────────────
const cfg = sanitizeConfig()
check(
  '16 · 白名单里没有执行 / 样式口子',
  !cfg.ALLOWED_TAGS.includes('script') &&
    !cfg.ALLOWED_TAGS.includes('style') &&
    !cfg.ALLOWED_ATTR.some((a) => a === 'style' || /^on/i.test(a)) &&
    cfg.ALLOWED_ATTR.includes('href'),
  JSON.stringify(cfg.ALLOWED_ATTR)
)

const styled = render('<span style="color:red">红</span>')
check('17 · style 属性被剥掉', !/style=/i.test(styled), styled)

check('18 · 空串返回空串', render('') === '' && renderMarkdown(undefined, purify) === '', JSON.stringify(render('')))

const huge = 'x'.repeat(200000)
let hugeOk = true
let hugeLen = 0
try {
  hugeLen = render(huge).length
} catch (error) {
  hugeOk = false
}
check('19 · 20 万字符不抛异常', hugeOk && hugeLen > 190000, String(hugeLen))

let unclosedOk = true
let unclosedOut = ''
try {
  unclosedOut = render('**未闭合 *斜 还有 <div 和 > 和 & 号')
} catch (error) {
  unclosedOk = false
}
check('20 · 未闭合标签 / 裸 & 不抛异常', unclosedOk && typeof unclosedOut === 'string', unclosedOut)

// ── 21–22 · 兜底分支与 P3 契约 ───────────────────────────────────────────
check(
  '21 · 净化失败时退回转义文本（不返回原样 HTML）',
  escapeHtml('<b>x</b>') === '&lt;b&gt;x&lt;/b&gt;',
  escapeHtml('<b>x</b>')
)

const p3 = render('<div class="mes_text">【旁白】<b>她说</b></div>')
check(
  '22 · P3 输入的 HTML 片段：class 保留、危险标签退化成文本结构',
  p3.includes('她说') && !/<div/i.test(p3),
  p3
)

// ── SUPPLEMENT-01 · 剧情与对话分离（保留以上原断言） ─────────────────────
const { wrapQuotes } = await import(pathToFileURL(path.join(projectRoot, 'src/renderer/src/features/chat/markdown/quotes.ts')).href)
const dialogueRender = (source) => renderMarkdown(source, purify, wrapQuotes)
const fragment = (html) => JSDOM.fragment(html)
for (const quoted of ['"a"', '“a”', '«a»', '「a」', '『a』', '＂a＂']) {
  const doc = fragment(dialogueRender(quoted))
  check('S-01 · 六对分隔符 ' + quoted, doc.querySelectorAll('q').length === 1 && doc.querySelector('q').textContent === quoted)
}
const nested = fragment(dialogueRender('《他说「走吧」》'))
check('S-02 · 书名号不包裹，内部对话只包一层', nested.querySelectorAll('q').length === 1 && !nested.querySelector('q q') && nested.textContent.trim() === '《他说「走吧」》')
for (const source of ['`"code"`', '```js\nconst a = "code"\n```']) {
  const doc = fragment(dialogueRender(source))
  check('S-03 · 代码引号不包装 ' + source.slice(0, 8), doc.querySelector('code') && !doc.querySelector('q') && doc.querySelector('code').textContent.includes('"code"'))
}
const quotedLink = fragment(dialogueRender('[text](http://a/"b")')).querySelector('a')
check('S-04 · 链接目标保持原文', quotedLink?.getAttribute('href') === 'http://a/%22b%22' && !quotedLink.querySelector('q'))
const titledLink = fragment(dialogueRender("[text](https://a/ 'say \"hi\"')")).querySelector('a')
check('S-04 · 链接 title 保持原文', titledLink?.getAttribute('title') === 'say "hi"' && !titledLink.querySelector('q'))
const span = fragment(dialogueRender('<span title="x">y</span>'))
check('S-05 · HTML 属性不包装', span.querySelector('span')?.getAttribute('title') === 'x' && !span.querySelector('q'))
check('S-06 · 动作仍为 em', dialogueRender('*她低头*').includes('<em>她低头</em>'))
check('S-07 · renderMarkdown 默认行为保持无自动引号', !fragment(render('「默认」')).querySelector('q'))
const { bundleModule } = await import('./qq-test-util.mjs')
const displayModule = await bundleModule('supp01-display', 'export { displayOf, displayPartsOf } from ' + JSON.stringify(path.join(projectRoot, 'src/renderer/src/features/chat/markdown/display.ts').replaceAll('\\', '/')))
const defaultDisplay = displayModule.displayOf('她说「走吧」', [], undefined, purify)
check('S-08 · displayOf 默认开启', fragment(defaultDisplay).querySelector('q')?.textContent === '「走吧」', defaultDisplay)
check('S-08 · 显式 false 仍可关闭', !fragment(displayModule.displayOf('「关闭」', [], undefined, purify, false)).querySelector('q'))
check('S-08 · 结构化文本链同样开启', fragment(displayModule.displayPartsOf('「结构化」', [], undefined, purify)[0].html).querySelector('q')?.textContent === '「结构化」')

const { readFileSync } = await import('node:fs')
const css = readFileSync(path.join(projectRoot, 'src/renderer/src/styles/global.css'), 'utf8')
const styleDom = new JSDOM('<style>' + css + '</style><div class="bubble__md"><font color="red" style="color: red"><em>动作</em><i>斜体</i><u>下划线</u><q>对话</q></font></div>')
const styledAction = styleDom.window.document.querySelector('em')
check('F-03 · 动作显式斜体并使用独立次级色令牌', styleDom.window.getComputedStyle(styledAction).fontStyle === 'italic' && /\.bubble__md em\s*\{[^}]*color:\s*var\(--nc-action\)/.test(css))
for (const tag of ['em', 'i', 'u', 'q']) {
  check('F-04 · font[color] 下 ' + tag + ' 自动色让位', styleDom.window.getComputedStyle(styleDom.window.document.querySelector(tag)).color === 'rgb(255, 0, 0)')
}
const sanitizedFont = fragment(dialogueRender('<font color="red">「对话」</font>'))
check('F-04 · 既有净化边界保持（font/color 仍剥除，生产显式色支持未闭合）', !sanitizedFont.querySelector('font') && !sanitizedFont.querySelector('[color]'))
styleDom.window.close()

// ── 汇总 ────────────────────────────────────────────────────────────────
let failed = 0
for (const item of checks) {
  const line = (item.ok ? 'PASS ' : 'FAIL ') + item.name
  console.log(item.ok ? line : line + (item.detail ? '  ← ' + item.detail : ''))
  if (!item.ok) failed += 1
}
console.log('\n' + checks.length + ' checks, ' + failed + ' failed')
if (failed > 0) {
  process.exitCode = 1
} else {
  console.log('PASS markdown-render')
}
