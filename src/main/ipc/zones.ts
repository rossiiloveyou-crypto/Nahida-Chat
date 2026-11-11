// P1 过渡：区块的记忆域语义已被「用户 × 人设」取代。
// 本文件在 P6 会被整体删除，在此之前只保证「编译通过 + 页面能打开」。
// 🔴 禁止在这里实现任何 scope → tenant 的转换（那会制造第二套域语义，P6 删不干净）。
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { UnzonedChannelItem } from '@shared/channels'
import type { Zone, ZoneAdoptResult, ZoneConfig, ZoneDraft, ZoneMemberDraft, ZoneStat } from '@shared/zones'
import { channelStore } from '../features/channels/store'
import { zoneStore } from '../features/zones/store'

/**
 * 区块的 IPC handler（P5 §4.8，P6 G8 改候选来源）。
 *
 * 一律「薄转发」：不变量在 zones/store.ts，域解析在 zones/scope.ts，
 * 这里只做通道注册 + 两处收尾（删区块时搬记忆、加成员时校验白名单）。
 *
 * P6 的载重事实（用户原话）：「只有群聊或私聊产生对话后才能显示在区块以便加入，
 * 我们这边直接改成在添加白名单后就可以在区块里加入。」
 * ⇒ 候选集从「绑定表」换成「白名单」：加了白名单就出现，与有没有说过话彻底解耦。
 */

/**
 * P6：区块成员必须先是白名单条目。
 *
 * 否则可以绕过控制台直接往区块里塞一个**永远不会响应**的成员 —— 那是死配置，
 * 而真正的原因（没加白名单）在另一个面板里，排查成本极高。
 *
 * 守卫放在 IPC 边界，不改 ZoneStore.addMember：features/zones 不该依赖 features/channels。
 */
function assertWhitelisted(key: string): void {
  if (!channelStore.has(key)) {
    throw new Error('先把这条会话加入渠道白名单，再加入区块')
  }
}

export function registerZonesIpcHandlers(): void {
  ipcMain.handle(IPC.zoneList, (): Zone[] => zoneStore.listZones())

  ipcMain.handle(IPC.zoneCreate, (_event, draft: ZoneDraft): Zone[] => {
    zoneStore.createZone(draft)
    return zoneStore.listZones()
  })

  ipcMain.handle(IPC.zoneRename, (_event, zoneId: string, name: string): Zone[] => {
    zoneStore.renameZone(zoneId, name)
    return zoneStore.listZones()
  })

  ipcMain.handle(IPC.zoneDelete, (_event, zoneId: string): Zone[] => {
    const removed = zoneStore.deleteZone(zoneId)
    // P1 起记忆按「用户 × 人设」分区，区块不再是记忆域的宿主 ⇒ 删区块不再搬记忆。
    // 这是**有意接受的功能退化**（RK-3），P6 会把整个区块功能连同本文件一起删除。
    if (removed) {
      console.warn('[zones] 区块记忆搬迁已停用（P1 起记忆按用户 × 人设分区）；本页将在 P6 删除')
    }
    return zoneStore.listZones()
  })

  ipcMain.handle(IPC.zoneConfig, (_event, zoneId: string, patch: Partial<ZoneConfig>): Zone[] => {
    zoneStore.updateZoneConfig(zoneId, patch)
    return zoneStore.listZones()
  })

  ipcMain.handle(IPC.zoneMemberAdd, (_event, draft: ZoneMemberDraft): Zone[] => {
    assertWhitelisted(String(draft.key ?? ''))
    zoneStore.addMember(draft)
    return zoneStore.listZones()
  })

  ipcMain.handle(IPC.zoneMemberRemove, (_event, zoneId: string, key: string): Zone[] => {
    zoneStore.removeMember(zoneId, key)
    return zoneStore.listZones()
  })

  ipcMain.handle(
    IPC.zoneAdopt,
    (
      _event,
      zoneId: string,
      members: Array<{ key: string; chatType: 'private' | 'group'; chatId: string; displayName?: string }>
    ): ZoneAdoptResult => {
      const allowed: typeof members = []
      const errors: string[] = []
      for (const member of members ?? []) {
        if (channelStore.has(String(member.key ?? ''))) allowed.push(member)
        else errors.push((member.displayName || member.chatId) + '：先把这条会话加入渠道白名单，再加入区块')
      }
      const result = allowed.length > 0 ? zoneStore.adoptMembers(zoneId, allowed) : { added: 0, errors: [] }
      return { zones: zoneStore.listZones(), added: result.added, errors: [...errors, ...result.errors] }
    }
  )

  /**
   * P6 G8：还没归区的外部会话候选（渲染层区块面板的 C 区）。
   *
   * 只列白名单条目，并带上 inZone / permissions —— P7 的控制台直接用这些字段，
   * 不必再加通道。inZone 的判定只看 zones.json（真值），不看任何「便捷字段」。
   */
  ipcMain.handle(IPC.zoneUnzoned, (): UnzonedChannelItem[] => {
    const zones = zoneStore.listZones()
    const assigned = new Map<string, string>()
    for (const zone of zones) {
      for (const member of zone.members) assigned.set(member.key, zone.zoneId)
    }
    return channelStore
      .sessions()
      .filter((entry) => !assigned.has(entry.key))
      .map((entry) => ({
        key: entry.key,
        uin: entry.uin,
        chatType: entry.chatType,
        chatId: entry.chatId,
        label: entry.label,
        inZone: false,
        zoneId: null,
        permissions: entry.permissions,
        lastAt: entry.lastAt
      }))
  })

  ipcMain.handle(IPC.zoneStats, (): ZoneStat[] => {
    // P1–P5：区块页的记忆计数恒为 0（记忆已不属于区块），P6 删除本页。
    const counts = new Map<string, number>()
    return zoneStore.listZones().map((zone) => ({
      zoneId: zone.zoneId,
      memoryCount: counts.get(zone.zoneId) ?? 0,
      memberCount: zone.members.length
    }))
  })
}
