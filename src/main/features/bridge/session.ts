/**
 * ST 会话的清场与巡检（P4 §1 第 3 行）。
 *
 * 职责只有两件：把 `chat / chatMetadata / extensionPrompts` 清成零，以及读回当前状态。
 *
 * 🔴 **禁** `resetChatState` / `clearChat`（J-02）：前者会把 `characters` 清空并塞一条
 *    SAFETY_CHAT，后者会走保存流程（等于写 ST 磁盘）。只能用三行原地清 —— 直接改
 *    `getContext()` 返回的**引用**，因为 `chatMetadata` / `extensionPrompts` 是引用快照，
 *    整体赋值（`ctx.chatMetadata = {}`）改的是本地变量，模块里的那份不会变。
 * 🔴 判据是「三个长度全为 0 且 characters 没变」，不是「没抛异常」——清不干净不报错，
 *    表现是模型突然变笨（P0 完成报告 §三 第 3 条同源）。
 */

import type { StChatMessage } from './mapper'

/** `page.eval()` 的标签。假宿主（单测）按标签分发，真宿主只把它写进日志 */
export const EVAL_LABEL = {
  ready: 'ready',
  exposure: 'exposure',
  clear: 'clear',
  inject: 'inject',
  connect: 'connect',
  generate: 'generate',
  switchMute: 'switch:mute',
  switchRestore: 'switch:restore',
  /** P6：把 NC 的 system 段灌进 ST 的 extensionPrompt（人格 / 时间 / 记忆 / 摘要） */
  prompts: 'prompt:inject'
} as const

/** 清场后的观测值（做差集用） */
export interface SessionSnapshot {
  chat: number
  metadata: number
  prompts: number
  characters: number
}

/** 暴露面巡检结果（P0 的 A1 同一个表达式） */
export interface ExposureReport {
  present: string[]
  missing: string[]
  characters: number
  chat: number
  metadata: number
  prompts: number
  hasStopGeneration: boolean
  hasStreamEvent: boolean
}

/**
 * 三行原地清（J-02 的**唯一**落点）。
 * 返回清完之后的四个计数 —— 调用方必须自己判「三个 0 + characters 不变」。
 */
export const CLEAR_EXPR = [
  '(() => {',
  '    const ctx = SillyTavern.getContext();',
  '    ctx.chat.length = 0;',
  '    Object.keys(ctx.chatMetadata).forEach(k => delete ctx.chatMetadata[k]);',
  '    Object.keys(ctx.extensionPrompts).forEach(k => delete ctx.extensionPrompts[k]);',
  '    return {',
  '        chat: ctx.chat.length,',
  '        metadata: Object.keys(ctx.chatMetadata).length,',
  '        prompts: Object.keys(ctx.extensionPrompts).length,',
  '        characters: ctx.characters.length,',
  '    };',
  '})()'
].join('\n')

/**
 * 暴露面巡检：`getContext()` 上那 8 个字段在不在（P0 的 A1）。
 *
 * 停止条件 1 就是它：有缺失说明 ST 被改过（M8：不升级 ST，字段按当前版本冻结），
 * 这时后面所有判据都不可信，必须停。
 */
export const EXPOSURE_EXPR = [
  '(() => {',
  '    const ctx = SillyTavern.getContext();',
  '    const need = ["chat","characters","chatMetadata","extensionPrompts","generate","eventSource","eventTypes","setExtensionPrompt"];',
  '    return {',
  '        present: need.filter(k => k in ctx),',
  '        missing: need.filter(k => !(k in ctx)),',
  '        characters: ctx.characters.length,',
  '        chat: ctx.chat.length,',
  '        metadata: Object.keys(ctx.chatMetadata).length,',
  '        prompts: Object.keys(ctx.extensionPrompts).length,',
  '        hasStopGeneration: typeof ctx.stopGeneration === "function",',
  '        hasStreamEvent: !!(ctx.eventTypes && ctx.eventTypes.STREAM_TOKEN_RECEIVED),',
  '    };',
  '})()'
].join('\n')

/** 页面侧能拿到的最小接口面（真宿主是 BridgeHost，单测里是假宿主） */
export interface BridgePageLike {
  eval<T>(expr: string, label?: string): Promise<T>
}

/** 注入结果自检：逐字相等才算注入成功 */
export interface InjectReport {
  /** 条数 + 每条 mes 逐字一致 */
  equal: boolean
  /** is_user / is_system 映射一致 */
  flagsEqual: boolean
  /** 期望的 mes 数组（逐字） */
  expectedMes: string[]
  /** 期望的 [is_user, is_system] */
  expectedFlags: Array<[boolean, boolean]>
  /** 页面回读的 mes 数组 */
  actualMes: string[]
  length: number
}

