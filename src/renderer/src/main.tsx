import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles/tokens.css'
import './styles/global.css'

// 首帧前把主题落到 <html>：必须在 createRoot 之前，否则必然"先浅后深"闪一下。
// 主题来自 preload 注入的同步常量（主进程 additionalArguments），不经过异步 IPC。
const bootTheme = window.nahida?.initialTheme ?? 'light'
if (bootTheme === 'dark') document.documentElement.dataset.theme = 'dark'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点')

if (!window.nahida) {
  container.innerHTML =
    '<div style="padding:40px;font-family:sans-serif;line-height:1.7">预加载脚本未注入，应用无法启动。<br/>请通过 pnpm dev 或打包后的可执行文件启动。</div>'
} else {
  createRoot(container).render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>
  )
}
