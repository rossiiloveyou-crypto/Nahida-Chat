import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SESSION_TITLE, MAX_TOOL_TURNS } from '@shared/constants'
import { isChannelSessionId, parseChannelKey } from '@shared/channels'
import type {
  ChatDelta,
  ChatDone,
  ChatToolUpdate,
  ConversationMode,
  CreateSessionInput,
  Message,
  SendInput,
  SendResult,
  Session,
  Settings,
  ToolScope,
  UpdateSessionInput
} from '@shared/types'
import type { ToolCallRecord } from '@shared/tools'
import { createProvider } from '../llm'
import type { LlmMessage } from '../llm'
import type { ChatSink, ChatTurnOutcome, WindowLike } from './sink'
import { windowSink } from './sink'
import { sessionPolicy } from './sessionPolicy'
import { permissionGate } from '../tools/permission'
import { channelToolVerdict } from '../channels/toolGate'
import { definitionOf, executeTool, listDefinitions } from '../tools/registry'
import { resolveToolSupply } from '../tools/capability'
import { clockNotice } from '../tools/clock'
import { promptStore } from '../prompt/promptStore'
import { memoryService } from '../rag'
import {
  defaultChannelWorkspaceDir,
  resolveProfile,
  resolveWorkspace,
  settingsStore
} from '../settings/settingsStore'

/**
 * 对话内核（主进程侧）。
 * 职责：会话生命周期、落库、调用模型适配器、跑"模型要工具 -> 审批 -> 执行 -> 继续"的循环。
 * 渲染进程不持有真实数据源，只做展示与交互。
 */
class ChatService {
  private sessions: Session[] = []
  private loaded = false
  private readonly inflight = new Map<string, AbortController>()
  /**
   * 正在跑的那一轮（按会话 id）。
   *
   * 存在的理由：runStream 以前是 fire-and-forget，外面拿不到"这一轮完了"的信号。
   * QQ 侧必须等到整轮结束再发消息，所以这里存住 promise 供 sendAwait await。
   * 清理在 runStream 的 finally 里 —— 必须在 done/fail 之后（顺序敏感，P2 的 D-04 同源）。
   */
  private readonly turns = new Map<string, Promise<ChatTurnOutcome>>()

  listSessions(): Session[] {
    this.ensureLoaded()
    return this.sessions.map(cloneSession)
  }

  /**
   * 桌面会话（侧栏可见的那些）。
   *
   * P6：渠道会话（id 形如 `qq:<uin>:<type>:<id>`）不进侧栏 —— 它们由 QQ 消息驱动出现，
   * 用户没有「新建 / 删除」动作，出现在侧栏只会制造困惑。主进程内仍然能拿到（listSessions）。
   */
  listDesktopSessions(): Session[] {
    return this.listSessions().filter((item) => !isChannelSessionId(item.id))
  }

  createSession(input?: CreateSessionInput): Session {
    this.ensureLoaded()
    const now = Date.now()
    const settings = settingsStore.get()
    const wantedId = input?.id?.trim() ?? ''
    // P6：id 只允许 ensureChannelSession 传。撞上已有会话就报错，绝不静默覆盖别人的消息。
    if (wantedId && this.sessions.some((item) => item.id === wantedId)) {
      throw new Error('会话已存在：' + wantedId)
    }
    const session: Session = {
      id: wantedId || randomUUID(),
      title: input?.title?.trim() || DEFAULT_SESSION_TITLE,
      createdAt: now,
      updatedAt: now,
      messages: [],
      mode: normalizeMode(input?.mode),
      characterId: input?.characterId?.trim() || settings.defaultCharacterId,
      // 新建会话时把当前活动工作区钉下来：之后用户在侧栏切换活动工作区，
      // 这个会话的目录边界不会跟着漂移（那会造成"同一个会话文件突然跑到别处"）。
      workspaceId: resolveWorkspace(settings, input?.workspaceId)?.id ?? null,
      modelProfileId: input?.modelProfileId?.trim() || null,
      modelId: input?.modelId?.trim() || null
    }
    this.sessions.unshift(session)
    this.persist()
    return cloneSession(session)
  }

