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
 * P4: generate resolve is prerequisite; stable JSONL with exact counts is the success authority.
 *    generation_ended is diagnostic only; persisted empty/non-assistant replies are hard failures.
 * 🔴 串行：ST 只有一个页面、一份 chat，两个分支同时跑必然串味。M7 已拍板「串行可接受」，
 *    所以这里用**全局单链**排队；`minIntervalMs` 只负责同会话的轮间间隔。
 */

import { BRIDGE_DEFAULT_CONFIG, BRIDGE_EVENT, BridgeFailure, bridgeFailure, isPageUnavailable } from '@shared/bridge'
import type { BridgeFailureStep, BridgePrepareBudget, BridgeBudgetTrace } from '@shared/bridge'
export type { BridgeBudgetSource, BridgeBudgetPrepared, BridgePrepareBudget } from '@shared/bridge'
import type { BridgeConfig, BridgeTurnInput, BridgeTurnResult, BridgeTurnStatus } from '@shared/bridge'
import { bridgeHost } from './host'
import { chatDisk, chatName } from './chats'
import type { ChatDisk, ChatTarget } from './chats'
import { prepareChat, restoreChat, drainChatSaves } from './session'
import type { BridgeTraceDisk } from './trace'
import { appendBridgeTrace } from './trace'
import type { BridgeTraceRecord } from './trace'
import type { BridgePage, BridgePageEvent } from './host'
import {
  assertExposure,
  EVAL_LABEL,
  injectChat,
  injectSystemPrompts,
  muteSwitches,
  resetSession,
  readBudgetSource,
  restoreSwitches
} from './session'
import type { BridgeSwitchState, SessionSnapshot } from './session'
import { mapMessages } from './mapper'
import { assertCharacter } from './character'
import { getOverride } from './override'
import { estimateBridgeTokens } from './budget'
import type { BridgeOverrideState } from '@shared/bridge'
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
  assertAvailable?(): void
  recover?(): Promise<BridgePage>
  recoverySucceeded?(): void
  recoveryFailed?(error: unknown): void
  noteFailure?(step: BridgeFailureStep): void
  onEvent(listener: (event: BridgePageEvent) => void): () => void
}

export interface BridgeDriverDeps {
  gateway: BridgeGateway
  disk?: ChatDisk
  config?: Partial<BridgeConfig>
  /** 注入的时间源（单测可替换，别用 jest 那套假时钟） */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  writeTrace?: (record: BridgeTraceRecord) => void
  readOverride?: () => BridgeOverrideState
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
  /** 在就绪后、任何清场或磁盘操作前执行预算准备。 */
  prepareBudget?: BridgePrepareBudget
}

/**
 * 这一轮到底发生了什么（**排障与单测用**，不进 `BridgeTurnResult`）。
 * 🔴 与结果分开的理由：结果是契约（五个字段），轨迹是证据（想加就加）。混在一起会让
 *    P5/P6 的消费者被迫依赖一堆它们不关心的字段。
 */
export interface BridgeTurnTrace extends BridgeBudgetTrace {
  disk?: BridgeTraceDisk
  historyBefore: number
  historySent: number
  historyInChat: number
  historyInPrompt: number
  steps: string[]
  failures?: Array<{ step: BridgeFailureStep; detail: string }>
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

export function overrideExpr(text: string): string {
  return [
    '(() => {',
    '  const ctx = SillyTavern.getContext();',
    '  const text = ' + JSON.stringify(text) + ';',
    '  if (!text.trim()) return false;',
    '  ctx.setExtensionPrompt("nc-bridge:override", text, 1, 0);',
    '  const prompt = ctx.extensionPrompts["nc-bridge:override"];',
    '  if (!prompt || prompt.value !== text || prompt.position !== 1 || prompt.depth !== 0 || prompt.role !== 0) throw new Error("最高权重规则注入自检失败");',
    '  return true;',
    '})()'
  ].join('\n')
}

export class BridgeDriver {
  private readonly disk: ChatDisk
  private readonly gateway: BridgeGateway
  readonly config: BridgeConfig
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (message: string) => void
  private readonly writeTrace: (record: BridgeTraceRecord) => void
  private readonly readOverride: () => BridgeOverrideState
  /** 全局单链：ST 只有一个页面，跨分支并发必然串味 */
  private chain: Promise<void> = Promise.resolve()
  private readonly lastDoneAt = new Map<string, number>()
  private traceOfLastTurn: BridgeTurnTrace | null = null

