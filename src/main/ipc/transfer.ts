import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { ImportRequest, ExportRequest } from '@shared/transfer'
import { transferService } from '../features/transfer/service'

/** 文件选择、解析和持久化都由主进程持有，渲染层只传预览令牌。 */
export function registerTransferIpcHandlers(): void {
  ipcMain.handle(IPC.transferPickImport, () => transferService.pickImport())
  ipcMain.handle(IPC.transferImport, (_event, request: ImportRequest) => transferService.import(request))
  ipcMain.handle(IPC.transferExport, (_event, request: ExportRequest) => transferService.export(request))
}
