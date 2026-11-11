import type { ProviderId } from './types'

/** 应用级常量：出现在多个进程里的魔法值统一收口到这里。 */
export const APP_NAME = 'Nahida Chat'

export const DEFAULT_SESSION_TITLE = '新的对话'

/**
 * 主题色令牌，与 src/renderer/src/styles/tokens.css 保持一致。
 *
 * 日间已改用资产包 #F8F9F3 系（M1）。改这里 = 主进程窗口底色 + 设置页色板同时生效，
 * 不要在 main/window.ts 或渲染层各写一份。
 */
export const THEME = {
  canvas: '#F8F9F3',
  surface: '#FFFFFF',
  accent: '#4F7945'
} as const

/** 深色主题的窗口底色：主进程在首帧前用它填窗口，避免深色启动闪一块浅色 */
export const THEME_DARK = {
  canvas: '#101722'
} as const

/** 外观设置的出厂值；老配置缺这一段时按它补齐 */
export const DEFAULT_APPEARANCE = {
  theme: 'light'
} as const

/**
 * 输入框软提示阈值：超过它只在计数上标红提醒，不拦发送。
 * 原来的 8000 是 maxLength 硬截断，会把长文直接吞掉，已移除。
 */
export const INPUT_LENGTH_WARN = 100_000

/** 一次对话里最多允许几轮"模型要工具 -> 执行 -> 继续" */
export const MAX_TOOL_TURNS = 6

/** 审批卡等待时长，超时按拒绝处理 */
export const APPROVAL_TIMEOUT_MS = 120_000

/** 连接测试的超时；超过就按失败处理，避免设置页卡死 */
export const MODEL_TEST_TIMEOUT_MS = 20_000

export interface ProviderMeta {
  id: ProviderId
  label: string
  /** 切换服务商时自动填入的默认 baseUrl */
  defaultBaseUrl: string
  offline: boolean
}

/** 传输适配器清单（真正接哪一类 HTTP 协议）。模型档案里的 provider 只能取其中之一。 */
export const PROVIDERS: ProviderMeta[] = [
  { id: 'mock', label: '演示模式', defaultBaseUrl: '', offline: true },
  { id: 'openai-compatible', label: 'OpenAI 兼容', defaultBaseUrl: 'https://api.openai.com/v1', offline: false },
  { id: 'anthropic', label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', offline: false },
  { id: 'gemini', label: 'Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', offline: false },
  { id: 'ollama', label: 'Ollama（本地）', defaultBaseUrl: 'http://127.0.0.1:11434', offline: true }
]

export function providerMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((item) => item.id === id) ?? PROVIDERS[0]
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDERS.some((item) => item.id === value)
}

/**
 * 服务商预设：一键填好「传输适配器 + 地址 + 常用模型」。
 * 只做预填，不锁定——用户可以改地址、加模型，也可以选「自定义」从零填。
 */
export interface VendorPreset {
  id: string
  label: string
  /** 映射到哪个传输适配器 */
  provider: ProviderId
  baseUrl: string
  /** 常用模型 ID，仅作为候选清单与输入建议 */
  models: string[]
  websiteUrl: string
}

export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: 'mock',
    label: '演示模式（离线）',
    provider: 'mock',
    baseUrl: '',
    models: ['demo'],
    websiteUrl: ''
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    websiteUrl: 'https://platform.openai.com/'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    websiteUrl: 'https://platform.deepseek.com/'
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    provider: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    websiteUrl: 'https://platform.moonshot.cn/'
  },
  {
    id: 'qwen',
    label: '通义千问',
    provider: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    websiteUrl: 'https://bailian.console.aliyun.com/'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    provider: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    websiteUrl: 'https://open.bigmodel.cn/'
  },
  {
    id: 'volcengine',
    label: '火山方舟',
    provider: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115'],
    websiteUrl: 'https://www.volcengine.com/product/ark'
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    provider: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M2', 'abab6.5s-chat'],
    websiteUrl: 'https://platform.minimaxi.com/'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4.1', 'anthropic/claude-sonnet-4.5', 'deepseek/deepseek-chat'],
    websiteUrl: 'https://openrouter.ai/'
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    websiteUrl: 'https://console.anthropic.com/'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    websiteUrl: 'https://aistudio.google.com/'
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    models: ['qwen3:8b', 'llama3.1:8b', 'deepseek-r1:8b'],
    websiteUrl: 'https://ollama.com/'
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    provider: 'openai-compatible',
    baseUrl: '',
    models: [],
    websiteUrl: ''
  }
]

