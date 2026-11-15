/**
 * 驱动一轮生成（P4 §1 第 5 行）。
 *
 * 一轮 = `ensure → 就绪巡检 → 清场 → 注入 → Connect → generate → harvest → finally 再清场`。
 * 这个顺序**不能重排**，每一格都有一条实测踩出来的理由：
 * - 巡检在前：`getContext` 少字段时后面全是假绿（停止条件 1）。
 * - 清场在注入前：上一轮的残留会让模型看到两倍历史（M2）。
 * - Connect 在 generate 前：不点则 `generate` 静默 `resolve(undefined)`（P0 §三 第 4 条）。
 * - 清场在 **finally**：失败/超时/取消都必须清，否则下一轮从一开始就是脏的。
 *
 * 🔴 成败**只认** `await ctx.generate('normal')` 的 resolve / reject（J-03）：
 *    `generation_ended` 有 DOM 守卫，会静默丢失；resolve 空串按失败处理（不许把空回复写进分支）。
 * 🔴 串行：ST 只有一个页面、一份 chat，两个分支同时跑必然串味。M7 已拍板「串行可接受」，
 *    所以这里用**全局单链**排队；`minIntervalMs` 只负责同会话的轮间间隔。
 */

import { BRIDGE_DEFAULT_CONFIG, BRIDGE_EVENT } from '@shared/bridge'
import type { BridgeConfig, BridgeTurnInput, BridgeTurnResult, BridgeTurnStatus } from '@shared/bridge'
import { bridgeHost } from './host'
import type { BridgePage, BridgePageEvent } from './host'
import {
  assertExposure,
  EVAL_LABEL,
  injectChat,
  injectSystemPrompts,
  muteSwitches,
  resetSession,
  restoreSwitches
} from './session'
import type { BridgeSwitchState, SessionSnapshot } from './session'
import { mapMessages } from './mapper'
import type { MapOptions, MapDropped } from './mapper'

/** 生成结果（页面侧返回的形状） */
export interface GenerateOutcome {
  ok: boolean
  timeout: boolean
  ms: number
  value: string
  chatAfter: number
  lastMes: string
  toasts: string[]
  error: string | null
}

/** 宿主的最小接口面（真宿主是 BridgeHost；单测里换成假宿主，别的代码不动） */
export interface BridgeGateway {
  ensure(): Promise<BridgePage>
  onEvent(listener: (event: BridgePageEvent) => void): () => void
}

