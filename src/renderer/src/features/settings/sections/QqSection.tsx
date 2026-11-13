import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { QqSettings } from '@shared/qq'
import { COMMAND_NAMES } from '@shared/persona'
import type { CommandName, CommandPermissionLevel } from '@shared/persona'
import { useQq } from '../useQq'

/**
 * 设置页「QQ」面板（P4 G7，P6 删掉绑定表）。
 *
 * 四个区块的顺序就是用户的操作顺序：宿主状态 → 注入哪个 QQ → 行为开关 → 最近事件。
 * 最后一块是排查「为什么不回我」的唯一现场。
 *
 * P6：原来的 C 区「绑定表」整块删除 —— 谁能响应改由「渠道控制台」（P7）决定，
 * 数据源是 userData/channels/access.json。本面板不再有「把外部会话绑到哪条本机会话」
 * 这回事（会话 id 由外部键直接算出）。
 *
 * 🔴 进程列表**只读**：本组件从不自动调用 load()（M2：多 QQ 进程必须用户点选）。
 */

const OUTCOME_LABEL: Record<string, string> = {
  responded: '已回复',
  'empty-reply': '空回复，未发送',
  failed: '失败',
  'error-reply': '生成出错，已回错误提示',
  'dropped-not-message': '非消息事件',
  'dropped-self-echo': '自己的回声（已忽略）',
  'dropped-bad-chat': '会话信息不全',
  'dropped-non-text': '非文本消息',
  'dropped-unbound': '不在白名单（不响应）',
  'dropped-no-permission': '在白名单但未授权回复',
  // P9-R3：按「人」判 —— 私聊不在账号白名单 / 群成员鉴权没过，都记这个理由
  'dropped-not-authorized-member': '发言人不被允许（按人授权）',
  'dropped-not-mentioned': '群里没 @ 她',
  'dropped-duplicate': '重复消息',
  'dropped-rate-limited': '触发限速',
  'dropped-queue-full': '队列已满',
  // P4：指令被接住，没有进模型。成功与失败分开，排查「//switch 没反应」时才有依据
  'command-handled': '已执行指令',
  'command-failed': '指令出错'
}

/** P4：指令门槛的四个等级。与 shared/persona.ts 的等级名一一对应，顺序即强弱 */
const LEVEL_OPTIONS = [
  { value: 'none', label: '无' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' }
] as const

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome
}

