/**
 * 旁听记录（P8）—— 群/私聊里说过的原话，按会话、按行、只增不清。
 *
 * 🔴 与 cyrene-agent 的 history-log 的关系：只抄形状，不抄截断与归档。
 *    cyrene: 超 200 行截断 + 按月搬家  ⇒ 旧数据会从原文件消失
 *    这里  : 超 32 MiB 开新分片        ⇒ 任何一行都永远留在它当初写入的那个文件里
 *
 * 🔴 旁听 ≠ 记忆。本文件记录的是**语料**（谁在什么时候说了什么），
 *    不进 userData/memory.db，不参与 RAG 检索。要参与必须另立一项工程。
 *
 * 本文件**零运行时 import**（与 shared/channels.ts 同规格）。
 * outcome 用字符串字面量联合单独声明，不 import QqEventOutcome ——
 * 那会把 shared/qq.ts 拖进来（它还 type-import 了 qqHost）。
 */

export const OBSERVE_DIR_NAME = 'observe'

/** 单片上限。超过就开 <chatId>.2.jsonl、.3.jsonl…（旧片只读封存） */
export const OBSERVE_SEGMENT_BYTES = 32 * 1024 * 1024

/** 读尾部时默认取多少字节（面板「最近 50 条」用） */
export const OBSERVE_TAIL_BYTES = 256 * 1024

/** 面板提示「该自己清一下了」的阈值。程序不会删任何东西。 */
export const OBSERVE_WARN_BYTES = 2 * 1024 * 1024 * 1024

/** 文件里一行 JSON 的形状。字段只增不改（旧行永远可读） */
export interface ObserveRecord {
  /** 记录格式版本。将来加字段时旧行没有它也能读（缺省按 1 处理） */
  v: 1
  /** 本行唯一 id（观测用，不参与业务） */
  id: string
  /** epoch ms */
  at: number
  /** 渠道会话 id（P6 定义，= key） */
  sessionId: string
  key: string
  channel: 'qq'
  /** 机器人自己的 QQ 号 */
  uin: string
  chatType: 'private' | 'group'
  chatId: string
  /** 群名（优先取事件里的 group_name），私聊为空串 */
  chatLabel: string
  /** 白名单里的备注/群名（P6 的 label） */
  entryLabel: string
  messageId: string
  speakerId: string
  speakerName: string
  /** 群名片/头衔（事件 sender.card），可能为空 */
  speakerCard: string
  /** 说话的人是不是机器人自己 */
  isBot: boolean
  /** 是否 @ 了机器人 */
  mentioned: boolean
  /** 是否真的送进了模型（false = 被 @ 判定/限速/队列挡下） */
  triggered: boolean
  /**
   * 该会话是否在白名单里（2026-11-01 加，群语料口径）。
   *
   * 群聊现在**全采**，所以会同时出现 allowed=false 的行（没加白的群）。
   * 将来做风格学习时，用 allowed + triggered + chatType 三个字段一起筛样本：
   * 采集期不过滤，信息一个不丢。
   */
  allowed: boolean
  /** 这条消息最终的归宿 */
  outcome: ObserveOutcome
  /** 纯文本（只取 text 段，与 QqInbound.text 同源） */
  text: string
  /** 段类型列表，如 ['text','image']。**不落二进制** */
  segmentTypes: string[]
}

/** 与 QqEventOutcome 同值域，但单独声明（见文件头：不 import shared/qq） */
export type ObserveOutcome =
  | 'responded'
  | 'empty-reply'
  | 'failed'
  | 'error-reply'
  | 'dropped-not-message'
  | 'dropped-self-echo'
  | 'dropped-bad-chat'
  | 'dropped-non-text'
  | 'dropped-unbound'
  | 'dropped-no-permission'
  | 'dropped-not-authorized-member'
  | 'dropped-not-mentioned'
  | 'dropped-duplicate'
  | 'dropped-rate-limited'
  | 'dropped-queue-full'

/** 面板的一行：一个会话的汇总 */
export interface ObserveConversation {
  key: string
  uin: string
  chatType: 'private' | 'group'
  chatId: string
  /** 取最近一行里的 chatLabel / entryLabel */
  label: string
  /** 分片数（>= 1） */
  segments: number
  bytes: number
  /** 大致行数（按换行符计；崩溃后半行会被算进去，所以是「大致」） */
  lines: number
  /** 最近一行的 at（0 = 读不到） */
  lastAt: number
}

export interface ObserveStatus {
  /** observe/ 的绝对路径 */
  root: string
  /** 会话数 */
  conversations: number
  /** 总分片文件数 */
  files: number
  totalBytes: number
  totalLines: number
  /** 超过这个字节数就在面板上提示「该自己清一下了」（程序不删） */
  warnBytes: number
  /** totalBytes > warnBytes */
  warn: boolean
}

/**
 * 把任意字符串变成一个**安全且可读**的路径片段。
 *
 * Windows 非法字符：< > : " / \ | ? *  以及控制字符、结尾的点与空格。
 * 渠道会话 id 形如 qq:1:private:1（含冒号），直接当文件名会 EINVAL（P8 §2.1 E8）。
 *
 * 规则：允许 [0-9A-Za-z_-] 原样；其余字符替换成 '_'。
 * QQ 号与群号全是数字，所以正常情况**不会发生替换**。
 * 替换掉了就说明上游给了异常值 —— 调用方（store）必须先用 isSafeSegment 拒绝，而不是依赖这里。
 */
export function safeSegment(value: string): string {
  return String(value ?? '').replace(/[^0-9A-Za-z_-]/g, '_')
}

/**
 * 路径片段校验：接受非空、长度 <= 64、只含 [0-9A-Za-z_-]。
 *
 * 🔴 这是**路径穿越的唯一边界**。uin / chatId / 分片号都要过它。
 *    不要因为「QQ 号一定是数字」就跳过 —— 白名单是用户可以手改的 JSON 文件。
 */
export function isSafeSegment(value: string): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 64) return false
  return /^[0-9A-Za-z_-]+$/.test(value)
}
