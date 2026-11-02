import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { ChannelAccessConfig } from '@shared/channelAccess'
import { channelStore, type AccountDraft, type GatePatch, type GroupDraft } from '../features/channels/store'

/**
 * 渠道授权 IPC（P6 §4.8 → **P9-R3 改成按「人」授权**）。
 *
 * 薄转发：归一化、校验、迁移、原子写全在 `ChannelAccessStore` 里。
 * ⚠️ 这里**不**暴露 touch —— 命中计数只由 bridge 写，渲染层不该能伪造「最近活动」。
 *
 * 通道清单（v2）：
 *   channels:config   读整份配置（账号 + 群 + 两个总开关）
 *   channels:gates    改两个总开关（groupMemberGate / toolGate）
 *   channels:account  增改一个账号
 *   channels:remove-account
 *   channels:group    增改一个群
 *   channels:remove-group
 *   channels:uin      记一个机器人登录号（面板识别到已注入进程时调）
 *   channels:sessions 白名单在**会话维度**上的投影（区块面板的候选集）
 *   channels:status   数据目录 / 文件 / 计数
 */
export function registerChannelsIpcHandlers(): void {
  ipcMain.handle(IPC.channelsConfig, (): ChannelAccessConfig => channelStore.config())
  ipcMain.handle(IPC.channelsGates, (_event, patch: GatePatch) => channelStore.setGates(patch ?? {}))
  ipcMain.handle(IPC.channelsAccount, (_event, draft: AccountDraft) => channelStore.upsertAccount(draft))
  ipcMain.handle(IPC.channelsRemoveAccount, (_event, userId: string) =>
    channelStore.removeAccount(String(userId ?? ''))
  )
  ipcMain.handle(IPC.channelsGroup, (_event, draft: GroupDraft) => channelStore.upsertGroup(draft))
  ipcMain.handle(IPC.channelsRemoveGroup, (_event, chatId: string) =>
    channelStore.removeGroup(String(chatId ?? ''))
  )
  ipcMain.handle(IPC.channelsUin, (_event, uin: string) => {
    channelStore.addUin(String(uin ?? ''))
    return channelStore.config()
  })
  ipcMain.handle(IPC.channelsSessions, () => channelStore.sessions())
  ipcMain.handle(IPC.channelsStatus, (): ChannelStatusPayload => {
    const config = channelStore.config()
    return {
      dataDir: channelStore.dir,
      file: channelStore.file,
      count: config.accounts.length + config.groups.length,
      accounts: config.accounts.length,
      groups: config.groups.length
    }
  })
}

export interface ChannelStatusPayload {
  dataDir: string
  file: string
  /** 账号数 + 群数（面板标题用） */
  count: number
  accounts: number
  groups: number
}
