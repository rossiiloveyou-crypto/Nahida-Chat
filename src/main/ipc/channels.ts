import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { ChannelAccessDraft, ChannelStatusPayload } from '@shared/channels'
import { channelStore } from '../features/channels/store'

/**
 * 渠道白名单 IPC（P6 §4.8）。
 *
 * 薄转发：校验与落盘都在 `ChannelAccessStore` 里。
 * ⚠️ 这里**不**暴露 touch —— 命中计数只由 bridge 写，渲染层不该能伪造「最近活动」。
 */
export function registerChannelsIpcHandlers(): void {
  ipcMain.handle(IPC.channelsList, () => channelStore.entries())
  ipcMain.handle(IPC.channelsUpsert, (_event, draft: ChannelAccessDraft) => channelStore.upsert(draft))
  ipcMain.handle(IPC.channelsRemove, (_event, key: string) => channelStore.remove(String(key ?? '')))
  ipcMain.handle(
    IPC.channelsStatus,
    (): ChannelStatusPayload => ({
      dataDir: channelStore.dir,
      file: channelStore.file,
      count: channelStore.entries().length
    })
  )
}
