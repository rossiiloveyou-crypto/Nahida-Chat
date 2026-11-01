import { randomUUID } from 'node:crypto'
import { APPROVAL_TIMEOUT_MS } from '@shared/constants'
import type { ToolAccess, ToolApprovalReply, ToolApprovalTicket, ToolCallRecord } from '@shared/tools'
import type { PermissionMode, PermissionSettings } from '@shared/types'
import type { ChatSink } from '../chat/sink'
import { settingsStore } from '../settings/settingsStore'

interface PendingEntry {
  sessionId: string
  toolName: string
  settle: (approved: boolean) => void
}

/** 三种权限模式的中文说明，审批卡与设置页共用同一套措辞。 */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  full: '完全访问',
  readonly: '只读',
  approve: '审批'
}

export const PERMISSION_MODE_DESC: Record<PermissionMode, string> = {
  full: '所有工具直接执行，文件工具不受工作区限制。只适合你完全信任的模型。',
  readonly: '只用只读工具。任何会改动文件或执行命令的调用一律拒绝。',
  approve: '只读工具直接跑；会改动东西的调用先弹卡问你。'
}

/**
 * 工具闸门。
 *
 * 判定只依赖两件事：用户选的权限模式，和「这个工具是不是只读」。
 * 没有按工具名逐个配置，也没有风险分级——那两样东西的定义权不在用户手里，
 * 配错了反而给人虚假的安全感。
 *
 * 目录白名单仍然存在，但它只约束"能碰哪里"，不决定"能不能碰"：
 * 完全访问模式下不再是限制，只读/审批模式下文件工具只能落在工作区内。
 */
class PermissionGate {
  private readonly pending = new Map<string, PendingEntry>()
  /** 本进程内"这次总是允许"的工具名，重启即失效 */
  private readonly remembered = new Set<string>()

  evaluate(toolName: string, readOnly: boolean): ToolAccess {
    const permission = this.currentPermission()
    if (permission.mode === 'full') return 'allow'
    if (permission.mode === 'readonly') return readOnly ? 'allow' : 'deny'
    // approve：只读直接放行，有副作用的一律先问
    if (readOnly) return 'allow'
    return this.remembered.has(toolName) ? 'allow' : 'ask'
  }

  currentPermission(): PermissionSettings {
    return settingsStore.get().permission
  }

  /** 生成给用户看的审批理由：说清"为什么弹这张卡"，而不是复述风险等级。 */
  reasonFor(record: ToolCallRecord): string {
    const mode = PERMISSION_MODE_LABEL[this.currentPermission().mode]
    return (
      '工具「' + record.title + '」（' + record.name + '）会改动文件或与外部交互，' +
      '当前权限模式是「' + mode + '」，需要你确认这一次。'
    )
  }

  /**
   * 申请一次审批。
   *
   * 归属划分：**呈现**交给 sink（它知道背后是窗口、还是没有窗口），
   * **超时与结算**留在这里（120 s、pending 表、remember 语义都是既定契约，重复实现必然分叉）。
   *
   * 无人值守的 sink（canApprove() === false，例如 HeadlessSink / 将来的 QqSink）
   * 当场按「拒绝」结算：不进 pending 表、不占一个 120 s 的定时器、不挂起对话循环。
   * 这个早退分支必须写在记账之前 —— 否则会先占坑再退出，pending 表里留下永远没人答的条目
   * （同源坑见 PHASE-2 报告 §五 D-04）。
   */
  request(
    sessionId: string,
    messageId: string,
    record: ToolCallRecord,
    sink: ChatSink
  ): Promise<boolean> {
    const requestId = randomUUID()
    const ticket: ToolApprovalTicket = {
      requestId,
      sessionId,
      messageId,
      call: record,
      reason: this.reasonFor(record)
    }

    return new Promise<boolean>((resolve) => {
      if (!sink.isAlive() || !sink.canApprove()) {
        sink.presentApproval(ticket)
        resolve(false)
        return
      }

      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(false)
      }, APPROVAL_TIMEOUT_MS)

      this.pending.set(requestId, {
        sessionId,
        toolName: record.name,
        settle: (approved) => {
          clearTimeout(timer)
          resolve(approved)
        }
      })

      sink.presentApproval(ticket)
    })
  }

  resolve(reply: ToolApprovalReply): void {
    const entry = this.pending.get(reply.requestId)
    if (!entry) return
    this.pending.delete(reply.requestId)
    if (reply.approved && reply.remember) this.remembered.add(entry.toolName)
    entry.settle(reply.approved)
  }

  /** 用户点了"停止生成"时，把该会话挂起的审批全部按拒绝收尾。 */
  cancelSession(sessionId: string): void {
    for (const [requestId, entry] of [...this.pending.entries()]) {
      if (entry.sessionId !== sessionId) continue
      this.pending.delete(requestId)
      entry.settle(false)
    }
  }

  /** 用户切换权限模式时清空"总是允许"记忆，避免旧授权跨模式泄漏 */
  forgetRemembered(): void {
    this.remembered.clear()
  }
}

export const permissionGate = new PermissionGate()
