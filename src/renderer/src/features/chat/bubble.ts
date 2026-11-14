/**
 * 一条助手消息在气泡里该长什么样（用户 2026-11-14）。
 *
 * 起因：请求失败后气泡停在「三个点」的打字动画上，既没说为什么没回，也没有重试键，
 * 用户只能再发一条消息把它顶下去。这里把「该显示什么」抽成纯函数，
 * 它不影响取数、不写状态，所以能脱离 React 单独测。
 *
 * 三种形态：
 *  - text   正常文字（有内容就显示内容）
 *  - typing 真的还在流式生成（只有这一条是「活」的时候才是）
 *  - failed 这一轮结束了但没拿到内容：失败 / 中断 / 空回复
 */
import type { Message } from '@shared/types'

export type BubblePhase = 'text' | 'typing' | 'failed'

export interface BubbleView {
  phase: BubblePhase
  /** 只有 failed 时有值：气泡里那句说明 */
  note: string
  /** 能不能重试（只有这一轮**最后一条**才能重跑） */
  canRetry: boolean
  /** 能不能删掉（fail 的都能删；正在生成的不行） */
  canRemove: boolean
}

/** 没有原因可用时的兜底文案（主进程一般会带原因，见 chatService 的 catch） */
export const FAILED_FALLBACK = '这一轮没有拿到回复。'
/** 半路断掉（应用退出 / 崩溃 / 主进程被杀） */
export const INTERRUPTED_FALLBACK = '这一轮没有跑完，断在了半路。'
/** 跑完了但什么都没有：用户点了停止，或者模型真的没说话 */
export const EMPTY_FALLBACK = '这一轮没有内容（可能被停止，或者模型什么都没说）。'

/**
 * @param message 目标消息
 * @param ctx.isLive 这条消息此刻是不是**正在**流式生成（会话在生成 + 就是这一条）
 * @param ctx.isTail 是不是本会话的最后一条（只有它能重试）
 */
export function bubbleViewOf(
  message: Message,
  ctx: { isLive: boolean; isTail: boolean }
): BubbleView {
  const hasText = message.content.trim().length > 0
  if (ctx.isLive) {
    return { phase: hasText ? 'text' : 'typing', note: '', canRetry: false, canRemove: false }
  }

  if (message.status === 'error') {
    return {
      phase: 'failed',
      note: (message.error ?? '').trim() || FAILED_FALLBACK,
      canRetry: ctx.isTail,
      canRemove: true
    }
  }

  // 状态还写着 streaming，却不是「活」的那一条 = 上次没跑完就被留在了盘里。
  // 不这么判的话，重启后它永远在转圈（settleInterrupted 会改写盘里的值，这里是界面兜底）。
  if (message.status === 'streaming') {
    return { phase: 'failed', note: INTERRUPTED_FALLBACK, canRetry: ctx.isTail, canRemove: true }
  }

  // done 但没内容：用户点了停止，或者模型什么都没返回。
  // 只剩工具调用时不算「没内容」—— 工具卡自己会说话，不该再叠一句红字。
  if (!hasText) {
    if (message.toolCalls && message.toolCalls.length > 0) {
      return { phase: 'text', note: '', canRetry: false, canRemove: false }
    }
    return { phase: 'failed', note: EMPTY_FALLBACK, canRetry: ctx.isTail, canRemove: true }
  }

  return { phase: 'text', note: '', canRetry: false, canRemove: false }
}

/** 失败态一律用同一套样式：说明 + 两个按钮，颜色不表达「严重程度」 */
export function bubbleClassOf(phase: BubblePhase): string {
  return phase === 'failed' ? 'bubble bubble--failed' : 'bubble'
}
