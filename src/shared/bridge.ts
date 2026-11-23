import { isChannelSessionId } from './channels'
import { DEFAULT_BRIDGE_BUDGET } from './constants'
import type { Session, Settings } from './types'

/**
 * NC × SillyTavern 桥接的跨进程契约（P4）。
 *
 * 只放「两端都要认」的东西：配置形状、一轮的结果、IPC 频道名、页面侧事件名。
 * 真正的驱动逻辑全在 `src/main/features/bridge/`；渲染进程只消费这里的类型。
 *
 * 🔴 本文件不 import 任何 `main/` 的东西（AGENTS.md 分层铁律）：渲染进程要能直接打进来。
 * 🔴 IPC 频道名刻意**不写进 `shared/ipc.ts`**：那个文件是 P3 的改动面（显示层要加
 *    `regex:listScripts`），P3 与 P4 同批施工，共用一个常量表就会在合入时冲突。
 *    桥接自成一个命名空间 `BRIDGE_IPC`，互不覆盖。
 * P8：bridgeEligible 从 main/bridge/router 提至本共享契约；生成路由和模型锁同源。
 */

/**
 * 三条件与：这一轮该不该走 ST 桥接。
 *
 * @param session 只读 id / mode（其余字段与本判定无关，收窄入参能防止有人顺手读 storyId）
 * @param settings 只管 bridge 开关；取 Pick 是为了让单测能只造一个壳
 */
export function bridgeEligible(
  session: Pick<Session, 'id' | 'mode'>,
  settings: Pick<Settings, 'bridge'>
): boolean {
  return (
    session.mode === 'story' && !isChannelSessionId(session.id) && settings.bridge?.enabled === true
  )
}

/**
 * 桥接的运行时配置。全部字段都可覆盖，缺省值见 `BRIDGE_DEFAULT_CONFIG`。
 */
export interface BridgeConfig {
  /**
   * ST 前端地址。
   * 🔴 必须是 `127.0.0.1`，不要 `localhost`（总蓝图 §一 拓扑 2：ST 的 whitelist 只放
   *    `::1` / `127.0.0.1`，写 localhost 会在某些解析下变成公网可路由的地址）。
   */
  stUrl: string
  /** 用户提供的完整 ST 源码目录 */
  stRoot: string
  /** @deprecated 仅保留旧配置字段，不再用于桥接行为。 */
  cardPath?: string
  cardName: string
  /** 已检测并回读确认的 PNG 文件名 */
  cardAvatar: string
  port: number
  dataRootMode: 'data-nc'
  /** 空串表示 <stRoot>/data-nc/logs/st-bridge.log */
  logPath: string
  /** 空串按 PATH node → Electron Node 依次选择 */
  nodePath: string
  /**
   * ST 的数据目录；托管进程时派生为 <stRoot>/data-nc/default-user。
   * 未选择 ST 目录时为空；托管启动后由配置派生，不复制原有数据。
   */
  stDataDir: string
  /**
   * ST 窗口的 Electron 分区。
   * 独立 profile 是硬要求：共默认 profile 时，被强杀的前一实例会把这个实例卡在 ready 之前
   * （P0 完成报告 §三 第 5 条）。
   */
  partition: string
  /** 等 `SillyTavern.getContext()` 就绪的上限 */
  readyTimeoutMs: number
  /** 点 Connect 之后等 `online_status` 抬起来的上限 */
  connectTimeoutMs: number
  /** 单轮生成上限；超时必须 `stopGeneration()`，否则下一轮必冲突 */
  generateTimeoutMs: number
  /**
   * 同一会话两轮之间的最小间隔（ms）。0 = 不限制。
   * 存在的理由：ST 侧扩展（tavern_helper）对「上一轮刚结束就又来一轮」比较敏感，
   * 800ms 是实测能稳过的下限（PHASE-4 §一 driver 第 5 条 + A5）。
   */
  minIntervalMs: number
  /** 缺省开启；无 prepareBudget 的旧调用仍使用原路径。 */
  budgetEnabled?: boolean
  /** 读不到 ST 活值时的手填总预算；null 表示尚未配置。 */
  manualBudgetTokens?: number | null
  /** null 或缺省表示总预算的 35%。 */
  stReserveTokens?: number | null
}

/** 单轮生成上限的允许区间（10 秒 ~ 1 小时）。用户在设置页按「秒」填，落盘按毫秒存。 */
export const BRIDGE_GENERATE_TIMEOUT_RANGE = { minMs: 10_000, maxMs: 3_600_000 } as const

