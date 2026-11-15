/**
 * 气泡正文的 markdown 渲染 —— **唯一出口**（P1，2026-11-15）。
 *
 * 为什么要有这一层：
 *  - 气泡原来是纯文本插值（`{message.content}`），粗体 / 标题 / 代码围栏全部裸显示；
 *  - P3 的显示层（正则产物是 markdown / HTML）没有渲染器就只能显示源码。
 *
 * 三条硬规矩：
 *  1. 只有这里能把字符串变成 HTML —— 别处再写一次 marked 就会出现两套白名单，迟早分叉；
 *  2. 产物必须过 DOMPurify；白名单是「枚举放行」，不是「枚举禁止」；
 *  3. 对任意输入都不抛异常（P3 会把正则跑完的任意文本喂进来：空串、超长串、未闭合标签）。
 *
 * ⚠️ DOMPurify 需要 window：本模块**只**在 renderer 里用，main 进程不许 import。
 * ⚠️ Node 单测（`scripts/test/markdown-render.test.mjs`）直接 import 本文件，
 *    但必须**显式传入**自己的 purifier（jsdom 造 window 后 createDOMPurify 的那个），
 *    不要依赖默认参数 —— Node 里没有 document。
 */
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

/** 允许出现在气泡里的标签（枚举放行）。details / summary 是 P3 折叠块的依赖，别删。 */
export const MARKDOWN_TAGS: string[] = [
  'p',
  'q',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'details',
  'summary',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a'
]

/**
 * 允许的属性。
 * 🔴 没有 style、也没有任何 on* —— 这两个是「一条就能执行代码 / 一条就能钓鱼」的口子。
 */
export const MARKDOWN_ATTR: string[] = ['href', 'title', 'class', 'open']

/**
 * marked 实例。
 *
 * breaks: true 是**刻意**的：气泡里单换行必须换行（聊天记录没有空行也不该粘成一坨），
 * 否则排版比现在的纯文本还差。async: false 是为了让 parse 同步返回 string。
 */
const marked = new Marked({ gfm: true, breaks: true, async: false })

/** 纯函数：markdown 源码 → 未净化 HTML。marked 抛异常时退回转义后的纯文本，而不是把异常扔出去。 */
const dialogueMarked = (wrapQuotes: (text: string) => string) => new Marked({ gfm: true, breaks: true, async: false, renderer: {
  html(token) {
    return token.text.replace(/<\/?[a-z][a-z0-9]*[_-][a-z0-9_-]+\s*>/gi, escapeHtml)
  },
  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens)
    if (token.type === 'escape') return token.text
    return wrapQuotes('escaped' in token && token.escaped ? token.text : token.text
      .replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);)/gi, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'))
  }
} })

export function buildHtml(source: string, dialogue?: (text: string) => string): string {
  if (!source) return ''
  try {
    const html = (dialogue ? dialogueMarked(dialogue) : marked).parse(source)
    return typeof html === 'string' ? html : ''
  } catch {
    // marked 理论上不会抛；真抛了也不许让界面白屏 —— 退回纯文本，至少能读。
    return escapeHtml(source).replace(/\r?\n/g, '<br>')
  }
}

/** 纯函数：DOMPurify 的配置。抽出来是为了单测能直接断言白名单本身。 */
export function sanitizeConfig(): {
  ALLOWED_TAGS: string[]
  ALLOWED_ATTR: string[]
  ALLOW_DATA_ATTR: boolean
  ALLOW_ARIA_ATTR: boolean
  FORBID_TAGS: string[]
  FORBID_ATTR: string[]
} {
  return {
    ALLOWED_TAGS: [...MARKDOWN_TAGS],
    ALLOWED_ATTR: [...MARKDOWN_ATTR],
    // 默认 DOMPurify 放行 data-* / aria-*；气泡里不需要，关掉少一个面。
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // 双保险：即使 ALLOWED_TAGS 被谁改宽，这几个也进不来。
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
    FORBID_ATTR: ['style']
  }
}

/** 只要求两点：能吃字符串、吐字符串；addHook 可选（stub 不带也能跑）。 */
export interface PurifierLike {
  sanitize(dirty: string, config?: ReturnType<typeof sanitizeConfig>): string
  // DOMPurify 的 addHook 是重载：这里钉死我们唯一用到的那一个入口点，
  // 用 string 会与 BasicHookName 这个字面量联合对不上（TS2322）。
  addHook?: (name: 'afterSanitizeAttributes', hook: (node: Element) => void) => void
}

/**
 * 外链一律新窗口 + noopener。
 * 用 DOMPurify 的 afterSanitizeAttributes 钩子（官方推荐姿势）：此时属性已经过滤完，
 * 这里补上去的 target / rel 不会再被抹掉。
 */
function hardenAnchor(node: Element): void {
  if (node.tagName !== 'A') return
  const href = node.getAttribute('href') ?? ''
  // javascript: / data: 之类已经被 DOMPurify 剥掉 href 了；这里只处理真链接。
  if (!href) return
  if (/^(https?:|mailto:)/i.test(href)) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
}

/** 纯函数：未净化 HTML → 净化后 HTML。净化本身失败时退回转义文本（绝不返回原样的 HTML）。 */
export function sanitizeHtml(raw: string, purify: PurifierLike = DOMPurify): string {
  if (!raw) return ''
  try {
    purify.addHook?.('afterSanitizeAttributes', hardenAnchor)
    return purify.sanitize(raw, sanitizeConfig())
  } catch {
    return escapeHtml(raw)
  }
}

/**
 * 唯一对外的渲染函数：markdown 源码 → 可以塞进 dangerouslySetInnerHTML 的 HTML。
 *
 * @param source 任意字符串
 * @param purify 注入点：renderer 用默认（浏览器里的 DOMPurify），单测传 jsdom 的那个
 */
export function renderMarkdown(source: string, purify: PurifierLike = DOMPurify, dialogue?: (text: string) => string): string {
  if (!source) return ''
  return sanitizeHtml(buildHtml(source, dialogue), purify)
}

/** 兜底转义（净化 / 解析失败时用，保证产物仍然是「文本」而不是「HTML」） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
