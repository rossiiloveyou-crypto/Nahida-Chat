/**
 * NC ↔ snowluma-host 的 RPC 契约（**唯一真源**）。
 *
 * 位置在 `src/shared/` 的理由（AGENTS.md 一「跨进程的数据结构先写 shared」）：
 * 它同时被 NC 主进程与本任务新增的宿主入口消费，且必须被 `tsconfig.node.json` 覆盖到，
 * 否则契约漂移时 typecheck 不会报。构建时脚本把它拷成宿主侧的 `./nc-host-protocol`。
 *
 * 这个文件被两端同时 import：
 *  - 宿主侧：`host/entry.ts`（构建时被拷进 SL 工作副本，由 SL 自己的 vite 打包成 index.mjs）
 *  - NC 侧：`src/main/features/qq/host.ts`（NC 主进程 CJS，经 electron-vite 打包）
 *
 * 因此本文件**不允许有任何 import**（不能依赖 node/electron 类型），只能是
 * 纯类型 + 纯常量 —— 否则一端打得进去、另一端打不进去（P0 的 ESM/CJS 边界，总蓝图约束 8）。
 *
 * 为什么不用 OneBot HTTP/WS 当传输：总蓝图 §一 已定「NC 主进程 ↔ snowluma-host 用
 * `child_process.spawn(node.exe) + stdio:'ipc'`」，OneBot 是 QQ 协议运行时自己的对外
 * 适配层，和本通道是两件事。
 */

/** 只有这四类消息会从宿主发往 NC 主进程。 */
export const QQ_HOST_MESSAGE = {
  ready: 'ready',
  log: 'log',
  response: 'response',
  fatal: 'fatal',
  /** 宿主 → NC：一条 OneBot v11 事件（原样，不做裁剪） */
  event: 'event'
} as const

/** 宿主可被调用的方法名。新增方法必须两端同时加，不允许一端偷偷扩。 */
export const QQ_HOST_RPC = {
  /** 列出本机全部 QQ 主进程（**绝不注入**，总蓝图 D2 / M2） */
  listProcesses: 'listProcesses',
  /** 用户点选后注入指定 PID */
  loadProcess: 'loadProcess',
  /** 卸载指定 PID 的注入 */
  unloadProcess: 'unloadProcess',
  /** 刷新指定 PID 的连接状态 */
  refreshProcess: 'refreshProcess',
  /** 宿主自身状态（版本、运行期目录、账号列表） */
  status: 'status',
  /** 优雅关闭 */
  shutdown: 'shutdown',
  /** 在指定账号上调用一个 OneBot 动作 */
  invokeAction: 'invokeAction'
} as const

export type QqHostRpcMethod = (typeof QQ_HOST_RPC)[keyof typeof QQ_HOST_RPC]

/** 宿主侧 `HookProcessInfo` 的**显式投影**：只带能过 JSON 序列化的字段。
 *  不直接透传对象，是为了防止将来 SL 往 HookProcessInfo 里塞 bigint（IPC 默认 json 序列化会直接抛）。 */
export interface QqProcessSnapshot {
  pid: number
  name: string
  path: string
  injected: boolean
  connected: boolean
  loggedIn: boolean
  uin: string
  status: string
  error: string
  method: string
  account: { uin: string; nickname: string } | null
}

/** 宿主 → NC：启动完成握手。`pid` 是宿主自身 PID（不是 QQ 的）。 */
export interface QqHostReadyMessage {
  kind: typeof QQ_HOST_MESSAGE.ready
  pid: number
  /** 宿主 node 的 `process.versions.node`（J-01 / 约束 9：≥ 24.22.1） */
  node: string
  /** `process.versions.napi`（判据 J-04 要求「真的用一次」，这里先把口径记下来） */
  napi: string
  /** 运行期数据目录（= NC_SL_HOME 的绝对路径） */
  home: string
  startedAt: number
}

/** 宿主 → NC：一条 SL 日志。级别只转发 debug 以上（trace 是内存级，不跨进程）。 */
export interface QqHostLogMessage {
  kind: typeof QQ_HOST_MESSAGE.log
  level: string
  scope: string
  time: string
  line: string
}

export interface QqHostResponseMessage {
  kind: typeof QQ_HOST_MESSAGE.response
  id: number
  ok: boolean
  /** ok === true 时的结果 */
  result?: unknown
  /** ok === false 时的错误原文（**必须原样透传到 UI**，总蓝图 D3） */
  error?: string
}

/** 宿主 → NC：宿主自身发生不可恢复的错误（例如握手前就崩了）。 */
export interface QqHostFatalMessage {
  kind: typeof QQ_HOST_MESSAGE.fatal
  message: string
}

/** 宿主 → NC：一条 OneBot v11 事件。uin 是它属于哪个账号（= OneBotInstance.uin）。 */
export interface QqHostEventMessage {
  kind: typeof QQ_HOST_MESSAGE.event
  /** 这个事件属于哪个账号（= OneBotInstance.uin） */
  uin: string
  /** 原始 OneBot v11 事件对象。审计用，**不要**在这里裁剪字段 */
  event: unknown
}

/** NC → 宿主：调用一个 OneBot 动作 */
export interface QqActionRequest {
  uin: string
  action: string
  params?: Record<string, unknown>
}

/**
 * 动作结果的显式投影。**不直接透传 ApiResponse**。
 *
 * messageId 用 string 而不是 number：OneBot 的 message_id 是**签名 int32**，
 * 负值合法（SL 明确约束）；用 number 跨 IPC 会在调用方随手判断正数时把负 id 当失败。
 */
export interface QqActionResult {
  ok: boolean
  retcode: number
  /** 成功时是 data.message_id 的字符串形式 */
  messageId: string | null
  /** 失败时的原文（wording 优先，其次 message，最后 status/retcode） */
  error: string | null
}

export type QqHostToMain =
  | QqHostReadyMessage
  | QqHostLogMessage
  | QqHostResponseMessage
  | QqHostFatalMessage
  | QqHostEventMessage

/** NC → 宿主：一条 RPC 请求。`id` 自增，回包按 id 关联（经验库 C17：不能假设顺序）。 */
export interface QqHostRequestMessage {
  kind: 'request'
  id: number
  method: QqHostRpcMethod
  params?: unknown
}

/** NC → 宿主：优雅关闭。为兼容 SL 上游契约，纯字符串 'shutdown' 也接受。 */
export interface QqHostShutdownMessage {
  kind: 'shutdown'
}

export type QqMainToHost = QqHostRequestMessage | QqHostShutdownMessage

/** 宿主运行状态（NC 侧，不进 IPC）。 */
export type QqHostState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'degraded'
  | 'stopping'

export interface QqHostStatus {
  state: QqHostState
  /** 宿主 PID；未起进程时为 null */
  pid: number | null
  /** 最近一次成功握手的耗时（ms）；未握手为 null */
  readyMs: number | null
  /** 连续启动失败次数（成功握手后清零） */
  failures: number
  /** 最近一次错误原文 */
  lastError: string | null
  /** 运行期数据目录 */
  home: string | null
  /** 产物目录 */
  hostDir: string | null
  /** 宿主的 node 版本 / napi（来自 ready 消息） */
  node: string | null
  napi: string | null
}