/** 缺省配置。改这里 = 改所有调用方的默认行为，非必要不动。 */
export const BRIDGE_DEFAULT_CONFIG: BridgeConfig = {
  stUrl: 'http://127.0.0.1:8000',
  stRoot: '',
  cardName: '',
  cardAvatar: '',
  port: 8000,
  dataRootMode: 'data-nc',
  logPath: '',
  nodePath: '',
  stDataDir: '',
  partition: 'persist:nc-bridge',
  readyTimeoutMs: 60000,
  connectTimeoutMs: 45000,
  generateTimeoutMs: 180000,
  minIntervalMs: 800,
  ...DEFAULT_BRIDGE_BUDGET
}

/**
 * 一轮的结局。三取值与 `ChatTurnOutcome.status` 对齐（P5 的失败转译直接映射，不再造一层）。
 *
 * - `done`    拿到非空文本
 * - `error`   reject / resolve 空串 / 超时 / 注入自检失败（J-03：**以 resolve 为准**）
 * - `aborted` 调用方中途取消
 */
export type BridgeTurnStatus = 'done' | 'error' | 'aborted'

/**
 * 一轮的结果。🔴 只有这五个字段（PHASE-4 §1 第 1 行）：
 * 失败原因必须能被 P5 原样转成错误条文案，所以 `error` 是**字符串**而不是错误码。
 */
export interface BridgeTurnResult {
  status: BridgeTurnStatus
  /** 落库用正文。失败时是空串（不要把半截回复当成功写进分支） */
  content: string
  /** `ctx.generate()` 的 resolve 原值（逐字，不 trim、不加工） */
  raw: string
  /** 失败原因（status !== 'done' 时非 null） */
  error: string | null
  /** 这一轮**生成**耗时（ms）；失败在生成之前时为 0 */
  ms: number
  /**
   * 这一轮的**人话告警**（P5 §1 第 3 行）：开关被临时压制/还原失败等「不致命但用户该知道」的事。
   * ⚠️ 页面 toast **不在**这里：它是失败**主因**的一部分，已并进 `error`（`生成失败：…；页面提示：…`）。
   * 🔴 恒为数组（没有告警就是空数组），消费方不必判空指针；失败的**主因**仍在 `error` 上，
   *    这里只放「不致命但用户该知道」的东西（P6 直接显示）。
   */
  warnings: string[]
}

/**
 * 一条历史消息。与 `LlmMessage` 同形但**不含**工具字段：
 * 桥接只做「把历史灌进 ST」，工具调用是 chat 模式的事（M3：story 模式恒无工具）。
 */
export interface BridgeMessage {
  role: 'user' | 'assistant' | 'system' | 'narration' | 'tool'
  content: string
}

/** 本轮只读 ST 活值或明确配置的手填预算；未知值不猜测。 */
export interface BridgeBudgetSource {
  context: number | null
  response: number | null
  budgetTotal: number | null
  source: 'st' | 'manual' | 'unavailable'
  /** Active fixed override prompt, already safety-adjusted by the driver. */
  fixedPromptTokens?: number
  stReserveTokens: number
  warning?: string
}

/** 回调产物：历史为原始消息的连续后缀，system 段由调用方按分层预算重建。 */
export interface BridgeBudgetPrepared {
  messages: BridgeMessage[]
  systemPrompts: string[]
  historyDropped: number
  budgetUsed: number
  budgetTotal: number
  stReserveTokens: number
  warnings?: string[]
}

export type BridgePrepareBudget = (source: BridgeBudgetSource) => BridgeBudgetPrepared | Promise<BridgeBudgetPrepared>

/** 只含统计，不含正文；driver 与落盘轨迹共用。 */
export interface BridgeBudgetTrace {
  historyDropped?: number
  budgetUsed?: number
  budgetTotal?: number
  stReserveTokens?: number
  budgetSource?: BridgeBudgetSource
}

/** 一次调用的入参：哪条会话（只用于排队/间隔，不发给 ST）+ 完整历史（最后一条应为 user） */
export interface BridgeTurnInput {
  /** NC 侧会话 id（分支 id）。🔴 只用于桥接内部的排队与限速，**不进 ST** */
  sessionId: string
  /** 已按 NC 口径裁好的历史（含本轮用户输入） */
  messages: BridgeMessage[]
  /** 同次 historyOf 的原始长度（含尚未过滤的旁白与占位）。 */
  historyBefore?: number
}

