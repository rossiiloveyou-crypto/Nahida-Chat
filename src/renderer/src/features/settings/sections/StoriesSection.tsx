import { useCallback, useEffect, useState } from 'react'
import type { StoryMeta, StorySummary, StoryWorldbookMode } from '@shared/story'
import type { MemoryEntry } from '@shared/types'
import { usePromptLibrary } from '../usePromptLibrary'
import { useStoryStore } from '../../story/store'

/**
 * 设置 · 故事区面板（P7 / T7 / F-08 / H-21）。
 *
 * 左列全部故事区，右列编辑选中的那个：meta（标题 / 概要 / 角色 / 世界书档位 / 目录）、
 * 故事画像 profile.md（用户自己的画像，不是角色设定）、以及删除。
 *
 * 🔴 画像读写都走主进程 storyProfilePath()（B4）；空串保存 = 删文件。
 * 🔴 删故事区是唯一不可逆动作：确认框必须写明「连同记忆库一起删除」（C10）。
 * 🔴 不读 zones（总蓝图 §附 前向兼容）：故事相关只绑 storyId。
 */
export function StoriesSection() {
  const refreshSidebar = useStoryStore((s) => s.refreshStories)
  const { library } = usePromptLibrary()
  const [stories, setStories] = useState<StorySummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [meta, setMeta] = useState<StoryMeta | null>(null)
  const [profile, setProfile] = useState('')
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (keepId?: string | null): Promise<void> => {
    setBusy(true)
    try {
      const list = await window.nahida.story.list()
      setStories(list)
      const nextId = keepId && list.some((item) => item.storyId === keepId) ? keepId : (list[0]?.storyId ?? null)
      setSelectedId(nextId)
      if (nextId) {
        setMeta(await window.nahida.story.get(nextId))
        setProfile(await window.nahida.story.profileGet(nextId))
        setMemories(await window.nahida.story.memoryList(nextId))
      } else {
        setMeta(null)
        setProfile('')
        setMemories([])
      }
    } catch (cause) {
      setStatus('载入失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const choose = async (storyId: string): Promise<void> => {
    setStatus(null)
    setSelectedId(storyId)
    setBusy(true)
    try {
      setMeta(await window.nahida.story.get(storyId))
      setProfile(await window.nahida.story.profileGet(storyId))
      setMemories(await window.nahida.story.memoryList(storyId))
    } catch (cause) {
      setStatus('载入失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }

  const patchMeta = (patch: Partial<StoryMeta>): void => {
    setMeta((current) => (current ? { ...current, ...patch } : current))
  }

  const saveMeta = async (): Promise<void> => {
    if (!meta) return
    setBusy(true)
    setStatus(null)
    try {
      const updated = await window.nahida.story.updateMeta(meta.storyId, {
        title: meta.title,
        synopsis: meta.synopsis,
        characterId: meta.characterId,
        worldbookDir: meta.worldbookDir && meta.worldbookDir.trim() ? meta.worldbookDir.trim() : null,
        worldbookMode: meta.worldbookMode === 'override' ? 'override' : 'default',
        background: meta.background && meta.background.trim() ? meta.background.trim() : null
      })
      if (!updated) {
        setStatus('保存失败：故事区不存在')
      } else {
        setMeta(updated)
        setStatus('已保存')
        // 侧栏卡片要立刻反映新标题/概要
        await load(updated.storyId)
        await refreshSidebar()
      }
    } catch (cause) {
      setStatus('保存失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }

  const saveProfile = async (): Promise<void> => {
    if (!meta) return
    setBusy(true)
    setStatus(null)
    try {
      const ok = await window.nahida.story.profileSave(meta.storyId, profile)
      setStatus(ok ? (profile.trim() ? '画像已保存' : '画像已清空') : '画像保存失败')
    } catch (cause) {
      setStatus('画像保存失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }

  const removeMemory = async (id: string): Promise<void> => {
    if (!meta) return
    setBusy(true)
    try {
      setMemories(await window.nahida.story.memoryDelete(meta.storyId, id))
    } catch (cause) {
      setStatus('删除记忆失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }

  const clearMemories = async (): Promise<void> => {
    if (!meta) return
    if (!window.confirm('清空这个故事区的全部长期记忆？不可恢复')) return
    setBusy(true)
    try {
      setMemories(await window.nahida.story.memoryClear(meta.storyId))
    } catch (cause) {
      setStatus('清空记忆失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }

  const removeStory = async (): Promise<void> => {
    if (!meta) return
    const confirmed = window.confirm('删除故事区会连同记忆库一起删除，且不可恢复')
    if (!confirmed) return
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.nahida.story.remove(meta.storyId, { confirmed: true })
      if (result.ok) {
        setStatus(`已删除（备份在 ${result.receipt.backupPath}）`)
        await load(null)
        await refreshSidebar()
      } else {
        setStatus('删除失败：' + result.detail)
      }
    } catch (cause) {
      setStatus('删除失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }

  const pickDir = async (): Promise<boolean> => {
    try {
      const dir = await window.nahida.story.pickWorldbookDir()
      if (!dir) return false
      patchMeta({ worldbookDir: dir })
      return true
    } catch (cause) {
      setStatus('选择目录失败：' + (cause instanceof Error ? cause.message : String(cause)))
      return false
    }
  }

  return (
    <>
      <div className="settings-page__head" data-ui-target="故事设置页头">
        <h1>故事区</h1>
        <p>每个故事区是独立的一份数据：自己的分支、自己的记忆库、你自己在这个故事里的人物设定（用户画像）。</p>
      </div>

      {status && <p className="story-settings__status">{status}</p>}

      <div className="story-settings" data-ui-region="C 故事设置面板">
        <div className="story-settings__list" data-ui-target="故事选择列表">
          <p className="story-settings__label">全部故事区（{stories.length}）</p>
          {stories.length === 0 && <p className="session-list__empty">还没有故事区</p>}
          <ul>
            {stories.map((item) => (
              <li key={item.storyId}>
                <button
                  type="button"
                  className={'story-settings__item sel-frame--stitch' + (item.storyId === selectedId ? ' is-active' : '')}
                  data-ui-target={`设置故事 ${item.title}`}
                  disabled={busy}
                  onClick={() => void choose(item.storyId)}
                >
                  <span className="story-settings__item-title">{item.title}</span>
                  <span className="story-settings__item-meta">
                    {item.branchCount} 分支 · {item.memoryCount} 条记忆
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="story-settings__editor" data-ui-target="故事编辑区">
          {!meta ? (
            <p className="session-list__empty">左侧选择一个故事区，或去侧栏「故事」里新建一个。</p>
          ) : (
            <>
              <label className="story-field">
                <span>标题</span>
                <input
                  data-ui-target="设置故事标题"
                  value={meta.title}
                  onChange={(event) => patchMeta({ title: event.target.value })}
                />
              </label>

              <label className="story-field">
                <span>概要</span>
                <textarea
                  data-ui-target="设置故事概要"
                  rows={2}
                  value={meta.synopsis}
                  onChange={(event) => patchMeta({ synopsis: event.target.value })}
                />
              </label>

              <label className="story-field">
                <span>角色</span>
                <select
                  data-ui-target="设置故事角色"
                  value={meta.characterId}
                  onChange={(event) => patchMeta({ characterId: event.target.value })}
                >
                  {(library?.characters ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                  {!library?.characters.some((item) => item.id === meta.characterId) && (
                    <option value={meta.characterId}>{meta.characterId}（不在提示词库里）</option>
                  )}
                </select>
              </label>

              <label className="story-field">
                <span>剧本世界书目录</span>
                <span className="story-field__row">
                  <input
                    data-ui-target="设置世界书目录"
                    value={meta.worldbookDir ?? ''}
                    onChange={(event) => patchMeta({ worldbookDir: event.target.value })}
                    placeholder="留空 = 不配剧本世界书"
                  />
                  <button type="button" disabled={busy} onClick={() => void pickDir()}>
                    选择目录
                  </button>
                </span>
              </label>

              <fieldset className="story-field story-field--radios">
                <legend>世界书档位</legend>
                {(
                  [
                    ['default', '两段都注入（角色设定 + 剧本世界书）'],
                    ['override', '完全覆盖（只注入剧本世界书）']
                  ] as Array<[StoryWorldbookMode, string]>
                ).map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="settings-worldbook-mode"
                      checked={(meta.worldbookMode ?? 'default') === value}
                      onChange={() => patchMeta({ worldbookMode: value })}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>

              <label className="story-field">
                <span>背景与剧本设定</span>
                <textarea
                  data-ui-target="设置故事背景"
                  rows={5}
                  value={meta.background ?? ''}
                  onChange={(event) => patchMeta({ background: event.target.value })}
                  placeholder="开场环境与场景介绍（世界长什么样、这一幕从哪开始）。这是【设定】，不是第一条消息。"
                />
              </label>

              <button
                type="button"
                className="is-primary"
                data-ui-target="保存故事信息"
                disabled={busy}
                onClick={() => void saveMeta()}
              >
                {busy ? '保存中…' : '保存信息'}
              </button>

              <label className="story-field">
                <span>用户画像（描述「你」在这个故事里是谁，只对本故事生效）</span>
                <textarea
                  data-ui-target="用户画像编辑"
                  rows={6}
                  value={profile}
                  onChange={(event) => setProfile(event.target.value)}
                  placeholder="例如：我是旅行至此的炼金术士，性子慢、怕水，和她有过一面之缘……（这是你的人设，不是剧情记忆；剧情记忆见下方「长期记忆」）清空并保存 = 删除画像"
                />
              </label>
              <button type="button" data-ui-target="保存用户画像" disabled={busy} onClick={() => void saveProfile()}>
                保存用户画像
              </button>

              <section className="story-memory" data-ui-target="故事长期记忆">
                <div className="story-memory__head">
                  <span>长期记忆（{memories.length}）</span>
                  {memories.length > 0 && (
                    <button type="button" disabled={busy} onClick={() => void clearMemories()}>
                      清空
                    </button>
                  )}
                </div>
                {memories.length === 0 && (
                  <p className="session-list__empty">
                    还没有记忆（对话中会自动抽取；需在「长期记忆」设置里开启自动抽取）
                  </p>
                )}
                <ul>
                  {memories.map((m) => (
                    <li key={m.id} className="story-memory__item">
                      <span className="story-memory__text">{m.content}</span>
                      <span className="story-memory__meta">
                        {typeof m.sourceMessageIndex === 'number'
                          ? '分支消息 #' + (m.sourceMessageIndex + 1)
                          : '无来源'}
                        {' · 权重 ' + m.weight.toFixed(1)}
                      </span>
                      <button
                        type="button"
                        aria-label="删除记忆"
                        disabled={busy}
                        onClick={() => void removeMemory(m.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <div className="story-settings__danger">
                <button
                  type="button"
                  className="is-danger"
                  data-ui-target="删除故事区"
                  disabled={busy}
                  onClick={() => void removeStory()}
                >
                  删除故事区
                </button>
                <span className="story-settings__danger-hint">
                  会连同它的记忆库与本区全部分支一起删除，不可恢复（删前自动备份到 stories/.trash）
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
