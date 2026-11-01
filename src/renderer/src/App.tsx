import { Navigate, Route, Routes } from 'react-router-dom'
import { GridOverlay } from './components/GridOverlay'
import { Sidebar } from './components/Sidebar'
import { ChatPage } from './features/chat/ChatPage'
import { SettingsPage } from './features/settings/SettingsPage'

/**
 * 两条主线：
 * - /chat 使用对话外壳（左栏 = 会话列表）
 * - /settings/* 使用设置外壳（左栏 = 设置条目，由 SettingsPage 自己渲染）
 */
export default function App() {
  return (
    <>
      <Routes>
        <Route
          path="/chat"
          element={
            <div className="app-shell">
              <Sidebar />
              <main className="app-main">
                <ChatPage />
              </main>
            </div>
          }
        />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
      {/* 网格调试覆盖层：默认关闭，Ctrl/Cmd + Shift + G 显隐 */}
      <GridOverlay />
    </>
  )
}