/** 桥接健康度（P6 的设置面板与探针都用它，不需要另一个字段集） */
export interface BridgeHealth {
  /** 最近完成轮次的预算证据；正文不跨 IPC。 */
  budget?: BridgeBudgetTrace & { historySent: number }
  /** 隐藏窗口当前可用（没崩、没被销毁、上下文就绪过） */
  alive: boolean
  /** 已经在跑的轮次（0 = 空闲） */
  busy: boolean
  /** 崩溃重建次数（>0 说明发生过 render-process-gone / did-fail-load） */
  rebuilds: number
  circuitOpen: boolean
  retryCount: number
  lastFailStep: BridgeFailureStep | null
  orphanScanError: string | null
  stRunning: boolean
  stPid: number | null
  port: number
  logBytes: number
  orphans: number
  nodeSource: 'configured' | 'path' | 'electron' | null
  needsOnboarding: boolean
  cardAvatar: string
  cardName: string
  /** @deprecated P2 起无拦截，兼容旧消费者一版，恒为 0 */
  cancelledWrites: number
  /** @deprecated P2 起无拦截，恒为 0 */
  blockedExternal: number
  /** 最近一次失败原因；正常为 null */
  lastError: string | null
  /** 当前生效的配置（设置页要能显示 ST 地址与分区） */
  config: BridgeConfig
}

export interface BridgeOverrideState {
  text: string
  active: boolean
  truncated: boolean
  warning: string | null
}

/**
 * 桥接专用 IPC 频道（见文件头：不并进 `shared/ipc.ts`）。
 *
 * - `turn`   渲染层发起一轮（P6 接线后使用）
 * - `health` 读健康度
 * - `event`  隐藏窗口 → 主进程的单向事件（preload 的 `window.ncEmit` 打的就是这条）
 */
export const BRIDGE_IPC = {
  turn: 'bridge:turn',
  health: 'bridge:health',
  openSt: 'bridge:open-st',
  stopSt: 'bridge:stop-st',
  openLog: 'bridge:open-log',
  overrideGet: 'bridge:override-get',
  overrideSave: 'bridge:override-save',
  event: 'bridge:event'
} as const

/**
 * 页面侧事件名（`window.ncEmit` 的第一个参数）。
 *
 * `streamToken` 就是 ST 的 `STREAM_TOKEN_RECEIVED`：逐字回推，让 NC 能边生成边显示。
 * 🔴 它是**展示用**的增量，不是真相来源：这一轮成不成只认 `generate()` 的 resolve（J-03）。
 */

