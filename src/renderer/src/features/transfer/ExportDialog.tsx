import { useState } from 'react'
import type { ExportRequest } from '@shared/transfer'

export function ExportDialog({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  const [format, setFormat] = useState<ExportRequest['format']>('nc')
  const [scope, setScope] = useState<'current' | 'all'>(sessionId ? 'current' : 'all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState('')
  const close = (): void => { if (!busy) onClose() }
  const submit = async (): Promise<void> => {
    if (busy || (scope === 'current' && !sessionId)) return
    setBusy(true); setError(''); setReport('')
    try {
      const result = await window.nahida.transfer.export(scope === 'current' && sessionId ? { format, scope, sessionId } : { format, scope: 'all' })
      if (!result.ok) { if (!result.cancelled) setError(result.error || '导出未完成'); return }
      setReport('已导出 ' + result.sessionCount + ' 个会话 / ' + result.messageCount + ' 条消息。' + (result.warnings.length ? ' ' + result.warnings.join('；') : ''))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <div className="story-dialog__backdrop" role="presentation" onClick={close}><div className="story-dialog transfer-dialog" role="dialog" aria-modal="true" aria-label="导出对话" data-ui-region="C 对话导出" onClick={(event) => event.stopPropagation()}>
    <div className="story-dialog__head"><h2>导出对话</h2><button data-ui-target="关闭导出" aria-label="关闭导出" disabled={busy} onClick={close}>×</button></div>
    <fieldset className="story-field story-field--radios" disabled={busy} data-ui-target="导出格式"><legend>格式</legend><label><input type="radio" name="export-format" checked={format === 'nc'} onChange={() => setFormat('nc')} />NC 备份（完整消息）</label><label><input type="radio" name="export-format" checked={format === 'st'} onChange={() => setFormat('st')} />酒馆 JSONL（每会话一个文件）</label></fieldset>
    <fieldset className="story-field story-field--radios" disabled={busy} data-ui-target="导出范围"><legend>范围</legend><label><input type="radio" name="export-scope" disabled={!sessionId} checked={scope === 'current'} onChange={() => setScope('current')} />当前选中会话</label><label><input type="radio" name="export-scope" checked={scope === 'all'} onChange={() => setScope('all')} />全部桌面会话</label></fieldset>
    <p>在系统对话框中选择保存位置。</p>{error && <p role="alert" className="story-dialog__error">{error}</p>}{report && <p role="status" data-ui-target="导出结果">{report}</p>}
    <div className="story-dialog__actions"><button disabled={busy} onClick={close}>关闭</button><button className="is-primary" data-ui-target="确认导出" disabled={busy || (scope === 'current' && !sessionId)} onClick={() => void submit()}>{busy ? '导出中…' : '导出'}</button></div>
  </div></div>
}
