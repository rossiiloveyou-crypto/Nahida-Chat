/**
 * 工具契约。
 *
 * 这里刻意不再有「风险分级」：风险等级是个分类学问题，用户既看不懂也调不对。
 * 用户只需要回答一个行为问题——这个工具会不会改东西？
 * 所以每个工具只声明 readOnly，权限模式（完全/只读/审批）据此判定，
 * 具体策略见 src/main/features/tools/permission.ts。
 */
export interface ToolDefinition {
  name: string
  title: string
  description: string
  /** true = 只读取信息；false = 会写文件、联网、执行命令等有副作用的行为 */
  readOnly: boolean
  /** JSON Schema，直接喂给模型的 function parameters */
  parameters: Record<string, unknown>
}

export interface ToolCallRequest {
  id: string
  name: string
  /** 模型输出的原始 JSON 字符串，未经校验 */
  arguments: string
}

export type ToolCallStatus = 'awaiting' | 'running' | 'ok' | 'error' | 'denied'

export interface ToolCallRecord {
  id: string
  name: string
  title: string
  readOnly: boolean
  arguments: string
  status: ToolCallStatus
  result: string | null
  error: string | null
  startedAt: number
  durationMs: number | null
}

/** 主进程推给渲染层的审批票据。 */
export interface ToolApprovalTicket {
  requestId: string
  sessionId: string
  messageId: string
  call: ToolCallRecord
  /** 为什么需要审批：策略原文，便于用户理解 */
  reason: string
}

export interface ToolApprovalReply {
  requestId: string
  approved: boolean
  /** 本次进程内对该工具永久放行（重启失效） */
  remember: boolean
}

/** 单个工具的判定结果。 */
export type ToolAccess = 'allow' | 'ask' | 'deny'

export const READ_ONLY_LABEL = '只读'
export const WRITE_LABEL = '可写'

// ── Chat 工具增强（P1）─────────────────────────────────────
//
// 🔴 供给 ≠ 授权（M24）：本结构只回答「这一轮给模型哪些工具」，
//    不回答「谁允许执行」。授权仍在 main/features/channels/toolGate.ts。
//
// 🔴 字段全部可选 + 缺省即「关」：老配置（无此字段）行为与改动前完全一致。

export interface ChatToolsSettings {
  /** 桌面 chat 会话的工具增强总开关。缺省 false = 与改动前一致（chat 不给工具） */
  enabled?: boolean
  /**
   * 逐工具放行表：toolName → 是否在 chat 模式放行。
   * 只有 enabled === true 时才会被读取；缺省空对象。
   */
  tools?: Record<string, boolean>
  /**
   * 群聊工具增强开关（M02，默认 **true**）。
   * 只对「渠道会话 + chatType === 'group'」生效，不影响桌面与私聊。
   */
  groupEnabled?: boolean
}
