import { MODEL_TEST_TIMEOUT_MS, providerMeta } from '@shared/constants'
import type { DiscoveredModel, ModelDiscoveryRequest, ModelDiscoveryResult } from '@shared/types'

/**
 * 「获取可用模型」：问服务商要一份模型清单，让用户勾选而不是手打 ID。
 *
 * 每个服务商的清单接口都不一样，而且同一家的不同部署（官方 / 中转站 / 自建）
 * 经常只实现了其中的一部分。所以这里的策略是：
 * 1. 先试该服务商的「标准」接口，能用就用；
 * 2. 失败就退回 OpenAI 兼容的 /models（绝大多数中转站都实现了它）；
 * 3. 两个都失败，把第一个错误原样抛给用户看，别编造一个空清单说"没有模型"。
 *
 * 绝不写死模型清单：模型名每周都在变，写死的清单过期后比没有更糟。
 */
export async function discoverModels(request: ModelDiscoveryRequest): Promise<ModelDiscoveryResult> {
  const started = Date.now()
  const provider = request.provider
  // 演示模式没有远端清单，但它必须明确告诉用户"这里没有东西可拉"
  if (provider === 'mock') {
    return {
      ok: false,
      latencyMs: 0,
      error: '演示模式是本地模拟的，没有可选模型列表。切到真实服务商再试。',
      models: []
    }
  }

  const baseUrl = request.baseUrl.trim().replace(/\/+$/, '')
  const apiKey = request.apiKey.trim()
  if (!baseUrl) return fail(started, '未填写 baseUrl')

  const attempts = buildAttempts(provider, baseUrl, apiKey)
  let firstError = ''
  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        method: 'GET',
        headers: attempt.headers,
        signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS)
      })
      const text = await response.text().catch(() => '')
      if (!response.ok) {
        const error =
          providerMeta(provider).label + ' 返回 ' + response.status + '：' + text.slice(0, 200)
        if (!firstError) firstError = error
        continue
      }
      const models = parseModelList(attempt.kind, text)
      if (models.length === 0) {
        if (!firstError) firstError = '接口返回成功，但里面没有可识别的模型条目'
        continue
      }
      return { ok: true, latencyMs: Date.now() - started, error: null, models }
    } catch (error) {
      const message = describeError(error)
      if (!firstError) firstError = message
    }
  }

  return fail(started, firstError || '没有拿到模型列表')
}

interface Attempt {
  kind: 'openai' | 'anthropic' | 'gemini' | 'ollama'
  url: string
  headers: Record<string, string>
}

/**
 * 候选清单接口，按「最可能成功」排序。
 * 注意排序不是按服务商分类做的，而是按协议：
 * OpenAI 兼容的 /models 覆盖面最广，所以永远留一条兜底。
 */
function buildAttempts(provider: ModelDiscoveryRequest['provider'], base: string, apiKey: string): Attempt[] {
  const attempts: Attempt[] = []

  if (provider === 'anthropic') {
    attempts.push({
      kind: 'anthropic',
      url: base + '/models?limit=1000',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    })
  }

  if (provider === 'gemini') {
    attempts.push({
      kind: 'gemini',
      url: base + '/models?pageSize=1000&key=' + encodeURIComponent(apiKey),
      headers: {}
    })
  }

  if (provider === 'ollama') {
    attempts.push({ kind: 'ollama', url: base + '/api/tags', headers: {} })
  }

  // OpenAI 兼容（也是所有其它协议失败后的兜底）
  const openAiHeaders: Record<string, string> = {}
  if (apiKey) openAiHeaders.Authorization = 'Bearer ' + apiKey
  attempts.push({ kind: 'openai', url: base + '/models', headers: openAiHeaders })

  return attempts
}

function parseModelList(kind: Attempt['kind'], text: string): DiscoveredModel[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const json = parsed as Record<string, unknown>

  if (kind === 'ollama') {
    const items = Array.isArray(json.models) ? (json.models as Array<Record<string, unknown>>) : []
    return dedupe(
      items.map((item) => ({
        // Ollama 的 name 就是调用时要传的 model 名（含 :tag）
        id: typeof item.name === 'string' ? item.name : '',
        name: null,
        contextWindowTokens: null,
        multimodal: null
      }))
    )
  }

  if (kind === 'gemini') {
    const items = Array.isArray(json.models) ? (json.models as Array<Record<string, unknown>>) : []
    return dedupe(
      items.map((item) => {
        // Gemini 的 name 形如 "models/gemini-2.5-pro"，调用时只要后半段
        const raw = typeof item.name === 'string' ? item.name.replace(/^models\//, '') : ''
        return {
          id: raw,
          name: typeof item.displayName === 'string' ? item.displayName : null,
          contextWindowTokens: numberOrNull(item.inputTokenLimit),
          // 清单接口不公布输入模态，宁可留空也不要瞎猜
          multimodal: null
        }
      })
    )
  }

  if (kind === 'anthropic') {
    const items = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : []
    return dedupe(
      items.map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        name: typeof item.display_name === 'string' ? item.display_name : null,
        contextWindowTokens: numberOrNull(item.max_input_tokens),
        multimodal: null
      }))
    )
  }

  // OpenAI 兼容：data[].id，有的中转站会额外给 created / owned_by
  const items = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : []
  return dedupe(
    items.map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      name: typeof item.name === 'string' ? item.name : null,
      contextWindowTokens: numberOrNull(item.context_window ?? item.context_length),
      multimodal: Array.isArray(item.input_modalities)
        ? item.input_modalities.includes('image')
        : null
    }))
  )
}

function dedupe(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>()
  const output: DiscoveredModel[] = []
  for (const model of models) {
    const id = model.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    output.push({ ...model, id })
  }
  return output.sort((a, b) => a.id.localeCompare(b.id))
}

function numberOrNull(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.toLowerCase().includes('abort')) return '请求超时（' + MODEL_TEST_TIMEOUT_MS + 'ms）'
  return message
}

function fail(started: number, error: string): ModelDiscoveryResult {
  return { ok: false, latencyMs: Date.now() - started, error, models: [] }
}
