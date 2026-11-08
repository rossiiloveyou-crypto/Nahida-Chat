import { useState } from 'react'
import type { StoryWorldbookMode } from '@shared/story'
import { usePromptLibrary } from '../settings/usePromptLibrary'
import { useStoryStore } from './store'

interface NewStoryDialogProps {
  onClose: () => void
}

/**
 * P7：新建故事区表单（M18 能选到角色 + M15 世界书两档 + D12 开场，H-10 的前置）。
 *
 * 🔴 代码里零硬编码角色文本：角色来自 Prompt/characters（usePromptLibrary），
 *    开场文案由用户自己填，与总蓝图 §7.1「Prompt 是用户资产」一致。
 */
export function NewStoryDialog({ onClose }: NewStoryDialogProps) {
  const { library } = usePromptLibrary()
  const refreshStories = useStoryStore((s) => s.refreshStories)
  const openStory = useStoryStore((s) => s.openStory)

  const [title, setTitle] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [worldbookDir, setWorldbookDir] = useState('')
  const [worldbookMode, setWorldbookMode] = useState<StoryWorldbookMode>('default')
  const [background, setBackground] = useState('')
  const [openingText, setOpeningText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const characters = library?.characters ?? []
  // 没有显式选择时，回落到第一个「完整」角色（缺 soul.md 的角色不算可用）
  const chosenCharacter =
    characterId || characters.find((item) => item.complete)?.id || characters[0]?.id || ''

  const pickDir = async (): Promise<void> => {
    try {
      const dir = await window.nahida.story.pickWorldbookDir()
      if (dir) setWorldbookDir(dir)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const submit = async (): Promise<void> => {
    if (!title.trim()) return setError('请先填标题')
    if (worldbookMode === 'override' && !worldbookDir.trim()) {
      return setError('「完全覆盖」必须指定剧本世界书目录，否则世界书会整段消失')
    }
    setBusy(true)
    setError(null)
    try {
      const created = await window.nahida.story.create({
        title: title.trim(),
        characterId: chosenCharacter,
        worldbookDir: worldbookDir.trim() || undefined,
        worldbookMode,
        background: background.trim() || undefined,
        openingText: openingText.trim() || undefined
      })
      await refreshStories()
      await openStory(created.meta.storyId)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="story-dialog__backdrop" role="presentation" onClick={onClose}>
      <div
        className="story-dialog"
        data-ui-region="C 新建故事区"
        role="dialog"
        aria-label="新建故事区"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="story-dialog__head">
          <h2>新建故事区</h2>
          <button className="story-dialog__close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <label className="story-field">
          <span>标题（必填）</span>
          <input
            data-ui-target="故事标题输入"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：时钟之谜"
          />
        </label>

        <label className="story-field">
          <span>角色</span>
          <select
            data-ui-target="故事角色选择"
            value={chosenCharacter}
            onChange={(event) => setCharacterId(event.target.value)}
          >
            {characters.length === 0 && <option value="">（Prompt/characters 里还没有角色）</option>}
            {characters.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.complete ? '' : '（缺少 soul.md）'}
              </option>
            ))}
          </select>
        </label>

        <label className="story-field">
          <span>剧本世界书目录（可空）</span>
          <span className="story-field__row">
            <input
              data-ui-target="世界书目录输入"
              value={worldbookDir}
              onChange={(event) => setWorldbookDir(event.target.value)}
              placeholder="绝对路径，或相对 stories/ 的路径"
            />
            <button type="button" onClick={() => void pickDir()} disabled={busy}>
              选择目录
            </button>
          </span>
        </label>

        <fieldset className="story-field story-field--radios">
          <legend>世界书档位</legend>
          <label>
            <input
              type="radio"
              name="worldbook-mode"
              checked={worldbookMode === 'default'}
              onChange={() => setWorldbookMode('default')}
            />
            两段都注入（角色设定 + 剧本世界书）
          </label>
          <label>
            <input
              type="radio"
              name="worldbook-mode"
              checked={worldbookMode === 'override'}
              onChange={() => setWorldbookMode('override')}
            />
            完全覆盖（只注入剧本世界书）
          </label>
        </fieldset>

        <label className="story-field">
          <span>背景与剧本设定（可空）</span>
          <textarea
            data-ui-target="背景设定输入"
            value={background}
            onChange={(event) => setBackground(event.target.value)}
            rows={5}
            placeholder="开场环境与场景介绍（世界长什么样、这一幕从哪开始）。这是【设定】，会作为背景注入，不是第一条消息。"
          />
        </label>

        <label className="story-field">
          <span>开场消息（可空）</span>
          <textarea
            data-ui-target="开场消息输入"
            value={openingText}
            onChange={(event) => setOpeningText(event.target.value)}
            rows={4}
            placeholder="这一条是第一条 assistant 消息的正文（她先开口说什么）。留空则由她的第一条回复自然开场。剧情背景请填上面的『背景与剧本设定』。"
          />
        </label>

        {error && <p className="story-dialog__error">{error}</p>}

        <div className="story-dialog__actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="is-primary" data-ui-target="创建故事区" onClick={() => void submit()} disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
