import { MODEL_TEST_TIMEOUT_MS, providerMeta } from '@shared/constants'
import type { ModelTestRequest, ModelTestResult } from '@shared/types'

/**
 * 连接测试：发一次最小请求，确认地址/密钥/模型三者真的可用。
 * 不走流式——设置页只需要一个"通/不通"的结论，流式反而更难判超时。
 */
export async function testModelConnection(request: ModelTestRequest): Promise<ModelTestResult> {
  const started = Date.now()
  const provider = request.provider
  if (provider === 'mock') {
    return { ok: true, latencyMs: 0, error: null, sample: '演示模式不联网，本地回显可用。' }
  }

  const baseUrl = request.baseUrl.trim().replace(/\/+$/, '')
  const model = request.model.trim()
  const apiKey = request.apiKey.trim()

  if (!baseUrl) return fail(started, '未填写 baseUrl')
  if (!model) return fail(started, '未填写模型 ID')

  try {
    const response = await fetchWithTimeout(buildFetchArgs(provider, baseUrl, model, apiKey))
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      return fail(started, providerMeta(provider).label + ' 返回 ' + response.status + '：' + text.slice(0, 400))
    }
    const sample = extractSample(text)
    return {
      ok: true,
      latencyMs: Date.now() - started,
      error: null,
      sample: sample || '（响应为空，但状态码正常）'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timeout = message.toLowerCase().includes('abort')
    return fail(started, timeout ? '请求超时（' + MODEL_TEST_TIMEOUT_MS + 'ms）' : message)
  }
}

function fail(started: number, error: string): ModelTestResult {
  return { ok: false, latencyMs: Date.now() - started, error, sample: null }
}

function fetchWithTimeout({ url, init }: { url: string; init: RequestInit }): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS) })
}

function buildFetchArgs(
  provider: ModelTestRequest['provider'],
  base: string,
  model: string,
  apiKey: string
): { url: string; init: RequestInit } {
  const prompt = '只回复两个字：可用'

  if (provider === 'anthropic') {
    return {
      url: base + '/messages',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [{ role: 'user', content: prompt }]
        })
      }
    }
  }

  if (provider === 'gemini') {
    return {
      url: base + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 32 }
        })
      }
    }
  }

  if (provider === 'ollama') {
    return {
      url: base + '/api/chat',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          options: { num_predict: 32 }
        })
      }
    }
  }

  // openai-compatible
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey
  return {
    url: base + '/chat/completions',
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 32,
        stream: false
      })
    }
  }
}

function extractSample(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text.trim().slice(0, 200)
  }
  const json = parsed as Record<string, unknown>
  // OpenAI / Ollama
  const choices = json.choices as Array<Record<string, unknown>> | undefined
  const choiceMessage = choices?.[0]?.message as Record<string, unknown> | undefined
  if (typeof choiceMessage?.content === 'string') return choiceMessage.content.trim().slice(0, 200)
  const ollamaMessage = json.message as Record<string, unknown> | undefined
  if (typeof ollamaMessage?.content === 'string') return ollamaMessage.content.trim().slice(0, 200)
  // Anthropic
  const content = json.content as Array<Record<string, unknown>> | undefined
  const textBlock = content?.find((item) => typeof item.text === 'string')
  if (textBlock && typeof textBlock.text === 'string') return textBlock.text.trim().slice(0, 200)
  // Gemini
  const candidates = json.candidates as Array<Record<string, unknown>> | undefined
  const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as
    | Array<Record<string, unknown>>
    | undefined
  const geminiText = parts?.find((item) => typeof item.text === 'string')
  if (geminiText && typeof geminiText.text === 'string') return geminiText.text.trim().slice(0, 200)
  return ''
}
