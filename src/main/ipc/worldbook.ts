import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { DuplicateKeyword, WorldbookDirInfo, WorldbookEntryDraft, WorldbookListing } from '@shared/worldbook'
import {
  addEntry,
  createWorldbook,
  findDuplicates,
  knownDirs,
  listWorldbook,
  removeEntry,
  updateEntry
} from '../features/worldbook/editor'

/**
 * 世界书编写器的 IPC handler（P9 §4.5）。
 *
 * 一律「薄转发」：路径守卫、原子写、块级手术、id 生成全在 `features/worldbook/`。
 * 🔴 这里唯一的额外语义是**系统对话框**（渲染进程没有 Node 能力，选目录/选文件只能在这做）。
 */
export function registerWorldbookIpcHandlers(): void {
  ipcMain.handle(IPC.worldbookKnownDirs, (): WorldbookDirInfo[] => knownDirs())
  ipcMain.handle(IPC.worldbookList, (_event, target: string): WorldbookListing => listWorldbook(target))
  ipcMain.handle(
    IPC.worldbookAdd,
    (_event, dir: string, file: string, draft: WorldbookEntryDraft): WorldbookListing =>
      addEntry(dir, file, draft)
  )
  // 🔴 末位 fallbackTitle 只服务「合规但缺 id」的条目（没有句柄，用标题唯一命中）
  ipcMain.handle(
    IPC.worldbookUpdate,
    (
      _event,
      dir: string,
      file: string,
      id: string,
      draft: WorldbookEntryDraft,
      fallbackTitle?: string
    ): WorldbookListing => updateEntry(dir, file, id, draft, fallbackTitle)
  )
  ipcMain.handle(
    IPC.worldbookRemove,
    (_event, dir: string, file: string, id: string, fallbackTitle?: string): WorldbookListing =>
      removeEntry(dir, file, id, fallbackTitle)
  )
  ipcMain.handle(IPC.worldbookCreate, (_event, dir: string): WorldbookListing => createWorldbook(dir))
  // 触发词重复**只提醒**（用户明确「不限制写入，仅作提醒」）：这条通道只读，永远不做写入校验
  ipcMain.handle(
    IPC.worldbookDuplicates,
    (_event, dir: string, file: string, keywords: string[], excludeId?: string): DuplicateKeyword[] =>
      findDuplicates(dir, file, keywords, excludeId)
  )
  ipcMain.handle(IPC.worldbookPickDir, async (event): Promise<string> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, { title: '选择世界书目录', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: '选择世界书目录', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0]
  })
  ipcMain.handle(IPC.worldbookPickFile, async (event): Promise<string> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '选择世界书文件',
      properties: ['openFile' as const],
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0]
  })
}