  /**
   * 渠道会话的幂等创建（P6 G3）。
   *
   * 语义：这个外部键「有没有对应会话」不再由绑定表回答，而是由 sessions.json 本身回答。
   *  - 已有 → 直接返回（顺手把 title 补成 label：用户后来填了群名，侧栏/导出才对得上）
   *  - 没有 → 用外部键当 id 建一条
   *
   * ⚠️ 这里**允许**补 title，而 updateSession 不允许 —— 因为 updateSession 是渲染层入口，
   *    放开它等于让用户改会话标题。本方法是主进程内部专用，title 只来自白名单 label。
   *
   * ⚠️ 渠道会话不绑工作区（K1 实测：resolveWorkspace('') 会回落到**活动**工作区，
   *    所以不能靠传空串，必须建完立刻把 workspaceId 清成 null 再落盘）。
   */
  ensureChannelSession(sessionId: string, opts?: { title?: string; mode?: ConversationMode }): Session {
    this.ensureLoaded()
    const id = sessionId.trim()
    if (!id) throw new Error('渠道会话 id 不能为空')
    const wanted = opts?.title?.trim()
    const existing = this.sessions.find((item) => item.id === id)
    if (existing) {
      if (wanted && existing.title !== wanted) {
        existing.title = wanted
        existing.updatedAt = Date.now()
        this.persist()
      }
      return cloneSession(existing)
    }
    const created = this.createSession({
      id,
      title: wanted || id,
      ...(opts?.mode ? { mode: opts.mode } : {})
    })
    const stored = this.sessions.find((item) => item.id === created.id)
    if (stored && stored.workspaceId !== null) {
      stored.workspaceId = null
      this.persist()
    }
    return cloneSession(stored ?? created)
  }

  /** 改会话的模式 / 角色；只允许在没有消息、也没有进行中的生成时改。 */
  updateSession(id: string, patch: UpdateSessionInput): Session {
    this.ensureLoaded()
    const session = this.sessions.find((item) => item.id === id)
    if (!session) throw new Error('会话不存在')
    if (this.inflight.has(id)) throw new Error('当前会话正在生成，先停止再改')

    if (patch.mode !== undefined) {
      if (session.messages.length > 0) throw new Error('已有消息的会话不能切换模式，请新建对话')
      session.mode = normalizeMode(patch.mode)
    }
    if (patch.characterId !== undefined) {
      const next = String(patch.characterId).trim()
      if (!next) throw new Error('角色不能为空')
      session.characterId = next
    }
    // 换工作区不需要锁会话：和换模型同理，下一步请求就用新值。
    // 传 null = 回到「跟随当前活动工作区」。
    if (patch.workspaceId !== undefined) {
      const settings = settingsStore.get()
      const next = resolveWorkspace(settings, patch.workspaceId)
      if (!next) throw new Error('没有可用的工作区')
      session.workspaceId = next.id
    }
    // 换模型不需要锁会话：下一步请求就会用新值，正在跑的这一步保持启动时的选择
    if (patch.modelProfileId !== undefined) {
      session.modelProfileId = patch.modelProfileId ? String(patch.modelProfileId).trim() : null
    }
    if (patch.modelId !== undefined) {
      session.modelId = patch.modelId ? String(patch.modelId).trim() : null
    }
    session.updatedAt = Date.now()
    this.persist()
    return cloneSession(session)
  }