export interface BridgeDriverDeps {
  gateway: BridgeGateway
  config?: Partial<BridgeConfig>
  /** 注入的时间源（单测可替换，别用 jest 那套假时钟） */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/** 一次调用的入参：`BridgeTurnInput` + 可选的取消与流式回调 */
export interface BridgeRunInput extends BridgeTurnInput {
  /** 中途取消（P5 的「停止」按钮会传它） */
  signal?: AbortSignal
  /** 逐字增量（P6 转成 `IPC.chatDelta`）；桥接内部只保证「有就回调」 */
  onToken?: (text: string) => void
  /** 映射选项（发言人名等）。缺省即可 */
  map?: MapOptions
  /**
   * NC 的 system 段（人格 / 时间 / RAG 事实 / 摘要），P6 起由调用方给。
   *
   * 🔴 它**不进 chat**（mapper 会把 system 丢掉），而是灌进 ST 的 extensionPrompt：
   *    那是 ST 自己的「材料注入」通道。不传 = 这一轮不注入人格（P4/P5 的逐字行为）。
   */
  systemPrompts?: string[]
}

/**
 * 这一轮到底发生了什么（**排障与单测用**，不进 `BridgeTurnResult`）。
 * 🔴 与结果分开的理由：结果是契约（五个字段），轨迹是证据（想加就加）。混在一起会让
 *    P5/P6 的消费者被迫依赖一堆它们不关心的字段。
 */
export interface BridgeTurnTrace {
  steps: string[]
  clearedBefore: SessionSnapshot | null
  clearedAfter: SessionSnapshot | null
  /** 清场前后 characters 是否一致（J-02：误用 resetChatState 会让它变） */
  charactersKept: boolean
  injected: number
  dropped: MapDropped
  /** 收到的 `stream_token_received` 条数 */
  tokens: number
  /** 生成耗时（页面侧 performance.now） */
  genMs: number
  /** 整轮耗时（含清场/注入/重建） */
  totalMs: number
  lastMes: string
  toasts: string[]
  /** 被临时压制的开关（P5 §1 第 1/2 行；空 = 这一轮没动过） */
  switchesMuted: string[]
  /** 开关的原始形态（还原依据；空数组 = 页面没有 powerUserSettings） */
  switches: BridgeSwitchState[]
  /** 开关是否**确认**还原回原值（没有开关要还原时为 true） */
  switchesRestored: boolean
  /** 这一轮带出的人话告警（与 result.warnings 同源） */
  warnings: string[]
  /** 成功写进 extensionPrompt 的段数（P6；0 = 这一轮没注入 system 段） */
  promptsWritten: number
}

export interface BridgeTurnDetail {
  result: BridgeTurnResult
  trace: BridgeTurnTrace
}

/**
 * 生成表达式。
 *
 * 🔴 三件事必须都在页面里做，拿回主进程做就晚了：
 * 1. 超时 → `stopGeneration()`（不 stop 的话 ST 还在跑，下一轮必然冲突）；
 * 2. 流式订阅 → `window.ncEmit`（preload 的唯一出口）；
 * 3. 失败文案 → 页面 toast（ST 把「模型不可用」这类原因写在 toastr 里，不在 reject 的 message 上）。
 */
export function generateExpr(timeoutMs: number): string {
  return [
    '(async () => {',
    '    const ctx = SillyTavern.getContext();',
    '    const timeoutMs = ' + Number(timeoutMs) + ';',
    '    const t0 = performance.now();',
    '    const toastText = () => {',
    '        try {',
    '            return Array.from(document.querySelectorAll(".toast-message, .toast-body"))',
    '                .map(el => String(el.textContent || "").trim())',
    '                .filter(Boolean)',
    '                .slice(-5);',
    '        } catch (error) { return []; }',
    '    };',
    '    let timer = null;',
    '    let unsub = null;',
    '    try {',
    '        const et = ctx.eventTypes && ctx.eventTypes.STREAM_TOKEN_RECEIVED;',
    '        if (et && ctx.eventSource && typeof window.ncEmit === "function") {',
    '            const onToken = (text) => { try { window.ncEmit(' + JSON.stringify(BRIDGE_EVENT.streamToken) + ', { text: String(text == null ? "" : text) }); } catch (error) { /* 事件通道断掉不影响生成 */ } };',
    '            ctx.eventSource.on(et, onToken);',
    '            unsub = () => { try { ctx.eventSource.removeListener(et, onToken); } catch (error) { /* ignore */ } };',
    '        }',
    '    } catch (error) { /* 旧版 ST 没有这个事件：流式退化成整段返回，不影响成败判定 */ }',
    '    const timeoutPromise = new Promise((_resolve, reject) => {',
    '        timer = setTimeout(() => {',
    '            const error = new Error("BRIDGE_TIMEOUT");',
    '            error.__bridgeTimeout = true;',
    '            reject(error);',
    '        }, timeoutMs);',
    '    });',
    '    try {',
    '        const raw = await Promise.race([Promise.resolve().then(() => ctx.generate("normal")), timeoutPromise]);',
    '        const value = typeof raw === "string" ? raw : (raw === undefined || raw === null ? "" : String(raw));',
    '        return {',
    '            ok: true,',
    '            timeout: false,',
    '            ms: Math.round(performance.now() - t0),',
    '            value,',
    '            chatAfter: ctx.chat.length,',
    '            lastMes: ctx.chat.length ? String(ctx.chat[ctx.chat.length - 1].mes || "") : "",',
    '            toasts: toastText(),',
    '            error: null,',
    '        };',
    '    } catch (error) {',
    '        const isTimeout = !!(error && error.__bridgeTimeout);',
    '        if (isTimeout) { try { ctx.stopGeneration(); } catch (ignored) { /* ignore */ } }',
    '        return {',
    '            ok: false,',
    '            timeout: isTimeout,',
    '            ms: Math.round(performance.now() - t0),',
    '            value: "",',
    '            chatAfter: ctx.chat.length,',
    '            lastMes: ctx.chat.length ? String(ctx.chat[ctx.chat.length - 1].mes || "") : "",',
    '            toasts: toastText(),',
    '            error: isTimeout ? "timeout" : String(error && error.message ? error.message : error),',
    '        };',
    '    } finally {',
    '        if (timer) { clearTimeout(timer); }',
    '        if (unsub) { unsub(); }',
    '    }',
    '})()'
  ].join('\n')
}

/** 取消：只调 `stopGeneration`，让进行中的 generate 自己结束（不在这里 destroy） */
export const STOP_EXPR = [
  '(() => {',
  '    try {',
  '        SillyTavern.getContext().stopGeneration();',
  '        return true;',
  '    } catch (error) { return false; }',
  '})()'
].join('\n')

export class BridgeDriver {
  private readonly gateway: BridgeGateway
  readonly config: BridgeConfig
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (message: string) => void
  /** 全局单链：ST 只有一个页面，跨分支并发必然串味 */
  private chain: Promise<void> = Promise.resolve()
  private readonly lastDoneAt = new Map<string, number>()
  private traceOfLastTurn: BridgeTurnTrace | null = null

