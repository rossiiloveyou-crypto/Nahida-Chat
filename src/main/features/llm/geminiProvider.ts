import { parseJson, sseEvents, trimSlash } from './stream'
import type { LlmMessage, LlmProvider } from './types'

type Part = Record<string, unknown>

/** Google Gemini streamGenerateContent。工具调用走 functionCall / functionResponse，没有调用 id。 */
export const geminiProvider: LlmProvider = {
  id: 'gemini',
  label: 'Gemini',
  offline: false,
  async *stream(request) {
    const { settings, signal, tools } = request
    const base = trimSlash(settings.baseUrl) || 'https://generativelanguage.googleapis.com/v1beta'
    if (!settings.apiKey.trim()) throw new Error('Gemini 需要 apiKey')
    if (!settings.model.trim()) throw new Error('未配置 model')

    const mapped = toGeminiContents(request.messages)
    const body: Record<string, unknown> = {
      contents: mapped.contents,
      generationConfig: { temperature: settings.temperature }
    }
    if (mapped.system) body.systemInstruction = { parts: [{ text: mapped.system }] }
    if (tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }))
        }
      ]
    }

    const url =
      base +
      '/models/' +
      encodeURIComponent(settings.model) +
      ':streamGenerateContent?alt=sse&key=' +
      encodeURIComponent(settings.apiKey.trim())

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error('Gemini 返回 ' + response.status + '：' + detail.slice(0, 300))
    }

    let emitted = 0
    let callIndex = 0

    for await (const payload of sseEvents(response)) {
      const json = parseJson(payload)
      const candidates = json.candidates as Array<Record<string, unknown>> | undefined
      const candidate = candidates && candidates[0]
      if (!candidate) continue
      const content = candidate.content as Record<string, unknown> | undefined
      const parts = content && Array.isArray(content.parts) ? (content.parts as Part[]) : []

      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          // Gemini 的思考片段与正文共用一个 text 字段，靠 part.thought 区分。
          // 🔴 判据只能用 thought === true：写成 truthy 会把 thought: false 也当思考。
          if (part.thought === true) {
            yield { type: 'reasoning', text: part.text }
          } else {
            yield { type: 'text', text: part.text }
          }
        }
        const call = part.functionCall as Record<string, unknown> | undefined
        if (call && typeof call.name === 'string') {
          callIndex += 1
          emitted += 1
          yield {
            type: 'tool_call',
            call: {
              id: 'gemini_' + callIndex,
              name: call.name,
              arguments: JSON.stringify(call.args ?? {})
            }
          }
        }
      }
    }

    yield { type: 'finish', reason: emitted > 0 ? 'tool_calls' : 'stop' }
  }
}

function toGeminiContents(messages: LlmMessage[]): {
  system: string
  contents: Array<{ role: 'user' | 'model'; parts: Part[] }>
} {
  let system = ''
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      system += (system ? '\n\n' : '') + message.content
      continue
    }

    if (message.role === 'tool') {
      const part: Part = {
        functionResponse: { name: message.toolName ?? 'tool', response: { content: message.content } }
      }
      const last = contents[contents.length - 1]
      if (last && last.role === 'user' && last.parts.some((p) => 'functionResponse' in p)) {
        last.parts.push(part)
      } else {
        contents.push({ role: 'user', parts: [part] })
      }
      continue
    }

    if (message.role === 'assistant') {
      const parts: Part[] = []
      if (message.content) parts.push({ text: message.content })
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: parseJson(call.arguments) } })
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }

    if (!message.content) continue
    contents.push({ role: 'user', parts: [{ text: message.content }] })
  }

  return { system, contents }
}
