import { useNavigate } from 'react-router-dom'
import { brandFor } from '../../assets/nahida'
import { useTheme } from './useTheme'
import { SETTINGS_NAV, type SettingsSectionId } from './nav'
import { IconBack } from './icons'

interface SettingsSidebarProps {
  active: SettingsSectionId
  version: string
}

/**
 * 设置态的左栏：不再显示对话列表，而是设置条目。
 * 视觉骨架与聊天侧栏共用同一套 .sidebar 变量，只换内容。
 */
export function SettingsSidebar({ active, version }: SettingsSidebarProps) {
  const navigate = useNavigate()
  // 与对话侧栏共用同一枚品牌头像：.brand-mark 在 P2 已改成图片容器，
  // 留着汉字 div 会变成"没有白底的裸字"（P2 施工实测）。
  const brand = brandFor(useTheme().resolved)

  return (
    <aside className="sidebar sidebar--settings" data-ui-region="A 设置导航">
      <div className="sidebar__brand">
        <img className="brand-mark" src={brand.avatar} alt="" aria-hidden="true" />
        <div className="brand-text">
          <strong>设置</strong>
          <span>Nahida Chat</span>
        </div>
      </div>

      <button className="settings-back" data-ui-target="返回对话" onClick={() => navigate('/chat')}>
        <IconBack size={16} />
        返回对话
      </button>

      <nav className="settings-nav" data-ui-target="导航条目" aria-label="设置导航">
        {SETTINGS_NAV.map((item, index) => {
          const showGroup = index === 0 || SETTINGS_NAV[index - 1].group !== item.group
          const Icon = item.icon
          const isActive = item.id === active
          return (
            <div key={item.id}>
              {showGroup && <div className="settings-nav__group">{item.group}</div>}
              <button
                type="button"
                className={'settings-nav__item sel-frame--stitch' + (isActive ? ' is-active' : '')}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => navigate('/settings/' + item.id, { replace: true })}
              >
                <span className="settings-nav__icon">
                  <Icon size={17} />
                </span>
                <span className="settings-nav__label">
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </button>
            </div>
          )
        })}
      </nav>

      <div className="sidebar__footer settings-nav__footer">
        <span className="hint-text">v{version}</span>
      </div>
    </aside>
  )
}
