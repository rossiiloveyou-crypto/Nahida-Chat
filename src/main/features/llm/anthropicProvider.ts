import { parseJson, sseEvents, trimSlash } from './stream'
import type { LlmMessage, LlmProvider } from './types'

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/** Anthropic Messages API。system 是顶层字段，工具结果必须塞进 user 消息的 content 块。 */
export const anthropicProvider: LlmProvider = {
  id: 'anthropic',
  label: 'Anthropic',
  offline: false,
  async *stream(request) {
    const { settings, signal, tools } = request
    const base = trimSlash(settings.baseUrl) || 'https://api.anthropic.com/v1'
    if (!settings.apiKey.trim()) throw new Error('Anthropic 需要 apiKey')
    if (!settings.model.trim()) throw new Error('未配置 model')

    const mapped = toAnthropicMessages(request.messages)
    const body: Record<string, unknown> = {
      model: settings.model,
      max_tokens: 4096,
      temperature: settings.temperature,
      messages: mapped.messages,
      stream: true
    }
    if (mapped.system) body.system = mapped.system
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }))
    }

    const response = await fetch(base + '/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey.trim(),
        'anthropic-version': '2023-06-01'
      },
      signal,
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error('Anthropic 返回 ' + response.status + '：' + detail.slice(0, 300))
    }

    const pending = new Map<number, { id: string; name: string; json: string }>()
    let emitted = 0

    for await (const payload of sseEvents(response)) {
      const event = parseJson(payload)
      const type = event.type as string | undefined

      if (type === 'content_block_start') {
        const block = event.content_block as Record<string, unknown> | undefined
        const index = typeof event.index === 'number' ? event.index : 0
        if (block && block.type === 'tool_use') {
          pending.set(index, { id: String(block.id ?? ''), name: String(block.name ?? ''), json: '' })
        }
        continue
      }

      if (type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined
        const index = typeof event.index === 'number' ? event.index : 0
        if (!delta) continue
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text', text: delta.text }
        } else if (delta.type === 'input_json_delta') {
          const current = pending.get(index)
          if (current && typeof delta.partial_json === 'string') current.json += delta.partial_json
        }
        continue
      }

      if (type === 'content_block_stop') {
        const index = typeof event.index === 'number' ? event.index : 0
        const current = pending.get(index)
        if (current) {
          pending.delete(index)
          emitted += 1
          yield {
            type: 'tool_call',
            call: { id: current.id || 'toolu_' + index, name: current.name, arguments: current.json || '{}' }
          }
        }
      }
    }

    yield { type: 'finish', reason: emitted > 0 ? 'tool_calls' : 'stop' }
  }
}

function toAnthropicMessages(messages: LlmMessage[]): {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: Block[] }>
} {
  let system = ''
  const output: Array<{ role: 'user' | 'assistant'; content: Block[] }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      system += (system ? '\n\n' : '') + message.content
      continue
    }

    if (message.role === 'tool') {
      const block: Block = { type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }
      const last = output[output.length - 1]
      const first = last && last.content.length > 0 ? last.content[0] : null
      if (last && last.role === 'user' && first && first.type === 'tool_result') {
        last.content.push(block)
      } else {
        output.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (message.role === 'assistant') {
      const blocks: Block[] = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseJson(call.arguments) })
      }
      if (blocks.length > 0) output.push({ role: 'assistant', content: blocks })
      continue
    }

    if (!message.content) continue
    output.push({ role: 'user', content: [{ type: 'text', text: message.content }] })
  }

  return { system, messages: output }
}