/** P5: stable failure steps and human next actions; raw exceptions stay in diagnostics. */
export type BridgeFailureKey = 'preflight' | 'port' | 'node' | 'ready' | 'exposure' | 'role-empty' | 'role-missing' | 'role-ambiguous' | 'role-switched' | 'inject' | 'timeout' | 'budget' | 'empty' | 'disk-count' | 'disk-timeout' | 'delete' | 'crash'
export type BridgeFailureStep = `fail:${BridgeFailureKey}`
export class BridgeFailure extends Error {
  constructor(readonly step: BridgeFailureStep, message: string, readonly detail = '', readonly budget?: BridgeBudgetTrace) { super(message); this.name = 'BridgeFailure' }
}
export function isPageUnavailable(error: unknown): boolean {
  if (error instanceof BridgeFailure) return error.step === 'fail:crash'
  const text = error instanceof Error ? error.message : String(error)
  return /render-process-gone|did-fail-load|ERR_(?:ABORTED|CONNECTION_REFUSED)|(?:^|ST )(?:页面|窗口).*(?:不可用|已关闭|已崩溃)|(?:webContents|frame|render frame|Object).*(?:destroyed|disposed|detached)|Execution context was destroyed|Render frame was disposed|crashed/i.test(text)
}
export function bridgeFailure(error: unknown, context: { port?: number; timeoutMs?: number; cardName?: string; stage?: string } = {}): BridgeFailure {
  if (error instanceof BridgeFailure) return error
  const detail = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : String(error)
  let key: BridgeFailureKey
  if (isPageUnavailable(error)) key = 'crash'
  else if (/EADDRINUSE|is already in use|端口.*已被占用/i.test(detail)) key = 'port'
  else if (/Node.*(?:不可用|找不到)|spawn.*ENOENT/i.test(detail)) key = 'node'
  else if (/请填写桥接角色/.test(detail)) key = 'role-empty'
  else if (/未找到角色|角色列表中没有/.test(detail)) key = 'role-missing'
  else if (/多张同名/.test(detail)) key = 'role-ambiguous'
  else if (/当前角色是|角色不符|角色选中校验失败/.test(detail)) key = 'role-switched'
  else if (/暴露面|selectCharacterById/.test(detail)) key = 'exposure'
  else if (/TokenBudgetExceeded|上下文预算|必要的提示词超过了上下文大小|Not enough free tokens|Insufficient.*token|required prompts.*(?:exceed|context)/i.test(detail)) key = 'budget'
  else if (/注入/.test(detail)) key = 'inject'
  else if (/落盘.*超时|等待 ST 落盘/.test(detail)) key = 'disk-timeout'
  else if (/落盘末条.*非空 assistant/.test(detail)) key = 'empty'
  else if (/落盘|metadata 首行/.test(detail)) key = 'disk-count'
  else if (/空回复/.test(detail)) key = 'empty'
  else if (/生成超时/.test(detail)) key = 'timeout'
  else if (/启动超时|服务启动超时|首次启动|就绪超时/.test(detail)) key = 'ready'
  else if (/删除|孤儿/.test(detail)) key = 'delete'
  else if (/体检|server\.js|SillyTavern 源码目录/.test(detail)) key = 'preflight'
  else if (context.stage === 'exposure') key = 'exposure'
  else if (context.stage === 'inject') key = 'inject'
  else if (context.stage === 'disk') key = 'disk-count'
  else key = 'preflight'
  const name = context.cardName || '配置的角色'
  const messages: Record<BridgeFailureKey, string> = {
    preflight: 'ST 运行失败，请在设置检查包含 server.js、node_modules、config.yaml 的完整安装目录，并打开日志查看原因',
    port: '端口 ' + (context.port ?? '所选') + ' 已被占用，请在 ST 设置里换一个端口',
    node: '找不到可用的 Node，请在设置里指定 nodePath',
    ready: 'ST 启动超时（' + ((context.timeoutMs ?? 60000) / 1000) + 's），请打开日志窗口；首次启动请先完成初始化向导',
    exposure: 'ST 页面版本不受支持（停止条件 1），请更新或检查 ST 版本',
    'role-empty': '请填写桥接角色后再打开 ST',
    'role-missing': '未找到角色「' + name + '」，请先在酒馆中导入对应角色卡',
    'role-ambiguous': '有多张同名角色卡「' + name + '」，请改用唯一名称',
    'role-switched': (/角色选中校验失败/.test(detail) ? 'ST 角色选中校验失败。' : '') + 'ST 当前角色与本轮「' + name + '」不符，请切回目标角色；或停止 ST 后修改桥接角色',
    inject: '历史注入自检失败（mes / is_user 不一致），请保留日志并反馈问题',
    timeout: '生成超时（' + ((context.timeoutMs ?? 180000) / 1000) + ' 秒；' + (context.timeoutMs ?? 180000) + 'ms），可在设置里调大单轮上限',
    budget: 'ST 上下文预算不足，请提高容量或调小世界书预算后重试',
    empty: 'ST 返回空串（空回复，可能被截断或审查），请重试',
    'disk-count': '落盘校验失败，本轮不落库，请重试并查看日志',
    'disk-timeout': '等不到 ST 存盘（3s），请重试并查看日志',
    delete: '本轮 chat 删除失败，已登记孤儿清单，请重新打开 ST 自动清理并查看日志',
    crash: 'ST 页面崩溃，正在自动重启；如仍失败，请打开日志或重新打开 ST'
  }
  // Only allow the character module's fixed, human-readable identity template through.
  if (key === 'role-switched' && /^ST 当前角色是「[^\r\n]*」.*请切回「[^\r\n]*」/.test(detail) && !/EPERM|ENOENT|EADDRINUSE|\n\s*at /.test(detail)) messages[key] = detail
  if (key === 'disk-count') {
    const counts = /expected=(\d+) actual=(\d+)/.exec(detail)
    if (counts) messages[key] = '落盘校验失败（expected=' + counts[1] + ' / actual=' + counts[2] + '），本轮不落库，请重试'
  }
  return new BridgeFailure(('fail:' + key) as BridgeFailureStep, messages[key], detail)
}

export const BRIDGE_EVENT = {
  streamToken: 'stream_token_received'
} as const
