import { useEffect, useMemo, useState } from 'react'
import type { ChannelChatType, UnzonedChannelItem } from '@shared/channels'
import type { Zone } from '@shared/zones'
import { useZones } from '../useZones'

/**
 * 设置页「区块」面板（P5 G7）。
 *
 * 四个区块的顺序就是用户的操作顺序：
 *  A 区块列表（root 置顶、灰底、不可删不可改名）
 *  B 选中区块的成员表
 *  C 把「白名单里还没归区的会话」加进来
 *  D 该区块的两个开关（画像注入 / 旁听）
 *
 * 🔴 面板只做展示与转发：不变量在 zones/store.ts，域解析在 zones/scope.ts。
 * P6：候选来源是主进程的 `zones:unzoned`（白名单 − 已归区），**加了白名单就能入区**，
 * 与这条会话有没有说过话无关（用户明确要求的行为）。
 */

const CHAT_TYPE_LABEL: Record<ChannelChatType, string> = { group: '群聊', private: '私聊' }

function zoneOf(item: UnzonedChannelItem): string {
  return item.chatId + (item.label ? '（' + item.label + '）' : '')
}

export function ZonesSection() {
  const zones = useZones()
  const [selectedId, setSelectedId] = useState('')
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState('')
  const [renameText, setRenameText] = useState('')
  const [checked, setChecked] = useState<string[]>([])

  // 选中项跟着列表走：删掉当前选中的区块后自动落到第一行（root）
  useEffect(() => {
    if (zones.zones.length === 0) return
    if (!zones.zones.some((zone) => zone.zoneId === selectedId)) setSelectedId(zones.zones[0].zoneId)
  }, [zones.zones, selectedId])

  const selected: Zone | null = useMemo(
    () => zones.zones.find((zone) => zone.zoneId === selectedId) ?? zones.zones[0] ?? null,
    [zones.zones, selectedId]
  )

  const memoryCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of zones.stats) map.set(item.zoneId, item.memoryCount)
    return map
  }, [zones.stats])

  // 候选集由主进程给（白名单 − 已归区），渲染层不再自己算集合差
  const unassigned = zones.unzoned

  const toggle = (key: string): void => {
    setChecked((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]))
  }

  const applyAdopt = async (): Promise<void> => {
    if (!selected) return
    const members = unassigned
      .filter((item) => checked.includes(item.key))
      .map((item) => ({
        key: item.key,
        chatType: item.chatType,
        chatId: item.chatId,
        ...(item.label ? { displayName: item.label } : {})
      }))
    if (members.length === 0) return
    await zones.adopt(selected.zoneId, members)
    setChecked([])
  }

  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>区块</h1>
        <p>
          区块 = 长期记忆的「域」。同一个区块里的群能共享记忆，不同区块之间读不到彼此的；
          桌面会话永远在主区块里。区块**只共享长期记忆，不共享短期上下文** ——
          每个群仍然是各自的一条会话（各自的人设、模式、消息历史）。
        </p>
      </div>

      {zones.loading && <p className="hint-text">读取中…</p>}
      {zones.error && <p className="hint-text hint-text--error">{zones.error}</p>}
      {zones.notice && <p className="hint-text">{zones.notice}</p>}

      <section className="setting-group" data-ui-region="A 区块列表">
        <h3 className="setting-group__title">区块列表（{zones.zones.length}）</h3>
        <p className="setting-group__desc">
          主区块（root）唯一、不可删除、不可改名，自动包含全部桌面对话，至多再挂 1 个 QQ 私聊。
          其余区块按你划的边界共享记忆。
        </p>

        <div className="zones-table" data-ui-target="区块表格">
          <div className="zones-table__head">
            <span>名称</span>
            <span>成员</span>
            <span>记忆</span>
            <span>操作</span>
          </div>
          {zones.zones.map((zone) => (
            <div
              className={
                'zones-table__row' +
                (zone.isRoot ? ' is-root' : '') +
                (selected && selected.zoneId === zone.zoneId ? ' is-active' : '')
              }
              key={zone.zoneId}
              onClick={() => setSelectedId(zone.zoneId)}
              data-ui-target={'区块 ' + zone.zoneName}
            >
              <span className="zones-table__name">
                {renamingId === zone.zoneId ? (
                  <input
                    className="field__control field__control--inline"
                    value={renameText}
                    autoFocus
                    onChange={(event) => setRenameText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void zones.rename(zone.zoneId, renameText)
                        setRenamingId('')
                      }
                      if (event.key === 'Escape') setRenamingId('')
                    }}
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  <strong>{zone.zoneName}</strong>
                )}
                <em className="zones-table__note">
                  {zone.isRoot ? '自动包含全部桌面对话' : 'zone:' + zone.zoneId.slice(0, 14)}
                </em>
              </span>
              <span>{zone.members.length}</span>
              <span>{memoryCount.get(zone.zoneId) ?? 0}</span>
              <span className="zones-table__actions">
                <button
                  type="button"
                  className="btn-ghost btn-ghost--sm"
                  disabled={zone.isRoot || zones.busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    setRenamingId(zone.zoneId)
                    setRenameText(zone.zoneName)
                  }}
                >
                  改名
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-ghost--sm btn-ghost--danger"
                  disabled={zone.isRoot || zones.busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    void zones.remove(zone.zoneId)
                  }}
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="zones-create" data-ui-target="新建区块">
          <label className="field">
            <span className="field__label">新建区块</span>
            <input
              className="field__control"
              value={newName}
              placeholder="例如：摄影群 / 工作群"
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={zones.busy || !newName.trim()}
            onClick={() => {
              void zones.create(newName.trim())
              setNewName('')
            }}
          >
            新建
          </button>
        </div>
      </section>

      <section className="setting-group" data-ui-region="B 区块成员">
        <h3 className="setting-group__title">
          成员{selected ? '（' + selected.zoneName + '）' : ''}
        </h3>
        <p className="setting-group__desc">
          一个外部会话同一时刻只属于一个区块。移出后它会有自己的独立域（solo），
          既读不到桌面，也读不到原区块。主区块至多挂 1 个 QQ 私聊。
        </p>
        {!selected && <p className="hint-text">还没有可选的区块。</p>}
        {selected && (
          <div className="zones-table zones-table--members" data-ui-target="成员表格">
            <div className="zones-table__head zones-table__head--members">
              <span>类型</span>
              <span>外部会话</span>
              <span>显示名</span>
              <span>操作</span>
            </div>
            {selected.members.length === 0 && <p className="hint-text">这个区块还没有成员。</p>}
            {selected.members.map((member) => (
              <div className="zones-table__row zones-table__row--members" key={member.key}>
                <span>{CHAT_TYPE_LABEL[member.chatType]}</span>
                <span title={member.key}>{member.chatId}</span>
                <span>{member.displayName || '—'}</span>
                <span className="zones-table__actions">
                  <button
                    type="button"
                    className="btn-ghost btn-ghost--sm"
                    disabled={zones.busy}
                    onClick={() => void zones.removeMember(selected.zoneId, member.key)}
                  >
                    移出
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="setting-group" data-ui-region="C 未归区的 QQ 会话">
        <h3 className="setting-group__title">加入未归区的 QQ 会话（{unassigned.length}）</h3>
        <p className="setting-group__desc">
          这里列出渠道白名单里还没划区块的会话 —— 加了白名单就会出现，不需要先聊过天。
          勾选后点「加入本区块」，它们就会和本区块的其它群共享长期记忆。没勾的保持 solo（只读自己）。
        </p>
        {unassigned.length === 0 && (
          <p className="hint-text">
            白名单里还没有可归区的会话。先在「渠道控制台」加白（P7 起提供；当前版本可手改
            %APPDATA%\Nahida Chat\channels\access.json）。
          </p>
        )}
        {unassigned.length > 0 && (
          <div className="zones-candidates" data-ui-target="候选列表">
            {unassigned.map((item) => (
              <label className="memory-check" key={item.key}>
                <input
                  type="checkbox"
                  checked={checked.includes(item.key)}
                  onChange={() => toggle(item.key)}
                />
                <span>
                  {CHAT_TYPE_LABEL[item.chatType]} · {zoneOf(item)}
                  {!item.permissions.respond && <em className="zones-table__note"> · 未授权自动回复</em>}
                  <em className="zones-table__note"> · {item.key}</em>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="settings-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={zones.busy || !selected || checked.length === 0}
            onClick={() => void applyAdopt()}
          >
            {zones.busy ? '处理中…' : '加入本区块'}
          </button>
        </div>
      </section>

      <section className="setting-group" data-ui-region="D 区块开关">
        <h3 className="setting-group__title">本区块的行为</h3>
        <p className="setting-group__desc">
          这两个开关只影响「记忆与旁听」，不影响人设与会话历史。
          root 的画像注入固定开启且不可关闭。
        </p>
        {!selected && <p className="hint-text">先在上方选择一个区块。</p>}
        {selected && (
          <div data-ui-target="开关组">
            <label className="memory-check">
              <input
                type="checkbox"
                checked={selected.isRoot ? true : selected.config.injectOwnerProfile}
                disabled={selected.isRoot || zones.busy}
                onChange={(event) =>
                  void zones.updateConfig(selected.zoneId, { injectOwnerProfile: event.target.checked })
                }
              />
              <span>
                注入我的画像（用户资料 / 关系日志）
                {selected.isRoot && <em className="zones-table__note"> · 主区块固定开启，不可关闭</em>}
              </span>
            </label>
            <label className="memory-check">
              <input
                type="checkbox"
                checked={selected.config.observeGroupMessages}
                disabled={zones.busy}
                onChange={(event) =>
                  void zones.updateConfig(selected.zoneId, { observeGroupMessages: event.target.checked })
                }
              />
              <span>
                在本区块旁听群消息
                <em className="zones-table__note"> · P6 生效，当前只保存设置</em>
              </span>
            </label>
          </div>
        )}
      </section>
    </>
  )
}