/** 每轮**进入**与**退出**各调一次（M2：ST 零持久化） */
export async function resetSession(page: BridgePageLike): Promise<SessionSnapshot> {
  const snapshot = await page.eval<SessionSnapshot>(CLEAR_EXPR, EVAL_LABEL.clear)
  if (snapshot.chat !== 0 || snapshot.metadata !== 0 || snapshot.prompts !== 0) {
    throw new Error(
      'ST 会话清不干净：chat=' + snapshot.chat + ' metadata=' + snapshot.metadata + ' prompts=' + snapshot.prompts
    )
  }
  return snapshot
}

/** 读当前状态（不清）。做「清场前后差集」与探针断言用 */
export async function readSession(page: BridgePageLike): Promise<SessionSnapshot> {
  const exposure = await page.eval<ExposureReport>(EXPOSURE_EXPR, EVAL_LABEL.exposure)
  return {
    chat: exposure.chat,
    metadata: exposure.metadata,
    prompts: exposure.prompts,
    characters: exposure.characters
  }
}

/** 暴露面巡检；有缺失就抛（停止条件 1） */
export async function assertExposure(page: BridgePageLike): Promise<ExposureReport> {
  const exposure = await page.eval<ExposureReport>(EXPOSURE_EXPR, EVAL_LABEL.exposure)
  const missing = Array.isArray(exposure.missing) ? exposure.missing : []
  if (missing.length > 0) {
    throw new Error('ST 暴露面缺字段：' + missing.join(',') + '（停止条件 1：ST 被改过）')
  }
  return exposure
}

/**
 * 把历史灌进 ST 的 chat（**原地替换**，不是追加）。
 *
 * 为什么要自检：`chat.splice` 之后的 mes 与 is_user/is_system 映射是这一轮的唯一事实来源，
 * 只要有一处不对，模型看到的历史就不是 NC 以为的那份 —— 而这种偏差**不会报错**，
 * 只会让回复「莫名跑题」。所以注入后立刻回读比对，不一致就整轮判失败。
 */
export async function injectChat(page: BridgePageLike, chat: StChatMessage[]): Promise<InjectReport> {
  const expr = [
    '(() => {',
    '    const input = ' + JSON.stringify(chat) + ';',
    '    const ctx = SillyTavern.getContext();',
    '    const built = input.map((m, i) => ({',
    '        is_user: !!m.is_user,',
    '        mes: String(m.mes),',
    '        name: String(m.name),',
    '        send_date: new Date(Date.now() + i * 1000).toISOString(),',
    '        is_system: !!m.is_system,',
    '        extra: {},',
    '    }));',
    '    ctx.chat.splice(0, ctx.chat.length, ...built);',
    '    const actual = ctx.chat.map(m => String(m.mes));',
    '    const flags = ctx.chat.map(m => [m.is_user === true, m.is_system === true]);',
    '    return {',
    '        equal: actual.length === input.length && actual.every((v, i) => v === String(input[i].mes)),',
    '        flagsEqual: flags.length === input.length && flags.every((v, i) => v[0] === !!input[i].is_user && v[1] === !!input[i].is_system),',
    '        actual,',
    '        length: ctx.chat.length,',
    '    };',
    '})()'
  ].join('\n')
  const report = await page.eval<{ equal: boolean; flagsEqual: boolean; actual: string[]; length: number }>(
    expr,
    EVAL_LABEL.inject
  )
  return {
    equal: report.equal === true,
    flagsEqual: report.flagsEqual === true,
    expectedMes: chat.map((item) => item.mes),
    expectedFlags: chat.map((item) => [item.is_user === true, item.is_system === true] as [boolean, boolean]),
    actualMes: Array.isArray(report.actual) ? report.actual : [],
    length: report.length
  }
}

/* ─────────────────────── NC 的 system 段 → ST 的 extensionPrompt（P6） ─────────────────────── */

/**
 * 注入用的键名前缀。**必须**可枚举出全局唯一的一组键，否则清不干净。
 *
 * 🔴 为什么不用 ST 自己的 extension prompt 键（比如 0/1/2 数字位或 'summary' 之类）：
 *    ST 的扩展各自持有一份，撞车时两边都以为自己写进去了，而实际只有后写的生效。
 *    用自己的前缀 + 序号，清理时按前缀扫一遍就行。
 */
export const BRIDGE_PROMPT_PREFIX = 'nc-bridge:'

/**
 * 把 NC 的 system 段（人格 → 时间 → RAG 事实 → 摘要，顺序由调用方定）灌进 ST 的
 * extensionPrompt，**位置 0（in-prompt）**。
 *
 * 为什么走这条通道而不是塞进 chat：chat 里每一行都是一次「发言」，而人格/时间/记忆
 * 是**材料**。塞成 system 行会让 ST 把它当角色台词或系统消息处理（它对 is_system 行
 * 有自己的语义），模型看到的东西与 NC 以为的不同 —— 而且不会报错。
 *
 * 🔴 只写页面内存（ctx.extensionPrompts 是模块变量的引用快照，J-02 同源）：
 *    不调 saveSettings、不 fetch。CLEAR_EXPR 的第三行就是它，每轮进出各清一次。
 * 🔴 逐段写、按序号排：ST 按 position/depth 排序，同 position 下按插入顺序，序号保证
 *    人格永远在时间前面 —— 与 buildPayload 的注释同一条理由（越靠后越贴近这次回答）。
 */
