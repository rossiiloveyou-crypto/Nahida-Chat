/**
 * `LlmMessage[]` ⇄ ST `chat[]` 的唯一转换点（P4 §1 第 4 行）。
 *
 * 全仓**只有这里**知道「NC 的历史长什么样」和「ST 的 chat 行长什么样」的差异。
 * 换一处就会出现两份映射：一份对、一份悄悄错，而且都不报错。
 *
 * 映射表（刻意的，不是随手写）：
 * | NC role    | ST 行                                  | 为什么 |
 * |------------|----------------------------------------|--------|
 * | user       | `is_user:true`                          | 用户的台词 |
 * | assistant  | `is_user:false`                         | 角色台词 |
 * | narration  | `is_user:false, is_system:true`         | 旁白是**故事内容**，要进上下文，但不能冒充任何一方发言 |
 * | system     | **丢弃**                                | 人设/时间/记忆由 ST 的 `extensionPrompt` 承担（P6 再做；蓝图 §1 第 4 行原话） |
 * | tool       | **丢弃**                                | M3：故事模式恒无工具，历史上不该有；出现就是上游用错，不往 ST 塞 |
 *
 * 🔴 `mes` 一律**逐字**搬运：不 trim、不折叠空白、不转义。ST 的宏/正则会自己处理，
 *    这里动一个字符，模型看到的历史就和 NC 里存的不是同一份（F-04）。
 */

import type { BridgeMessage } from '@shared/bridge'

/** ST 的 chat 行（只声明桥接读写到的字段；ST 侧还有 swipes 等，这里不碰） */
export interface StChatMessage {
  is_user: boolean
  mes: string
  name: string
  send_date?: string
  is_system?: boolean
  extra?: Record<string, unknown>
}

export interface MapOptions {
  /** 用户侧的 `name`（ST 用它渲染发言人；不参与 prompt 的人称） */
  userName?: string
  /** 角色侧的 `name` */
  assistantName?: string
  /** 旁白的 `name` */
  systemName?: string
  /** `send_date` 的基准时刻；缺省 = 当前时间。单测传固定值即可复现 */
  now?: number
}

/** 映射时被丢掉的条数（**必须能被调用方看到**：静默丢 system 是设计，静默丢 user 是 bug） */
export interface MapDropped {
  system: number
  tool: number
  empty: number
}

export interface MapReport {
  chat: StChatMessage[]
  dropped: MapDropped
}

const DEFAULTS = { userName: 'User', assistantName: 'Assistant', systemName: 'System' }

function isBlank(content: string): boolean {
  return typeof content !== 'string' || content.length === 0
}

/**
 * 带丢弃统计的映射（driver 用它，单测也用它）。
 * `toStChat` 是它的薄封装：不想看统计的地方只拿 chat。
 */
export function mapMessages(messages: BridgeMessage[], options: MapOptions = {}): MapReport {
  const userName = options.userName ?? DEFAULTS.userName
  const assistantName = options.assistantName ?? DEFAULTS.assistantName
  const systemName = options.systemName ?? DEFAULTS.systemName
  const base = typeof options.now === 'number' ? options.now : Date.now()

  const chat: StChatMessage[] = []
  const dropped: MapDropped = { system: 0, tool: 0, empty: 0 }

  for (const message of Array.isArray(messages) ? messages : []) {
    const content = typeof message?.content === 'string' ? message.content : ''
    if (message?.role === 'system') {
      dropped.system += 1
      continue
    }
    if (message?.role === 'tool') {
      dropped.tool += 1
      continue
    }
    if (isBlank(content)) {
      dropped.empty += 1
      continue
    }

    const row: StChatMessage =
      message.role === 'user'
        ? { is_user: true, mes: content, name: userName, is_system: false }
        : message.role === 'narration'
          ? { is_user: false, mes: content, name: systemName, is_system: true }
          : { is_user: false, mes: content, name: assistantName, is_system: false }
    // send_date 按行号递增 1s：ST 的排序/时间显示不依赖它，但同值会让「时间线」看起来是假的
    row.send_date = new Date(base + chat.length * 1000).toISOString()
    chat.push(row)
  }

  return { chat, dropped }
}

/** 便捷入口：只要 chat */
export function toStChat(messages: BridgeMessage[], options: MapOptions = {}): StChatMessage[] {
  return mapMessages(messages, options).chat
}

/**
 * ST chat → NC 历史（反向）。
 *
 * 🔴 反向**只用于取回与自检**（harvest 的第二证据、单测的往返比对），
 *    不是「把 ST 的历史搬回 NC」—— NC 的历史永远由 NC 自己维护（M2）。
 */
export function fromStChat(chat: StChatMessage[]): BridgeMessage[] {
  const out: BridgeMessage[] = []
  for (const row of Array.isArray(chat) ? chat : []) {
    const content = typeof row?.mes === 'string' ? row.mes : ''
    if (row?.is_system === true) out.push({ role: 'narration', content })
    else if (row?.is_user === true) out.push({ role: 'user', content })
    else out.push({ role: 'assistant', content })
  }
  return out
}

/**
 * 往返自检：`fromStChat(toStChat(x))` 必须与 x 逐字一致（F-04 / A1 的主断言）。
 * 返回不一致的下标，空数组 = 一致。
 */
export function roundTripDiff(messages: BridgeMessage[], options: MapOptions = {}): number[] {
  // 只比「会被映射的那部分」：system / tool / 空正文按设计丢弃，把它们算成差异只会得到假红
  const kept = (Array.isArray(messages) ? messages : []).filter(
    (item) =>
      !!item && item.role !== 'system' && item.role !== 'tool' && typeof item.content === 'string' && item.content.length > 0
  )
  const back = fromStChat(toStChat(kept, options))
  const diff: number[] = []
  const length = Math.max(back.length, kept.length)
  for (let i = 0; i < length; i += 1) {
    const left = back[i]
    const right = kept[i]
    if (!left || !right) {
      diff.push(i)
      continue
    }
    if (left.role !== right.role || left.content !== right.content) diff.push(i)
  }
  return diff
}
