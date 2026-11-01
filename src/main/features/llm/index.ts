import { anthropicProvider } from './anthropicProvider'
import { geminiProvider } from './geminiProvider'
import { mockProvider } from './mockProvider'
import { ollamaProvider } from './ollamaProvider'
import { openAiCompatibleProvider } from './openAiProvider'
import type { LlmProvider } from './types'
import type { ProviderId, Settings } from '@shared/types'

export type { LlmMessage, LlmProvider, LlmRequest, ProviderEvent } from './types'

const providers: Record<ProviderId, LlmProvider> = {
  mock: mockProvider,
  'openai-compatible': openAiCompatibleProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider
}

/** 未知 provider 一律回落到演示模式，保证 UI 不会因为脏配置直接白屏。 */
export function createProvider(settings: Settings): LlmProvider {
  return providers[settings.provider] ?? mockProvider
}

export function describeProviders(): Array<{ id: ProviderId; label: string; offline: boolean }> {
  return (Object.keys(providers) as ProviderId[]).map((id) => ({
    id,
    label: providers[id].label,
    offline: providers[id].offline
  }))
}
