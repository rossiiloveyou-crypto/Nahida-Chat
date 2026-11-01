import { ndjsonEvents, parseJson, trimSlash } from './stream'
import type { LlmMessage, LlmProvider } from './types'

/** Ollama /api/chat，NDJSON 流。默认地址是本机 11434，不需要 apiKey。 */
export const ollamaProvider: LlmProvider = {
  id: 'ollama',
  label: 'Ollama（本地）',
  offline: true,
  async *stream(request) {
    const { settings, signal, tools } = request
    const base = trimSlash(settings.baseUrl) || 'http://127.0.0.1:11434'
    if (!settings.model.trim()) throw new Error('未配置 model')

    const body: Record<string, unknown> = {
      model: settings.model,
      messages: toOllamaMessages(request.messages),
      stream: true,
      options: { temperature: settings.temperature }
    }
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }))
    }

    const response = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error('Ollama 返回 ' + response.status + '：' + detail.slice(0, 300))
    }

    let emitted = 0
    let callIndex = 0

    for await (const line of ndjsonEvents(response)) {
      const json = parseJson(line)
      const message = json.message as Record<string, unknown> | undefined
      if (message) {
        if (typeof message.content === 'string' && message.content) {
          yield { type: 'text', text: message.content }
        }
        const calls = message.tool_calls as Array<Record<string, unknown>> | undefined
        for (const item of calls ?? []) {
          const fn = item.function as Record<string, unknown> | undefined
          if (!fn || typeof fn.name !== 'string') continue
          callIndex += 1
          emitted += 1
          yield {
            type: 'tool_call',
            call: {
              id: 'ollama_' + callIndex,
              name: fn.name,
              arguments: JSON.stringify(fn.arguments ?? {})
            }
          }
        }
      }
      if (json.done === true) break
    }

    yield { type: 'finish', reason: emitted > 0 ? 'tool_calls' : 'stop' }
  }
}

function toOllamaMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'tool') {
      output.push({ role: 'tool', content: message.content, tool_name: message.toolName ?? '' })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      output.push({
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: parseJson(call.arguments) }
        }))
      })
      continue
    }
    if (!message.content) continue
    output.push({ role: message.role, content: message.content })
  }
  return output
}
