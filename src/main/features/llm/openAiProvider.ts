import { parseJson, sseEvents, trimSlash } from './stream'
import type { LlmMessage, LlmProvider, ProviderEvent } from './types'

/**
 * OpenAI 兼容适配器：任何暴露 POST {baseUrl}/chat/completions 且支持 SSE 的服务都能用
 * （官方、one-api、vLLM、各类中转）。
 */
export const openAiCompatibleProvider: LlmProvider = {
  id: 'openai-compatible',
  label: 'OpenAI 兼容',
  offline: false,
  async *stream(request) {
    const { settings, signal, tools } = request
    const base = trimSlash(settings.baseUrl)
    if (!base) throw new Error('未配置 baseUrl')
    if (!settings.model.trim()) throw new Error('未配置 model')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (settings.apiKey.trim()) headers.Authorization = 'Bearer ' + settings.apiKey.trim()

    const body: Record<string, unknown> = {
      model: settings.model,
      messages: toOpenAiMessages(request.messages),
      temperature: settings.temperature,
      stream: true
    }
    if (tools.length > 0) body.tools = tools.map(toOpenAiTool)

    const response = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error('模型服务返回 ' + response.status + '：' + detail.slice(0, 300))
    }

    const pending = new Map<number, { id: string; name: string; args: string }>()

    for await (const payload of sseEvents(response)) {
      if (payload === '[DONE]') break
      const json = parseJson(payload)
      const choices = json.choices as Array<Record<string, unknown>> | undefined
      const choice = choices && choices[0]
      if (!choice) continue
      const delta = choice.delta as Record<string, unknown> | undefined
      if (!delta) continue

      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', text: delta.content }
      }

      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined
      if (Array.isArray(toolCalls)) {
        for (const item of toolCalls) {
          const index = typeof item.index === 'number' ? item.index : 0
          const current = pending.get(index) ?? { id: '', name: '', args: '' }
          if (typeof item.id === 'string' && item.id) current.id = item.id
          const fn = item.function as Record<string, unknown> | undefined
          if (fn && typeof fn.name === 'string' && fn.name) current.name += fn.name
          if (fn && typeof fn.arguments === 'string' && fn.arguments) current.args += fn.arguments
          pending.set(index, current)
        }
      }
    }

    let emitted = 0
    for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.name) continue
      emitted += 1
      yield {
        type: 'tool_call',
        call: { id: call.id || 'call_' + index, name: call.name, arguments: call.args || '{}' }
      }
    }

    yield { type: 'finish', reason: emitted > 0 ? 'tool_calls' : 'stop' }
  }
}

function toOpenAiMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'tool') {
      output.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      output.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
      })
      continue
    }
    if (!message.content) continue
    output.push({ role: message.role, content: message.content })
  }
  return output
}

function toOpenAiTool(tool: { name: string; description: string; parameters: Record<string, unknown> }): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }
}