export const PROMPT_INJECT_EXPR_TEMPLATE = [
  '(() => {',
  '    const prefix = ' + JSON.stringify(BRIDGE_PROMPT_PREFIX) + ';',
  '    const prompts = INPUT_JSON;',
  '    const ctx = SillyTavern.getContext();',
  '    if (typeof ctx.setExtensionPrompt !== "function") {',
  '        return { ok: false, written: 0, error: "setExtensionPrompt 不存在" };',
  '    }',
  '    let written = 0;',
  '    prompts.forEach(function (text, index) {',
  '        try {',
  '            ctx.setExtensionPrompt(prefix + index, String(text), 0, 0);',
  '            written += 1;',
  '        } catch (error) { /* 单段失败不拖垮其他段 */ }',
  '    });',
  '    const seen = Object.keys(ctx.extensionPrompts).filter(function (key) {',
  '        return key.indexOf(prefix) === 0;',
  '    });',
  '    return { ok: written === prompts.length, written: written, keys: seen };',
  '})()'
].join('\n')

export interface PromptInjectReport {
  ok: boolean
  written: number
  keys: string[]
  error: string | null
}

/**
 * 灌入 system 段。**空数组 = 什么都不做**（不是「清空」—— 清场是 CLEAR_EXPR 的事，
 * 在这里顺手清一次会让「注入」与「清场」的时序关系变得说不清）。
 */
export async function injectSystemPrompts(
  page: BridgePageLike,
  prompts: string[]
): Promise<PromptInjectReport> {
  const list = Array.isArray(prompts) ? prompts.filter((item) => typeof item === 'string' && item.trim()) : []
  if (list.length === 0) return { ok: true, written: 0, keys: [], error: null }
  const expr = PROMPT_INJECT_EXPR_TEMPLATE.replace('INPUT_JSON', JSON.stringify(list))
  const report = await page.eval<PromptInjectReport>(expr, EVAL_LABEL.prompts)
  return {
    ok: report?.ok === true,
    written: typeof report?.written === 'number' ? report.written : 0,
    keys: Array.isArray(report?.keys) ? report.keys : [],
    error: report?.error ? String(report.error) : null
  }
}

/* ───────────────────────── 开关锁（P5 §1 第 1 / 2 / 4 行） ───────────────────────── */

/**
 * 会被桥接**临时**压制的页面开关。
 *
 * 为什么要压：auto_continue 一开，ST 在自己跑完一轮后会**立刻再发起一轮**（页面自动续写），
 * 而桥接每轮结束都要清场 —— 两个人同时改同一个 chat，第二轮的注入必然与 ST 的续写撞车
 * （表现是「历史莫名多出一条」或「generate 永不 resolve」）。auto_swipe 同理（自动重掷）。
 *
 * 🔴 只改**页面内存里的 powerUserSettings 对象**：不调 saveSettingsDebounced()、
 *    不写 settings.json。页面被 J-07 拦着 /api/settings/save，即使误调也写不下去 ——
 *    但**不依赖拦截**，这就是不调的原因（蓝图 §1「开关怎么改才算不影响用户」）。
 */
export const BRIDGE_SWITCH_KEYS = ['auto_continue', 'auto_swipe'] as const

export type BridgeSwitchKey = (typeof BRIDGE_SWITCH_KEYS)[number]

/** 一个开关在页面上的**原始形态**（还原必须按形态还原，否则会凭空造出字段） */
export type BridgeSwitchKind = 'absent' | 'boolean' | 'enabled' | 'unknown'

export interface BridgeSwitchState {
  key: BridgeSwitchKey
  kind: BridgeSwitchKind
  /** 改动前的真值；absent / unknown 时为 null */
  before: boolean | null
  /** 改动后回读的真值；absent / unknown 时为 null */
  after: boolean | null
}

export interface BridgeSwitchSnapshot {
  /** 页面根本没有 powerUserSettings（老版本 ST 或被裁过）。不是错，但要点名 */
  missingRoot: boolean
  items: BridgeSwitchState[]
  /** 真正被临时关掉的开关（before === true）。空数组 = 这一轮没动过任何开关 */
  muted: BridgeSwitchKey[]
}