  constructor(deps: BridgeDriverDeps) {
    this.gateway = deps.gateway
    this.disk = deps.disk ?? chatDisk
    this.config = { ...BRIDGE_DEFAULT_CONFIG, ...(deps.config ?? {}) }
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.log = deps.log ?? (() => {})
    this.writeTrace = deps.writeTrace ?? appendBridgeTrace
    this.readOverride = deps.readOverride ?? (() => getOverride())
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
    // An open circuit must fail without waiting behind another turn or its interval.
    try { this.gateway.assertAvailable?.() } catch {
      const rejected = await this.attempt(input)
      this.persistTrace(input, rejected.trace, rejected.result.warnings)
      rejected.trace.warnings = rejected.result.warnings.slice()
      this.traceOfLastTurn = rejected.trace
      return rejected
    }
    // One gate covers both attempts and their cleanup. No other branch can enter between them.
    const release = await this.acquire(input.sessionId)
    let detail: BridgeTurnDetail | undefined
    let previousSteps: string[] = []
    try {
      detail = await this.attempt(input)
      if (detail.trace.steps.includes('fail:crash') && !detail.trace.steps.includes('fail:delete') && !detail.trace.steps.includes('fail:cleanup') && !input.signal?.aborted && this.gateway.recover) {
        const firstSteps = detail.trace.steps.slice()
        const firstFailures = detail.trace.failures?.slice() ?? []
        try {
          await this.gateway.recover()
          detail = await this.attempt(input)
          previousSteps = [...firstSteps, 'retry:1']
          detail.trace.failures = [...firstFailures, ...(detail.trace.failures ?? [])]
          if (detail.trace.steps.includes('fail:crash')) this.gateway.recoveryFailed?.(detail.result.error ?? 'ST 页面崩溃')
        } catch (error) {
          this.gateway.recoveryFailed?.(error)
          const failure = this.failure(error, detail.trace, 'ensure')
          detail.result = fail(failure.message, detail.trace.genMs, detail.result.warnings)
          detail.trace.steps.push('retry:1')
        }
      }
      // Cleanup errors are terminal too: never publish a reply before finally has finished.
      if (detail.result.status === 'done' && detail.trace.steps.some(step => step === 'fail:delete' || step === 'fail:cleanup' || step === 'fail:crash')) {
        const failure = this.failure(new BridgeFailure('fail:delete', 'ST 本轮收尾未完成，请重新打开 ST 清理并查看日志'), detail.trace)
        detail.result = fail(failure.message, detail.trace.genMs, detail.result.warnings)
      }
      if (previousSteps.length) detail.trace.steps.unshift(...previousSteps)
      if (detail.result.status === 'done') {
        this.gateway.recoverySucceeded?.()
        try { input.onToken?.(detail.result.raw) } catch (error) { this.log('onToken 回调抛错：' + messageOf(error)) }
      }
      return detail
    } finally {
      release()
      if (detail) {
        detail.trace.warnings = detail.result.warnings.slice()
        this.persistTrace(input, detail.trace, detail.result.warnings)
        detail.trace.warnings = detail.result.warnings.slice()
        this.traceOfLastTurn = { ...detail.trace, steps: detail.trace.steps.slice() }
      }
    }
  }

  private async attempt(input: BridgeRunInput): Promise<BridgeTurnDetail> {
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
      promptsWritten: 0,
      historyBefore: input.historyBefore ?? input.messages.length,
      historySent: 0,
      historyDropped: 0,
      historyInChat: 0,
      historyInPrompt: 0
    }

    let mapped = mapMessages(Array.isArray(input.messages) ? input.messages : [], input.map)
    let systemPrompts = input.systemPrompts
    trace.dropped = mapped.dropped
    trace.injected = mapped.chat.length

