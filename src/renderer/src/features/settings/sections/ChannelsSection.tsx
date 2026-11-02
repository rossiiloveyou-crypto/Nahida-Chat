import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AccountPermissions, ChannelAccount, ChannelAccessConfig, ChannelGroup } from '@shared/channelAccess'
import { DEFAULT_ACCOUNT_PERMISSIONS } from '@shared/channelAccess'
import { useChannels } from '../useChannels'
import { ObservePanel } from './ObservePanel'

/**
 * 设置页「渠道控制台」面板（P7 G4 → **P9-R3 v2：按「人」授权**）。
 *
 * 形状（PHASE-9 §15.7.1）：
 *   A0 机器人账号     —— 我们自己登录的号（只用于展开会话键，不参与授权）
 *   A  QQ 号白名单    —— **一个号一行**：私聊 / 群聊 / 工具 三个位
 *   B  群白名单       —— 群号一行：管的是「这个群允不允许她说话」
 *   C  鉴权开关       —— 群成员鉴权（默认关）/ 工具调用拦截（默认开）
 *   D  数据位置
 *   +  ObservePanel（旁听库，与其他区块无关）
 *
 * 🔴 面板只做展示与转发：真源在 userData/channels/access.json，
 *    校验在 features/channels/store.ts。面板不重复实现一遍校验（J-34）。
 *
 * 🔴 「群聊」这一列在 groupMemberGate 关闭时**看不到效果**（判定恒放行）。
 *    必须在该列写清「群成员鉴权关闭时不生效」，否则就是 J-33 的复现
 *    （界面上看得见但不出效果的权限位不算存在）。
 */

/** 机器人号的手填兜底（方案乙）。方案甲取到时这个键不会被读。 */
const BOT_UIN_STORAGE_KEY = 'nahida.channels.uin'

interface BotUinSource {
  uin: string
  /** 'auto' = 从已注入进程取到；'manual' = 用户手填；'none' = 都没有 */
  mode: 'auto' | 'manual' | 'none'
  /** 自动取到时带上昵称，便于用户确认是哪个号 */
  nickname: string
  setManual: (value: string) => void
  reload: () => Promise<void>
}

/**
 * 机器人 QQ 号的来源（P7 §4.2.3 方案甲 / 乙）。
 *
 * 甲：qq.processes() 里 injected === true 的那条带 account.uin —— 只读，不改 P6 契约。
 * 乙：取不到时回落 localStorage 手填值，并在面板上显式写出「当前填的号」。
 */
