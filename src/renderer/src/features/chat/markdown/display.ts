/**
 * 显示层（档 2，P3）—— 气泡正文的**唯一装配点**：ST 正则（markdown 通道）→ markdown 渲染。
 *
 * 顺序不可颠倒：正则产物本身可能就是 markdown（预设里大量 `显示：xxx` 脚本就是把标签换成 markdown），
 * 先渲染再跑正则会得到「HTML 里夹着正则」，什么都匹配不上。
 *
 * 四道降级（全部是「返回原稿」，绝不抛、绝不白屏）：
 *  1. 空入参 → 空串；
 *  2. 脚本清单为空 / 未加载完 → **只做 markdown**（P1 行为），不跑正则；
 *  3. 引擎抛异常 → 返回原稿；
 *  4. 单条脚本的产物想当 HTML 宿主（`<iframe>` / `<script>` / `<style>` …）→ 引擎自己回落到原文（S9/M9），
 *     这里不需要再判一次 —— 判据只有一处，才不会两边不一致。
 *
 * 🔴 通道只走 `isMarkdown: true`：`promptOnly` 脚本由 ST 在组装 prompt 时跑，NC 显示层**绝不能**再跑一遍，
 *    否则同一条改写会在两边各生效一次（这就是"同一句话在 ST 和 NC 里不一样"的经典来源）。
 * 🔴 落库永远是原稿（M5）：本模块只影响**气泡显示**，不碰 message.content。
 */
import { REGEX_PLACEMENT } from '@shared/regex'
import type { StRegexScript } from '@shared/regex'
import { getRegexedString } from '@shared/regexEngine'
import { renderMarkdown } from './render'
import type { PurifierLike } from './render'
import { structureOf } from './structure'
import { wrapQuotes } from './quotes'
import type { CardData } from './structure'

export type DisplayToken = CardData | { kind: 'text'; html: string; offset: number }

/** Structured UI entry; displayOf retains the P3 string contract. */
export function displayPartsOf(mes: string, scripts: StRegexScript[] = [], depth?: number, purify?: PurifierLike): DisplayToken[] {
  return structureOf(mes, scripts, depth).map(part => part.kind === 'card' ? part : {
    kind: 'text', offset: part.offset, html: renderMarkdown(
      applyDisplayScripts(part.text, scripts, depth),
      purify, wrapQuotes
    )
  })
}

/** 静默 debug：显示层在 UI 循环里，`console.debug` 会刷屏且没人看得到。 */
function quiet(): void {}

/**
 * 只跑正则、不渲染（纯文本进出）。
 *
 * 单测用它断言「正则链产物」，不必先过一遍 HTML 转义；
 * 也方便将来把产物同时喂给别的地方（例如统计标签残留）而不重复跑链。
 */
export function applyDisplayScripts(mes: string, scripts: StRegexScript[] | undefined, depth?: number): string {
  const raw = typeof mes === 'string' ? mes : ''
  if (!raw) return ''
  if (!scripts || scripts.length === 0) return raw
  try {
    return getRegexedString(raw, REGEX_PLACEMENT.AI_OUTPUT, {
      scripts,
      isMarkdown: true,
      // undefined = 引擎不做深度过滤（与 ST 的 `typeof depth === 'number'` 同口径）
      depth,
      onDebug: quiet
    })
  } catch {
    return raw
  }
}

/**
 * 唯一对外入口：原稿 → 可塞进 `dangerouslySetInnerHTML` 的 HTML。
 *
 * @param mes     落库正文（原稿，含标签）
 * @param scripts ST 的 `regex_scripts` 清单（上层一次性取，**不要每条消息都 IPC**）
 * @param depth   楼层深度；取不到传 `undefined`（= 不过滤）
 * @param purify  注入点：renderer 用默认（浏览器里的 DOMPurify），单测传 jsdom 造的那个
 */
export function displayOf(
  mes: string,
  scripts: StRegexScript[] | undefined,
  depth?: number,
  purify?: PurifierLike,
  dialogue = true
): string {
  const text = applyDisplayScripts(mes, scripts, depth)
  if (!text) return ''
  try {
    return renderMarkdown(text, purify, dialogue ? wrapQuotes : undefined)
  } catch {
    return ''
  }
}
