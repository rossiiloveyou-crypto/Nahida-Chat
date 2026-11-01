/** SSE（`data: ...` 分帧）读取器，OpenAI / Anthropic / Gemini 共用。 */
export async function* sseEvents(response: Response): AsyncGenerator<string, void, unknown> {
  if (!response.body) throw new Error('模型服务没有返回响应体')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
}

/** NDJSON（一行一个 JSON）读取器，Ollama 用。 */
export async function* ndjsonEvents(response: Response): AsyncGenerator<string, void, unknown> {
  if (!response.body) throw new Error('模型服务没有返回响应体')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line) yield line
    }
  }
}

export function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function parseJson(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
