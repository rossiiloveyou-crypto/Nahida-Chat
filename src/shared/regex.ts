/**
 * ST 正则脚本的类型契约（P2）。
 *
 * 只放类型与常量，不放逻辑：渲染进程与主进程都要用同一份形状，
 * 而这两边能共享的只有 `src/shared`。
 *
 * 🔴 字段名必须与 ST 的 `RegexScriptData` **逐字一致**（`runOnEdit` 也在内），
 *    因为这些对象是从 ST 的 `settings.json` 原样读出来的，改名就等于读不到。
 */

/**
 * ST 的 `regex_placement` 取值。
 *
 * 🔴 数字是 ST 的线上格式，**不许重排**：`settings.json` 里存的就是这些数字。
 */
export const REGEX_PLACEMENT = {
  /** 已废弃（ST 标了 deprecated），保留只为读得懂旧数据。 */
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  /** 4 曾用于 sendAs，已废弃。 */
  WORLD_INFO: 5,
  REASONING: 6
} as const

export type RegexPlacement = (typeof REGEX_PLACEMENT)[keyof typeof REGEX_PLACEMENT]

/** ST 的 `substitute_find_regex`：findRegex 里要不要先展开宏。 */
export const SUBSTITUTE_FIND_REGEX = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2
} as const

export type SubstituteFindRegex = (typeof SUBSTITUTE_FIND_REGEX)[keyof typeof SUBSTITUTE_FIND_REGEX]

/**
 * 一条 ST 正则脚本。
 *
 * 布尔字段一律显式写成 `boolean` 而不是可选：读盘层会把缺失值补成 `false`，
 * 引擎层就不必到处判 `=== true`。真正可能缺席的是两个深度字段——`null` 表示不限。
 */
export interface StRegexScript {
  /** 稳定标识。ST 用随机 UUID；空串表示这条脚本自己没有 id。 */
  id: string
  /** 给人看的名字；跳过脚本时写进日志的就是它。 */
  scriptName: string
  disabled: boolean
  /** 编辑既有楼层时是否也跑（ST 的 `runOnEdit`）。 */
  runOnEdit: boolean
  /** 斜杠包裹的字符串，例如 `/<note>([\\s\\S]*?)<\\/note>/gi`。 */
  findRegex: string
  /** 替换模板，可含 `{{match}}` / `$1` / `$<name>`。 */
  replaceString: string
  /** 捕获组里要逐个删掉的子串。 */
  trimStrings: string[]
  /** 作用位置，取值见 `REGEX_PLACEMENT`。 */
  placement: number[]
  substituteRegex: number
  minDepth: number | null
  maxDepth: number | null
  /** 只在渲染（markdown 通道）时应用。 */
  markdownOnly: boolean
  /** 只在组装 prompt 时应用（由 ST 自己跑，NC 不碰）。 */
  promptOnly: boolean
}

/**
 * 跑引擎时的参数。
 *
 * `scripts` 放在 options 里而不是单独入参：引擎是纯函数，脚本列表必须由调用方给出，
 * 但调用方（显示层）也不该关心「引擎怎么遍历」——它只要交一份数组。
 */
export interface RegexRunOptions {
  /** 脚本清单，按数组顺序串行执行（S3）。 */
  scripts?: StRegexScript[]
  /** 楼层深度；不给就**不做**深度过滤（ST 只在 `typeof depth === 'number'` 时过滤）。 */
  depth?: number
  /** 当前是否走在 markdown（渲染）通道。 */
  isMarkdown?: boolean
  /** 当前是否走在 prompt 组装通道。 */
  isPrompt?: boolean
  /** 当前是否在编辑既有楼层。 */
  isEdit?: boolean
  /** 宏表，例如 `{ char: '娜希妲', user: '你' }`；命中 `{{char}}` 就替换。 */
  macros?: Record<string, string>
  /** 更复杂的宏展开；在 `macros` 之后执行，拿到的是已经替换过一次的整段文本。 */
  macroExpand?: (text: string) => string
  /** trimStrings 里 `{{char}}` 这类宏的替换目标（ST 的 `name2Override`）。 */
  characterOverride?: string
  /** 跳过事件的下沉口；不给就走 `console.debug`。 */
  onDebug?: (message: string) => void
}