  /**
   * 工作区被移出列表时，把绑在它上面的会话改绑到别的工作区。
   *
   * 不这么做的话，那些会话会带着一个失效的 workspaceId 留在盘里：
   * 侧栏按工作区过滤，「最近」里再也看不到它们——用户看到的是"对话凭空消失"。
   * 宁可让它们回到默认工作区（用户能重新看见、重新选目录），也不能静默失联。
   */
  reassignWorkspace(fromWorkspaceId: string, toWorkspaceId: string | null): number {
    this.ensureLoaded()
    let moved = 0
    for (const session of this.sessions) {
      if (session.workspaceId !== fromWorkspaceId) continue
      session.workspaceId = toWorkspaceId
      session.updatedAt = Date.now()
      moved += 1
    }
    if (moved > 0) this.persist()
    return moved
  }

  deleteSession(id: string): void {
    this.ensureLoaded()
    this.stop(id)
    this.sessions = this.sessions.filter((s) => s.id !== id)
    this.persist()
  }

  stop(sessionId: string): void {
    const controller = this.inflight.get(sessionId)
    if (!controller) return
    controller.abort()
    this.inflight.delete(sessionId)
    permissionGate.cancelSession(sessionId)
  }

  /**
   * 渲染进程入口：行为与改动前完全一致（同步返回一条 SendResult，生成在后台继续）。
   *
   * 参数是 WindowLike（收口在 sink 里），调用方 ipc/index.ts:115 传的仍然是 event.sender，
   * 一个字都不用改 —— 渲染层的 IPC 契约与载荷结构保持原样。
   */
  async send(input: SendInput, sender: WindowLike): Promise<SendResult> {
    return (await this.begin(input, windowSink(sender))).result
  }

  /**
   * 无窗口调用方用这个：能 await 完整一轮，拿到结构化结果。
   *
   * 与 send() 共用 begin()，区别只有一处 —— send() 丢掉那个 promise，sendAwait() 等它。
   * 没有第二份实现，所以新增这条路径不会改变渲染层的任何行为。
   */
  async sendAwait(input: SendInput, sink: ChatSink): Promise<ChatTurnOutcome> {
    return (await this.begin(input, sink)).turn
  }

  /** 该会话是否有正在跑的一轮（P4 用来判断「正在生成」，不必自己维护状态） */
  isGenerating(sessionId: string): boolean {
    return this.turns.has(sessionId)
  }

