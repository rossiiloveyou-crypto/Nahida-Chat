import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, nativeTheme, shell } from 'electron'
import { POST_WIPE_FLAG, THEME, THEME_DARK } from '@shared/constants'
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

  // 🔴 D-5：清空后重启的实例带 POST_WIPE_FLAG —— 那一次**不许**再连 dev server。
  //    dev server 住在 electron-vite 进程里，旧实例一退它就没了，连过去只会得到
  //    ERR_CONNECTION_REFUSED（探针实测 did-fail-load -102），用户看到的就是白屏。
  const afterWipe = process.argv.includes(POST_WIPE_FLAG)
  const devServerUrl = afterWipe ? undefined : process.env['ELECTRON_RENDERER_URL']
  const builtHtml = join(__dirname, '../renderer/index.html')
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else if (existsSync(builtHtml)) {
    void window.loadFile(builtHtml)
  } else {
    // 连构建产物都没有：给一句能照着做的提示，绝不留一张纯白页面
    void window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<body style="font:14px/1.7 system-ui;padding:32px;color:#333">' +
            '<h2 style="margin:0 0 8px">已清空数据，但没有可加载的页面</h2>' +
            '<p>这次重启既没有 dev server，也没有构建产物（out/renderer/index.html）。</p>' +
            '<p>请回到终端重新运行 <code>pnpm dev</code>。</p>' +
            '</body>'
        )
    )
  }

  return window
}
