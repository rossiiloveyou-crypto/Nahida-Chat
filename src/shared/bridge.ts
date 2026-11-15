import { isChannelSessionId } from './channels'
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
  /**
   * ST 的数据目录。桥接只**读**它（当前预设里的正则脚本、只读巡检），永不写。
   * 缺省值与总蓝图 §一 拓扑 3 一致；这里硬编码的是**路径**，不是凭据。
   */
  stDataDir: string
  /**
   * 隐藏窗口的 Electron 分区。
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
}

/** 缺省配置。改这里 = 改所有调用方的默认行为，非必要不动。 */
export const BRIDGE_DEFAULT_CONFIG: BridgeConfig = {
  stUrl: 'http://127.0.0.1:8000',
  stDataDir: 'D:/ST/SillyTavern/data/default-user',
  partition: 'persist:nc-bridge',
  readyTimeoutMs: 60000,
  connectTimeoutMs: 45000,
  generateTimeoutMs: 180000,
  minIntervalMs: 800
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

/** 一次调用的入参：哪条会话（只用于排队/间隔，不发给 ST）+ 完整历史（最后一条应为 user） */
export interface BridgeTurnInput {
  /** NC 侧会话 id（分支 id）。🔴 只用于桥接内部的排队与限速，**不进 ST** */
  sessionId: string
  /** 已按 NC 口径裁好的历史（含本轮用户输入） */
  messages: BridgeMessage[]
}

/** 桥接健康度（P6 的设置面板与探针都用它，不需要另一个字段集） */
export interface BridgeHealth {
  /** 隐藏窗口当前可用（没崩、没被销毁、上下文就绪过） */
  alive: boolean
  /** 已经在跑的轮次（0 = 空闲） */
  busy: boolean
  /** 崩溃重建次数（>0 说明发生过 render-process-gone / did-fail-load） */
  rebuilds: number
  /** 被拦下的写盘请求数（J-07） */
  cancelledWrites: number
  /** 被拦下的外网请求数（J-07） */
  blockedExternal: number
  /** 最近一次失败原因；正常为 null */
  lastError: string | null
  /** 当前生效的配置（设置页要能显示 ST 地址与分区） */
  config: BridgeConfig
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
  event: 'bridge:event'
} as const

/**
 * 页面侧事件名（`window.ncEmit` 的第一个参数）。
 *
 * `streamToken` 就是 ST 的 `STREAM_TOKEN_RECEIVED`：逐字回推，让 NC 能边生成边显示。
 * 🔴 它是**展示用**的增量，不是真相来源：这一轮成不成只认 `generate()` 的 resolve（J-03）。
 */
export const BRIDGE_EVENT = {
  streamToken: 'stream_token_received'
} as const