export function vendorPreset(id: string): VendorPreset {
  return VENDOR_PRESETS.find((item) => item.id === id) ?? VENDOR_PRESETS[VENDOR_PRESETS.length - 1]
}

/** 按 baseUrl 反查预设；对不上就是自定义。 */
export function matchVendorPreset(provider: ProviderId, baseUrl: string): VendorPreset {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase()
  const target = normalize(baseUrl)
  if (!target) {
    return provider === 'mock' ? vendorPreset('mock') : vendorPreset('custom')
  }
  return (
    VENDOR_PRESETS.find(
      (item) => item.provider === provider && item.baseUrl && normalize(item.baseUrl) === target
    ) ?? vendorPreset('custom')
  )
}

/** 记忆检索的默认参数；设置里可调，这里是首次启动的初值 */
export const DEFAULT_MEMORY_SETTINGS = {
  enabled: true,
  autoExtract: true,
  topK: 5,
  budgetTokens: 1200,
  // 0.55 是实测值：bge-m3 的无关句子余弦基线在 0.45~0.49（不是理论上的 0），
  // 低于这个数等于没设阈值。
  minScore: 0.55
} as const

/**
 * 对话摘要（会话滚动摘要）的出厂值。
 *
 * 与 DEFAULT_MEMORY_SETTINGS 是两套东西：那套是「按 query 检索事实」的 RAG 参数，
 * 这套是「把对话压成四段文本、无条件注入」的窗口参数。
 *
 * 40/12 按桌面聊天调：一轮只有 2 条消息，照搬 galgame 的 250 条等于永远不压缩。
 * 四段上限决定每轮注入的体积（400+600+400+1200 ≈ 2600 字符）。
 */
export const DEFAULT_SUMMARY_SETTINGS = {
  enabled: true,
  triggerCount: 40,
  windowCount: 12,
  shortTermMaxChars: 400,
  longTermMaxChars: 1200,
  userInfoMaxChars: 600,
  promisesMaxChars: 400
} as const

/** 触发阈值区间。下限 2 = 至少一问一答，再小就是每轮都压，纯烧钱 */
export const SUMMARY_TRIGGER_RANGE = { min: 2, max: 10_000 } as const

/** 保留窗口区间。0 = 压缩边界前一条原文都不留，全靠摘要接话 */
export const SUMMARY_WINDOW_RANGE = { min: 0, max: 10_000 } as const

/** 单段字符上限区间。0 = 不截断（与 MEMORY 的语义一致：填错了别崩） */
export const SUMMARY_CHARS_RANGE = { min: 0, max: 1_000_000 } as const

/** 记忆 token 预算的合法区间。没有硬上限，只有"填错了别崩"的下限。 */
export const MEMORY_BUDGET_RANGE = { min: 50, max: 200_000, step: 100 } as const

/** 单条记忆召回条数上限，防止用户填 1e9 把上下文撑爆 */
export const MEMORY_TOP_K_RANGE = { min: 1, max: 50 } as const

/** 向量 + 关键词的融合权重。向量擅长语义，关键词擅长人名/编号等专有名词 */
export const MEMORY_VECTOR_WEIGHT = 0.7
export const MEMORY_KEYWORD_WEIGHT = 0.3

/** 单条记忆最大长度（字符）。超长说明抽取跑偏了，直接截断。 */
export const MEMORY_MAX_CHARS = 300

/** embedding 模型目录（相对应用根）与模型 id */
export const MEMORY_MODEL_RELATIVE_DIR = 'models'
export const MEMORY_MODEL_ID = 'Xenova/bge-m3'
export const MEMORY_MODEL_DIMENSIONS = 1024

/** 默认上下文窗口，仅作展示与将来裁剪判断的初值 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** 上下文窗口合法区间 */
export const CONTEXT_WINDOW_RANGE = { min: 4096, max: 4_000_000 } as const

export const TEMPERATURE_RANGE = { min: 0, max: 2, step: 0.1 } as const