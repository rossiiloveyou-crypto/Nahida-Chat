import { join } from 'node:path'
import { BrowserWindow, nativeTheme, shell } from 'electron'
import { THEME, THEME_DARK } from '@shared/constants'
import { settingsStore } from './features/settings/settingsStore'

/**
 * 求当前"应该用哪个主题"。
 *
 * system 模式下读主进程的 nativeTheme，**不要**在渲染层用 matchMedia 猜——
 * 主进程要拿它决定窗口底色，两边各猜一次必然不一致。
 *
 * settingsStore 在 app ready 之后才可用（userData 路径依赖 app），
 * 而 window 只会在 ready 之后创建，所以这里直接读是安全的。
 */
function resolveEffectiveTheme(): 'light' | 'dark' {
  let mode: 'light' | 'dark' | 'system' = 'light'
  try {
    mode = settingsStore.get().appearance.theme
  } catch {
    // 配置读不出来（首次启动 / 文件损坏）时按浅色起，绝不猜深色
    return 'light'
  }
  if (mode === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
  return mode
}

export function createMainWindow(): BrowserWindow {
  // 深色下窗口底色必须跟着变，否则渲染进程画出第一帧前会先露出一块浅色底（D5 白闪）
  const theme = resolveEffectiveTheme()
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'Nahida Chat',
    backgroundColor: theme === 'dark' ? THEME_DARK.canvas : THEME.canvas,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 让 preload 能在首帧前同步拿到主题，见 PHASE-1 §4.5
      additionalArguments: ['--nahida-theme=' + theme]
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
