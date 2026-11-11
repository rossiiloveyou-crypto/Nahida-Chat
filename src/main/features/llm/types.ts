import type { Settings } from '@shared/types'
import type { ToolCallRequest, ToolDefinition } from '@shared/tools'

/**
 * 内部统一消息格式。四个适配器各自把它翻译成自己服务商的形状，
 * 会话层只认这一种表示。
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** role=assistant 时，这一轮模型请求的工具调用 */
  toolCalls?: ToolCallRequest[]
  /** role=tool 时，对应的是哪个调用 */
  toolCallId?: string
  toolName?: string
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  /**
   * 思考增量（DeepSeek reasoning_content / Anthropic thinking / Gemini thought）。
   *
   * 🔴 与 text 严格分开：它不是回答的一部分，不能拼进正文、不能回灌历史。
   *    四家协议各自的字段名见各适配器里的注释。
   */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCallRequest }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'unknown' }

export interface LlmRequest {
  messages: LlmMessage[]
  settings: Settings
  signal: AbortSignal
  tools: ToolDefinition[]
}

export interface LlmProvider {
  id: string
  label: string
  /** 离线实现（不联网） */
  offline: boolean
  stream: (request: LlmRequest) => AsyncGenerator<ProviderEvent, void, unknown>
}
