/**
 * 设置 · ST 桥接（P6 / F-01 / F-07）。
 *
 * 只有两件事：一个开关（三条件与的第三条）＋ 一块**只读**健康度。
 *
 * 🔴 为什么不做「测试连接」按钮：桥接的窗口是懒启动的，第一次 ensure() 就发生在
 *    用户真正的第一轮故事生成里。给设置页加一个「现在连一次」的按钮，等于让隐藏窗口
 *    在用户没打算聊天的时候起来（多一个 ST 进程、多一份拦截日志），而且它成功也不代表
 *    生成能成功 —— 那个按钮只会制造「设置页绿了、聊天还是失败」的错觉。
 *    健康度里 alive / lastError 已经把「上一次为什么没好」说清楚了。
 * 🔴 连接参数（地址 / 数据目录 / 超时）**只读显示**，不在 NC 里改：
 *    它们是部署事实（BRIDGE_DEFAULT_CONFIG），写进 Settings 会变成第二份真值。
 */
import { useCallback, useEffect, useState } from 'react'
import type { BridgeHealth } from '@shared/bridge'
import { useSettings } from '../useSettings'

/** 把毫秒显示成人话（设置页只显示三个超时，不做格式化工具库） */
function seconds(ms: number): string {
  return String(Math.round(ms / 1000)) + ' 秒'
}

export function BridgeSection() {
  const { settings, loading, saving, error, save } = useSettings()
  const [health, setHealth] = useState<BridgeHealth | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)

  const enabled = settings?.bridge?.enabled === true

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setHealth(await window.nahida.bridge.health())
      setHealthError(null)
    } catch (cause) {
      // 健康度读不到不是致命：开关照常能改，只是这块显示不出来
      setHealth(null)
      setHealthError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (next: boolean): Promise<void> => {
    const ok = await save({ bridge: { enabled: next } })
    if (ok) setSavedAt(Date.now())
    void refresh()
  }

  return (
    <>
      <div className="settings-page__head" data-ui-target="页头">
        <h1>ST 桥接</h1>
        <p>
          打开后，故事模式的每一轮改成由 SillyTavern 的完整提示词管线出字；
          上下文与分支仍由 NC 独占，ST 侧不留任何痕迹。
        </p>
      </div>

      <section className="setting-group" data-ui-region="桥接开关">
        <h3 className="setting-group__title">总开关</h3>
        <p className="setting-group__desc">
          关掉即逐字回到原来的路径：故事模式走 NC 自己的模型配置，不启动隐藏窗口。
          渠道会话（QQ）永远不走桥接，与这个开关无关。
        </p>
        <p className="setting-group__desc" data-ui-target="ST 后台运行提示">
          使用前需先在后台启动 SillyTavern（ST）服务，并在使用期间保持运行。
          NC 不会自动启动 ST；仅关闭浏览器页面不影响已运行的 ST 服务。
        </p>
        <label className="setting-toggle" data-ui-target="桥接开关">
          <input
            type="checkbox"
            checked={enabled}
            disabled={loading || saving}
            onChange={(event) => void toggle(event.target.checked)}
          />
          <span>故事模式走 ST 桥接</span>
        </label>
        {savedAt > 0 && <p className="hint-text">已保存。</p>}
        {error && <p className="hint-text hint-text--error">保存失败：{error}</p>}
      </section>

      <section className="setting-group" data-ui-region="桥接健康度">
        <h3 className="setting-group__title">运行状态</h3>
        <p className="setting-group__desc">
          隐藏窗口是懒启动的：第一轮故事生成才会拉起它，所以没聊过天时这里是「未启动」，不是出错。
        </p>
        {healthError && <p className="hint-text hint-text--error">读取失败：{healthError}</p>}
        {health && (
          <dl className="info-grid" data-ui-target="桥接状态">
            <dt>隐藏窗口</dt>
            <dd>{health.alive ? '已就绪' : '未启动 / 已关闭'}</dd>
            <dt>当前轮次</dt>
            <dd>{health.busy ? '正在启动或执行' : '空闲'}</dd>
            <dt>重建次数</dt>
            <dd>{health.rebuilds}</dd>
            <dt>拦下的写盘请求</dt>
            <dd>{health.cancelledWrites}</dd>
            <dt>拦下的外网请求</dt>
            <dd>{health.blockedExternal}</dd>
            <dt>最近错误</dt>
            <dd>{health.lastError ?? '无'}</dd>
            <dt>ST 地址</dt>
            <dd>{health.config.stUrl}</dd>
            <dt>ST 数据目录</dt>
            <dd>{health.config.stDataDir}</dd>
            <dt>单轮上限</dt>
            <dd>{seconds(health.config.generateTimeoutMs)}</dd>
          </dl>
        )}
        <button type="button" className="theme-option sel-frame--stitch" data-ui-target="刷新桥接状态" onClick={() => void refresh()}>
          刷新状态
        </button>
      </section>
    </>
  )
}
