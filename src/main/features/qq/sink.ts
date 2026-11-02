import { IPC } from '@shared/ipc'
import type { ChatDelta, ChatDone, ChatFailure, ChatToolUpdate } from '@shared/types'
import type { ToolApprovalTicket } from '@shared/tools'
import { HeadlessSink } from '../chat/sink'

/**
 * QQ 会话的呈现端（P4 G7 / E16）。
 *
 * 继承 HeadlessSink：攒正文、审批恒拒绝（M3）。**不要覆盖 canApprove** ——
 * 群聊里没人能点审批卡，permissionGate 必须当场按拒绝结算（P3 G5，实测 9 ms）。
 *
 * P9-R3：多带一个 **发言人 QQ 号**（`senderId`）。工具闸门按「人」判权限，
 * 而 runTool 手上只有 session 与 message —— 把发言人挂在 sink 上是**一处改动、语义正确**：
 * 发言人本来就属于「这一轮是谁发起的」。桌面 / 无头 sink 的 senderId 恒为 null，
 * 于是它们**整体跳过**渠道闸门（桌面行为零变化）。
 *
 * 广播沿用既有的 chat:delta / chat:done / chat:error / chat:tool 频道，
 * **不新增渲染层频道**（否则要改 store.ts，破坏"渲染层零改动"基线）。
 * 安全性依据 E18：渲染层 mapSession 对不在列表里的 sessionId 是空操作。
 */
export class QqSink extends HeadlessSink {
  readonly kind = 'qq' as const
  /** 本轮消息的发言人（QQ 号）。群聊与私聊都有；取不到时为空串 */
  readonly senderId: string

  constructor(
    private readonly broadcast: (channel: string, payload: unknown) => void,
    senderId = ''
  ) {
    super()
    this.senderId = String(senderId ?? '')
  }

  override delta(d: ChatDelta): void {
    super.delta(d)
    this.broadcast(IPC.chatDelta, d)
  }

  override done(d: ChatDone): void {
    super.done(d)
    this.broadcast(IPC.chatDone, d)
  }

  override fail(f: ChatFailure): void {
    super.fail(f)
    this.broadcast(IPC.chatError, f)
  }

  override tool(t: ChatToolUpdate): void {
    super.tool(t)
    this.broadcast(IPC.chatTool, t)
  }

  override presentApproval(t: ToolApprovalTicket): void {
    super.presentApproval(t)
    this.broadcast(IPC.chatApproval, t)
  }
}
