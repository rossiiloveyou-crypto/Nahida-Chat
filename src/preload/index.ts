import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { NahidaApi } from '@shared/api'
import { IPC } from '@shared/ipc'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

/**
 * 初始主题：由主进程通过 additionalArguments 注入，preload 同步解析。
 *
 * 为什么走 preload 而不是异步 IPC：渲染层必须在 createRoot 之前决定
 * <html data-theme>，异步拿会造成"先画浅色一帧再变深色"——就是要治的白闪。
 * 缺省按 light，绝不猜 dark。
 */
function readInitialTheme(): 'light' | 'dark' {
  const prefix = '--nahida-theme='
  const argv = Array.isArray(process.argv) ? process.argv : []
  const hit = argv.find((item) => typeof item === 'string' && item.startsWith(prefix))
  const value = hit ? hit.slice(prefix.length) : ''
  return value === 'dark' ? 'dark' : 'light'
}

const api: NahidaApi = {
  initialTheme: readInitialTheme(),
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    save: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch)
  },
  modelProfiles: {
    list: () => ipcRenderer.invoke(IPC.modelProfileList),
    save: (draft) => ipcRenderer.invoke(IPC.modelProfileSave, draft),
    remove: (id) => ipcRenderer.invoke(IPC.modelProfileDelete, id),
    setDefault: (id) => ipcRenderer.invoke(IPC.modelProfileSetDefault, id),
    test: (request) => ipcRenderer.invoke(IPC.modelProfileTest, request),
    discover: (request) => ipcRenderer.invoke(IPC.modelDiscover, request)
  },
  prompts: {
    library: () => ipcRenderer.invoke(IPC.promptLibrary),
    openLibrary: () => ipcRenderer.invoke(IPC.promptOpen),
    openCharacter: (characterId) => ipcRenderer.invoke(IPC.promptOpenCharacter, characterId)
  },
  tools: {
    list: () => ipcRenderer.invoke(IPC.toolList),
    respond: (reply) => ipcRenderer.invoke(IPC.toolRespond, reply)
  },
  workspaces: {
    list: () => ipcRenderer.invoke(IPC.workspaceList),
    save: (draft) => ipcRenderer.invoke(IPC.workspaceSave, draft),
    remove: (id) => ipcRenderer.invoke(IPC.workspaceDelete, id),
    setActive: (id) => ipcRenderer.invoke(IPC.workspaceSetActive, id),
    pickDirectory: () => ipcRenderer.invoke(IPC.workspacePickDir),
    open: (id) => ipcRenderer.invoke(IPC.workspaceOpen, id)
  },
  memory: {
    status: () => ipcRenderer.invoke(IPC.memoryStatus),
    list: () => ipcRenderer.invoke(IPC.memoryList),
    save: (draft) => ipcRenderer.invoke(IPC.memorySave, draft),
    remove: (id) => ipcRenderer.invoke(IPC.memoryDelete, id),
    clear: () => ipcRenderer.invoke(IPC.memoryClear),
    recall: (query) => ipcRenderer.invoke(IPC.memoryRecall, query),
    openModelDir: () => ipcRenderer.invoke(IPC.memoryOpenModel)
  },
  chat: {
    listSessions: () => ipcRenderer.invoke(IPC.chatList),
    createSession: (input) => ipcRenderer.invoke(IPC.chatCreate, input),
    updateSession: (id, patch) => ipcRenderer.invoke(IPC.chatUpdate, id, patch),
    deleteSession: (id) => ipcRenderer.invoke(IPC.chatDelete, id),
    send: (input) => ipcRenderer.invoke(IPC.chatSend, input),
    stop: (sessionId) => ipcRenderer.invoke(IPC.chatStop, sessionId),
    onDelta: (handler) => subscribe(IPC.chatDelta, handler),
    onTool: (handler) => subscribe(IPC.chatTool, handler),
    onApproval: (handler) => subscribe(IPC.chatApproval, handler),
    onDone: (handler) => subscribe(IPC.chatDone, handler),
    onError: (handler) => subscribe(IPC.chatError, handler)
  },
  qq: {
    status: () => ipcRenderer.invoke(IPC.qqStatus),
    processes: () => ipcRenderer.invoke(IPC.qqProcesses),
    load: (pid) => ipcRenderer.invoke(IPC.qqLoad, pid),
    unload: (pid) => ipcRenderer.invoke(IPC.qqUnload, pid),
    restart: () => ipcRenderer.invoke(IPC.qqRestart),
    getSettings: () => ipcRenderer.invoke(IPC.qqSettingsGet),
    saveSettings: (patch) => ipcRenderer.invoke(IPC.qqSettingsSave, patch),
    logs: (limit) => ipcRenderer.invoke(IPC.qqLogs, limit),
    onEvent: (handler) => subscribe(IPC.qqEvent, handler)
  },
  zones: {
    list: () => ipcRenderer.invoke(IPC.zoneList),
    create: (draft) => ipcRenderer.invoke(IPC.zoneCreate, draft),
    rename: (zoneId, name) => ipcRenderer.invoke(IPC.zoneRename, zoneId, name),
    remove: (zoneId) => ipcRenderer.invoke(IPC.zoneDelete, zoneId),
    updateConfig: (zoneId, patch) => ipcRenderer.invoke(IPC.zoneConfig, zoneId, patch),
    addMember: (draft) => ipcRenderer.invoke(IPC.zoneMemberAdd, draft),
    removeMember: (zoneId, key) => ipcRenderer.invoke(IPC.zoneMemberRemove, zoneId, key),
    adopt: (zoneId, members) => ipcRenderer.invoke(IPC.zoneAdopt, zoneId, members),
    stats: () => ipcRenderer.invoke(IPC.zoneStats),
    unzoned: () => ipcRenderer.invoke(IPC.zoneUnzoned)
  },
  channels: {
    config: () => ipcRenderer.invoke(IPC.channelsConfig),
    setGates: (patch) => ipcRenderer.invoke(IPC.channelsGates, patch),
    saveAccount: (draft) => ipcRenderer.invoke(IPC.channelsAccount, draft),
    removeAccount: (userId) => ipcRenderer.invoke(IPC.channelsRemoveAccount, userId),
    saveGroup: (draft) => ipcRenderer.invoke(IPC.channelsGroup, draft),
    removeGroup: (chatId) => ipcRenderer.invoke(IPC.channelsRemoveGroup, chatId),
    rememberUin: (uin) => ipcRenderer.invoke(IPC.channelsUin, uin),
    sessions: () => ipcRenderer.invoke(IPC.channelsSessions),
    status: () => ipcRenderer.invoke(IPC.channelsStatus)
  },
  // P8：旁听库只有这四个只读入口。**没有** clear / delete —— 见 PHASE-8 §4.6。
  observe: {
    status: () => ipcRenderer.invoke(IPC.observeStatus),
    conversations: () => ipcRenderer.invoke(IPC.observeConversations),
    tail: (payload) => ipcRenderer.invoke(IPC.observeTail, payload),
    openDir: () => ipcRenderer.invoke(IPC.observeOpenDir)
  }
}

contextBridge.exposeInMainWorld('nahida', api)
