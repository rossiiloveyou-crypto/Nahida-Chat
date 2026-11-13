import type { ChannelId } from './channels'
import { DEFAULT_ACCOUNT_LEVEL } from './persona'
import type { CommandPermissionLevel } from './persona'

/**
 * 渠道授权的 **v2 数据模型**（P9-R3）—— 授权主体从「会话」改成「人」。
 *
 * 🔴 为什么重做（用户 2026-11-02 原话）：
 *    「不是按照会话给权限，粒度太粗了」
 *    会话 = 机器人号 + 群号。整个群共用一条记录 ⇒ 群里一个人有权限 = 全群都能干活。
 *
 * 🔴 本文件**零运行时依赖**（与 shared/channels.ts 同规格）：
 *    主进程 / preload / 渲染层都能直接 import，不拖进任何 Node 模块。
 *
 * 只有类型与纯函数，落盘在 main/features/channels/store.ts。
 * 判定函数（resolveMessageAccess / resolveToolAccess）放在这里的原因：
 * 它们是**纯函数**，能用内存数据直接单测，不必碰 userData（test:channel-access 26 项）。
 */

/** 单条账号权限位。**主体是「一个人」，不是「一条会话」** */
export interface AccountPermissions {
  /** 允许私聊响应 */
  private: boolean
  /** 允许在群里响应（被 @ 时）。只在 groupMemberGate 打开时才有意义 */
  group: boolean
  /** 允许调用工具（私聊群聊通用） */
  tool: boolean
  /**
   * P4：指令等级。**与上面三位正交**：它回答「能做多重的事」，
   * 三位回答「能不能做这类事」。缺省 = DEFAULT_ACCOUNT_LEVEL（low）。
   */
  level: CommandPermissionLevel
}

/**
 * 新增账号的默认权限：**只给群聊响应**，私聊与工具都要显式授权。
 *
 * 理由：把一个人加进名单，通常是为了「让他在群里能被 @ 到」；
 * 私聊与工具是会碰数据的，必须用户点一下才算给了。
 */
export const DEFAULT_ACCOUNT_PERMISSIONS: AccountPermissions = {
  private: false,
  group: true,
  tool: false,
  level: DEFAULT_ACCOUNT_LEVEL
}

/** 一个账号（QQ 号）及其权限 */
export interface ChannelAccount {
  channel: ChannelId
  /** QQ 号 —— **这是 userId，不是群号，也不是机器人号** */
  userId: string
  /** 备注，便于控制台认出是谁。空串表示没填 */
  label: string
  /** 加入时间（epoch ms） */
  addedAt: number
  /** 最近一次命中（epoch ms，0 = 从未）。面板「最近活动」用 */
  lastAt: number
  permissions: AccountPermissions
}

/** 群白名单的一条。**加白 ≠ 群里所有人都有权限**（那是 groupMemberGate 的事） */
export interface ChannelGroup {
  channel: ChannelId
  /** 群号 */
  chatId: string
  /** 群名 / 备注，空串表示没填 */
  label: string
  addedAt: number
  lastAt: number
}

/**
 * `userData/channels/access.json` 的整体形状（v2）。
 *
 * ⚠️ `uins` 是**机器人自己的登录号**列表（不是被授权的人）。
 *    它只用于两件事：① 面板显示「哪个号在跑」；② 区块面板把「(机器人号, 群) 组合」
 *    展开成具体的会话键 qq:<uin>:group:<群号>。授权判定**一个字节都不读它**。
 */
export interface ChannelAccessConfig {
  version: 2
  /** 群成员鉴权总开关。**默认 false** = 群里谁 @ 她都回（当前行为） */
  groupMemberGate: boolean
  /** 工具调用拦截总开关。默认 true = 按账号的 tool 权限校验 */
  toolGate: boolean
  /** 账号白名单（按人） */
  accounts: ChannelAccount[]
  /** 群白名单（按群） */
  groups: ChannelGroup[]
  /** 机器人自己的登录号（去重、纯数字） */
  uins: string[]
}

