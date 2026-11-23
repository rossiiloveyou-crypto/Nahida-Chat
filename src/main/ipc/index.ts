import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { RequestReplyInput } from '@shared/api'
import { isChannelSessionId } from '@shared/channels'
import { BRIDGE_IPC } from '@shared/bridge'
import type { BridgeConfig, BridgeHealth, BridgeOverrideState } from '@shared/bridge'
import type {
  AppInfo,
  CreateSessionInput,
  MemoryDraft,
  MemoryModelProgress,
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
import { summaryService } from '../features/summary/service'
import { permissionGate } from '../features/tools/permission'
import { listDefinitions } from '../features/tools/registry'
import { registerChannelsIpcHandlers } from './channels'
import { registerObserveIpcHandlers } from './observe'
import { registerQqIpcHandlers } from './qq'
import { registerStoryIpcHandlers } from './story'
import { registerWorldbookIpcHandlers } from './worldbook'
import { registerMemoryIpcHandlers } from './memory'
import { registerWipeIpcHandlers } from './wipe'
import { registerRegexIpcHandlers } from './regex'
import { registerTransferIpcHandlers } from './transfer'
import { bridgeHost } from '../features/bridge/host'
import { bridgeDriver } from '../features/bridge/driver'
import { ensureOverrideFile, getOverride, saveOverride } from '../features/bridge/override'

/** 所有 IPC handler 在这里集中注册，渲染进程能做的事一目了然。 */
export function registerIpcHandlers(): void {
  registerTransferIpcHandlers()
  ensureOverrideFile()
  promptStore.ensureUserRoot()
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userDataPath: app.getPath('userData'),
    promptRoot: promptStore.userRoot()
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
  ipcMain.handle(IPC.promptOpenUserRoot, () => promptStore.openUserRoot())
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
  ipcMain.handle(IPC.memoryDownloadModel, async (event: Electron.IpcMainInvokeEvent) => {
    const controller = new AbortController()
    const sender = event.sender
    const push = (progress: MemoryModelProgress): void => {
      if (!sender.isDestroyed()) sender.send(IPC.memoryModelProgress, progress)
    }
    try {
      const dir = await memoryService.downloadModel(push, controller.signal)
      return { ok: true as const, dir, status: memoryService.status(settingsStore.get().memory) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      push({ phase: 'failed', file: '', ratio: 0, receivedBytes: 0, totalBytes: 0, error: message })
      return { ok: false as const, error: message, status: memoryService.status(settingsStore.get().memory) }
    }
  })
  ipcMain.handle(IPC.memoryOpenModel, async () => {
    const dir = memoryService.status(settingsStore.get().memory).modelPath
    const { shell } = await import('electron')
    return shell.openPath(dir)
  })

  // 对话摘要：把窗口外的对话压成四段文本（与上面的 memory:* 是两套东西）。
  // forget 只删一条会话的摘要，clear 删全部摘要；两者都不动 sessions.json 与 memory.db。
  ipcMain.handle(IPC.summaryStatus, () => summaryService.status())
  ipcMain.handle(IPC.summaryForget, (_event, sessionId: string) => {
    summaryService.forget(String(sessionId ?? ''))
    return summaryService.status()
  })
  ipcMain.handle(IPC.summaryClear, () => summaryService.clear())

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

  registerMemoryIpcHandlers()
  registerWipeIpcHandlers()
  // 显示层正则（P3）：只读 ST 的 regex_scripts；读盘失败返回空数组，绝不抛
  registerRegexIpcHandlers()

  // P2：进程与日志入口；配置校验和 userData/nc-bridge/config.json 持久化由 host 负责。
  // 打开 ST 只管理进程和可见窗口，生成仍由 chatService 的 bridgeEligible 路由触发。
  ipcMain.handle(BRIDGE_IPC.health, (): BridgeHealth => {
    const health = bridgeHost.health()
    const trace = bridgeDriver.lastTurnTrace()
    if (!trace?.budgetSource) return health
    return { ...health, budget: {
      budgetSource: { ...trace.budgetSource },
      budgetTotal: trace.budgetTotal, budgetUsed: trace.budgetUsed,
      stReserveTokens: trace.stReserveTokens, historyDropped: trace.historyDropped,
      historySent: trace.historySent
    } }
  })
  ipcMain.handle(BRIDGE_IPC.openSt, (_event, config?: Partial<BridgeConfig>): Promise<BridgeHealth> =>
    bridgeHost.openSt(config === undefined ? undefined : {
      stRoot: config.stRoot,
      cardName: config.cardName,
      port: config.port,
      nodePath: config.nodePath,
      generateTimeoutMs: config.generateTimeoutMs,
      budgetEnabled: config.budgetEnabled,
      manualBudgetTokens: config.manualBudgetTokens,
      stReserveTokens: config.stReserveTokens
    })
  )
  ipcMain.handle(BRIDGE_IPC.stopSt, (): Promise<BridgeHealth> => bridgeHost.stopSt())
  ipcMain.handle(BRIDGE_IPC.openLog, (): Promise<void> => bridgeHost.openLog())
  ipcMain.handle(BRIDGE_IPC.overrideGet, (): BridgeOverrideState => getOverride())
  ipcMain.handle(BRIDGE_IPC.overrideSave, (_event, text: unknown): BridgeOverrideState => saveOverride(text))

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
  ipcMain.handle(IPC.chatQueueMessage, (_event, input: SendInput) => {
    if (isChannelSessionId(input.sessionId)) throw new Error('渠道会话不支持预发送')
    return chatService.queueMessage(input)
  })
  ipcMain.handle(IPC.chatRequestReply, (event, input: RequestReplyInput) => {
    if (isChannelSessionId(input.sessionId)) throw new Error('渠道会话不支持预发送')
    return chatService.requestReply(input, event.sender)
  })
  ipcMain.handle(IPC.chatNarrate, (_event, sessionId: string, content: string) =>
    chatService.narrate(sessionId, content)
  )
  ipcMain.handle(IPC.chatStop, (_event, sessionId: string) => {
    chatService.stop(sessionId)
  })
  // 重试 / 删消息（2026-11-14）：失败的气泡要能自己收场，不能只靠「再发一条消息绕过去」
  ipcMain.handle(IPC.chatRetry, (event, sessionId: string, messageId: string) =>
    chatService.retry(sessionId, messageId, event.sender)
  )
  ipcMain.handle(IPC.chatUpdateMessage, (_event, sessionId: string, messageId: string, content: string) =>
    chatService.updateMessage(sessionId, messageId, content)
  )
  ipcMain.handle(IPC.chatResend, (event, sessionId: string, messageId: string, content: string) =>
    chatService.resendFrom(sessionId, messageId, content, event.sender)
  )
  ipcMain.handle(IPC.chatDeleteMessage, (_event, sessionId: string, messageId: string) => {
    if (isChannelSessionId(sessionId)) throw new Error('渠道会话的消息只读')
    chatService.deleteMessage(sessionId, messageId)
  })

  // QQ 接入（P4）：状态 / 进程 / 设置 / 日志
  registerQqIpcHandlers()
  // 渠道白名单（P6）：授权真源，替代已废弃的 QQ 绑定表
  registerChannelsIpcHandlers()
  // 旁听库（P8）：只增不清的群语料，只读转发
  registerObserveIpcHandlers()
  // 故事区（P4）：建区 / 列区 / 读区 / 删区（删区要 confirmed）
  registerStoryIpcHandlers()
  // 世界书编写器（P9 / M26）：写 worldbook/*.md，原子写 + .bak + 路径守卫
  registerWorldbookIpcHandlers()
}
