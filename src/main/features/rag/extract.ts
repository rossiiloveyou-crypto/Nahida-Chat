import { MEMORY_MAX_CHARS } from '@shared/constants'
import type { LlmMessage, LlmProvider } from '../llm'
import type { Settings } from '@shared/types'

/**
 * 记忆抽取：一轮对话结束后，判断用户这句话里有没有值得长期记住的事实。
 *
 * 为什么不用「把对话全部 chunk 入库」：那样库里 90% 是寒暄和废话，
 * 召回时噪声会挤掉真正有用的信息，而且入库成本随对话轮数线性增长。
 *
 * 为什么只从用户消息抽：模型回复里可能有工具返回值、网页内容、文件内容，
 * 那些是攻击者可控的输入。把它们的摘要写进长期记忆 = 持久化提示词注入。
 * 这是安全设计，不是省事。
 */

const EXTRACT_SYSTEM = [
  '你是一个记忆提炼器。判断用户这句话里有没有值得长期记住的稳定事实。',
  '',
  '值得记住的：姓名/称呼、居住地、职业、长期偏好、重要计划、明确说"记住"的内容。',
  '不值得记住的：寒暄、一次性的临时问题、对模型本身的评价、情绪宣泄、追问。',
  '',
  '严格输出 JSON，不要任何解释文字：',
  '{"memories":["一句话事实"]}',
  '没有值得记的就输出：{"memories":[]}',
  '',
  '规则：',
  '- 每条记忆是一句完整的中文陈述，主语用"用户"。',
  '- 一条只讲一件事，不超过 60 字。',
  '- 不要编造用户没说的内容。',
  '- 不要记录情绪状态、临时任务、对 AI 的指令。',
  '- 最多输出 3 条。'
].join('\n')

/** 从模型回复里解析出记忆条目，解析失败一律当空——宁可漏记，不要记错 */
export function parseExtractResult(text: string): string[] {
  if (!text) return []
  // 模型偶尔会包一层 ```json
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { memories?: unknown }
    if (!Array.isArray(parsed.memories)) return []
    return parsed.memories
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().replace(/\s+/g, ' '))
      .filter((item) => item.length >= 4 && item.length <= MEMORY_MAX_CHARS)
      .slice(0, 3)
  } catch {
    return []
  }
}

/**
 * 调一次模型做抽取。
 * 用主对话的 provider，但只发最短的上下文——这是一次后台小请求，
 * 不能为了记忆而把整段对话再发一遍（成本会翻倍）。
 */
export async function extractMemories(
  userText: string,
  provider: LlmProvider,
  settings: Settings,
  signal: AbortSignal
): Promise<string[]> {
  const messages: LlmMessage[] = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: '用户刚说：' + userText.slice(0, 2000) }
  ]

  let raw = ''
  try {
    for await (const event of provider.stream({ messages, settings, signal, tools: [] })) {
      if (event.type === 'text') raw += event.text
      // 抽取阶段绝不允许工具调用：一旦模型在这里调工具，等于绕过了审批闸
      if (event.type === 'finish') break
    }
  } catch {
    return []
  }
  return parseExtractResult(raw)
}
