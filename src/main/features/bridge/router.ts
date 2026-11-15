/**
 * 生成路由的兼容导出与 payload 转换（J-06）。
 * P8：纯判定已移至 shared/bridge，主进程与界面共用。
 * 🔴 顺带把「NC payload → 桥接历史 / system 段」也收在这里：P6 唯一的形状转换点。
 *    system 段**不进 chat**（那是 ST 的 extensionPrompt 的事，见 stream.ts），
 *    tool 段一律丢（M3：故事模式恒无工具）。丢弃是设计，不是 bug，所以计数在 mapper 里留账。
 */

import type { BridgeMessage, BridgeTurnResult } from '@shared/bridge'
import type { LlmMessage } from '../llm'

// P8：生成路由和界面模型锁复用同一共享纯判定。
export { bridgeEligible } from '@shared/bridge'

/**
 * NC 的模型消息 → 桥接历史。
 *
 * 只搬 user / assistant，且**逐字**搬运（不 trim、不折叠空白）：落库原稿（M5）与
 * 「模型看到的历史就是 NC 里那份」（F-04）都靠这一条。
 * 空正文不搬：runStream 里那条助手占位就是空串，搬过去 ST 会看到一条空发言。
 */
export function toBridgeMessages(payload: LlmMessage[]): BridgeMessage[] {
  const out: BridgeMessage[] = []
  for (const message of Array.isArray(payload) ? payload : []) {
    if (!message) continue
    if (message.role === 'system' || message.role === 'tool') continue
    const content = typeof message.content === 'string' ? message.content : ''
    if (content.length === 0) continue
    out.push({ role: message.role === 'user' ? 'user' : 'assistant', content })
  }
  return out
}

/**
 * NC payload 里的 system 段（人格 → 时间 → RAG 事实 → 对话摘要，顺序由 buildPayload 定）。
 *
 * 这些段**不进 chat**，而是作为 ST 的 extensionPrompt 注入 —— 那才是 ST 自己的
 * 「材料注入」通道：它会把内容放进 prompt 的正确位置，而不是伪装成一句发言。
 * 顺序原样保留（越靠后越贴近这次回答这层语义是 buildPayload 定的，这里不许重排）。
 */
export function toBridgeSystemPrompts(payload: LlmMessage[]): string[] {
  const out: string[] = []
  for (const message of Array.isArray(payload) ? payload : []) {
    if (!message || message.role !== 'system') continue
    const content = typeof message.content === 'string' ? message.content : ''
    if (content.trim().length === 0) continue
    out.push(content)
  }
  return out
}

/**
 * 桥接结论 → 生成器该怎么收场（F-04 的三值映射，纯函数）。
 *
 * - error   → 抛出去，让 chatService 现成的 catch 收成 status:'error' 并把文案**原样**透出
 *             （P5 已经带了原因 + 页面 toast，P6 不许改写一个字）
 * - aborted → 静默结束，让外层按 signal.aborted 结算（既有收尾一行不动）
 * - done    → 正文以它为准（落库原稿，M5）
 */
export type BridgeStreamOutcome =
  | { kind: 'throw'; error: string }
  | { kind: 'return' }
  | { kind: 'continue'; text: string }

export function bridgeStreamOutcome(result: BridgeTurnResult): BridgeStreamOutcome {
  if (result.status === 'error') {
    const reason = typeof result.error === 'string' ? result.error.trim() : ''
    return { kind: 'throw', error: reason || 'ST 桥接生成失败（未给出原因）' }
  }
  if (result.status === 'aborted') return { kind: 'return' }
  return { kind: 'continue', text: typeof result.content === 'string' ? result.content : '' }
}
