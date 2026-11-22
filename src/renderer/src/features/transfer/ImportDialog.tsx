import { useState } from 'react'
import type { ImportPreview } from '@shared/transfer'
import { usePromptLibrary } from '../settings/usePromptLibrary'
import { useSettings } from '../settings/useSettings'
import { useStoryStore } from '../story/store'
import { ImportPreviewPanel } from './ImportPreviewPanel'
import { refreshImported } from './refresh'

export function ImportDialog({ onClose, storyId, onImported }: { onClose: () => void; storyId?: string; onImported?: () => void }) {
  const { library } = usePromptLibrary()
  const { settings } = useSettings()
  const story = useStoryStore((state) => state.stories.find((item) => item.storyId === storyId))
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [title, setTitle] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [mode, setMode] = useState<'story' | 'chat' | 'agent'>('story')
  const [makeActive, setMakeActive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosen = storyId ? story?.characterId || '' : characterId || settings?.defaultCharacterId || library?.characters[0]?.id || ''
  const pick = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const next = await window.nahida.transfer.pickImport()
      if (next) { setPreview(next); setTitle(next.title); setCharacterId(next.suggestedCharacterId || '') }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const submit = async (): Promise<void> => {
    if (!preview || !chosen || !title.trim() || busy) return
    setBusy(true); setError('')
    try {
      const result = await window.nahida.transfer.import({ token: preview.token, title: title.trim(), target: storyId ? { kind: 'story-branch', storyId, makeActive } : mode === 'story' ? { kind: 'new-story', characterId: chosen } : { kind: 'session', mode, characterId: chosen } })
      await refreshImported(result, !storyId || makeActive)
      onImported?.(); onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const close = (): void => { if (!busy) onClose() }
  return <div className="story-dialog__backdrop" role="presentation" onClick={close}>
    <div className="story-dialog transfer-dialog" role="dialog" aria-modal="true" aria-label={storyId ? '导入为新分支' : '导入对话'} data-ui-region="C 对话导入" onClick={(event) => event.stopPropagation()}>
      <div className="story-dialog__head"><h2>{storyId ? '导入为新分支' : '导入对话'}</h2><button aria-label="关闭导入" data-ui-target="关闭导入" disabled={busy} onClick={close}>×</button></div>
      <div className="story-field__row"><button data-ui-target="选择导入文件" disabled={busy} onClick={() => void pick()}>{preview ? '重新选择文件' : '选择对话文件'}</button><span>自动识别酒馆 JSONL / NC JSON</span></div>
      {preview && <><ImportPreviewPanel preview={preview} />
        <label className="story-field"><span>标题</span><input data-ui-target="导入标题" disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="story-field"><span>{storyId ? '角色（跟随故事，已锁定）' : '角色'}</span><select data-ui-target="导入角色" disabled={busy || Boolean(storyId)} value={chosen} onChange={(event) => setCharacterId(event.target.value)}>
          {!chosen && <option value="">请选择角色</option>}{library?.characters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          {storyId && chosen && !library?.characters.some((item) => item.id === chosen) && <option value={chosen}>{chosen}</option>}
        </select></label>
        {storyId ? <label className="transfer-check"><input data-ui-target="设为活跃分支" type="checkbox" checked={makeActive} disabled={busy} onChange={(event) => setMakeActive(event.target.checked)} />导入后设为活跃分支</label> : <label className="story-field"><span>导入目标</span><select data-ui-target="导入模式" disabled={busy} value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="story">新故事区</option><option value="chat">Chat</option><option value="agent">Agent</option></select></label>}
      </>}
      {error && <p role="alert" className="story-dialog__error">{error}</p>}
      <div className="story-dialog__actions"><button disabled={busy} onClick={close}>取消</button><button className="is-primary" data-ui-target="确认导入" disabled={busy || !preview || !chosen || !title.trim()} onClick={() => void submit()}>{busy ? '处理中…' : '确认预览并导入'}</button></div>
    </div>
  </div>
}
