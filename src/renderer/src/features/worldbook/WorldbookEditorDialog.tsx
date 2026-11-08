import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DuplicateKeyword,
  WorldbookDirInfo,
  WorldbookEntry,
  WorldbookEntryDraft,
  WorldbookListing
} from '@shared/worldbook'
import { filterWorldbookEntries } from './filter'
import {
  WORLDBOOK_DEFAULT_PRIORITY,
  WORLDBOOK_DEFAULT_VALUE,
  WORLDBOOK_PRIORITY_MAX,
  WORLDBOOK_PRIORITY_MIN,
  WORLDBOOK_VALUE_MAX,
  WORLDBOOK_VALUE_MIN
} from '@shared/worldbook'

/** 默认折叠阈值：用户原话「默认显示 8 条，其它的压缩到『展开页』」（P9 §1.1） */
const PAGE_SIZE = 8

interface WorldbookEditorDialogProps {
  /** 打开时定位到的世界书（目录或单个 .md）；空串则由已知目录里的第一项兜底 */
  initialTarget: string
  onClose: () => void
}

/** 渲染层没有 Node：只切路径尾部，不碰 fs */
function basenameOf(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return index >= 0 ? target.slice(index + 1) : target
}

function parentOf(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return index > 0 ? target.slice(0, index) : target
}

interface FormState {
  /** 正在编辑的条目 id；空串 = 新增，或「合规但缺 id」的条目（那时靠 originalTitle 定位） */
  id: string
  /**
   * 缺 id 条目的**原标题**（临时句柄）。空串 = 新增条目。
   * 🔴 必须在编辑期间保持不变：用户改「条目名」时它不能跟着变，否则就找不到原块了。
   */
  originalTitle: string
  title: string
  keywords: string
  always: boolean
  priority: number
  value: number
  chained: string
  body: string
  /** 写入哪个文件（目录内的文件名） */
  file: string
  /** 目标是「新建文件」时为 true */
  newFile: boolean
}

function emptyForm(file: string): FormState {
  return {
    id: '',
    originalTitle: '',
    title: '',
    keywords: '',
    always: false,
    priority: WORLDBOOK_DEFAULT_PRIORITY,
    value: WORLDBOOK_DEFAULT_VALUE,
    chained: '',
    body: '',
    file,
    newFile: false
  }
}