    if (mapped.chat.length === 0) {
      const result = fail('没有可注入的历史（system / tool / 空正文被全部丢掉）', 0)
      trace.totalMs = this.now() - startedAt
      this.traceOfLastTurn = trace
      trace.steps.push('fail:inject')
      this.gateway.noteFailure?.('fail:inject')
      return { result, trace }
    }

    /**
     * 这一轮的人话告警（开关被压制 / 页面提示被并入 / 还原失败）。
     * 🔴 它是**同一个数组引用**：各条 return 分支把它原样挂进 result，finally 里后追加的
     *    「还原失败」也就在其中 —— 调用方拿到 result 时 finally 已跑完，看到的是最终清单。
     *    若在这里 slice 一份，finally 阶段的告警就永远送不出去（这是一条实测踩过的坑）。
     */
    const warnings: string[] = []

    let pageFailure: unknown
    let rejectPage: (error: unknown) => void = () => {}
    const unavailable = new Promise<never>((_resolve, reject) => { rejectPage = reject })
    // Attach immediately; a crash can arrive during ensure, before any eval is raced.
    void unavailable.catch(() => {})
    const offToken = this.gateway.onEvent((event) => {
      if (event.name === 'bridge:page-unavailable') {
        pageFailure = new BridgeFailure('fail:crash', 'ST 页面崩溃，正在自动重启')
        rejectPage(pageFailure)
        return
      }
      if (event.name !== BRIDGE_EVENT.streamToken) return
      trace.tokens += 1
      const payload = event.payload as { text?: unknown } | null
      const text = payload && typeof payload.text === 'string' ? payload.text : ''
      if (!text) return
      try {
        // Tokens are diagnostic only until the persisted assistant is validated (M20).
      } catch (error) {
        this.log('onToken 回调抛错（已吞掉）：' + messageOf(error))
      }
    })

