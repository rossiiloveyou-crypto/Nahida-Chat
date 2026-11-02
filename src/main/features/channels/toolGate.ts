import { resolveToolAccess } from '@shared/channelAccess'
import type { ChannelAccessConfig } from '@shared/channelAccess'
import { isChannelSessionId, parseChannelKey } from '@shared/channels'
import { channelStore, type ChannelAccessStore } from './store'

/**
 * 渠道工具闸门（P9-R3）—— 全仓**唯一**的「这个人能不能用工具」判定点。
 *
 * 🔴 判定对象是**发言人**（QQ 号），不是会话。
 *    会话 = 机器人号 + 群号，整个群共用一条记录；按会话判等于
 *    「群里一个人有权限 = 全群都有」——用户 2026-11-02 明确否掉了这个粒度。
 *
 * 🔴 工具目录**照常给模型**（plus `tool-guard.ts:1-9` 的原话：
 *    「这件事本身需要被模型和用户看到」）。本闸门拦的是**执行**，不是**可见性**：
 *    模型看得到工具 → 会尝试 → 被拒 → 能对用户解释「我没有这个权限」。
 *    把工具从目录里摘掉的话，模型永远不尝试，用户只会觉得「她坏了」。
 *
 * 🔴 本文件**不读 session.mode**（总蓝图 M24：供给与授权正交）。
 *    判据 R3-C13 会逐行扫：注释里出现 mode 允许，代码行必须 0 命中。
 */
export interface ToolVerdict {
  allowed: boolean
  /** 拒绝理由。允许时为空串。会原样写进 record.error（进聊天气泡），必须是人话 + 指路 */
  reason: string
}

const ALLOW: ToolVerdict = { allowed: true, reason: '' }

/** 闸门依赖的最小 store 面（测试注入内存假店，不碰真实 userData） */
export type ToolGateStore = Pick<ChannelAccessStore, 'config'>

export function channelToolVerdictWith(
  store: ToolGateStore,
  senderId: string,
  sessionId: string
): ToolVerdict {
  // ① 非渠道会话（桌面）：本闸门不管。放在最前面是为了不让桌面每次工具调用都去读一次盘。
  //
  //    判据是**前缀**而不是 isChannelSessionId（后者要求 id 能完整解析）：
  //    带 qq: 前缀但解析不出来的 id 属于「看起来是渠道会话、实际形状坏了」，
  //    那种情况必须 fail-closed（下面第 ② 步），不能当成桌面放行。
  if (typeof sessionId !== 'string' || !sessionId.startsWith('qq:')) return ALLOW
  // ② 渠道会话 id 解析失败：fail-closed
  const parsed = parseChannelKey(sessionId)
  if (!parsed) return { allowed: false, reason: '渠道会话 id 解析失败，已按拒绝处理' }
  // ③ 拿不到是谁在说话：fail-closed（「不知道是谁」不能当成「他是好人」）
  if (!senderId) return { allowed: false, reason: '拿不到发言人标识，已按拒绝处理' }

  const config: ChannelAccessConfig = store.config()
  const decision = resolveToolAccess(config, {
    channel: 'qq',
    chatType: parsed.chatType,
    senderId
  })
  if (!decision.blocked) return ALLOW

  return {
    allowed: false,
    reason:
      '[' +
      decision.reason +
      '] 工具调用被拦截。需要授权时，在「设置 → 渠道控制台 → QQ 号白名单」里给这个号勾上「工具」。'
  }
}

export function channelToolVerdict(senderId: string, sessionId: string): ToolVerdict {
  return channelToolVerdictWith(channelStore, senderId, sessionId)
}