  constructor(deps: BridgeDriverDeps) {
    this.gateway = deps.gateway
    this.config = { ...BRIDGE_DEFAULT_CONFIG, ...(deps.config ?? {}) }
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.log = deps.log ?? (() => {})
  }

  /** 上一轮的轨迹（排障用；没有轮次时为 null） */
  lastTurnTrace(): BridgeTurnTrace | null {
    return this.traceOfLastTurn
  }

  /** 跑一轮；对外只给契约里的五个字段 */
  async run(input: BridgeRunInput): Promise<BridgeTurnResult> {
    return (await this.runTurn(input)).result
  }

  /** 跑一轮并同时交出轨迹（单测与探针用） */
  async runTurn(input: BridgeRunInput): Promise<BridgeTurnDetail> {
    const startedAt = this.now()
    const trace: BridgeTurnTrace = {
      steps: [],
      clearedBefore: null,
      clearedAfter: null,
      charactersKept: false,
      injected: 0,
      dropped: { system: 0, tool: 0, empty: 0 },
      tokens: 0,
      genMs: 0,
      totalMs: 0,
      lastMes: '',
      toasts: [],
      switchesMuted: [],
      switches: [],
      switchesRestored: true,
      warnings: [],
      promptsWritten: 0
    }

    const mapped = mapMessages(Array.isArray(input.messages) ? input.messages : [], input.map)
    trace.dropped = mapped.dropped
    trace.injected = mapped.chat.length

    if (mapped.chat.length === 0) {
      const result = fail('没有可注入的历史（system / tool / 空正文被全部丢掉）', 0)
      trace.totalMs = this.now() - startedAt
      this.traceOfLastTurn = trace
      return { result, trace }
    }

    /**
     * 这一轮的人话告警（开关被压制 / 页面提示被并入 / 还原失败）。
     * 🔴 它是**同一个数组引用**：各条 return 分支把它原样挂进 result，finally 里后追加的
     *    「还原失败」也就在其中 —— 调用方拿到 result 时 finally 已跑完，看到的是最终清单。
     *    若在这里 slice 一份，finally 阶段的告警就永远送不出去（这是一条实测踩过的坑）。
     */
    const warnings: string[] = []

    const release = await this.acquire(input.sessionId)
    const offToken = this.gateway.onEvent((event) => {
      if (event.name !== BRIDGE_EVENT.streamToken) return
      trace.tokens += 1
      const payload = event.payload as { text?: unknown } | null
      const text = payload && typeof payload.text === 'string' ? payload.text : ''
      if (!text) return
      try {
        input.onToken?.(text)
      } catch (error) {
        this.log('onToken 回调抛错（已吞掉）：' + messageOf(error))
      }
    })

    let page: BridgePage | null = null
    try {
      page = await this.gateway.ensure()
      trace.steps.push('ensure')

      // 停止条件 1：暴露面缺字段 → 后面所有判据都不可信
      await assertExposure(page)
      trace.steps.push('exposure')

      // 进入先清（M2）
      trace.clearedBefore = await resetSession(page)
      trace.steps.push('clear:before')

      // P5 §1 第 1/2 行：压住 auto_continue / auto_swipe，免得 ST 自己续写/重掷与这一轮抢同一个 chat
      const switches = await muteSwitches(page)
      trace.switches = switches.items
      trace.switchesMuted = switches.muted.slice()
      trace.steps.push('switch:mute')
      if (switches.missingRoot) {
        warnings.push('ST 页面没有 powerUserSettings，本轮无法临时关闭 auto_continue / auto_swipe')
      } else {
        if (switches.muted.includes('auto_continue')) {
          warnings.push('auto_continue 已开启，本轮临时关闭（结束立即还原）')
        }
        if (switches.muted.includes('auto_swipe')) {
          warnings.push('auto_swipe 已开启，本轮临时关闭（结束立即还原）')
        }
      }

      // P6：NC 的 system 段灌进 ST 的 extensionPrompt（人格 / 时间 / 记忆 / 摘要）。
      // 🔴 顺序敏感：必须在 chat 注入**之前** —— ST 在 generate 时才组装 prompt，
      //    但 extensionPrompts 与 chat 是两份独立存储，先写哪份都不影响正确性；
      //    放在前面是为了让失败点更早暴露（人格进不去，后面的生成就没有意义）。
      if (Array.isArray(input.systemPrompts) && input.systemPrompts.length > 0) {
        const prompts = await injectSystemPrompts(page, input.systemPrompts)
        trace.promptsWritten = prompts.written
        trace.steps.push('prompt:inject')
        if (!prompts.ok) {
          warnings.push(
            'NC 的 ' + String(input.systemPrompts.length) + ' 段系统提示只写进 ' + String(prompts.written) + ' 段' +
              (prompts.error ? '（' + prompts.error + '）' : '')
          )
        }
      }

      const injection = await injectChat(page, mapped.chat)
      trace.steps.push('inject')
      if (!injection.equal || !injection.flagsEqual) {
        const result = fail(
          '历史注入自检失败：' +
            (injection.equal ? '' : 'mes 不一致') +
            (injection.equal ? '' : '；') +
            (injection.flagsEqual ? '' : 'is_user/is_system 映射不一致'),
          0,
          warnings
        )
        return { result, trace }
      }

      const generated = await this.generate(page, input, trace)
      trace.genMs = generated.ms
      trace.lastMes = generated.lastMes
      trace.toasts = generated.toasts

      if (input.signal?.aborted) {
        return {
          result: { status: 'aborted', content: '', raw: '', error: null, ms: generated.ms, warnings },
          trace
        }
      }
      if (!generated.ok) {
        const reason = generated.timeout
          ? '生成超时（' + this.config.generateTimeoutMs + 'ms）'
          : '生成失败：' + (generated.error ?? '未知原因')
        const withToast = generated.toasts.length > 0 ? reason + '；页面提示：' + generated.toasts.join(' / ') : reason
        return { result: fail(withToast, generated.ms, warnings), trace }
      }

      const raw = typeof generated.value === 'string' ? generated.value : ''
      // 🔴 P5 缺口 0（依据 J-03）：以 resolve 为准，**trim 后为空**同样不算成功。
      //    位置很关键：必须在 resolve 分支**之后**判，不能被落成「reject 分支的一部分」。
      if (raw.trim() === '') {
        // 空回复写进分支比报错更糟（用户会以为模型哑了）
        const extra = generated.toasts.length > 0 ? '；页面提示：' + generated.toasts.join(' / ') : ''
        const hole = raw.length === 0 ? '空串' : '全空白（' + raw.length + ' 个空白字符）'
        return { result: fail('ST 返回空回复（可能被渠道截断或审查）：' + hole + extra, generated.ms, warnings), trace }
      }

      return {
        result: { status: 'done', content: raw, raw, error: null, ms: generated.ms, warnings },
        trace
      }
    } catch (error) {
      return { result: fail(messageOf(error), trace.genMs, warnings), trace }
    } finally {
      // 🔴 顺序敏感（蓝图 §1 第 4 行）：**先还原开关 → 再 reset 会话**。
      //    反了的话，还原动作会落在已被清空的会话域上（页面侧上下文可能已被重建，写入丢失）。
      // 只有**真的被关掉的**开关才需要还原：before 本来就是 false 的键，mute 写回去还是 false，
      // 为一轮「没动过任何开关」的调用多跑一次页面表达式是白费（也拖慢每轮 800ms 的间隔预算）。
      if (page && trace.switchesMuted.length > 0) {
        const restore = await restoreSwitches(page, trace.switches)
        trace.switchesRestored = restore.restored === true
        trace.steps.push('switch:restore')
        if (!restore.restored) {
          warnings.push('auto_continue / auto_swipe 还原失败：' + String(restore.error ?? '未知原因'))
        }
      }
      if (page) {
        try {
          trace.clearedAfter = await resetSession(page)
          trace.steps.push('clear:after')
          const before = trace.clearedBefore?.characters
          trace.charactersKept = typeof before === 'number' && trace.clearedAfter.characters === before
        } catch (error) {
          // 清场失败不能掩盖这一轮的真实结果，但必须留下痕迹
          this.log('退出清场失败：' + messageOf(error))
        }
      }
      offToken()
      release()
      trace.totalMs = this.now() - startedAt
      trace.warnings = warnings.slice()
      this.traceOfLastTurn = { ...trace, steps: trace.steps.slice() }
    }
  }

