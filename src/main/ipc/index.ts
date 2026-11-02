import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppInfo,
  CreateSessionInput,
  MemoryDraft,
  ModelDiscoveryRequest,
  ModelProfileDraft,
  ModelTestRequest,
  SendInput,
  Settings,
  UpdateSessionInput,
  WorkspaceDraft
} from '@shared/types'
import type { ToolApprovalReply } from '@shared/tools'
import { chatService } from '../features/chat/chatService'
import { promptStore } from '../features/prompt/promptStore'
import { settingsStore } from '../features/settings/settingsStore'
import { ensureWorkspace } from '../features/workspace'
import { testModelConnection } from '../features/settings/modelTest'
import { discoverModels } from '../features/settings/modelDiscovery'
import { memoryService } from '../features/rag'
import { permissionGate } from '../features/tools/permission'
import { listDefinitions } from '../features/tools/registry'
import { registerChannelsIpcHandlers } from './channels'
import { registerObserveIpcHandlers } from './observe'
import { registerQqIpcHandlers } from './qq'
import { registerZonesIpcHandlers } from './zones'

/** 所有 IPC handler 在这里集中注册，渲染进程能做的事一目了然。 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userDataPath: app.getPath('userData'),
    promptRoot: promptStore.root()
  }))

  ipcMain.handle(IPC.settingsGet, () => settingsStore.get())
  ipcMain.handle(IPC.settingsSave, (_event, patch: Partial<Settings>) => settingsStore.save(patch))

  ipcMain.handle(IPC.modelProfileList, () => settingsStore.listProfiles())
  ipcMain.handle(IPC.modelProfileSave, (_event, draft: ModelProfileDraft) => settingsStore.saveProfile(draft))
  ipcMain.handle(IPC.modelProfileDelete, (_event, id: string) => settingsStore.deleteProfile(id))
  ipcMain.handle(IPC.modelProfileSetDefault, (_event, id: string) => settingsStore.setDefaultProfile(id))
  ipcMain.handle(IPC.modelProfileTest, (_event, request: ModelTestRequest) => testModelConnection(request))
  ipcMain.handle(IPC.modelDiscover, (_event, request: ModelDiscoveryRequest) => discoverModels(request))

  ipcMain.handle(IPC.promptLibrary, () => promptStore.library())
  ipcMain.handle(IPC.promptOpen, () => promptStore.openLibrary())
  ipcMain.handle(IPC.promptOpenCharacter, (_event, characterId: string) => promptStore.openCharacter(characterId))

  // 记忆：每个 handler 都带上当前设置，保证改设置立即生效、无需重启
  ipcMain.handle(IPC.memoryStatus, () => memoryService.status(settingsStore.get().memory))
  ipcMain.handle(IPC.memoryList, () => memoryService.list())
  ipcMain.handle(IPC.memorySave, (_event, draft: MemoryDraft) => memoryService.save(draft))
  ipcMain.handle(IPC.memoryDelete, (_event, id: string) => memoryService.remove(id))
  ipcMain.handle(IPC.memoryClear, () => memoryService.clear())
  ipcMain.handle(IPC.memoryRecall, (_event, query: string) =>
    memoryService.probeRecall(query, settingsStore.get().memory)
  )
  ipcMain.handle(IPC.memoryOpenModel, async () => {
    const dir = memoryService.status(settingsStore.get().memory).modelPath
    const { shell } = await import('electron')
    return shell.openPath(dir)
  })

  ipcMain.handle(IPC.toolList, () => listDefinitions())
  ipcMain.handle(IPC.toolRespond, (_event, reply: ToolApprovalReply) => {
    permissionGate.resolve(reply)
  })
  // 工作区：多工作区清单。目录选择只能在这里做 —— 渲染进程没有 Node 能力。
  ipcMain.handle(IPC.workspaceList, () => settingsStore.listWorkspaces())
  ipcMain.handle(IPC.workspaceSave, (_event, draft: WorkspaceDraft) => {
    const catalog = settingsStore.saveWorkspace(draft)
    // 新建的工作区确保目录存在（用户可能手敲了一个还不存在的路径——
    // 但 saveWorkspace 已经校验过 isDirectory，走到这里目录一定在）
    ensureWorkspace(draft.dir)
    return catalog
  })
  ipcMain.handle(IPC.workspaceDelete, (_event, id: string) => {
    const catalog = settingsStore.deleteWorkspace(id)
    // 绑在这个工作区上的会话必须改绑，否则它们会带着失效 id 留在盘里，
    // 侧栏按工作区过滤后就再也看不见了（表现为"对话凭空消失"）。
    chatService.reassignWorkspace(id, catalog.activeWorkspaceId)
    return catalog
  })
  ipcMain.handle(IPC.workspaceSetActive, (_event, id: string) => settingsStore.setActiveWorkspace(id))
  ipcMain.handle(IPC.workspacePickDir, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择工作区目录',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ title: '选择工作区目录', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  })
  ipcMain.handle(IPC.workspaceOpen, async (_event, id: string) => {
    const workspace = settingsStore.get().workspaces.find((item) => item.id === id)
    if (!workspace) return '工作区不存在'
    const { shell } = await import('electron')
    return shell.openPath(workspace.dir)
  })

  // P6：渠道会话（id 形如 qq:<uin>:<type>:<id>）不进侧栏。
  // 它们由 QQ 消息驱动出现，用户没有「新建/删除」动作，出现在侧栏只会制造困惑。
  // 主进程内仍然能拿到（listSessions），只是不过 IPC。
  ipcMain.handle(IPC.chatList, () => chatService.listDesktopSessions())
  ipcMain.handle(IPC.chatCreate, (_event, input?: CreateSessionInput) => chatService.createSession(input))
  ipcMain.handle(IPC.chatUpdate, (_event, id: string, patch: UpdateSessionInput) =>
    chatService.updateSession(id, patch)
  )
  ipcMain.handle(IPC.chatDelete, (_event, id: string) => {
    chatService.deleteSession(id)
  })
  ipcMain.handle(IPC.chatSend, (event, input: SendInput) => chatService.send(input, event.sender))
  ipcMain.handle(IPC.chatStop, (_event, sessionId: string) => {
    chatService.stop(sessionId)
  })

  // QQ 接入（P4）：状态 / 进程 / 设置 / 日志
  registerQqIpcHandlers()
  // 渠道白名单（P6）：授权真源，替代已废弃的 QQ 绑定表
  registerChannelsIpcHandlers()
  // 区块（P5）：记忆域 / 群角色绑定
  registerZonesIpcHandlers()
  // 旁听库（P8）：只增不清的群语料，只读转发
  registerObserveIpcHandlers()
}
