import type { ObserveConversation } from '@shared/observe'

/**
 * 旁听会话的搜索（纯函数：不 import React，node 测试直接跑）。
 *
 * 规则写死，不做「智能匹配」：
 *  - 查询按空白切成多个词，**每个词都要命中**（AND）—— 「群号 + 群名」这种组合很好用；
 *  - 单个词命中 会话号 / 名称 / 账号 uin / 「群聊」「私聊」 之一即算命中，大小写无关；
 *  - 空查询 → 原样返回（不复制、不排序，列表顺序仍由主进程决定）。
 *
 * 🔴 为什么不排序：面板里的顺序是主进程按「最近活动」给的，
 *    搜索只做过滤，用户滚到哪一行在下一次输入前都不该跳。
 */
export function filterObserveConversations(
  list: ObserveConversation[],
  query: string
): ObserveConversation[] {
  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return list
  return list.filter((item) => {
    const haystack = [
      item.chatId,
      item.label,
      item.uin,
      item.chatType === 'group' ? '群聊 group' : '私聊 private'
    ]
      .join('\n')
      .toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

/** 面板概要用：群 / 私聊各多少个（按会话号去重后的行数统计，与面板口径一致） */
export function countObserveKinds(list: ObserveConversation[]): { groups: number; privates: number } {
  let groups = 0
  let privates = 0
  for (const item of list) {
    if (item.chatType === 'group') groups += 1
    else privates += 1
  }
  return { groups, privates }
}