    let page: BridgePage | null = null
    let target: ChatTarget | null = null
    let prepared = false
    let backupsBefore: string[] = []
    let dataDir = ''
    let stage = 'ensure'
    let budgetPending = false
    try {
      this.gateway.assertAvailable?.()
      const ensured = await this.gateway.ensure()
      page = {
        alive: () => ensured.alive(),
        eval: <T>(expr: string, label?: string): Promise<T> => {
          if (pageFailure) return Promise.reject(pageFailure)
          return Promise.race([ensured.eval<T>(expr, label), unavailable])
        }
      }
      trace.steps.push('ensure')

      // 停止条件 1：暴露面缺字段 → 后面所有判据都不可信
      stage = 'exposure'
      await assertExposure(page)
      trace.steps.push('exposure')
      const cardConfig = (this.gateway as BridgeGateway & { config?: BridgeConfig }).config ?? this.config
      stage = 'character'
      await assertCharacter(page, cardConfig.cardName, cardConfig.cardAvatar)
      trace.steps.push('character:assert')

      let override: BridgeOverrideState | undefined
      // SUP-05: fail before any reset, chat mutation or disk operation.
      if (input.prepareBudget && cardConfig.budgetEnabled !== false) {
        budgetPending = true
        stage = 'budget'
        const source = await readBudgetSource(page, cardConfig)
        override = this.readOverride()
        source.fixedPromptTokens = override.active ? estimateBridgeTokens(override.text) : 0
        trace.budgetSource = source
        trace.stReserveTokens = source.stReserveTokens
        if (source.budgetTotal !== null) trace.budgetTotal = source.budgetTotal
        if (source.warning) warnings.push(source.warning)
        const budget = await input.prepareBudget(source)
        const validCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0
        if (![budget.historyDropped, budget.budgetUsed, budget.budgetTotal, budget.stReserveTokens].every(validCount) ||
            budget.budgetTotal !== source.budgetTotal || budget.stReserveTokens !== source.stReserveTokens || budget.budgetUsed > budget.budgetTotal ||
            !Array.isArray(budget.messages) || !Array.isArray(budget.systemPrompts) || budget.systemPrompts.some(text => typeof text !== 'string')) {
          throw new BridgeFailure('fail:budget', '上下文预算准备结果无效，请检查预算与已用统计')
        }
        const start = input.messages.length - budget.messages.length
        if (start < 0 || start !== budget.historyDropped || budget.messages.some((message, i) =>
          message.role !== input.messages[start + i].role || message.content !== input.messages[start + i].content)) {
          throw new BridgeFailure('fail:budget', '上下文预算裁剪结果须为逐字连续后缀')
        }
        const lastUser = input.messages.findLastIndex(message => message.role === 'user')
        if (lastUser >= 0 && lastUser < start) throw new BridgeFailure('fail:budget', '上下文预算不足，最新用户消息须保留')
        mapped = mapMessages(budget.messages, input.map)
        if (!mapped.chat.length) throw new BridgeFailure('fail:budget', '上下文预算不足，没有可注入的历史')
        systemPrompts = budget.systemPrompts
        trace.dropped = mapped.dropped
        trace.injected = mapped.chat.length
        trace.historyDropped = budget.historyDropped
        trace.budgetUsed = budget.budgetUsed
        warnings.push(...(budget.warnings ?? []))
        if (budget.historyDropped > 0) warnings.push('本轮因上下文上限省略了 ' + budget.historyDropped + ' 条更早的消息')
        trace.steps.push('budget:prepared')
        if (input.signal?.aborted) throw new Error('Budget preparation aborted')
        budgetPending = false
      }

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

      stage = 'inject'
      dataDir = cardConfig.stDataDir
      const name = chatName(input.sessionId)
      backupsBefore = await this.disk.backups(dataDir)
      prepared = true
      const selection = await prepareChat(page, name)
      target = this.disk.target(dataDir, name, selection.avatar)
      trace.disk = { injected: 0, expectedLines: 0, actualLines: 0, deleted: false, backupDelta: 0, file: target.file, waitMs: 0 }
      trace.steps.push('chat:prepare')

      // P6：NC 的 system 段灌进 ST 的 extensionPrompt（人格 / 时间 / 记忆 / 摘要）。
      // 🔴 顺序敏感：必须在 chat 注入**之前** —— ST 在 generate 时才组装 prompt，
      //    但 extensionPrompts 与 chat 是两份独立存储，先写哪份都不影响正确性；
      //    放在前面是为了让失败点更早暴露（人格进不去，后面的生成就没有意义）。
      if (Array.isArray(systemPrompts) && systemPrompts.length > 0) {
        const prompts = await injectSystemPrompts(page, systemPrompts)
        trace.promptsWritten = prompts.written
        trace.steps.push('prompt:inject')
        if (!prompts.ok) {
          throw new Error('系统提示注入自检失败：' + (prompts.error ?? '写入段数不一致'))
        }
      }

      const injection = await injectChat(page, mapped.chat)
      trace.steps.push('inject')
      // metadata 行数要读盘才知道，这里只记「注入 + 回复」的下界，成功后由 persisted 覆盖。
      if (trace.disk) { trace.disk.injected = injection.length; trace.disk.expectedLines = injection.length + 1 }
      trace.historySent = injection.length
      trace.historyInChat = injection.length
      trace.historyInPrompt = injection.inPrompt
      if (!injection.equal || !injection.flagsEqual || injection.length !== mapped.chat.length) {
        throw new Error('历史注入自检失败：mes / is_user 不一致')
      }

      override ??= this.readOverride()
      if (override.warning) warnings.push(override.warning)
      if (override.active) {
        await page.eval(overrideExpr(override.text), 'override:inject')
        trace.steps.push('override:inject')
      }
      // 生成前再读一次，用户在注入期间切卡也不能静默继续。
      await assertCharacter(page, cardConfig.cardName, cardConfig.cardAvatar)
      stage = 'generate'
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
        const failure = this.failure(withToast, trace, stage)
        // Keep harmless provider explanations; machine codes and stacks never reach UI.
        const context = !/EPERM|ENOENT|EADDRINUSE|\n\s*at |Error:|node:|\.tsx?:\d/i.test(withToast) ? withToast : ''
        return { result: fail(failure.message + (context && !generated.timeout ? '；' + context : ''), generated.ms, warnings), trace }
      }

