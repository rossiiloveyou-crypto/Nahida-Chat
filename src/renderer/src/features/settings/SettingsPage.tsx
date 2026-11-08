import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import type { AppInfo } from '@shared/types'
import { SettingsSidebar } from './SettingsSidebar'
import { MemorySection } from './sections/MemorySection'
import { ModelSection } from './sections/ModelSection'
import { PromptsSection } from './sections/PromptsSection'
import { StoriesSection } from './sections/StoriesSection'
import { ToolsSection } from './sections/ToolsSection'
import { QqSection } from './sections/QqSection'
import { ZonesSection } from './sections/ZonesSection'
import { ChannelsSection } from './sections/ChannelsSection'
import { AboutSection, AppearanceSection } from './sections/MiscSections'
import { isSettingsSectionId, type SettingsSectionId } from './nav'

/**
 * 设置页外壳：左栏换成设置导航（不再显示对话列表），右栏按 section 渲染。
 * 路由是 /settings/:section，刷新或深链都能落到同一个分区。
 */
export function SettingsPage() {
  const params = useParams<{ section?: string }>()
  const [info, setInfo] = useState<AppInfo | null>(null)

  // Hooks 必须先于任何条件返回，否则两次渲染的 hook 数量会对不上
  useEffect(() => {
    let alive = true
    window.nahida.app
      .info()
      .then((value) => {
        if (alive) setInfo(value)
      })
      .catch(() => {
        if (alive) setInfo(null)
      })
    return () => {
      alive = false
    }
  }, [])

  // 未知分区直接回落到模型配置，避免空白页
  if (params.section !== undefined && !isSettingsSectionId(params.section)) {
    return <Navigate to="/settings/models" replace />
  }

  const active: SettingsSectionId = isSettingsSectionId(params.section) ? params.section : 'models'

  return (
    <div className="app-shell app-shell--settings">
      <SettingsSidebar active={active} version={info ? info.version : '—'} />
      <main className="app-main">
        <section className="settings-page" data-ui-region="B 设置内容">
          <div
            className={
              active === 'models'
                ? 'settings-page__inner settings-page__inner--wide'
                : 'settings-page__inner'
            }
          >
            {active === 'models' && <ModelSection />}
            {active === 'prompts' && <PromptsSection />}
            {active === 'stories' && <StoriesSection />}
            {active === 'memory' && <MemorySection />}
            {active === 'zones' && <ZonesSection />}
            {active === 'channels' && <ChannelsSection />}
            {active === 'qq' && <QqSection />}
            {active === 'tools' && <ToolsSection />}
            {active === 'appearance' && <AppearanceSection />}
            {active === 'about' && <AboutSection info={info} />}
          </div>
        </section>
      </main>
    </div>
  )
}