import { useState } from 'react'
import { isChannelSessionId } from '@shared/channels'
import { useChatStore } from '../../chat/store'
import { ExportDialog } from '../../transfer/ExportDialog'
import { ImportDialog } from '../../transfer/ImportDialog'

export function BackupPanel() {
  const sessions = useChatStore((state) => state.sessions)
  const [sessionId, setSessionId] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  return <section className="settings-section" data-ui-region="C 数据与备份">
    <header className="settings-section__head"><h1>数据与备份</h1><p>导入对话文件，或把桌面会话导出为备份。</p></header>
    <div className="settings-card transfer-card"><h2>对话导入</h2><p>自动识别酒馆 JSONL 与 NC 备份。确认预览后才会创建新会话。</p><button data-ui-target="设置页导入对话" onClick={() => setImportOpen(true)}>从文件导入</button></div>
    <div className="settings-card transfer-card"><h2>对话导出</h2><p>选择单个会话或全部桌面会话，再选择输出格式。</p><label className="story-field"><span>会话</span><select data-ui-target="选择备份会话" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
      <option value="">全部桌面会话</option>
      {sessions.filter((session) => !isChannelSessionId(session.id)).map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
    </select></label><button data-ui-target="设置页导出对话" onClick={() => setExportOpen(true)}>导出备份</button></div>
    {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
    {exportOpen && <ExportDialog sessionId={sessionId || undefined} onClose={() => setExportOpen(false)} />}
  </section>
}
