import type { CommandName, CommandPermissionLevel } from '@shared/persona'

/**
 * P4：指令执行的上下文。**只有这些**，不许从 bridge 的闭包里偷别的东西。
 *
 * 🔴 执行器**不读盘**：等级由 bridge 从 access.json 取好（它与 resolveMessageAccess 用
 *    同一份快照），门槛由 bridge 从 settings 归一化好。执行器只吃纯数据，
 *    所以能在内存里直接单测（test:command-level 大半靠这条）。
 */
export interface CommandContext {
  /** 发言人 QQ 号 = userId（与 chatService.memoryTenantOf 同源，**不重算**） */
  userId: string
  chatType: 'private' | 'group'
  /** 群号 / 对方号；私聊时与 userId 相同 */
  chatId: string
  /** 该账号的指令等级（由 bridge 从 access.json 取好传入，执行器不读盘） */
  level: CommandPermissionLevel
  /** 每条指令的门槛（已归一化） */
  thresholds: Record<CommandName, CommandPermissionLevel>
  args: string[]
}

/**
 * 执行结果。**执行器不自己发消息**（理由见 run.ts 末尾）。
 * `text` 空串 = 什么都不发；`ok` 只用于统计口径，**不用于判定**。
 */
export interface CommandResult {
  text: string
  /** 给旁听 detail 的一句话（中文、可读、≤80 字） */
  detail: string
  ok: boolean
}
