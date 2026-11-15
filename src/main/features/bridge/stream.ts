/**
 * 把桥接包成与 provider.stream() 同形状的异步生成器（P6 §1 的接缝）。
 *
 * 为什么不是「在 runStream 里写 if (story) { ...另一套收尾... }」：
 * 那会把落库、状态映射、abort、QQ 转发、超时全部复制一份，两份必然漂移
 * （漂移的第一次症状是「普通聊天好了、故事模式还是卡的」，没人会往复制品上找）。
 * 这里只替换**生成这一环**，外面那条链（工具循环、收尾、outcome）一行不改。
 *
 * 🔴 落库必须是原稿（M5）：流式增量只负责「看得见」，最终正文通过 onFinal 回交调用方，
 *    由 chatService 以它为准。两者不一致时以桥接结论为准（流式丢片不能改历史）。
 * 🔴 失败文案不许改写（F-04）：P5 已经把原因与页面 toast 拼进 result.error，这里原样抛。
 */

import type { BridgeMessage } from '@shared/bridge'
import type { BridgeRunInput, BridgeTurnDetail } from './driver'
import { bridgeDriver } from './driver'
import { bridgeStreamOutcome } from './router'

/** 跑一轮的东西（生产是 bridgeDriver.runTurn；单测换成假宿主驱动的版本） */
export type BridgeRunner = (input: BridgeRunInput) => Promise<BridgeTurnDetail>

const defaultRunner: BridgeRunner = (input) => bridgeDriver.runTurn(input)

let runner: BridgeRunner = defaultRunner

/**
 * 单测注入点（**只有测试调**，生产代码不得调用）。
 *
 * 存在的理由：A4/A5 要证明「status 三值与 warnings 真的穿过 chatService 落到了消息上」，
 * 而真 ST 在无人值守的测试里不可用。把 runner 换成假的，链路的其余部分（chatService 的
 * 收尾、sink、落库、重试）仍然是**真的**——这才是那两条判据的意义。
 * 传 null 还原。
 */
export function setBridgeRunnerForTest(next: BridgeRunner | null): void {
  runner = next ?? defaultRunner
}

export interface BridgeStreamInput {
  /** NC 会话 id（分支 id）。只用于桥接内部排队与限速，不进 ST */
  sessionId: string
  /** 已按 NC 口径裁好的历史（含本轮用户输入，最后一条应为 user） */
  messages: BridgeMessage[]
  /** NC 的 system 段（人格 / 时间 / 记忆 / 摘要）→ ST 的 extensionPrompt */
  systemPrompts?: string[]
  signal?: AbortSignal
  /** 这一轮的人话告警（P5 的 warnings）。恒以数组回调，空数组也回调一次 */
  onWarnings?: (warnings: string[]) => void
  /** 最终正文（落库原稿）。只有 done 才回调；error / aborted 不回调 */
  onFinal?: (text: string) => void
}

/**
 * 等下一次「有增量 / 跑完了」时的轮询上限。
 *
 * 🔴 为什么不只靠 notify 唤醒：「先查条件再挂唤醒」存在丢唤醒窗口 ——
 *    查完发现空 → 生成恰好在这一刻结束并 notify（此时没有等待者）→ 我们再挂上就永远不被唤醒。
 *    加一个 25ms 上限把这种情况变成「最多晚 25ms」，而不是死等。
 */
const TICK_MS = 25

export async function* bridgeStream(
  input: BridgeStreamInput
): AsyncGenerator<{ type: 'text'; text: string }> {
  const queue: string[] = []
  let emitted = ''
  let finished = false
  // 🔴 用 holder 而不是两个 `let`：TS 的控制流分析看不到「在 Promise 回调里被赋值」，
  //    会把后面读到的值窄化成 never（实测 TS2339）。一个对象字段绕开这个窄化，
  //    语义完全一样（同一个闭包里写、同一个闭包里读）。
  const done: { detail: BridgeTurnDetail | null; failure: unknown } = { detail: null, failure: null }
  let wake: (() => void) | null = null

  const notify = (): void => {
    const next = wake
    wake = null
    if (next) next()
  }
  const tick = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve
    })
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  void runner({
    sessionId: input.sessionId,
    messages: Array.isArray(input.messages) ? input.messages : [],
    ...(Array.isArray(input.systemPrompts) && input.systemPrompts.length > 0
      ? { systemPrompts: input.systemPrompts }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    onToken: (text: string) => {
      if (typeof text !== 'string' || text.length === 0) return
      queue.push(text)
      notify()
    }
  })
    .then((value) => {
      done.detail = value
    })
    .catch((error) => {
      done.failure = error
    })
    .finally(() => {
      finished = true
      notify()
    })

  while (!finished || queue.length > 0) {
    if (queue.length > 0) {
      const text = queue.shift() as string
      emitted += text
      yield { type: 'text', text }
      continue
    }
    if (finished) break
    await Promise.race([tick(), sleep(TICK_MS)])
  }

  if (done.failure) {
    // 驱动层自己抛的（窗口起不来 / 暴露面缺字段 / 注入自检失败）：原样冒给 chatService 的 catch
    throw done.failure instanceof Error ? done.failure : new Error(String(done.failure))
  }

  const result = done.detail ? done.detail.result : null
  if (!result) throw new Error('ST 桥接没有返回结果（驱动层异常退出）')

  input.onWarnings?.(Array.isArray(result.warnings) ? result.warnings.slice() : [])

  const outcome = bridgeStreamOutcome(result)
  if (outcome.kind === 'throw') throw new Error(outcome.error)
  if (outcome.kind === 'return') return

  // 没有增量（旧版 ST 没有 STREAM_TOKEN_RECEIVED，或页面把流式关掉了）：整段回一次，
  // 否则界面会一直空到 done —— 用户看到的是「顿了很久才出字」，而不是没有回复。
  if (emitted.length === 0 && outcome.text.length > 0) {
    emitted = outcome.text
    yield { type: 'text', text: outcome.text }
  }
  input.onFinal?.(outcome.text)
}
