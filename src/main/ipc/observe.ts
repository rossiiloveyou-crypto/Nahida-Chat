import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { ObserveConversation, ObserveRecord, ObserveStatus } from '@shared/observe'
import { observeStore } from '../features/observe/store'

/**
 * 旁听库 IPC（P8 §4.6）。薄转发。
 *
 * 🔴 这里**没有** delete / clear / truncate 通道 —— 不是忘了，是「只增不清」。
 *    将来任何「清理旁听」的需求都属于产品决策变更，必须另起一个 Phase 并显式告知用户。
 */

export interface ObserveTailPayload {
  uin: string
  chatType: 'private' | 'group'
  chatId: string
  limit?: number
}

export function registerObserveIpcHandlers(): void {
  ipcMain.handle(IPC.observeStatus, (): ObserveStatus => observeStore.status())
  ipcMain.handle(
    IPC.observeConversations,
    (): ObserveConversation[] => observeStore.listConversations()
  )
  ipcMain.handle(
    IPC.observeTail,
    (_event, payload: ObserveTailPayload): ObserveRecord[] =>
      observeStore.readTail(
        String(payload?.uin ?? ''),
        payload?.chatType === 'group' ? 'group' : 'private',
        String(payload?.chatId ?? ''),
        Math.min(Math.max(Number(payload?.limit ?? 50), 1), 200)
      )
  )
  ipcMain.handle(IPC.observeOpenDir, async (): Promise<string> => {
    const { shell } = await import('electron')
    return shell.openPath(observeStore.root)
  })
}
