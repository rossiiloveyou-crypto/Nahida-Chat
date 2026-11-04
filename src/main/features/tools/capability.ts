import type { ConversationMode } from '@shared/types'
import type { ChatToolsSettings, ToolDefinition } from '@shared/tools'

/**
 * 这一轮给模型哪些工具（P1）—— 全仓**唯一**的供给判定点。
 *
 * 🔴 本文件**不判权限**（M24 / J-03）：它只回答「给不给」，不回答「能不能执行」。
 *    授权仍在 channels/toolGate.ts + tools/permission.ts 两层。
 *
 * 🔴 判定顺序：
 *    1. mode === 'agent'  → 全部工具（与改动前**逐字一致**：listDefinitions() 全量）
 *    2. mode === 'story'  → 恒空（M10：故事模式本期彻底关闭工具）
 *    3. mode === 'chat'   → 三层闸门（总开关 / 群聊开关 / 逐工具 opt-in）
 *
 * 🔴 本文件是**纯函数**：不 import electron、不读 settings、不读盘。
 *    这样探针与单测才能直接拿实参调它（P0 的教训：拿不到实参就只能靠映射推算）。
 */

export interface ToolSupplyInput {
  mode: ConversationMode
  /** 已注册的全部工具（registry.listDefinitions() 的原样输出） */
  allTools: readonly ToolDefinition[]
  /** Settings.chatTools（可能 undefined） */
  chatTools?: ChatToolsSettings
  /** 这条会话是不是渠道会话（由调用方传入，本文件不解析 id） */
  isChannel: boolean
  /** 渠道会话类型；非渠道传 undefined */
  channelChatType?: 'private' | 'group'
}

export function resolveToolSupply(input: ToolSupplyInput): ToolDefinition[] {
  const { mode, allTools } = input

  // ① agent：与改动前逐字一致 —— 原样返回 listDefinitions()。
  //    🔴 不许在这里加任何别的过滤：A-02 / S5 会盯着「是不是 3」。
  if (mode === 'agent') return allTools.slice()

  // ② story：本期恒空（M10）。
  //    用运行时字符串比较而不是字面量类型：ConversationMode 现在还没有 'story'，
  //    写字面量会直接 TS2367（此比较无意义）。P5 加值那天本函数不需再改（J-08）。
  if ((mode as string) === 'story') return []

  // ③ chat：三层闸门
  const cfg = input.chatTools
  if (cfg?.enabled !== true) return [] // 总开关关 → 与改动前一致

  // 群聊：还要过群聊开关（M02 默认开启 = 缺省 undefined 视为开）
  if (input.isChannel && input.channelChatType === 'group' && cfg.groupEnabled === false) {
    return []
  }

  // 严格 opt-in：只有显式勾了的工具才放行（M01）。不写「未声明即放行」的兜底。
  const allow = cfg.tools ?? {}
  return allTools.filter((tool) => allow[tool.name] === true)
}