      // ST can still resolve after TokenBudgetExceeded with only a partial system prompt.
      if (generated.toasts.some(text => /TokenBudgetExceeded|必要的提示词超过了上下文大小|Not enough free tokens|Insufficient.*token|required prompts.*(exceed|context)/i.test(text))) {
        const failure = this.failure('ST 上下文预算不足', trace, stage)
        return { result: fail(failure.message, generated.ms, warnings), trace }
      }

      if (!target) throw new Error('Missing owned chat target')
      await drainChatSaves(page)
      stage = 'disk'
      const persisted = await this.disk.wait(target, trace.historyInChat)
      trace.disk = { injected: trace.historyInChat, expectedLines: persisted.expectedLines, actualLines: persisted.actualLines, deleted: false, backupDelta: 0, file: persisted.file, waitMs: persisted.waitMs }
      trace.steps.push('chat:stable')
      const raw = persisted.content
      // 🔴 P5 缺口 0（依据 J-03）：以 resolve 为准，**trim 后为空**同样不算成功。
      //    位置很关键：必须在 resolve 分支**之后**判，不能被落成「reject 分支的一部分」。
      if (raw.trim() === '') {
        // 空回复写进分支比报错更糟（用户会以为模型哑了）
        const failure = this.failure('ST 返回空回复', trace, stage)
        const blank = raw.length ? '（全空白，原始 ' + raw.length + ' 字符）' : ''
        return { result: fail(failure.message + blank, generated.ms, warnings), trace }
      }

