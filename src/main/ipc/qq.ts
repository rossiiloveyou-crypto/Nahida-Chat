import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { QqSettings, QqStatusPayload } from '@shared/qq'
import { qqHost } from '../features/qq/host'
import { qqStats } from '../features/qq/bridge'
import { qqStore } from '../features/qq/store'

/**
 * QQ 相关的 IPC handler（P4 §4.10）。
 *
 * 一律「薄转发」：校验/落盘/进程操作分别在 store / host 里，这里只做通道注册。
 * 进程列表**只读**：本文件里没有任何一处会调用 loadProcess —— 注入只有用户点选才会发生（M2）。
 *
 * P6：绑定表 3 个通道（bindings / binding-save / binding-delete）已删除。
 */
export function registerQqIpcHandlers(): void {
  ipcMain.handle(
    IPC.qqStatus,
    (): QqStatusPayload => ({
      host: qqHost.status(),
      stats: qqStats(),
      dataDir: qqStore.dir
    })
  )

  ipcMain.handle(IPC.qqProcesses, () => qqHost.listProcesses())
  ipcMain.handle(IPC.qqLoad, (_event, pid: number) => qqHost.loadProcess(pid))
  ipcMain.handle(IPC.qqUnload, (_event, pid: number) => qqHost.unloadProcess(pid))
  ipcMain.handle(IPC.qqRestart, async () => {
    await qqHost.restart()
    return qqHost.status()
  })
  ipcMain.handle(IPC.qqLogs, (_event, limit?: number) => qqHost.recentLogs(limit ?? 100))

  // P6：绑定表已下线。授权（白名单 / 权限位）走 ipc/channels.ts，文件是 userData/channels/access.json。
  ipcMain.handle(IPC.qqSettingsGet, () => qqStore.settings())
  ipcMain.handle(IPC.qqSettingsSave, (_event, patch: Partial<QqSettings>) => qqStore.saveSettings(patch))
}