export const DEFAULT_CHANNEL_ACCESS: ChannelAccessConfig = {
  version: 2,
  groupMemberGate: false,
  toolGate: true,
  accounts: [],
  groups: [],
  uins: []
}

export interface AccessContext {
  channel: ChannelId
  chatType: 'private' | 'group'
  /** 发言人的 QQ 号 */
  senderId: string
}

export interface AccessDecision {
  /** 是否处于校验范围（false = 这个场景不校验，直接放行） */
  guarded: boolean
  /** 是否拦截 */
  blocked: boolean
  /** 拦截原因（blocked 时有值，人话） */
  reason: string
  /** 命中的账号条目 */
  account: ChannelAccount | null
}

const ALLOW: AccessDecision = { guarded: false, blocked: false, reason: '', account: null }

/** 人话标签，给面板与错误文案共用 */
const CHAT_TYPE_LABEL: Record<'private' | 'group', string> = {
  private: '私聊',
  group: '群聊'
}

export function findAccount(
  accounts: readonly ChannelAccount[],
  senderId: string,
  channel: ChannelId = 'qq'
): ChannelAccount | null {
  if (typeof senderId !== 'string' || senderId === '') return null
  return accounts.find((item) => item.channel === channel && item.userId === senderId) ?? null
}

export function findGroup(
  groups: readonly ChannelGroup[],
  chatId: string,
  channel: ChannelId = 'qq'
): ChannelGroup | null {
  if (typeof chatId !== 'string' || chatId === '') return null
  return groups.find((item) => item.channel === channel && item.chatId === chatId) ?? null
}

/**
 * 判定一条**消息**是否放行。
 *
 * 私聊：**始终校验**（私聊没有「旁观」语义，陌生号发消息不该进模型）。
 * 群聊：只在 `groupMemberGate` 打开时校验；关闭时恒放行（= 现状：群里谁 @ 她都回）。
 */
export function resolveMessageAccess(
  config: ChannelAccessConfig,
  context: AccessContext
): AccessDecision {
  if (context.chatType === 'group' && !config.groupMemberGate) return ALLOW
  const label = CHAT_TYPE_LABEL[context.chatType]
  const account = findAccount(config.accounts, context.senderId, context.channel)
  if (!account) {
    return {
      guarded: true,
      blocked: true,
      reason: label + '用户 ' + context.senderId + ' 不在 QQ 号白名单中',
      account: null
    }
  }
  const key = context.chatType === 'group' ? 'group' : 'private'
  if (!account.permissions[key]) {
    return {
      guarded: true,
      blocked: true,
      reason: label + '用户 ' + context.senderId + ' 未授予' + label + '权限',
      account
    }
  }
  return { guarded: true, blocked: false, reason: '', account }
}

/**
 * 判定一次**工具调用**是否放行。
 *
 * 🔴 这是「按人授权」的落点：同一个群里 A 有工具权限、B 没有，两人各问一句，
 *    A 的工具能执行、B 的会被拒（test:channel-access R3-A12）。
 *
 * `toolGate` 关闭时不校验 —— 那是用户显式关掉整层的行为（面板里标了「不推荐」）。
 */
export function resolveToolAccess(
  config: ChannelAccessConfig,
  context: AccessContext
): AccessDecision {
  if (!config.toolGate) return ALLOW
  const account = findAccount(config.accounts, context.senderId, context.channel)
  if (!account) {
    return {
      guarded: true,
      blocked: true,
      reason: '发言人 ' + context.senderId + ' 不在 QQ 号白名单中，不能调用工具',
      account: null
    }
  }
  if (!account.permissions.tool) {
    return {
      guarded: true,
      blocked: true,
      reason: 'QQ 号 ' + context.senderId + ' 未授予工具权限',
      account
    }
  }
  return { guarded: true, blocked: false, reason: '', account }
}

/** 是不是一个「号」（纯数字）。空串 / 非数字一律 false，不抛错 */
export function isQqNumber(value: unknown): boolean {
  return typeof value === 'string' && /^\d+$/.test(value)
}