function timeLabel(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

export function QqSection() {
  const qq = useQq()

  const [draft, setDraft] = useState<QqSettings | null>(null)
  const [logs, setLogs] = useState<{ level: string; line: string }[]>([])

  useEffect(() => {
    if (qq.settings) setDraft(qq.settings)
  }, [qq.settings])

  const host = qq.status?.host
  const stats = qq.status?.stats
  const degraded = host?.state === 'degraded'

  const patch = (value: Partial<QqSettings>): void => {
    setDraft((prev) => (prev ? { ...prev, ...value } : prev))
  }

  /**
   * P4：改一条指令的门槛。
   *
   * 🔴 走**同一条** `patch`（= 同一个「保存设置」按钮）：门槛是 `QqSettings` 的一个字段，
   *    为它单开一条保存路径就是两处真值（B2），而且会出现「改了但没点保存」的半截状态。
   */
  const patchThreshold = (name: CommandName, value: CommandPermissionLevel): void => {
    if (!draft) return
    patch({ commandThresholds: { ...draft.commandThresholds, [name]: value } })
  }

  const refreshLogs = async (): Promise<void> => {
    try {
      setLogs(await window.nahida.qq.logs(20))
    } catch {
      setLogs([])
    }
  }

  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>QQ 接入</h1>
        <p>
          把 QQ 当作一个外部会话接进 Nahida Chat：QQ 里收到的消息会送进它自己的渠道会话，
          回复按句切开逐条发回去。注入只在点击「注入」后发生，不会自动挑进程。
        </p>
      </div>

      <p className="hint-text" data-ui-target="权限说明">
        谁来响应、谁能用工具，已经统一移到{' '}
        <Link to="/settings/channels" data-ui-target="渠道控制台链接">
          渠道控制台
        </Link>
        。这里只管宿主进程与出站行为。
      </p>

      {qq.loading && <p className="hint-text">读取中…</p>}
      {qq.error && <p className="hint-text hint-text--error">{qq.error}</p>}
      {qq.notice && <p className="hint-text">{qq.notice}</p>}

      <section className="setting-group" data-ui-region="A 宿主状态">
        <h3 className="setting-group__title">宿主状态</h3>
        <p className="setting-group__desc">
          snowluma-host 是独立的 node 进程；它崩了不影响聊天窗口，这里会显示降级原因。
          它是 QQ 注入与收发的唯一入口。
        </p>
        {host ? (
          <dl className="info-grid" data-ui-target="宿主状态表">
            <dt>状态</dt>
            <dd>
              {host.state}
              {host.readyMs !== null ? ' · 握手 ' + String(host.readyMs) + ' ms' : ''}
            </dd>
            <dt>PID</dt>
            <dd>{host.pid === null ? '—' : host.pid}</dd>
            <dt>Node / N-API</dt>
            <dd>
              {host.node ?? '—'} / {host.napi ?? '—'}
            </dd>
            <dt>数据目录</dt>
            <dd>{host.home ?? qq.status?.dataDir ?? '—'}</dd>
            <dt>产物目录</dt>
            <dd>{host.hostDir ?? '—'}</dd>
            <dt>最近事件</dt>
            <dd>
              收到 {stats ? stats.received : 0} · 回复 {stats ? stats.responded : 0} · 发送{' '}
              {stats ? stats.sent : 0} · 指令 {stats ? (stats.commands ?? 0) : 0} · 失败{' '}
              {stats ? stats.failed + (stats.commandsFailed ?? 0) : 0}
            </dd>
            {host.lastError && (
              <>
                <dt>最近错误</dt>
                <dd className="hint-text hint-text--error">{host.lastError}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="hint-text">宿主状态不可用。</p>
        )}
        <div className="settings-actions" data-ui-target="宿主操作">
          <button type="button" className="btn-ghost" onClick={() => void qq.refresh()} disabled={qq.busy}>
            刷新
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void qq.restart()}
            disabled={qq.busy || host?.state === 'starting'}
          >
            重启宿主
          </button>
          <button type="button" className="btn-ghost" onClick={() => void refreshLogs()}>
            查看最近日志
          </button>
        </div>
        {degraded && (
          <p className="hint-text hint-text--error">
            宿主已降级。先确认 out/snowluma-host 里的 node.exe 与 index.mjs 还在，再点「重启宿主」。
          </p>
        )}
        {logs.length > 0 && (
          <div className="qq-logs">
            {logs.map((item, index) => (
              <div className="qq-logs__line" key={String(index)}>
                <span className={item.level === 'error' ? 'qq-logs__level is-error' : 'qq-logs__level'}>
                  {item.level}
                </span>
                <code>{item.line}</code>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="setting-group" data-ui-region="B QQ 进程">
        <h3 className="setting-group__title">QQ 进程</h3>
        <p className="setting-group__desc">
          列出本机所有 QQ 主进程。不会自动注入任何一个 —— 有多个 QQ 时，由你决定注入哪一个。
        </p>
        <div className="qq-table" data-ui-target="进程列表">
          <div className="qq-table__head">
            <span>PID</span>
            <span>进程</span>
            <span>注入</span>
            <span>账号</span>
            <span>操作</span>
          </div>
          {qq.processes.length === 0 && (
            <p className="hint-text">没有发现 QQ 进程。先启动 QQ 并登录，再点「刷新」。</p>
          )}
          {qq.processes.map((item) => (
            <div className="qq-table__row" key={item.pid}>
              <span>{item.pid}</span>
              <span title={item.path}>{item.name}</span>
              <span className={item.injected ? 'qq-tag is-on' : 'qq-tag'}>
                {item.injected ? (item.connected ? '在线' : '已注入') : '未注入'}
              </span>
              <span>{item.account ? item.account.nickname + '(' + item.account.uin + ')' : item.uin || '—'}</span>
              <span className="qq-table__actions">
                <button
                  type="button"
                  className="btn-ghost btn-ghost--sm"
                  disabled={qq.busy || item.injected}
                  onClick={() => void qq.load(item.pid)}
                >
                  注入
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-ghost--sm"
                  disabled={qq.busy || !item.injected}
                  onClick={() => void qq.unload(item.pid)}
                >
                  卸载
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="setting-group" data-ui-region="C 行为开关">
        <h3 className="setting-group__title">行为开关</h3>
        <p className="setting-group__desc">
          切段与限速决定"一条长回复怎么落到 QQ"。段数/码点上限是硬的，超了会被拆开发。
        </p>
        {draft ? (
          <div data-ui-target="开关组">
            <label className="field">
              <span className="field__label">typing 提示（仅私聊，M12）</span>
              <select
                className="field__control"
                value={draft.typingMode}
                onChange={(event) =>
                  patch({ typingMode: event.target.value === 'status' ? 'status' : event.target.value === 'off' ? 'off' : 'text' })
                }
              >
                <option value="text">发一条极短文本</option>
                <option value="status">set_input_status（未真机验证）</option>
                <option value="off">不做</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">typing 文本</span>
              <input
                className="field__control"
                value={draft.typingText}
                disabled={draft.typingMode !== 'text'}
                onChange={(event) => patch({ typingText: event.target.value })}
              />
            </label>
            <label className="memory-check">
              <input
                type="checkbox"
                checked={draft.groupRequireMention}
                onChange={(event) => patch({ groupRequireMention: event.target.checked })}
              />
              <span>群里必须 @ 她才回应</span>
            </label>
            <label className="memory-check">
              <input
                type="checkbox"
                checked={draft.atOnGroupReply}
                onChange={(event) => patch({ atOnGroupReply: event.target.checked })}
              />
              <span>群聊首段 @ 提问者</span>
            </label>
            <div className="field__row">
              <label className="field">
                <span className="field__label">段间延迟（ms）</span>
                <input
                  className="field__control"
                  type="number"
                  min={0}
                  max={5000}
                  value={draft.segmentDelayMs}
                  onChange={(event) => patch({ segmentDelayMs: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span className="field__label">单句段数上限</span>
                <input
                  className="field__control"
                  type="number"
                  min={1}
                  max={20}
                  value={draft.maxSegments}
                  onChange={(event) => patch({ maxSegments: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span className="field__label">单段码点上限</span>
                <input
                  className="field__control"
                  type="number"
                  min={200}
                  max={4000}
                  value={draft.maxCharsPerSegment}
                  onChange={(event) => patch({ maxCharsPerSegment: Number(event.target.value) })}
                />
              </label>
            </div>
            <div className="field__row">
              <label className="field">
                <span className="field__label">每用户 / 60s</span>
                <input
                  className="field__control"
                  type="number"
                  min={1}
                  max={1000}
                  value={draft.rateLimitPerUser}
                  onChange={(event) => patch({ rateLimitPerUser: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span className="field__label">每渠道 / 60s</span>
                <input
                  className="field__control"
                  type="number"
                  min={1}
                  max={1000}
                  value={draft.rateLimitPerChannel}
                  onChange={(event) => patch({ rateLimitPerChannel: Number(event.target.value) })}
                />
              </label>
            </div>
            <label className="field">
              <span className="field__label">出错时回给对端的一句话（留空 = 不回）</span>
              <input
                className="field__control"
                value={draft.errorReplyText}
                onChange={(event) => patch({ errorReplyText: event.target.value })}
              />
            </label>
            <div className="settings-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={qq.busy}
                onClick={() => void qq.saveSettings(draft)}
              >
                {qq.busy ? '保存中…' : '保存设置'}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={!qq.settings}
                onClick={() => setDraft(qq.settings)}
              >
                还原
              </button>
            </div>
          </div>
        ) : (
          <p className="hint-text">读取设置中…</p>
        )}
      </section>

      <section className="setting-group" data-ui-region="C2 指令门槛">
        <h3 className="setting-group__title">指令门槛</h3>
        <p className="setting-group__desc">
          每条指令要多少等级才允许使用。账号等级在「渠道控制台 → QQ 号白名单」里逐人设置。
          等级从低到高：无 &lt; 低 &lt; 中 &lt; 高。
          <br />
          指令只在<strong>渠道侧</strong>生效：以 <code>//</code> 开头的一行不会送进模型，
          也不建会话。<code>//list</code> 看人设、<code>//switch</code> 切换、
          <code>//add</code> 新建、<code>//dele</code> 删除。
        </p>
        {draft ? (
          <div data-ui-target="门槛组">
            {COMMAND_NAMES.map((name) => (
              <label className="memory-check" key={name} data-ui-target={'门槛 ' + name}>
                <span>{'//' + name}</span>
                <select
                  value={draft.commandThresholds[name]}
                  onChange={(event) =>
                    patchThreshold(name, event.target.value as CommandPermissionLevel)
                  }
                >
                  {LEVEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : (
          <p className="hint-text">读取设置中…</p>
        )}
      </section>

      <section className="setting-group" data-ui-region="D 最近事件">
        <h3 className="setting-group__title">最近事件（{qq.events.length}）</h3>
        <p className="setting-group__desc">
          每条消息的判定结果。这是排查「为什么不回我」的唯一现场：不在白名单 / 没 @ / 触发限速都会记在这里。
        </p>
        <div className="qq-events" data-ui-target="事件列表">
          {qq.events.length === 0 && <p className="hint-text">还没有收到任何 QQ 事件。</p>}
          {qq.events.map((item) => (
            <div className="qq-events__row" key={item.id}>
              <span className="qq-events__time">{timeLabel(item.at)}</span>
              <span className="qq-events__source">
                {item.chatType === 'group' ? '群 ' : item.chatType === 'private' ? '私聊 ' : ''}
                {item.chatId || '—'}
                {item.senderName ? ' · ' + item.senderName : ''}
              </span>
              <span className={item.outcome === 'responded' ? 'qq-tag is-on' : 'qq-tag'}>
                {outcomeLabel(item.outcome)}
              </span>
              <span className="qq-events__preview" title={item.preview}>
                {item.preview || '—'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}