  /** send / sendAwait 的共用实现：校验、造消息、起一轮，返回「立即结果」与「整轮 promise」。 */
  private async begin(
    input: SendInput,
    sink: ChatSink
  ): Promise<{ result: SendResult; turn: Promise<ChatTurnOutcome> }> {
    this.ensureLoaded()
    const content = input.content.trim()
    if (!content) throw new Error('消息内容为空')

    const session = this.sessions.find((s) => s.id === input.sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.inflight.has(session.id)) throw new Error('当前会话仍在生成中')

    const now = Date.now()
    const userMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content,
      createdAt: now,
      status: 'done'
    }
    const assistantMessage: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: now,
      status: 'streaming',
      toolCalls: []
    }

    session.messages.push(userMessage, assistantMessage)
    session.updatedAt = now
    if (session.title === DEFAULT_SESSION_TITLE) session.title = deriveTitle(content)
    this.persist()

    const controller = new AbortController()
    this.inflight.set(session.id, controller)
    // runStream 自己把异常收敛成 status:'error' 的 outcome，所以这里不会有未处理的 rejection
    const turn = this.runStream(session, assistantMessage, sink, controller)
    this.turns.set(session.id, turn)

    return {
      result: { userMessage: { ...userMessage }, assistantMessage: cloneMessage(assistantMessage) },
      turn
    }
  }

  private async runStream(
    session: Session,
    message: Message,
    sink: ChatSink,
    controller: AbortController
  ): Promise<ChatTurnOutcome> {
    const startedAt = Date.now()
    // 本轮用户原话，既是记忆检索的 query，也是抽取记忆的输入
    const userText = this.latestUserText(session)
    const stored = settingsStore.get()
    // 档案是唯一真源：这里再算一次，避免镜像字段与档案不同步时用错模型。
    // 会话自己指定的档案/模型优先，没指定才用默认档案。
    const settings = this.effectiveSettings(session, stored)
    const provider = createProvider(settings)
    // 供给由 capability.ts 统一判定（P1）。不再用 mode === 'agent' 一刀切：
    // chat 会话在开启工具增强后也要拿得到工具目录（P9 的授权闸门因此才可能被触发）。
    // 🔴 这里只算「给不给」，不判「能不能执行」——授权在 runTool 的 channelToolVerdict
    //    与 permissionGate 两层（M24：供给与授权正交）。
    const definitions = resolveToolSupply({
      mode: session.mode,
      allTools: listDefinitions(),
      chatTools: stored.chatTools,
      isChannel: isChannelSessionId(session.id),
      channelChatType: parseChannelKey(session.id)?.chatType
    })

    // 记忆检索只在这一轮开始时做一次。
    // 绝不能放进 buildPayload：那个函数在工具循环里每轮都会调用，
    // 把 embedding 重算 N 次既慢又浪费。
    // 任何失败都必须降级成空串——记忆坏了不能影响聊天。
    // P5 G5：按域召回。空数组 = 不召回（fail-closed），此时连 embedding 都不算。
    // 任何失败都必须降级成空串——记忆坏了不能影响聊天。
    const recallScopes = sessionPolicy().recallScopes(session.id)
    const memoryBlock =
      recallScopes.length === 0
        ? ''
        : await this.recallMemory(userText, stored.memory, recallScopes).catch(() => '')

    // 时间只在「这一轮开始时」采样一次。
    // 放进循环里每步重取有两个坏处：工具循环一步一调会把时间戳刷成不同值，
    // 模型刚说完「凌晨 0:27」下一步又看到「0:28」，会开始纠结自己算错了。
    // 需要更新鲜的时间时，模型调 clock.now 即可。
    const clockBlock = clockNotice()

    // ── 供给闸（ERR-01）：本轮「允许被调用」的工具名集合 ────────────────
    // 必须建在循环外：definitions 在整轮内是不变量（runStream 开头算完就不再变），
    // 放进循环里重算会诱导后来者「顺手」重算 definitions，破坏「一轮内供给不变」的语义。
    const allowedTools = new Set(definitions.map((tool) => tool.name))

    // 被供给闸拦下的调用：**仍要**落进 message.toolCalls 并回喂理由，
    // 但绝不能再进 runTool —— 否则白拦一次，工具照跑。
    const blockedCalls = new Set<ToolCallRecord>()

    let outcome: ChatTurnOutcome
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
        if (controller.signal.aborted) break

        const payload = this.buildPayload(session, memoryBlock, clockBlock, definitions.length > 0)
        const calls: ToolCallRecord[] = []

        for await (const event of provider.stream({
          messages: payload,
          settings,
          signal: controller.signal,
          tools: definitions
        })) {
          if (controller.signal.aborted) break
          if (event.type === 'text') {
            message.content += event.text
            const delta: ChatDelta = { sessionId: session.id, messageId: message.id, delta: event.text }
            sink.delta(delta)
          } else if (event.type === 'tool_call') {
            // ── 供给闸（ERR-01）：本轮没交给模型的工具，一律不认。 ──
            //
            // 🔴 为什么必须在这里拦，而不是信任「请求里没带 tools」：
            //    openAiProvider 在 tools 为空时**不发 tools 字段**（openAiProvider.ts:27），
            //    请求本身是合法的、服务端不会报错；而 messages 里的历史 role:'tool'
            //    会让模型继续吐 tool_calls（真机实测：execute_command）。
            //    下面三道闸（未注册 / 按人授权 / 权限模式）都不回答「本轮给不给」。
            //
            // 🔴 被拦的调用仍要 calls.push：否则模型下一轮拿不到 role:'tool' 回执，
            //    会以为自己的调用被吞了，在同一轮里反复重试同一个工具（卡满 MAX_TOOL_TURNS）。
            if (!allowedTools.has(event.call.name)) {
              const blocked = toRecord(event.call)
              blocked.status = 'denied'
              // 措辞面向模型可转述：这条会作为 role:'tool' 消息回喂，不许出现内部术语。
              blocked.error =
                '本轮没有向模型提供这个工具（工具增强已关闭或未勾选），所以这次调用没有执行。' +
                '如果确实需要，请让用户在桌面端的设置里打开。'
              blockedCalls.add(blocked)
              calls.push(blocked)
              continue
            }
            calls.push(toRecord(event.call))
          }
        }

        if (controller.signal.aborted) break
        if (calls.length === 0) break

        message.toolCalls = [...(message.toolCalls ?? []), ...calls]
        this.emitTool(sink, session, message)

        for (const record of calls) {
          if (controller.signal.aborted) break
          // 供给闸已经拦下的调用：只留记录，不执行（ERR-01）。
          // 判的是对象身份而不是 status/name：同一轮里名字相同的两次调用要分别处理。
          if (blockedCalls.has(record)) continue
          await this.runTool(record, session, message, sink)
        }
        this.emitTool(sink, session, message)
        this.persist()
      }

      message.status = 'done'
      // 快照必须在 finally 之前取（A23：写入时机决定可引用对象）
      const done: ChatDone = {
        sessionId: session.id,
        messageId: message.id,
        content: message.content,
        toolCalls: cloneCalls(message.toolCalls)
      }
      sink.done(done)
      outcome = {
        status: controller.signal.aborted ? 'aborted' : 'done',
        sessionId: session.id,
        messageId: message.id,
        content: done.content,
        toolCalls: done.toolCalls,
        durationMs: Date.now() - startedAt
      }
    } catch (error) {
      message.status = 'error'
      const text = error instanceof Error ? error.message : String(error)
      sink.fail({ sessionId: session.id, messageId: message.id, message: text })
      outcome = {
        status: 'error',
        sessionId: session.id,
        messageId: message.id,
        content: message.content,
        toolCalls: cloneCalls(message.toolCalls),
        error: text,
        durationMs: Date.now() - startedAt
      }
    } finally {
      this.inflight.delete(session.id)
      // turns 的清理必须在 done/fail 之后（顺序敏感：先记账会被 await 方读成"还在跑"）
      this.turns.delete(session.id)
      session.updatedAt = Date.now()
      this.persist()
      this.scheduleExtraction(session, userText)
    }

    return outcome
  }

  /**
   * 对话结束后异步提炼记忆。
   * 刻意不 await：抽取要再调一次模型，让用户等它毫无意义。
   * 用独立的 AbortController，用户点「停止生成」不应该连记忆抽取一起取消
   * ——那句话已经说完了，事实该记还是要记。
   */
  private scheduleExtraction(session: Session, userText: string): void {
    // P5 G5：写进这条会话自己的域（P4 是「完全隔离=什么都不记」，P5 是「记在自己的域里」）。
    // 取不到域（空串）就不写：没有归属的条目在面板里看不见，等于黑洞。
    const scope = sessionPolicy().primaryScope(session.id)
    if (!scope) return
    const stored = settingsStore.get()
    if (!stored.memory?.enabled || !stored.memory.autoExtract) return
    if (!userText.trim()) return

    const lastUser = [...session.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return

    const llmSettings = this.effectiveSettings(session, stored)

    void memoryService
      .extractInBackground({
        sessionId: session.id,
        messageId: lastUser.id,
        userText,
        settings: stored.memory,
        provider: createProvider(llmSettings),
        llmSettings,
        signal: new AbortController().signal,
        scope
      })
      .catch((error) => console.warn('[chat] 记忆抽取失败', error))
  }

  /** 单个工具的完整生命周期：策略判定 -> 审批（可能） -> 执行 -> 回写状态。 */
  private async runTool(
    record: ToolCallRecord,
    session: Session,
    message: Message,
    sink: ChatSink
  ): Promise<void> {
    if (!definitionOf(record.name)) {
      record.status = 'error'
      record.error = '模型请求了未注册的工具：' + record.name
      this.emitTool(sink, session, message)
      return
    }

    // ── P9-R3：渠道工具闸门。**按发言人判，不按会话判**（在 permissionGate 之前）──
    //
    // 为什么必须在 permissionGate 之前：
    //  1. 「这个人根本没被授权用工具」比「当前权限模式禁止」更前置、更好懂；
    //  2. permissionGate 在 approve 模式下会 request()，对 QQ 会 emit 一张永远没人点的
    //     审批卡（QqSink 会 presentApproval）。对本来就没权限的人弹卡是纯噪音。
    //
    // 为什么这里不看 session.mode：供给与授权正交（M24）。工具目录照常给模型，
    // 拦的是**执行**，不是**可见性**（J-65）。
    //
    // senderId === null（桌面 / 无头 sink）→ 整体跳过，桌面行为零变化（R3-C12）。
    const senderId = sink.senderId
    if (senderId) {
      const verdict = channelToolVerdict(senderId, session.id)
      if (!verdict.allowed) {
        record.status = 'denied'
        record.error = verdict.reason
        this.emitTool(sink, session, message)
        return
      }
    }

    const decision = permissionGate.evaluate(record.name, record.readOnly)
    if (decision === 'deny') {
      record.status = 'denied'
      record.error = '当前权限策略禁止该操作'
      this.emitTool(sink, session, message)
      return
    }

    if (decision === 'ask') {
      record.status = 'awaiting'
      this.emitTool(sink, session, message)
      const approved = await permissionGate.request(session.id, message.id, record, sink)
      if (!approved) {
        record.status = 'denied'
        // P3 / M03：渠道场景里**没有人在场点卡**（QqSink.canApprove() 恒 false，
        // permissionGate 当场按拒绝结算）。所以不能说「用户拒绝或审批超时」——
        // 那会让模型对群友说「用户不让我做」，而真实原因是「这个环境不走审批」。
        //
        // 🔴 措辞面向模型可转述：不写 canApprove / permissionGate 这类内部术语
        //    （这条 error 会作为 role:'tool' 的消息回喂给模型）。
        // 🔴 canApprove 是**方法**，写成属性会永远 truthy（A-08 对照物盯着桌面那条）。
        record.error = sink.canApprove()
          ? '用户拒绝或审批超时'
          : '当前环境不支持交互式审批（渠道会话没有审批卡），需要副作用操作时已被直接拒绝。' +
            '如果用户在场，请让他在桌面端设置里把权限模式改为「完全访问」，或改用只读工具。'
        this.emitTool(sink, session, message)
        return
      }
    }

    record.status = 'running'
    record.startedAt = Date.now()
    this.emitTool(sink, session, message)

    // P6 G5 的落点：toolScopeOf 在零工作区时抛错。
    // 这里必须就地收敛成**工具级失败**，不能让它冒到 runStream：
    //   - 冒上去 = 整轮 message.status 变 error，而这条 record 永远停在 'running'，
    //     界面上是一张转不完的工具卡（真实可复现，不是理论问题）；
    //   - 就地收敛 = 工具卡显示失败原因，模型能读到它并回一句「请先建工作区」。
    // 关键点与蓝图一致：**绝不会**带着空 root 去执行工具。
    let result
    try {
      result = await executeTool(record.name, record.arguments, {
        scope: this.toolScopeOf(session)
      })
    } catch (error) {
      record.durationMs = Date.now() - record.startedAt
      record.status = 'error'
      record.result = null
      record.error = error instanceof Error ? error.message : String(error)
      this.emitTool(sink, session, message)
      return
    }

    record.durationMs = Date.now() - record.startedAt
    record.status = result.ok ? 'ok' : 'error'
    record.result = result.ok ? result.output : null
    record.error = result.ok ? null : result.output
    this.emitTool(sink, session, message)
  }

  private buildPayload(
    session: Session,
    memoryBlock: string,
    clockBlock: string,
    toolsEnabled: boolean
  ): LlmMessage[] {
    const payload: LlmMessage[] = []

    // 提示词按角色 + 模式现场拼：shared/base -> soul -> worldbook -> styles/<mode>
    try {
      // toolsEnabled 显式透传（C22）：不挂到 session 上——buildPayload 在工具循环里每轮
      // 都调用，隐式状态会漂；挂 session 还会污染三端契约。
      const system = promptStore.compose(session.characterId, session.mode, { toolsEnabled })
      if (system) payload.push({ role: 'system', content: system })
    } catch (error) {
      console.warn('[chat] 系统提示词组装修复失败', error)
    }

    // 时间作为独立的一段 system 注入，理由和记忆一样：
    // 它是「事实」不是「人格」，而且会过期——用户改提示词文件时不该碰它，
    // 它也不该出现在 Prompt/ 目录里让用户误以为是可编辑的人设文本。
    // 必须在人格之后：越靠后越贴近这次回答，时间必须压过人设里的任何时间描述。
    if (clockBlock) payload.push({ role: 'system', content: clockBlock })

    // 记忆作为独立的一段 system 注入，不拼进人格提示词。
    // 理由：人格是「怎么说话」，记忆是「已经知道什么」，两者的生命周期
    // 和可撤销性完全不同——用户删掉一条记忆，不该动到人格文件。
    if (memoryBlock) payload.push({ role: 'system', content: memoryBlock })

    for (const message of session.messages) {
      if (message.role === 'system') continue

      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        payload.push({
          role: 'assistant',
          content: message.content,
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments
          }))
        })
        for (const call of message.toolCalls) {
          payload.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content:
              call.status === 'ok'
                ? (call.result ?? '')
                : '工具未成功执行（' + call.status + '）：' + (call.error ?? '无错误信息')
          })
        }
        continue
      }

      if (!message.content) continue
      payload.push({ role: message.role, content: message.content })
    }

    return payload
  }

  /**
   * 会话实际生效的工具边界：权限模式（全局）+ 工作区根目录（按会话）。
   *
   * 每次执行工具都重算，而不是启动时缓存：用户可能在对话进行中切了权限模式，
   * 也可能改了工作区名/路径——下一步调用必须立刻按新值走。
   *
   * P6 G5：零工作区时**绝不能返回空根**。空根会让文件工具在进程 cwd 里乱撞，
   * 那比直接报错危险得多。这里提前抛，错误文案原样展示给用户
   * （runStream 的 catch 会把它收敛成 status:'error' 的 outcome，不会漏成未捕获 rejection）。
   */
  private toolScopeOf(session: Session): ToolScope {
    const settings = settingsStore.get()
    const workspace = resolveWorkspace(settings, session.workspaceId)
    // P3 / M21：渠道会话由 QQ 消息驱动出现，用户无法在侧栏给它选工作区，
    // 所以它有自己的「渠道工作区根」——缺省 userData/workspace，可在渠道控制台改。
    //
    // 🔴 这不是放宽检查：渠道本来就该有一个确定目录，只是以前从没定义过它。
    //    真正「没有工作区」的桌面会话仍然抛下面那个原错误（对照物 A-03 盯着它）。
    // 🔴 顺序敏感：必须**先** `!workspace` 再判渠道身份。
    //    无条件对渠道返回渠道根，会让「已绑定工作区的渠道会话」丢掉自己的绑定（A-05 盯着它）。
    if (!workspace && isChannelSessionId(session.id)) {
      const dir = settings.channelWorkspaceDir?.trim() || defaultChannelWorkspaceDir()
      return { mode: settings.permission.mode, root: dir }
    }
    if (!workspace) {
      throw new Error('当前没有工作区，Agent 模式无法执行工具。请先在侧栏新建一个工作区。')
    }
    return { mode: settings.permission.mode, root: workspace.dir }
  }

  /**
   * 会话实际生效的模型配置：会话指定了档案/模型就用它的，否则回落到默认档案。
   * 镜像字段与档案不同步时以档案为准，所以这里始终重算而不是直接读 settings。
   */
  private effectiveSettings(session: Session, stored: Settings): Settings {
    const { profile, model } = resolveProfile(stored, session.modelProfileId, session.modelId)
    if (!profile) return stored
    return {
      ...stored,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      model,
      temperature: profile.temperature
    }
  }

  /** 取本轮用户最新一句话，作为记忆检索的 query */
  private latestUserText(session: Session): string {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const message = session.messages[i]
      if (message.role === 'user' && message.content.trim()) return message.content
    }
    return ''
  }

  private async recallMemory(
    query: string,
    config: Settings['memory'],
    scopes: string[]
  ): Promise<string> {
    if (!config?.enabled) return ''
    if (!query.trim()) return ''
    return memoryService.buildContextBlock(query, config, scopes)
  }

  /**
   * 工具状态更新。
   *
   * 不再判断 isDestroyed：这个判断现在住在 sink 里（窗口 sink 的 post），
   * 因为只有 sink 知道自己背后是窗口还是"没有窗口"。
   */
  private emitTool(sink: ChatSink, session: Session, message: Message): void {
    const update: ChatToolUpdate = {
      sessionId: session.id,
      messageId: message.id,
      calls: cloneCalls(message.toolCalls)
    }
    sink.tool(update)
  }

  private get file(): string {
    return join(app.getPath('userData'), 'sessions.json')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Session[]
      const settings = settingsStore.get()
      // 老会话没有 workspaceId（单工作区时代）：绑到当前活动工作区，
      // 否则老会话的文件工具会找不到落点。
      // P6：渠道会话的 null 必须保住 —— 它不该有文件边界，落成活动工作区就跑到用户当前目录里去了。
      const fallbackWorkspaceId = resolveWorkspace(settings, null)?.id ?? null
      this.sessions = Array.isArray(parsed)
        ? parsed.map((session) => ({
            ...session,
            mode: normalizeMode(session.mode),
            characterId: session.characterId || settings.defaultCharacterId,
            workspaceId: session.workspaceId ?? (isChannelSessionId(session.id) ? null : fallbackWorkspaceId)
          }))
        : []
    } catch (error) {
      console.warn('[chat] 会话历史读取失败，已从空列表启动', error)
      this.sessions = []
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.sessions, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      console.error('[chat] 会话落库失败', error)
    }
  }
}

function normalizeMode(value: unknown): ConversationMode {
  return value === 'agent' ? 'agent' : 'chat'
}

function toRecord(call: { id: string; name: string; arguments: string }): ToolCallRecord {
  const definition = definitionOf(call.name)
  return {
    id: call.id,
    name: call.name,
    title: definition ? definition.title : call.name,
    readOnly: definition ? definition.readOnly : true,
    arguments: call.arguments,
    status: 'awaiting',
    result: null,
    error: null,
    startedAt: 0,
    durationMs: null
  }
}

function cloneCalls(calls: ToolCallRecord[] | undefined): ToolCallRecord[] {
  return (calls ?? []).map((call) => ({ ...call }))
}

function cloneMessage(message: Message): Message {
  return { ...message, toolCalls: cloneCalls(message.toolCalls) }
}

function cloneSession(session: Session): Session {
  return { ...session, messages: session.messages.map(cloneMessage) }
}

function deriveTitle(content: string): string {
  const single = content.replace(/\s+/g, ' ').trim()
  return single.length > 18 ? single.slice(0, 18) + '…' : single
}

export const chatService = new ChatService()