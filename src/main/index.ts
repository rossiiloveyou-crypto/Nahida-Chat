import { app, BrowserWindow, shell } from 'electron'
import { registerIpcHandlers } from './ipc'
import { channelStore, migrateFromBindings } from './features/channels/store'
import { startQqHost } from './features/qq/host'
import { startQqBridge } from './features/qq/bridge'
import { settingsStore } from './features/settings/settingsStore'
import { zoneStore } from './features/zones/store'
import { registerBuiltinTools } from './features/tools/builtin'
import { ensureWorkspace } from './features/workspace'
import { createMainWindow } from './window'

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.nahida.chat')

    // 工具要在任何一次对话之前注册好
    registerBuiltinTools()
    // 每个工作区都确保目录存在；只有内置默认工作区才塞 README，
    // 用户自己选的目录一律不动它的内容。
    for (const workspace of settingsStore.get().workspaces) {
      ensureWorkspace(workspace.dir, workspace.id === 'workspace-default')
    }

    // 任何渲染进程都不允许偷偷开新窗口或跳外链以外的导航
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-navigate', (event, url) => {
        const devServerUrl = process.env['ELECTRON_RENDERER_URL']
        const allowed = devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://')
        if (!allowed) {
          event.preventDefault()
          if (url.startsWith('https://')) void shell.openExternal(url)
        }
      })
    })

    // P6：旧绑定表 → 白名单的一次性迁移。只在检测到 userData/qq/bindings.json 时动，
    // 旧文件原地保留（只增不清）。必须在注册 IPC 之前跑，面板一打开就该看到迁移结果。
    const migrated = migrateFromBindings()
    if (migrated > 0) console.log('[channels] 已把 ' + String(migrated) + ' 条旧绑定迁移为白名单条目')
    // P9-R3：v1（会话级）→ v2（人 + 群）。**破坏性改写，先备份**（access.v1.backup.json）。
    // 幂等：已经是 v2 就直接返回，不重复迁。必须在注册 IPC 之前跑，面板一打开就该看到新形状。
    const upgrade = channelStore.migrateToV2()
    if (upgrade.migrated) {
      console.log(
        '[channels] access.json 已升级到 v2：' +
          String(upgrade.accounts) +
          ' 个账号 / ' +
          String(upgrade.groups) +
          ' 个群' +
          (upgrade.backedUp ? '（已备份 access.v1.backup.json）' : '（备份文件已存在，未覆盖）')
      )
    }

    registerIpcHandlers()
    createMainWindow()

    // QQ 协议运行时宿主（snowluma-host）。**必须在 whenReady 之后**：
    // 之前 app.getPath('userData') 还不可靠，而宿主的数据目录就落在 userData/snowluma。
    // 起不来不影响 NC 主进程（宿主是独立 node.exe），面板状态会显示 degraded。
    startQqHost()
    // 区块表要先可用：startQqBridge 注册的域解析器会在第一条消息到达时就查它，
    // 提前 touch 一次让 zones.json 在首次运行时落盘（而不是等第一条消息）。
    zoneStore.listZones()
    // 入站/出站编排。必须晚于宿主启动：桥一创建就订阅宿主的 event 通道。
    startQqBridge()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