function splitWords(text: string): string[] {
  return text
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 世界书编辑器弹层（P9 / T5 + T7 + T8）。
 *
 * 🔴 为什么是弹层而不是设置分区：「系统提示词」页要求整页一屏内看完（为了可定位截图），
 *    列表 + 表单铺进去必然超屏 —— 所以主页只留一个入口，编辑器单独占一屏。
 * 🔴 渲染层**不拼模板、不解析 md**：格式解析与序列化只在主进程 parse.ts 一处（B2）。
 * 🔴 触发词重复**只提醒不阻断**（用户 2026-11-07 原话「不限制写入，仅作提醒」）。
 */
export function WorldbookEditorDialog({ initialTarget, onClose }: WorldbookEditorDialogProps) {
  const [known, setKnown] = useState<WorldbookDirInfo[]>([])
  const [target, setTarget] = useState(initialTarget)
  const [listing, setListing] = useState<WorldbookListing | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<FormState>(emptyForm('world.md'))
  const [duplicates, setDuplicates] = useState<DuplicateKeyword[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const refreshKnown = useCallback(async (): Promise<WorldbookDirInfo[]> => {
    try {
      const dirs = await window.nahida.worldbook.knownDirs()
      setKnown(dirs)
      return dirs
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return []
    }
  }, [])

  const load = useCallback(async (next: string): Promise<void> => {
    if (!next.trim()) {
      setListing(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.nahida.worldbook.list(next)
      setListing(result)
      setTarget(next)
      setExpanded(false)
      const firstFile = result.files[0]
      setForm((prev) => ({ ...prev, file: firstFile ? basenameOf(firstFile.file) : 'world.md', newFile: false }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  // 首次打开：先拿已知目录，再定位。没有 initialTarget 时落到第一项（角色世界书）。
  useEffect(() => {
    void (async () => {
      const dirs = await refreshKnown()
      const next = initialTarget.trim() || dirs[0]?.dir || ''
      if (next) await load(next)
    })()
  }, [initialTarget, load, refreshKnown])

  const allEntries = useMemo(() => {
    const flat: Array<WorldbookEntry & { fileName: string }> = []
    for (const file of listing?.files ?? []) {
      for (const entry of file.entries) flat.push({ ...entry, fileName: basenameOf(file.file) })
    }
    return flat
  }, [listing])

  const filteredEntries = useMemo(() => filterWorldbookEntries(allEntries, query), [allEntries, query])

  const shown = expanded ? filteredEntries : filteredEntries.slice(0, PAGE_SIZE)
  const hidden = Math.max(0, filteredEntries.length - PAGE_SIZE)

  /** 写入用的目录与可写文件清单（target 可能是单个文件 —— 那时目录取它的父目录） */
  const dir = listing ? (listing.kind === 'dir' ? listing.target : parentOf(listing.target)) : ''
  const writableFiles = useMemo(() => {
    const names = (listing?.files ?? []).map((file) => basenameOf(file.file))
    if (listing && listing.kind === 'file') return [basenameOf(listing.target)]
    return names.length > 0 ? names : ['world.md']
  }, [listing])

  const checkDuplicates = useCallback(
    async (keywords: string, id: string, file: string): Promise<void> => {
      if (!dir || !file.trim()) return setDuplicates([])
      try {
        const found = await window.nahida.worldbook.duplicates(dir, file, splitWords(keywords), id || undefined)
        setDuplicates(found)
      } catch {
        setDuplicates([])
      }
    },
    [dir]
  )

  const pickDir = async (): Promise<void> => {
    try {
      const chosen = await window.nahida.worldbook.pickDir()
      if (chosen) await load(chosen)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const pickFile = async (): Promise<void> => {
    try {
      const chosen = await window.nahida.worldbook.pickFile()
      if (chosen) await load(chosen)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const createNew = async (): Promise<void> => {
    try {
      const chosen = await window.nahida.worldbook.pickDir()
      if (!chosen) return
      setBusy(true)
      const result = await window.nahida.worldbook.create(chosen)
      setListing(result)
      setTarget(result.target)
      setExpanded(false)
      setStatus('已新建世界书：' + result.target)
      await refreshKnown()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!dir) return setError('请先选择世界书目录或文件')
    if (!form.title.trim()) return setError('条目名不能为空')
    const file = form.file.trim()
    if (!file) return setError('请选择写入哪个 .md 文件')
    setBusy(true)
    setError(null)
    setStatus(null)
    const draft: WorldbookEntryDraft = {
      title: form.title.trim(),
      keywords: splitWords(form.keywords),
      always: form.always,
      priority: Number(form.priority),
      value: Number(form.value),
      chained: splitWords(form.chained),
      body: form.body
    }
    // 「正在编辑某条」= 有 id，或（缺 id 条目）有原标题。两者都没有才是新增。
    const editing = Boolean(form.id || form.originalTitle)
    try {
      const result = editing
        ? await window.nahida.worldbook.update(
            dir,
            file,
            form.id,
            draft,
            form.id ? undefined : form.originalTitle
          )
        : await window.nahida.worldbook.add(dir, file, draft)
      setListing(result)
      setStatus(editing ? '已更新「' + draft.title + '」' : '已新增「' + draft.title + '」到 ' + file)
      setForm(emptyForm(file))
      setDuplicates([])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (entry: WorldbookEntry & { fileName: string }): void => {
    setForm({
      id: entry.id,
      originalTitle: entry.missingId ? entry.title : '',
      title: entry.title,
      keywords: entry.keywords.join(', '),
      always: entry.always,
      priority: entry.priority,
      value: entry.value,
      chained: entry.chained.join(', '),
      body: entry.body,
      file: entry.fileName,
      newFile: false
    })
    setDuplicates([])
    setStatus(
      entry.missingId
        ? '正在编辑「' + entry.title + '」（该条目缺 - id: 行，保存时会自动补一个）'
        : '正在编辑「' + entry.title + '」'
    )
  }

  const removeOne = async (entry: WorldbookEntry & { fileName: string }): Promise<void> => {
    if (!dir) return
    if (!window.confirm('确认删除条目「' + entry.title + '」？会从 ' + entry.fileName + ' 中移除，不可恢复')) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.nahida.worldbook.remove(
        dir,
        entry.fileName,
        entry.id,
        entry.missingId ? entry.title : undefined
      )
      setListing(result)
      setStatus('已删除「' + entry.title + '」')
      if (form.id === entry.id || form.originalTitle === entry.title) setForm(emptyForm(form.file))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="story-dialog__backdrop" role="presentation" onClick={onClose}>
      <div
        className="wb-dialog"
        data-ui-region="E 世界书编辑器"
        role="dialog"
        aria-label="世界书编辑器"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="wb-dialog__head">
          <div>
            <h2>世界书编辑器</h2>
            <p className="wb-dialog__sub">
              只列「合规条目」（有 <code>- 触发词:</code> 且至少再命中 2 个元数据键）；普通小标题与 README 里的模板示例会被跳过。
            </p>
          </div>
          <button className="story-dialog__close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="wb-toolbar">
          <select
            data-ui-target="世界书已知目录"
            value={known.some((item) => item.dir === target) ? target : ''}
            onChange={(event) => {
              if (event.target.value) void load(event.target.value)
            }}
          >
            <option value="">（选择已知世界书）</option>
            {known.map((item) => (
              <option key={item.kind + item.dir} value={item.dir}>
                {item.kind === 'character' ? '角色 · ' : '故事 · '}
                {item.label}
              </option>
            ))}
          </select>
          <button type="button" data-ui-target="世界书选择目录" onClick={() => void pickDir()} disabled={busy}>
            选择目录
          </button>
          <button type="button" data-ui-target="世界书选择文件" onClick={() => void pickFile()} disabled={busy}>
            选择 .md 文件
          </button>
          <button type="button" className="is-primary" data-ui-target="世界书新建" onClick={() => void createNew()} disabled={busy}>
            新建世界书
          </button>
        </div>

        <p className="wb-path" title={target}>
          {target || '还没有选择世界书'}
          {listing && <span className="wb-path__kind">{listing.kind === 'dir' ? '目录' : '单文件'}</span>}
        </p>

        <div className="wb-body">
          <section className="wb-list">
            <div className="wb-list__head">
              <strong>条目</strong>
              <span>{query.trim() ? filteredEntries.length + ' / ' + allEntries.length : allEntries.length} 条</span>
            </div>
            <label className="wb-search">
              <span className="wb-search__icon" aria-hidden="true">⌕</span>
              <input
                data-ui-target="世界书条目搜索"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setExpanded(false)
                }}
                placeholder="搜索标题或触发词…"
                aria-label="按标题或触发词搜索世界书条目"
              />
              {query && (
                <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}>
                  ×
                </button>
              )}
            </label>
            <div className="wb-list__items" data-ui-target="世界书条目列表">
              {shown.map((entry) => (
                <article className="wb-entry-card" key={entry.fileName + entry.id + entry.title}>
                  <div className="wb-entry-card__head">
                    <strong>{entry.title}</strong>
                    {entry.always && <span className="wb-badge">常驻</span>}
                    {entry.missingId && (
                      <span className="wb-badge wb-badge--warn" title="这条没有 - id: 行；编辑保存时会自动补一个">
                        缺 id
                      </span>
                    )}
                    <code className="wb-entry-card__file">{entry.fileName}</code>
                  </div>
                  <p className="wb-entry-card__keywords">
                    {entry.keywords.length > 0 ? entry.keywords.slice(0, 4).join(' · ') : '（无触发词）'}
                    {entry.keywords.length > 4 ? ' …' : ''}
                  </p>
                  <div className="wb-entry-card__actions">
                    <button type="button" onClick={() => startEdit(entry)} disabled={busy}>
                      编辑
                    </button>
                    <button type="button" className="is-danger" onClick={() => void removeOne(entry)} disabled={busy}>
                      删除
                    </button>
                  </div>
                </article>
              ))}
              {allEntries.length === 0 && (
                <p className="wb-empty">
                  {listing ? '该文件没有符合世界书结构的段落（仍可新增）' : '先选择或新建一个世界书'}
                </p>
              )}
              {allEntries.length > 0 && filteredEntries.length === 0 && (
                <p className="wb-empty">没有标题或触发词匹配「{query.trim()}」的条目。</p>
              )}
            </div>
            {hidden > 0 && (
              <button
                type="button"
                className="wb-more"
                data-ui-target="世界书展开"
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? '收起' : '展开（还有 ' + String(hidden) + ' 条）'}
              </button>
            )}
          </section>

          <section className="wb-form" data-ui-target="世界书表单">
            <div className="wb-form__head">
              <strong>{form.id || form.originalTitle ? '编辑条目' : '新增条目'}</strong>
              {(form.id || form.originalTitle) && (
                <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => setForm(emptyForm(form.file))}>
                  取消编辑
                </button>
              )}
            </div>

            <label className="story-field">
              <span>写入文件</span>
              <span className="story-field__row">
                <select
                  data-ui-target="世界书目标文件"
                  value={form.newFile ? '__new__' : form.file}
                  onChange={(event) => {
                    const value = event.target.value
                    setForm((prev) => ({
                      ...prev,
                      newFile: value === '__new__',
                      file: value === '__new__' ? '' : value
                    }))
                  }}
                >
                  {writableFiles.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value="__new__">新建文件…</option>
                </select>
              </span>
              {form.newFile && (
                <input
                  value={form.file}
                  placeholder="新文件名，如 lore.md"
                  onChange={(event) => setForm((prev) => ({ ...prev, file: event.target.value }))}
                />
              )}
            </label>

            <label className="story-field">
              <span>条目名</span>
              <input
                data-ui-target="世界书条目名"
                value={form.title}
                placeholder="例如：时钟之谜"
                onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
              />
            </label>

            <label className="story-field">
              <span>触发词（逗号分隔）</span>
              <input
                data-ui-target="世界书触发词"
                value={form.keywords}
                placeholder="钟楼, 报时, 停摆"
                onChange={(event) => {
                  const next = event.target.value
                  setForm((prev) => ({ ...prev, keywords: next }))
                  void checkDuplicates(next, form.id, form.file)
                }}
              />
            </label>
            {duplicates.length > 0 && (
              <p className="wb-dup" data-ui-target="世界书重复提醒">
                ⚠ 与同文件其它条目重复（只提醒，不影响保存）：
                {duplicates.map((item) => item.keyword + '（' + item.owners.join('、') + '）').join('；')}
              </p>
            )}

            <div className="wb-form__row">
              <label className="story-field wb-flag">
                <span>常驻</span>
                <input
                  type="checkbox"
                  data-ui-target="世界书常驻"
                  checked={form.always}
                  onChange={(event) => setForm((prev) => ({ ...prev, always: event.target.checked }))}
                />
              </label>
              <label className="story-field wb-num">
                <span>优先级 {WORLDBOOK_PRIORITY_MIN}–{WORLDBOOK_PRIORITY_MAX}</span>
                <input
                  type="number"
                  data-ui-target="世界书优先级"
                  min={WORLDBOOK_PRIORITY_MIN}
                  max={WORLDBOOK_PRIORITY_MAX}
                  value={form.priority}
                  onChange={(event) => setForm((prev) => ({ ...prev, priority: Number(event.target.value) }))}
                />
              </label>
              <label className="story-field wb-num">
                <span>内在价值 {WORLDBOOK_VALUE_MIN}–{WORLDBOOK_VALUE_MAX}</span>
                <input
                  type="number"
                  data-ui-target="世界书内在价值"
                  min={WORLDBOOK_VALUE_MIN}
                  max={WORLDBOOK_VALUE_MAX}
                  value={form.value}
                  onChange={(event) => setForm((prev) => ({ ...prev, value: Number(event.target.value) }))}
                />
              </label>
            </div>

            <label className="story-field">
              <span>连带触发词（逗号分隔，可空）</span>
              <input
                data-ui-target="世界书连带触发词"
                value={form.chained}
                placeholder="世界树, 禁忌知识"
                onChange={(event) => setForm((prev) => ({ ...prev, chained: event.target.value }))}
              />
            </label>

            <label className="story-field">
              <span>正文</span>
              <textarea
                data-ui-target="世界书正文"
                rows={6}
                value={form.body}
                placeholder="条目正文（可含 ### 小标题、**加粗**、> 引用块）"
                onChange={(event) => setForm((prev) => ({ ...prev, body: event.target.value }))}
              />
            </label>

            {error && <p className="story-dialog__error">{error}</p>}
            {status && <p className="wb-status">{status}</p>}

            <div className="wb-form__actions">
              <button type="button" onClick={onClose} disabled={busy}>
                关闭
              </button>
              <button type="button" className="is-primary" data-ui-target="世界书保存" onClick={() => void submit()} disabled={busy}>
                {busy ? '保存中…' : form.id || form.originalTitle ? '保存修改' : '添加条目'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