function useBotUin(): BotUinSource {
  const [auto, setAuto] = useState<{ uin: string; nickname: string } | null>(null)
  const [manual, setManualState] = useState<string>(
    () => globalThis.localStorage?.getItem(BOT_UIN_STORAGE_KEY) ?? ''
  )

  const reload = useCallback(async (): Promise<void> => {
    try {
      const processes = await window.nahida.qq.processes()
      const injected = processes.find((item) => item.injected && (item.account?.uin || item.uin))
      if (!injected) {
        setAuto(null)
        return
      }
      const uin = injected.account?.uin || injected.uin
      setAuto({ uin, nickname: injected.account?.nickname ?? '' })
    } catch {
      // 宿主没起 / IPC 失败都不算错：手填兜底照样能用，不用错误态打扰用户
      setAuto(null)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const setManual = useCallback((value: string): void => {
    setManualState(value)
    try {
      globalThis.localStorage?.setItem(BOT_UIN_STORAGE_KEY, value)
    } catch {
      /* 隐私模式下 localStorage 可能不可写，忽略：本函数只是记住用户输入 */
    }
  }, [])

  if (auto) return { uin: auto.uin, mode: 'auto', nickname: auto.nickname, setManual, reload }
  const trimmed = manual.trim()
  return { uin: trimmed, mode: trimmed ? 'manual' : 'none', nickname: '', setManual, reload }
}

function timeLabel(at: number): string {
  if (!at) return '从未活动'
  try {
    return new Date(at).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

/** 三个权限位的列定义：字段名 / 表头 / 提示语（提示语是「她管什么」的一句话） */
const PERMISSION_COLUMNS: Array<{
  key: keyof AccountPermissions
  label: string
  hint: string
}> = [
  {
    key: 'private',
    label: '私聊',
    hint: '这个号私聊她能触发回复（私聊始终校验：没勾就一个字都不进模型）'
  },
  {
    key: 'group',
    label: '群聊',
    hint: '这个号在群里 @ 她能触发（⚠️ 只在「群成员鉴权」打开时才生效）'
  },
  {
    key: 'tool',
    label: '工具',
    hint: '这个号能让她调工具干活（读文件、查东西等；模型照常看得到工具，执行前才拦）'
  }
]

interface AccountRowProps {
  account: ChannelAccount
  busy: boolean
  onToggle: (account: ChannelAccount, field: keyof AccountPermissions) => void
  onRemove: (account: ChannelAccount) => void
}

function AccountRow({ account, busy, onToggle, onRemove }: AccountRowProps) {
  return (
    <div className="qq-table__row" key={account.userId}>
      <span title={account.userId}>{account.userId}</span>
      <span>{account.label || '—'}</span>
      <span className="qq-table__flags">
        {PERMISSION_COLUMNS.map((column) => (
          <label className="memory-check" key={column.key} title={column.hint}>
            <input
              type="checkbox"
              checked={account.permissions[column.key]}
              disabled={busy}
              onChange={() => onToggle(account, column.key)}
            />
            <span>{column.label}</span>
          </label>
        ))}
      </span>
      <span>{timeLabel(account.lastAt)}</span>
      <span className="qq-table__actions">
        <button
          type="button"
          className="btn-ghost btn-ghost--sm btn-ghost--danger"
          disabled={busy}
          onClick={() => onRemove(account)}
        >
          删除
        </button>
      </span>
    </div>
  )
}

interface GroupRowProps {
  group: ChannelGroup
  /** 已知机器人号的数量：0 表示这个群暂时展不开成会话（区块里看不到它） */
  uinCount: number
  busy: boolean
  onRemove: (group: ChannelGroup) => void
}

function GroupRow({ group, uinCount, busy, onRemove }: GroupRowProps) {
  return (
    <div className="qq-table__row" key={group.chatId}>
      <span title={group.chatId}>
        {group.chatId}
        {uinCount === 0 && (
          <em className="qq-tag-multi" title="还没识别到机器人登录号：这个群暂时不会出现在区块候选里">
            待识别
          </em>
        )}
      </span>
      <span>{group.label || '—'}</span>
      <span>{timeLabel(group.lastAt)}</span>
      <span className="qq-table__actions">
        <button
          type="button"
          className="btn-ghost btn-ghost--sm btn-ghost--danger"
          disabled={busy}
          onClick={() => onRemove(group)}
        >
          删除
        </button>
      </span>
    </div>
  )
}

export function ChannelsSection() {
  const channels = useChannels()
  const bot = useBotUin()

  const config: ChannelAccessConfig = channels.config

  // 识别到机器人号就顺手记进 access.json 的 uins[] ——
  // 群白名单存的是群号，区块 / 旁听要的是会话键 qq:<uin>:group:<群号>，没有 uin 就展不开。
  useEffect(() => {
    if (bot.uin) void channels.rememberUin(bot.uin)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.uin])

  const [newUserId, setNewUserId] = useState('')
  const [newUserLabel, setNewUserLabel] = useState('')
  const [newUserPerms, setNewUserPerms] = useState<AccountPermissions>({ ...DEFAULT_ACCOUNT_PERMISSIONS })
  const [newGroupId, setNewGroupId] = useState('')
  const [newGroupLabel, setNewGroupLabel] = useState('')

  const accounts = useMemo(
    () => [...config.accounts].sort((a, b) => b.lastAt - a.lastAt || a.userId.localeCompare(b.userId)),
    [config.accounts]
  )
  const groups = useMemo(
    () => [...config.groups].sort((a, b) => b.lastAt - a.lastAt || a.chatId.localeCompare(b.chatId)),
    [config.groups]
  )

  const togglePermission = (account: ChannelAccount, field: keyof AccountPermissions): void => {
    void channels.saveAccount({
      userId: account.userId,
      permissions: { [field]: !account.permissions[field] }
    })
  }

  const submitAccount = async (): Promise<void> => {
    const ok = await channels.saveAccount({
      userId: newUserId.trim(),
      label: newUserLabel.trim(),
      permissions: newUserPerms
    })
    if (ok) {
      setNewUserId('')
      setNewUserLabel('')
      setNewUserPerms({ ...DEFAULT_ACCOUNT_PERMISSIONS })
    }
  }

  const submitGroup = async (): Promise<void> => {
    const ok = await channels.saveGroup({ chatId: newGroupId.trim(), label: newGroupLabel.trim() })
    if (ok) {
      setNewGroupId('')
      setNewGroupLabel('')
    }
  }

  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>渠道控制台</h1>
        <p>
          这里决定<strong>谁能得到回复、谁能让她干活</strong>。授权按<strong>人</strong>判：
          一个 QQ 号一行，各人有自己的「私聊 / 群聊 / 工具」三个位；群白名单单独一块，
          管的是「这个群允不允许她说话」。不在名单里的消息一个字都不会进模型。
        </p>
      </div>

      {channels.error && (
        <p className="hint-text hint-text--error" data-ui-target="错误提示">
          {channels.error}
        </p>
      )}
      {channels.notice && <p className="hint-text">{channels.notice}</p>}

      <section className="setting-group" data-ui-region="A0 机器人账号">
        <h3 className="setting-group__title">机器人 QQ 号</h3>
        <p className="setting-group__desc">
          这是<strong>我们自己登录的号</strong>，不是被授权的人。它只用来把群白名单展开成会话
          （<code>qq:机器人号:group:群号</code>），授权判定一个字节都不读它。
        </p>
        {bot.mode === 'auto' && (
          <p className="hint-text" data-ui-target="机器人号（自动）">
            机器人 QQ 号：{bot.uin}
            {bot.nickname ? '（' + bot.nickname + '）' : ''}
            {' · 取自已注入的 QQ 进程'}
          </p>
        )}
        {bot.mode !== 'auto' && (
          <div className="field__row">
            <label className="field">
              <span className="field__label">机器人 QQ 号（登录 QQ 的那个号）</span>
              <input
                className="field__control"
                value={bot.uin}
                placeholder="例如 10001"
                onChange={(event) => bot.setManual(event.target.value)}
              />
            </label>
          </div>
        )}
        {bot.mode === 'none' && (
          <p className="hint-text hint-text--error">
            还没有拿到机器人号。先在「QQ 接入」里注入一个已登录的 QQ，或在上面手填。
            群白名单没有它也能存，只是区块候选里暂时看不到那些群。
          </p>
        )}
        {config.uins.length > 0 && (
          <p className="hint-text" data-ui-target="已记录的机器人号">
            已记录：{config.uins.join('、')}
          </p>
        )}
        <div className="settings-actions">
          <button type="button" className="btn-ghost" onClick={() => void bot.reload()}>
            重新识别
          </button>
        </div>
      </section>

      <section className="setting-group" data-ui-region="A QQ 号白名单">
        <h3 className="setting-group__title">QQ 号白名单（{accounts.length}）</h3>
        <p className="setting-group__desc">
          按<strong>人</strong>授权：一个号一行，三列各自独立。
          私聊始终校验（没勾「私聊」这个号私聊她不会得到回复）；
          「群聊」只在下面「群成员鉴权」打开时才有意义；
          「工具」决定她能不能替这个号干活。
        </p>

        <div className="qq-table qq-table--accounts" data-ui-target="账号表">
          <div className="qq-table__head">
            <span>QQ 号</span>
            <span>备注</span>
            <span>权限位</span>
            <span>最近活动</span>
            <span>操作</span>
          </div>
          {channels.loading && <p className="hint-text">加载中…</p>}
          {!channels.loading && accounts.length === 0 && (
            <p className="hint-text">
              还没有 QQ 号。加了这一条，这个号私聊她才会得到回复，在群里 @ 她才可能被响应。
            </p>
          )}
          {accounts.map((account) => (
            <AccountRow
              key={account.userId}
              account={account}
              busy={channels.busy}
              onToggle={togglePermission}
              onRemove={(item) => void channels.removeAccount(item.userId)}
            />
          ))}
        </div>

        <div className="field__row">
          <label className="field">
            <span className="field__label">QQ 号</span>
            <input
              className="field__control"
              value={newUserId}
              placeholder="对方的 QQ 号"
              onChange={(event) => setNewUserId(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">备注</span>
            <input
              className="field__control"
              value={newUserLabel}
              placeholder="可选，比如「小号」"
              onChange={(event) => setNewUserLabel(event.target.value)}
            />
          </label>
        </div>

        <div className="settings-actions" data-ui-target="新增账号权限">
          {PERMISSION_COLUMNS.map((column) => (
            <label className="memory-check" key={column.key} title={column.hint}>
              <input
                type="checkbox"
                checked={newUserPerms[column.key]}
                onChange={(event) =>
                  setNewUserPerms((prev) => ({ ...prev, [column.key]: event.target.checked }))
                }
              />
              <span>{column.label}</span>
            </label>
          ))}
          <button
            type="button"
            className="btn-primary"
            disabled={channels.busy || !newUserId.trim()}
            onClick={() => void submitAccount()}
          >
            添加
          </button>
        </div>
      </section>

      <section className="setting-group" data-ui-region="B 群白名单">
        <h3 className="setting-group__title">群白名单（{groups.length}）</h3>
        <p className="setting-group__desc">
          这里管的是<strong>「这个群允不允许她说话」</strong>，与「群里谁能触发她」是两件事：
          没加进来的群，她一条都不会回（但消息照样进旁听库 —— 那是语料，不是行为）。
        </p>

        <div className="qq-table qq-table--groups" data-ui-target="群表">
          <div className="qq-table__head">
            <span>群号</span>
            <span>群名</span>
            <span>最近活动</span>
            <span>操作</span>
          </div>
          {channels.loading && <p className="hint-text">加载中…</p>}
          {!channels.loading && groups.length === 0 && (
            <p className="hint-text">还没有群。加了这一条，这个群里 @ 她才可能得到回复。</p>
          )}
          {groups.map((group) => (
            <GroupRow
              key={group.chatId}
              group={group}
              uinCount={config.uins.length}
              busy={channels.busy}
              onRemove={(item) => void channels.removeGroup(item.chatId)}
            />
          ))}
        </div>

        <div className="field__row">
          <label className="field">
            <span className="field__label">群号</span>
            <input
              className="field__control"
              value={newGroupId}
              placeholder="群号"
              onChange={(event) => setNewGroupId(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">群名</span>
            <input
              className="field__control"
              value={newGroupLabel}
              placeholder="可选，方便自己认"
              onChange={(event) => setNewGroupLabel(event.target.value)}
            />
          </label>
        </div>

        <div className="settings-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={channels.busy || !newGroupId.trim()}
            onClick={() => void submitGroup()}
          >
            添加
          </button>
        </div>
      </section>

      <section className="setting-group" data-ui-region="C 鉴权开关">
        <h3 className="setting-group__title">鉴权开关</h3>

        <label className="memory-check" data-ui-target="群成员鉴权">
          <input
            type="checkbox"
            checked={config.groupMemberGate}
            disabled={channels.busy}
            onChange={(event) => void channels.setGates({ groupMemberGate: event.target.checked })}
          />
          <span>群成员鉴权</span>
        </label>
        <p className="setting-group__desc">
          打开后：群里只有<strong>「QQ 号白名单」里勾了「群聊」的人</strong> @ 她才会回复；
          其他人 @ 一律不理，但消息仍进旁听库。
          关闭时（默认）：群里任何人 @ 她都会回复（群本身要在上面的群白名单里）。
        </p>

        <label className="memory-check" data-ui-target="工具调用拦截">
          <input
            type="checkbox"
            checked={config.toolGate}
            disabled={channels.busy}
            onChange={(event) => void channels.setGates({ toolGate: event.target.checked })}
          />
          <span>工具调用拦截</span>
        </label>
        <p className="setting-group__desc">
          打开后：<strong>模型照常看得到工具</strong>，但只有「QQ 号白名单」里勾了「工具」的人
          才能真的让工具执行；没勾的人会收到一句<strong>「我没有这个权限」</strong>，
          而不是「她不会干活」。
          <br />
          关闭时：不做任何工具权限校验（不推荐）。
        </p>

        <p className="setting-group__desc" data-ui-target="全局权限模式说明">
          ⚠️ 「允许工具」还要看设置里的<strong>全局工具权限</strong>：
          <br />
          · <strong>只读</strong>：只放只读工具，会改文件的调用一律拒绝；
          <br />
          · <strong>审批</strong>：会改东西的调用要先弹卡问你 ——
          <strong>QQ 里没有卡片可点，等于一律拒绝</strong>（想真的放开就选「完全访问」）；
          <br />
          · <strong>完全访问</strong>：白名单里勾了「工具」的人可以直接执行。
        </p>
      </section>

      <section className="setting-group" data-ui-region="D 数据位置">
        <h3 className="setting-group__title">数据位置</h3>
        <p className="setting-group__desc">
          授权真源是一个纯文本 JSON 文件（版本 2：账号 + 群 + 两个开关），可以直接用编辑器改；
          改完不用重启，下一条消息就生效。首次升级到 v2 时会自动备份成{' '}
          <code>access.v1.backup.json</code>（只在首次，不覆盖已有的备份）。
        </p>
        <p className="hint-text" data-ui-target="授权文件">
          <code>{channels.file || channels.dataDir || '—'}</code>
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="btn-ghost"
            disabled={!channels.dataDir}
            onClick={() => {
              const target = channels.file || channels.dataDir
              if (target) void navigator.clipboard.writeText(target)
            }}
          >
            复制路径
          </button>
          <button type="button" className="btn-ghost" onClick={() => void channels.refresh()}>
            刷新
          </button>
        </div>
      </section>

      {/* P8：旁听库（独立于授权，是「只增不清」的群语料） */}
      <ObservePanel />
    </>
  )
}
