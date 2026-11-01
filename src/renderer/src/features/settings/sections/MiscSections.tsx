import { THEME } from '@shared/constants'
import type { AppInfo } from '@shared/types'
import { useTheme } from '../useTheme'

/** 外观：主题选择器（浅色 / 深色 / 跟随系统），改完立刻生效并落盘。 */
export function AppearanceSection() {
  const { mode, resolved, setMode } = useTheme()
  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>外观</h1>
        <p>主题会立刻生效，并记住到下一次启动。</p>
      </div>
      <section className="setting-group" data-ui-region="主题选择">
        <h3 className="setting-group__title">主题</h3>
        <p className="setting-group__desc">
          浅色是米白画布，深色是星空底；选「跟随系统」时按操作系统的外观设置自动切换。
        </p>
        <div className="theme-option-row" data-ui-target="主题单选">
          {(
            [
              ['light', '浅色'],
              ['dark', '深色'],
              ['system', '跟随系统']
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={'theme-option sel-frame--stitch' + (mode === value ? ' is-active' : '')}
              data-ui-target={'主题-' + label}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-group__desc" data-ui-target="当前主题">
          当前生效：<strong>{resolved === 'dark' ? '深色' : '浅色'}</strong>
          {mode === 'system' ? '（由系统决定）' : ''}
        </p>
      </section>
      <section className="setting-group">
        <h3 className="setting-group__title">配色</h3>
        <p className="setting-group__desc">
          色值统一收口在 tokens.css，组件里只引用变量。深色主题是同一套令牌的另一份取值。
        </p>
        <div className="swatch-row" data-ui-target="配色展示">
          <span className="swatch swatch--canvas" />
          <span>
            画布 {THEME.canvas} · 面板 {THEME.surface} · 强调 {THEME.accent}
          </span>
        </div>
      </section>
    </>
  )
}

/** 关于：版本与运行环境，数据目录便于用户直接找到落盘文件。 */
export function AboutSection({ info }: { info: AppInfo | null }) {
  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>关于</h1>
        <p>版本与运行环境。</p>
      </div>
      <section className="setting-group">
        <h3 className="setting-group__title">运行信息</h3>
        <p className="setting-group__desc">所有数据只存在本机，不联网同步。</p>
        {info ? (
          <dl className="info-grid" data-ui-target="运行信息">
            <dt>应用版本</dt>
            <dd>
              {info.name} {info.version}
            </dd>
            <dt>Electron</dt>
            <dd>{info.electron}</dd>
            <dt>Chromium</dt>
            <dd>{info.chrome}</dd>
            <dt>Node</dt>
            <dd>{info.node}</dd>
            <dt>平台</dt>
            <dd>{info.platform}</dd>
            <dt>数据目录</dt>
            <dd>{info.userDataPath}</dd>
            <dt>提示词目录</dt>
            <dd>{info.promptRoot}</dd>
          </dl>
        ) : (
          <p className="hint-text">读取中…</p>
        )}
      </section>
    </>
  )
}
