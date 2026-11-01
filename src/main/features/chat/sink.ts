import { IPC } from '@shared/ipc'
import type { ChatDelta, ChatDone, ChatFailure, ChatToolUpdate } from '@shared/types'
import type { ToolApprovalTicket, ToolCallRecord } from '@shared/tools'

/**
 * 一轮对话的结构化结果。
 *
 * 存在的理由：send() 是 fire-and-forget（chatService.ts 原来 :174 是 `void this.runStream(...)`），
 * 调用方拿到 SendResult 时生成才刚开始。QQ 侧必须等整轮结束才能把回复发出去，
 * 所以必须有一条能 await 到「这一轮真的完了」的路径 —— 就是 ChatTurnOutcome。
 */
export interface ChatTurnOutcome {
  /** aborted = 用户中途点了停止（正文是已生成的那部分） */
  status: 'done' | 'error' | 'aborted'
  sessionId: string
  messageId: string
  /** 完整正文（done / aborted 时是已生成的全文；error 时是出错前已生成的部分） */
  content: string
  toolCalls: ToolCallRecord[]
  /** 仅 status === 'error' 时存在 */
  error?: string
  /** 本轮总耗时（ms） */
  durationMs: number
}

/**
 * WebContents 的结构化最小面。
 *
 * 刻意不用 electron 的 WebContents 类型：chatService / permission 里一旦出现
 * `import type { WebContents } from 'electron'`，这两个文件就又被窗口绑死了（G2 硬判据）。
 * 这里只要两个方法，Electron 的 WebContents 天然满足，ipc/index.ts 的 event.sender 可以直接传。
 */
export interface WebContentsLike {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/**
 * 一轮对话的呈现端。只负责「把过程说出去」，不负责任何业务判断：
 * 不判超时、不决定审批结论、不拼 QQ 段落、不落库。
 */
export interface ChatSink {
  readonly kind: 'webContents' | 'headless' | 'qq'
  /** 替代原来的 sender.isDestroyed() */
  isAlive(): boolean
  /**
   * 这个 sink 背后有没有真人能回答审批。
   * false → permissionGate 立即按「拒绝」结算，不进 pending 表、不白等 120 s。
   */
  canApprove(): boolean
  delta(d: ChatDelta): void
  done(d: ChatDone): void
  fail(f: ChatFailure): void
  tool(t: ChatToolUpdate): void
  /** 呈现审批票据；结算仍归 permissionGate（sink 不自己 resolve、不自己判超时） */
  presentApproval(t: ToolApprovalTicket): void
}

/**
 * 渲染进程的 sink：逐字复刻改动前的行为。
 * 每个方法自己判 isDestroyed（原来 chatService.emit 里判的那一下），
 * 所以调用方不需要再写 `if (!sender.isDestroyed())`。
 */
export class WebContentsSink implements ChatSink {
  readonly kind = 'webContents' as const

  constructor(private readonly sender: WebContentsLike) {}

  isAlive(): boolean {
    return !this.sender.isDestroyed()
  }

  canApprove(): boolean {
    return true
  }

  delta(d: ChatDelta): void {
    this.post(IPC.chatDelta, d)
  }

  done(d: ChatDone): void {
    this.post(IPC.chatDone, d)
  }

  fail(f: ChatFailure): void {
    this.post(IPC.chatError, f)
  }

  tool(t: ChatToolUpdate): void {
    this.post(IPC.chatTool, t)
  }

  presentApproval(t: ToolApprovalTicket): void {
    this.post(IPC.chatApproval, t)
  }

  private post(channel: string, payload: unknown): void {
    if (this.sender.isDestroyed()) return
    this.sender.send(channel, payload)
  }
}

/**
 * 无人值守的 sink：把流式片段自己累积成正文，审批恒拒绝（M3：QQ 会话只开只读工具）。
 *
 * 这是 P4 的 QqSink 的基类：QqSink 只需覆盖 delta（攒段落）与 canApprove，
 * 不需要重写「一轮怎么跑」。
 */
export class HeadlessSink implements ChatSink {
  readonly kind: 'headless' | 'qq' = 'headless'

  /** 累积的正文（delta 逐片追加） */
  content = ''
  /** 收到的审批票据（按到达顺序留档，便于断言「确实走到了审批」） */
  readonly approvals: ToolApprovalTicket[] = []
  /** 收到 done 的次数（正常一轮 = 1） */
  doneCount = 0
  /** 收到 fail 的次数 */
  failCount = 0
  /** 最后一次 tool 更新的快照 */
  lastToolCalls: ToolCallRecord[] = []

  isAlive(): boolean {
    return true
  }

  /** 恒 false：没有窗口能弹审批卡，permissionGate 会当场按拒绝结算 */
  canApprove(): boolean {
    return false
  }

  delta(d: ChatDelta): void {
    this.content += d.delta
  }

  done(d: ChatDone): void {
    this.doneCount += 1
    // done 里的 content 是主进程侧的权威全文；以它为准，避免 delta 丢片导致缩水
    this.content = d.content
    this.lastToolCalls = d.toolCalls
  }

  fail(f: ChatFailure): void {
    this.failCount += 1
    void f
  }

  tool(t: ChatToolUpdate): void {
    this.lastToolCalls = t.calls
  }

  presentApproval(t: ToolApprovalTicket): void {
    this.approvals.push(t)
  }
}

/**
 * 「窗口」这件事在 chat 内核里的别名。
 *
 * 为什么要有别名：G2 是硬判据 —— chatService.ts 与 permission.ts 里
 * 一个字面量 `WebContents` 都不许留。内核只需要两个方法，不需要知道那是 Electron 的窗口对象。
 */
export type WindowLike = WebContentsLike

/** 工厂：把 `{ isDestroyed, send }` 包成渲染进程用的 sink。 */
export function windowSink(sender: WebContentsLike): ChatSink {
  return new WebContentsSink(sender)
}

/** 全部 no-op 的 sink：压测 / 冒烟 / 只想跑完一轮不要结果时用。 */
export class NullSink implements ChatSink {
  readonly kind = 'headless' as const
  isAlive(): boolean {
    return true
  }
  canApprove(): boolean {
    return false
  }
  delta(): void {}
  done(): void {}
  fail(): void {}
  tool(): void {}
  presentApproval(): void {}
}