/**
 * 压制开关并在**同一段表达式里**回读（避免「改完以为改成了」）。
 *
 * 三种形态各自处理：boolean（老式平铺）→ 直接赋值；{ enabled }（当前 ST）→ 改 enabled；
 * 不存在 → **什么都不做**。最后一种最容易写错：给它补一个 false 就等于替用户改了设置，
 * 而且还原时无从判断「它本来就没有」。
 */
export const SWITCH_MUTE_EXPR = [
  '(() => {',
  '    const keys = ' + JSON.stringify(BRIDGE_SWITCH_KEYS) + ';',
  '    const ctx = SillyTavern.getContext();',
  '    const pu = ctx && ctx.powerUserSettings;',
  '    if (!pu || typeof pu !== "object") {',
  '        return { missingRoot: true, items: [], muted: [] };',
  '    }',
  '    const items = keys.map(function (key) {',
  '        const raw = pu[key];',
  '        if (raw === undefined || raw === null) {',
  '            return { key: key, kind: "absent", before: null, after: null };',
  '        }',
  '        if (typeof raw === "boolean") {',
  '            const before = raw;',
  '            pu[key] = false;',
  '            return { key: key, kind: "boolean", before: before, after: pu[key] === true };',
  '        }',
  '        if (typeof raw === "object" && typeof raw.enabled === "boolean") {',
  '            const before = raw.enabled;',
  '            raw.enabled = false;',
  '            return { key: key, kind: "enabled", before: before, after: raw.enabled === true };',
  '        }',
  '        return { key: key, kind: "unknown", before: null, after: null };',
  '    });',
  '    const muted = items.filter(function (it) { return it.before === true; }).map(function (it) { return it.key; });',
  '    return { missingRoot: false, items: items, muted: muted };',
  '})()'
].join('\n')

/** 还原：按 snapshot 里的 kind 逐条还原，**不改动任何没被压制过的开关** */
export function switchRestoreExpr(items: BridgeSwitchState[]): string {
  return [
    '(() => {',
    '    const items = ' + JSON.stringify(items) + ';',
    '    const ctx = SillyTavern.getContext();',
    '    const pu = ctx && ctx.powerUserSettings;',
    '    if (!pu || typeof pu !== "object") { return { ok: false, error: "powerUserSettings 不见了" }; }',
    '    items.forEach(function (it) {',
    '        if (it.kind === "boolean") { pu[it.key] = it.before === true; return; }',
    '        if (it.kind === "enabled") {',
    '            const raw = pu[it.key];',
    '            if (raw && typeof raw === "object") { raw.enabled = it.before === true; }',
    '        }',
    '    });',
    '    const after = {};',
    '    items.forEach(function (it) {',
    '        const raw = pu[it.key];',
    '        after[it.key] = typeof raw === "boolean" ? raw : (raw && typeof raw === "object" && typeof raw.enabled === "boolean" ? raw.enabled : null);',
    '    });',
    '    return { ok: true, after: after };',
    '})()'
  ].join('\n')
}

/**
 * 压制开关；返回 snapshot 供 finally 还原。
 * 🔴 还原**必须**在同一个 finally 里做，且**先于** resetSession（蓝图 §1 第 4 行）。
 */
export async function muteSwitches(page: BridgePageLike): Promise<BridgeSwitchSnapshot> {
  const snapshot = await page.eval<BridgeSwitchSnapshot>(SWITCH_MUTE_EXPR, EVAL_LABEL.switchMute)
  const items = Array.isArray(snapshot?.items) ? snapshot.items : []
  return {
    missingRoot: snapshot?.missingRoot === true,
    items,
    muted: items.filter((item) => item.before === true).map((item) => item.key)
  }
}

/**
 * 还原开关；返回**回读**结果（true = 全部回到原值）。
 * 不抛：还原失败不能掩盖这一轮的真实结果，但调用方必须把它变成一条 warning。
 */
export async function restoreSwitches(
  page: BridgePageLike,
  items: BridgeSwitchState[]
): Promise<{ ok: boolean; restored: boolean; error: string | null }> {
  if (!Array.isArray(items) || items.length === 0) return { ok: true, restored: true, error: null }
  try {
    const report = await page.eval<{ ok: boolean; after?: Record<string, boolean | null>; error?: string }>(
      switchRestoreExpr(items),
      EVAL_LABEL.switchRestore
    )
    if (!report || report.ok !== true) {
      return { ok: false, restored: false, error: String(report?.error ?? '还原表达式返回 ok=false') }
    }
    const after = report.after ?? {}
    let restored = true
    for (const item of items) {
      if (item.kind !== 'boolean' && item.kind !== 'enabled') continue
      if (after[item.key] !== (item.before === true)) restored = false
    }
    return { ok: true, restored, error: restored ? null : '还原后回读与原值不一致：' + JSON.stringify(after) }
  } catch (error) {
    return { ok: false, restored: false, error: error instanceof Error ? error.message : String(error) }
  }
}