  /** 取消当前轮（P5 的「停止」）。真正的结束由进行中的 generate 自己完成 */
  async stop(): Promise<boolean> {
    try {
      const page = await this.gateway.ensure()
      return (await page.eval<boolean>(STOP_EXPR, 'stop')) === true
    } catch {
      return false
    }
  }

  private async generate(
    page: BridgePage,
    input: BridgeRunInput,
    trace: BridgeTurnTrace
  ): Promise<GenerateOutcome> {
    const running = page.eval<GenerateOutcome>(generateExpr(this.config.generateTimeoutMs), EVAL_LABEL.generate)
    trace.steps.push('generate')
    const signal = input.signal
    if (!signal) return running

    const onAbort = (): void => {
      trace.steps.push('abort')
      void page.eval<boolean>(STOP_EXPR, 'stop').catch(() => false)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await running
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 排队：全局单链 + 同会话轮间最小间隔。
   * 返回的 release 必须由调用方在 finally 里调 —— 漏了会把后续所有轮次卡死。
   */
  private async acquire(sessionId: string): Promise<() => void> {
    const previous = this.chain
    let releaseGate: () => void = () => {}
    this.chain = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    await previous

    const last = this.lastDoneAt.get(sessionId) ?? 0
    const waitMs = this.config.minIntervalMs - (this.now() - last)
    if (waitMs > 0) {
      this.log('同会话间隔等待 ' + waitMs + 'ms');
      await this.sleep(waitMs)
    }

    return () => {
      this.lastDoneAt.set(sessionId, this.now())
      releaseGate()
    }
  }
}

function fail(error: string, ms: number, warnings: string[] = []): BridgeTurnResult {
  const status: BridgeTurnStatus = 'error'
  // 🔴 不复制 warnings：要与 finally 阶段的追加共享同一个引用（见 runTurn 里的注释）
  return { status, content: '', raw: '', error, ms, warnings }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 单例：P6 接线后 `chatService` 直接用它（本 Phase 不接） */
export const bridgeDriver = new BridgeDriver({ gateway: bridgeHost })
