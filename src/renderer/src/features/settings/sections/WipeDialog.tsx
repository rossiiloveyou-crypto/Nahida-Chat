import { useEffect, useState } from 'react'
import type { WipeCaptcha, WipeExecuteResult, WipePreview } from '@shared/api'

/**
 * P7：「清空全部数据」的确认弹框（**本任务唯一不可逆的操作**）。
 *
 * 四态由 M15 / M16 逐条钉死，这一层只负责**显示与转发**：
 *  ① 打开弹框先只拉清单，**不生成码**（点「我明白，生成验证码」之后才有码）；
 *  ② 码是 8 位 hex，由主进程生成；这里只显示，不参与任何校验；
 *  ③ 不可鼠标复制 —— .wipe-code 的 user-select: none（双击也选不中）；
 *  ④ 错 1、2 次：留在框里、清空输入、**码不变**；第 3 次：关框 + 提示「删除失败」。
 *
 * 🔴 校验真值在主进程（ipc/wipe.ts）。前端自己比一遍码等于把验证码交给 DevTools。
 * 🔴 不要换成 window.confirm：它既不能延后生成码，也不能阻止复制，更不能「错 3 次关框」。
 */
/** 关闭回调：带 reason 表示「不是用户自己关的」，父组件据此在页面上留一句提示 */
export function WipeDialog({ onClose }: { onClose: (reason?: string) => void }) {
  const [preview, setPreview] = useState<WipePreview | null>(null)
  const [captcha, setCaptcha] = useState<WipeCaptcha | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.nahida.wipe
      .preview()
      .then((next) => {
        if (alive) setPreview(next)
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.nahida.wipe.captcha()
      setCaptcha(next)
      setInput('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result: WipeExecuteResult = await window.nahida.wipe.execute(input)
      if (result.ok) {
        // 报告已到，主进程紧接着 relaunch —— 这里只留一句话，不再改任何状态
        setError(null)
        setBusy(true)
        return
      }
      if (result.reason === 'too_many_failures') {
        // M16：第 3 次错 → 关闭弹框 + 提示「删除失败」。提示必须留在页面上，
        // 否则框一关用户什么都看不到，只会以为「点了一下，什么也没发生」。
        onClose('删除失败：验证码连续输错 3 次，弹框已关闭。数据未被删除。')
        return
      }
      if (result.reason === 'wrong') {
        setInput('')
        setError('验证码不对，请重试（码不变）')
        return
      }
      if (result.reason === 'expired') {
        setCaptcha(null)
        setInput('')
        setError('验证码已过期，请重新生成')
        return
      }
      if (result.reason === 'no_captcha') {
        setCaptcha(null)
        setError('还没有验证码，请先点「我明白，生成验证码」')
        return
      }
      setError(result.report?.detail ? '删除失败：' + result.report.detail : '删除失败')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="story-dialog__backdrop" role="presentation" onClick={busy ? undefined : () => onClose()}>
      <div
        className="story-dialog"
        role="dialog"
        aria-label="清空全部数据"
        data-ui-target="清空全部数据弹框"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="story-dialog__head">
          <h2>清空全部数据</h2>
          <button className="story-dialog__close" aria-label="关闭" disabled={busy} onClick={() => onClose()}>
            ×
          </button>
        </div>
        <p className="setting-group__desc">
          这是唯一<strong>不可撤销</strong>的操作。执行前会把要删的四类文件自动备份到
          <code> %APPDATA%\Nahida Chat.p7-backup-&lt;时间&gt; </code>，删完应用会立即重启。
        </p>

        <h3 className="setting-group__title">会删除</h3>
        <ul className="memory-list" data-ui-target="将删除清单">
          {(preview?.willDelete ?? []).map((item) => (
            <li key={item.path} className="memory-list__item">
              <div className="memory-list__body">
                <span className="memory-list__text">
                  <code>{item.path}</code> —— {item.detail}
                </span>
              </div>
            </li>
          ))}
        </ul>

        <h3 className="setting-group__title">会保留</h3>
        <ul className="memory-list" data-ui-target="将保留清单">
          {(preview?.willKeep ?? []).map((item) => (
            <li key={item.path} className="memory-list__item">
              <div className="memory-list__body">
                <span className="memory-list__text">
                  <code>{item.path}</code> —— {item.why}
                </span>
              </div>
            </li>
          ))}
        </ul>

        {captcha === null ? (
          <div className="settings-actions" data-ui-target="生成验证码">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void start()}>
              我明白，生成验证码
            </button>
          </div>
        ) : (
          <div data-ui-target="验证码输入">
            <p className="wipe-code" data-ui-target="验证码">
              {captcha.code}
            </p>
            <input
              className="field__control"
              value={input}
              placeholder="输入上面的 8 位码（不可复制，请照着敲）"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setInput(event.target.value)}
            />
            <div className="settings-actions">
              <button
                type="button"
                className="btn-ghost btn-ghost--danger"
                disabled={busy || input.trim().length === 0}
                onClick={() => void submit()}
              >
                确认清空（不可撤销）
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="story-dialog__error" data-ui-target="清空失败提示">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
