import { useState } from 'react'
import type { ObserveConversation, ObserveRecord } from '@shared/observe'
import { useObserve } from '../useObserve'

/**
 * 「旁听库」面板（P8 §4.7，渠道控制台 D 区）。
 *
 * 只读展示 + 一个「看最近 50 条」抽屉。**没有任何删除按钮** ——
 * 旁听库「只增不清」是用户裁决（M21b），程序没有删除路径，面板也不给入口。
 *
 * 文案必须写清的三件事（§4.7.2）：
 *  1. 采集条件（群聊全采 / 私聊需在白名单）—— 不写清用户会以为「加了白就在记」；
 *  2. 只增不清：增长靠分片，磁盘占满由用户自己处理；
 *  3. 不进记忆：旁听的内容不会自动变成长期记忆，当前模型也读不到。
 */

function sizeLabel(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return String(bytes) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function timeLabel(at: number): string {
  if (!at) return '—'
  try {
    return new Date(at).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

function chatLabelOf(item: ObserveConversation): string {
  if (item.label) return item.label
  return item.chatType === 'group' ? '（未命名群）' : '（未命名）'
}

function outcomeLabel(record: ObserveRecord): string {
  if (record.triggered) return record.outcome === 'responded' ? '已回复' : '进过模型'
  return '未触发 · ' + record.outcome.replace('dropped-', '')
}

export function ObservePanel() {
  const observe = useObserve()
  const [tailOf, setTailOf] = useState<ObserveConversation | null>(null)
  /**
   * 同一个 chatId 被几个账号记着（P9-R2 / J-64）。
   *
   * 用户有多个 QQ 号，同一句群消息会被每个号各记一份 —— 这是**有意的**
   * （多账号互为备份，换号/掉线时不丢档），不是 bug。
   * 但面板不显示 uin 时，用户会以为「同一个群记了两遍」。修显示口径，不改存储。
   */
  const accountCount = new Map<string, number>()
  for (const item of observe.conversations) {
    accountCount.set(item.chatId, (accountCount.get(item.chatId) ?? 0) + 1)
  }
  /** 被 ≥2 个账号同时记录的**会话号**个数（不是行数，也不是「多出来的行数」） */
  const multiChatIds = [...accountCount.values()].filter((count) => count > 1).length
  /** 因为多账号而多出来的行数（合计里那句「同一条消息可能被记多次」指的就是它们） */
  const duplicateRows = observe.conversations.length - accountCount.size
  const [tail, setTail] = useState<ObserveRecord[]>([])
  const [notice, setNotice] = useState('')

  const openTail = async (item: ObserveConversation): Promise<void> => {
    setTailOf(item)
    setNotice('')
    setTail(await observe.tail(item, 50))
  }

  const total = observe.status

  return (
    <section className="setting-group" data-ui-region="D 旁听库">
      <h3 className="setting-group__title">旁听库（群语料）</h3>
      <p className="setting-group__desc">
        群里说过的话会<strong>一行一条</strong>记到本地文件，给将来的风格学习攒原料。
        群聊<strong>全部记录</strong>（不看白名单），私聊<strong>只记白名单里的</strong>。
        记录不等于会回复 —— 记下来只是攒语料。
      </p>
      <p className="setting-group__desc">
        同一句话如果被多个 QQ 号同时旁听，会<strong>各记一份</strong> —— 这是<strong>有意的</strong>
        （多账号互为备份，换号 / 掉线时不丢档）。「账号」列就是「哪个号记的」，
        带 <em className="qq-tag-multi">⧉N</em> 角标的行表示同一个群被 N 个号同时记着。
      </p>
      <p className="setting-group__desc">
        ⚠️ <strong>只增不清</strong>：程序没有任何删除路径，增长靠「单文件超过 32 MiB 就开下一个分片」，
        旧分片原样封存。磁盘占满由你自己处理。
        <br />
        ⚠️ <strong>不进记忆</strong>：旁听内容不会变成长期记忆，当前也不参与任何提示词。
      </p>

      {observe.error && (
        <p className="hint-text hint-text--error" data-ui-target="旁听错误">
          {observe.error}
        </p>
      )}

      <p className="hint-text" data-ui-target="旁听根目录">
        <code>{total?.root || '—'}</code>
      </p>

      <p className="hint-text" data-ui-target="旁听合计">
        合计：{total?.conversations ?? 0} 个会话（含多账号重复）· {total?.files ?? 0} 个文件 ·{' '}
        {sizeLabel(total?.totalBytes ?? 0)} · 约 {total?.totalLines ?? 0} 行
      </p>
      {multiChatIds > 0 && (
        <p className="hint-text" data-ui-target="旁听跨账号提示">
          其中 <strong>{multiChatIds}</strong> 个会话号被多个账号同时记录（因此表里多出{' '}
          {duplicateRows} 行）。行数是文件行数，同一条消息可能被记多次 —— 这是多账号互为备份，
          不是重复写入。
        </p>
      )}

      {total?.warn && (
        <p className="hint-text hint-text--error" data-ui-target="旁听容量提示">
          旁听库已超过 {sizeLabel(total.warnBytes)}。程序不会自动清理，建议你自己归档或清理。
        </p>
      )}
      {notice && <p className="hint-text">{notice}</p>}

      <div className="qq-table qq-table--observe" data-ui-target="旁听会话表">
        <div className="qq-table__head">
          <span>类型</span>
          <span>账号</span>
          <span>会话号</span>
          <span>名称</span>
          <span>行数</span>
          <span>大小</span>
          <span>最近</span>
          <span>操作</span>
        </div>
        {observe.loading && <p className="hint-text">加载中…</p>}
        {!observe.loading && observe.conversations.length === 0 && (
          <p className="hint-text">
            还没有任何旁听记录。群里说一句话就会在这里出现（群聊不需要加白名单）。
          </p>
        )}
        {observe.conversations.map((item) => (
          <div className="qq-table__row" key={item.key}>
            <span>{item.chatType === 'group' ? '群聊' : '私聊'}</span>
            <span title={'记录账号 uin：' + item.uin}>{item.uin}</span>
            <span title={item.key}>
              {item.chatId}
              {(accountCount.get(item.chatId) ?? 0) > 1 && (
                <em
                  className="qq-tag-multi"
                  title={'该群另有 ' + String((accountCount.get(item.chatId) ?? 1) - 1) + ' 个账号在记录'}
                >
                  ⧉{accountCount.get(item.chatId)}
                </em>
              )}
            </span>
            <span>{chatLabelOf(item)}</span>
            <span>
              约 {item.lines}
              {item.segments > 1 ? '（' + String(item.segments) + ' 片）' : ''}
            </span>
            <span>{sizeLabel(item.bytes)}</span>
            <span>{timeLabel(item.lastAt)}</span>
            <span className="qq-table__actions">
              <button
                type="button"
                className="btn-ghost btn-ghost--sm"
                onClick={() => void openTail(item)}
              >
                看最近
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="settings-actions" data-ui-target="旁听操作">
        <button type="button" className="btn-ghost" onClick={() => void observe.refresh()}>
          刷新
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!total?.root}
          onClick={() => {
            void observe.openDir().then((error) => {
              if (error) setNotice('打开目录失败：' + error)
            })
          }}
        >
          打开目录
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!total?.root}
          onClick={() => {
            if (total?.root) void navigator.clipboard.writeText(total.root)
          }}
        >
          复制路径
        </button>
      </div>

      {tailOf && (
        <div className="setting-group" data-ui-target="旁听抽屉">
          <h4 className="setting-group__title">
            最近 50 条 · {tailOf.chatType === 'group' ? '群' : '私聊'} {tailOf.chatId} ·{' '}
            {chatLabelOf(tailOf)}
          </h4>
          <p className="setting-group__desc">
            这里只读。行数是大致值（进程被杀时的半行会被跳过，不会被修复）。
          </p>
          {tail.length === 0 && <p className="hint-text">这个会话还没有可读的记录。</p>}
          <div className="qq-table qq-table--observe-tail">
            {tail.map((record) => (
              <div className="qq-table__row" key={record.id}>
                <span>{timeLabel(record.at)}</span>
                <span>
                  {record.speakerName || record.speakerId || '—'}
                  {record.speakerCard && record.speakerCard !== record.speakerName
                    ? '（' + record.speakerCard + '）'
                    : ''}
                </span>
                <span>{outcomeLabel(record)}</span>
                <span>{record.text}</span>
              </div>
            ))}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn-ghost" onClick={() => setTailOf(null)}>
              收起
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
