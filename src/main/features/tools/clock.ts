import { registerTool } from './registry'

/**
 * 时间感知。
 *
 * 存在的理由：模型自己的"现在"是训练截止日期，靠它算「今天几号 / 还有几天」
 * 一定错。所以时间必须以本机运行时为准，分两条路给到模型：
 *
 *   1. 每轮对话开始时由 chatService 注入一段 system 提示（{@link clockNotice}）——
 *      被动注入，模型不动手也能知道现在几点，Chat 模式（没有工具）同样有效。
 *   2. clock.now 工具——需要精确到"调用的这一刻"时主动再问一次，
 *      长对话里注入的时间块会过期，工具调用永远是新鲜的。
 *
 * 两端共用同一份格式化代码：注入的文本和工具返回的文本必须长得一样，
 * 否则模型会读出两种口径、两种时区写法，白白消耗注意力。
 */

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export interface ClockSnapshot {
  /** Unix 毫秒时间戳 */
  epochMs: number
  /** 带时区偏移的 ISO 8601，如 2026-11-02T00:27:59+08:00 */
  iso: string
  /** 该时区下的日历日期，如 2026-11-02 */
  date: string
  /** 该时区下的时刻，如 00:27:59 */
  time: string
  /** 中文星期，如 星期日 */
  weekday: string
  /** IANA 时区名，如 Asia/Shanghai */
  timeZone: string
  /** 相对 UTC 的偏移，如 +08:00 */
  utcOffset: string
}

/**
 * 本机时区。Electron 里拿不到时回落到 UTC——
 * 时间戳本身永远是准的，只有显示用的偏移会退化，不会误导成错误日期。
 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * 取一份时间快照。
 *
 * timeZone 传 IANA 名（Asia/Shanghai、UTC、America/New_York）。
 * 非法时区直接抛错而不是静默回落到本机时区：模型传错参数时，
 * 静默回落会让它以为"纽约现在也是东八区"，错得比报错难查得多。
 */
export function clockSnapshot(now: Date = new Date(), timeZone?: string): ClockSnapshot {
  const zone = timeZone && timeZone.trim() ? timeZone.trim() : localTimeZone()

  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset'
    }).formatToParts(now)
  } catch {
    throw new Error(
      '无效的时区：' + zone + '。请使用 IANA 时区名，例如 Asia/Shanghai、UTC、America/New_York。'
    )
  }

  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''

  const date = pick('year') + '-' + pick('month') + '-' + pick('day')
  const time = pick('hour') + ':' + pick('minute') + ':' + pick('second')
  const utcOffset = normalizeOffset(pick('timeZoneName'))

  return {
    epochMs: now.getTime(),
    iso: date + 'T' + time + utcOffset,
    date,
    time,
    weekday: WEEKDAYS[weekdayOf(date)],
    timeZone: zone,
    utcOffset
  }
}

/**
 * 一段给人看、也给模型看的时间文本。
 * 三行以内：模型不需要更多，多一行就多一分被当成指令解读的风险。
 */
export function describeClock(snapshot: ClockSnapshot): string {
  return [
    '当前时间：' + snapshot.date + ' ' + snapshot.time + '（' + snapshot.weekday + '）',
    '时区：' + snapshot.timeZone + '（UTC' + snapshot.utcOffset + '）',
    'ISO 8601：' + snapshot.iso + ' ｜ Unix 毫秒：' + String(snapshot.epochMs)
  ].join('\n')
}

/**
 * 注入到 system 提示里的时间块。
 *
 * 措辞上刻意写死两件事：
 * - 「本轮开始时」——让模型明白这个值有保鲜期，长对话要重新取；
 * - 「不是训练数据里的时间」——直接掐掉"我记得现在是 2024 年"这类错误先验。
 */
export function clockNotice(now: Date = new Date()): string {
  return [
    '## 当前时间（运行时注入，本轮开始时采样）',
    describeClock(clockSnapshot(now)),
    '这是本机真实时间，不是训练数据里的时间；涉及「现在 / 今天 / 今年 / 还有多久 / 过期了没」时以它为准，不要凭记忆推算。',
    '需要精确到调用的这一刻（例如跨了午夜、或间隔很久之后才回答），调用 clock.now 重新取一次。'
  ].join('\n')
}

export function registerClockTools(): void {
  registerTool({
    definition: {
      name: 'clock.now',
      title: '当前时间',
      description:
        '返回本机当前时间（ISO 8601、中文星期、时区与 Unix 毫秒）。timezone 传 IANA 时区名可查其它时区的当前时刻，' +
        '例如 Asia/Shanghai、UTC、America/New_York；不传则用本机时区。',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA 时区名，如 Asia/Shanghai；不传则用本机时区'
          }
        },
        required: []
      }
    },
    async run(args) {
      const raw = typeof args.timezone === 'string' ? args.timezone.trim() : ''
      const snapshot = clockSnapshot(new Date(), raw || undefined)
      const local = localTimeZone()
      const lines = [describeClock(snapshot)]
      // 查的是别的时区时，顺带给出本机时间：模型接着算「和用户当地差几小时」不用再调一次
      if (raw && raw !== local) {
        lines.push('本机时区：' + local + '（UTC' + clockSnapshot(new Date(), local).utcOffset + '）')
      }
      return { ok: true, output: lines.join('\n') }
    }
  })
}

/** parts 里拿到的是 "GMT+08:00" / "GMT" 这种写法，统一成 "+08:00" / "+00:00" */
function normalizeOffset(raw: string): string {
  const match = raw.match(/([+-])(\d{2}):?(\d{2})/)
  if (match) return match[1] + match[2] + ':' + match[3]
  return '+00:00'
}

/** 用 UTC 日历反推星期：date 已经是目标时区下的日历日期，不受本机时区影响 */
function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map((part) => Number(part))
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1)).getUTCDay()
}
