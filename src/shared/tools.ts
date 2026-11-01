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