      return {
        result: { status: 'done', content: raw, raw, error: null, ms: generated.ms, warnings },
        trace
      }
    } catch (error) {
      if (trace.disk) {
        // 失败也要留住「判据算出的期望行数」：metadata 行数要读盘才知道，注入时只能给下界。
        const evidence = error as { actualLines?: number; expectedLines?: number }
        if (typeof evidence.actualLines === 'number') trace.disk.actualLines = evidence.actualLines
        if (typeof evidence.expectedLines === 'number') trace.disk.expectedLines = evidence.expectedLines
      }
      if (input.signal?.aborted) return { result: { status: 'aborted', content: '', raw: '', error: null, ms: trace.genMs, warnings }, trace }
      if (stage === 'budget' && error instanceof BridgeFailure && error.budget) {
        const evidence = error.budget
        if (typeof evidence.budgetUsed === 'number' && Number.isFinite(evidence.budgetUsed)) trace.budgetUsed = evidence.budgetUsed
        if (typeof evidence.historyDropped === 'number' && Number.isSafeInteger(evidence.historyDropped) && evidence.historyDropped >= 0) trace.historyDropped = evidence.historyDropped
      }
      const cause = stage === 'budget' && !(error instanceof BridgeFailure) && !isPageUnavailable(error)
        ? new BridgeFailure('fail:budget', '上下文预算准备失败：' + messageOf(error)) : error
      const failure = this.failure(cause, trace, stage)
      return { result: fail(failure.message, trace.genMs, warnings), trace }
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
          warnings.push('auto_continue / auto_swipe 还原失败，请重新打开 ST 并查看日志')
          if (!restore.ok && !isPageUnavailable(restore.error)) trace.steps.push('fail:cleanup')
          if (isPageUnavailable(restore.error)) this.failure(restore.error, trace)
        }
      }
      if (page && prepared) {
        try {
          await drainChatSaves(page)
          if (!await restoreChat(page)) throw new Error('chat name readback mismatch')
          trace.steps.push('chat:restore')
        } catch (error) {
          this.log('ST 会话名还原失败：' + messageOf(error))
          warnings.push('ST 会话名还原失败，请重新打开 ST 并查看日志')
          if (!isPageUnavailable(error)) trace.steps.push('fail:cleanup')
          if (isPageUnavailable(error)) this.failure(error, trace)
        }
      }
      if (page && !budgetPending) {
        try {
          trace.clearedAfter = await resetSession(page)
          trace.steps.push('clear:after')
          const before = trace.clearedBefore?.characters
          trace.charactersKept = typeof before === 'number' && trace.clearedAfter.characters === before
        } catch (error) {
          // 清场失败不能掩盖这一轮的真实结果，但必须留下痕迹
          this.log('退出清场失败：' + messageOf(error))
          if (!isPageUnavailable(error)) trace.steps.push('fail:cleanup')
          if (isPageUnavailable(error)) this.failure(error, trace)
        }
      }
      if (page && target) {
        try {
          const deleted = await this.disk.remove(page, target, input.sessionId)
          if (trace.disk) trace.disk.deleted = deleted
          trace.steps.push('chat:delete')
          if (!deleted) warnings.push(this.failure('本轮 chat 删除失败，已登记孤儿清单', trace).message)
        } catch (error) {
          this.log('本轮 chat 收尾失败：' + messageOf(error))
          warnings.push(this.failure(new BridgeFailure('fail:delete', '本轮 chat 删除失败，请重新打开 ST 自动清理并查看日志', messageOf(error)), trace).message)
        }
        try {
          // ST backups use a 10s leading/trailing throttle. Keep the serial gate until its observation window ends.
          if (this.disk.backupWindowMs) {
            await this.sleep(this.disk.backupWindowMs)
            await drainChatSaves(page)
            trace.clearedAfter = await resetSession(page)
            trace.steps.push('clear:settled')
          }
          const after = await this.disk.backups(dataDir)
          if (trace.disk) trace.disk.backupDelta = after.filter(file => !backupsBefore.includes(file)).length
        } catch (error) {
          this.log('备份计数或延迟清场失败：' + messageOf(error))
          warnings.push('备份计数或延迟清场失败，请查看日志')
          if (this.disk.backupWindowMs && !isPageUnavailable(error)) trace.steps.push('fail:cleanup')
          if (isPageUnavailable(error)) this.failure(error, trace)
        }
      }
      offToken()
      trace.totalMs = this.now() - startedAt
      trace.warnings = warnings.slice()
    }
  }

  private failure(error: unknown, trace: BridgeTurnTrace, stage?: string): BridgeFailure {
    const config = (this.gateway as BridgeGateway & { config?: BridgeConfig }).config ?? this.config
    const failure = bridgeFailure(error, { port: config.port, cardName: config.cardName, timeoutMs: stage === 'generate' ? config.generateTimeoutMs : config.readyTimeoutMs, stage })
    trace.steps.push(failure.step)
    ;(trace.failures ??= []).push({ step: failure.step, detail: failure.detail || messageOf(error) })
    this.gateway.noteFailure?.(failure.step)
    this.log(failure.step + '：' + (failure.detail || messageOf(error)))
    return failure
  }

  private persistTrace(input: BridgeRunInput, trace: BridgeTurnTrace, warnings = trace.warnings): void {
    try {
      const config = (this.gateway as BridgeGateway & { config?: BridgeConfig }).config ?? this.config
      this.writeTrace({
        at: new Date(this.now()).toISOString(), sessionId: input.sessionId,
        before: trace.historyBefore, sent: trace.historySent,
        inChat: trace.historyInChat, inPrompt: trace.historyInPrompt,
        promptsWritten: trace.promptsWritten, cardName: config.cardName,
        disk: trace.disk,
        historyDropped: trace.historyDropped, budgetUsed: trace.budgetUsed,
        budgetTotal: trace.budgetTotal, stReserveTokens: trace.stReserveTokens,
        budgetSource: trace.budgetSource, warnings: warnings.slice(),
        failures: trace.failures?.slice(),
        steps: trace.steps.slice()
      })
    } catch (error) {
      const detail = messageOf(error)
      const hint = /EPERM|ENOENT|EADDRINUSE|\n\s*at |Error:|node:internal/.test(detail) ? '' : '：' + detail
      warnings.push('桥接轨迹落盘失败' + hint + '，请检查日志目录权限并重试')
      this.log('桥接轨迹落盘失败：' + messageOf(error))
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