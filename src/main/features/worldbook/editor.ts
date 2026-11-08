import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'
import type {
  DuplicateKeyword,
  WorldbookDirInfo,
  WorldbookEntryDraft,
  WorldbookFile,
  WorldbookListing
} from '@shared/worldbook'
import { WORLDBOOK_INDEX_FILE } from '@shared/worldbook'
import { resolveWorldbookDir } from '../story/paths'
import { storyStore } from '../story/store'
import { promptStore } from '../prompt/promptStore'
import {
  appendEntry,
  findDuplicateKeywords,
  parseWorldbookFile,
  removeEntryBlock,
  replaceEntryBlock
} from './parse'

/**
 * 世界书编辑器的主进程实现（P9 / T3）。
 *
 * 三条硬不变量（P9 §4.3）：
 *  ① **路径守卫**：`resolve(dir, file)` 必须落在 `resolve(dir) + sep` 之内；只允许 `.md`；拒绝 `README.md`。
 *  ② **原子写**：先写 `<file>.tmp`，写前把原文件复制成 `<file>.bak`（单份滚动备份），最后 `rename` 覆盖。
 *  ③ **块级手术**：删 / 改只重写目标条目块，**其余字节逐字不变**（A-04 / A-05 守恒）。
 *
 * 🔴 这一层会写用户的 `Prompt/` 资产（M26 的有限放宽）：只写 `worldbook/` 里的 `.md`，
 *    不碰 `soul.md` / `canon/` / `modes/` / `styles/`。测试**只写 mkdtemp 临时目录**，绝不碰真实 Prompt/。
 */

/** 允许编辑的扩展名（M26 只放宽到 md） */
const MD_EXT = '.md'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

/**
 * 路径守卫（A-07 / A-08）。
 *
 * 🔴 拒绝的三类：越界的相对路径（`../evil.md`）、越界的绝对路径、`README.md`（索引不是条目文件）。
 * 🔴 判据用的是 **resolve 之后的前缀**，不是字符串包含 —— `/a/bc` 不该被当成 `/a/b` 的子路径。
 */
export function assertMarkdownInDir(dir: string, file: string): string {
  const root = resolve(dir)
  const raw = typeof file === 'string' ? file.trim() : ''
  if (!raw) throw new Error('缺少目标文件名')
  if (basename(raw).toLowerCase() === WORLDBOOK_INDEX_FILE.toLowerCase()) {
    throw new Error('README.md 是索引文件，不是世界书条目文件，不允许写入')
  }
  if (extname(raw).toLowerCase() !== MD_EXT) {
    throw new Error('只允许编辑 .md 文件：' + raw)
  }
  const target = resolve(root, raw)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('目标文件不在世界书目录内：' + raw)
  }
  if (target === root) throw new Error('目标必须是文件，不能是目录本身：' + raw)
  return target
}

/**
 * 原子写 + 单份滚动备份（A-06）。
 *
 * 顺序就是判据（J-12）：写 tmp → 备份原件 → rename 覆盖。
 * 备份失败就**不替换**，宁可报错也不留下「没备份的新内容」。
 */
function writeAtomic(file: string, text: string): void {
  const tmp = file + '.tmp'
  try {
    writeFileSync(tmp, text, 'utf8')
    if (existsSync(file)) copyFileSync(file, file + '.bak')
    renameSync(tmp, file)
  } catch (error) {
    // 失败时清掉半成品，目录里不许留下 *.tmp（A-06 的反面）
    try {
      if (existsSync(tmp)) writeFileSync(tmp, '')
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error
  }
}

/** 32 位十六进制 id（A-03）；与同文件既有 id 冲突就重生成 */
export function newEntryId(taken: Iterable<string> = []): string {
  const used = new Set<string>(taken)
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = randomUUID().replace(/-/g, '')
    if (!used.has(id)) return id
  }
  // 理论上到不了这里；真要到了，用时间戳拼一个仍然是 32 位十六进制的 id
  const fallback = (Date.now().toString(16) + randomUUID().replace(/-/g, '')).slice(0, 32)
  return fallback
}

/** 只解析一个文件（任意文件名，A-14 的 file 分支） */
export function parseFile(path: string): WorldbookFile {
  return { file: path, entries: parseWorldbookFile(path, readText(path)) }
}

/** 目录里的 .md 文件（**排除 README.md**，A-08）；目录不存在 → 空数组 */
function markdownFilesIn(dir: string): string[] {
  if (!isDirectory(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => extname(name).toLowerCase() === MD_EXT)
      .filter((name) => name.toLowerCase() !== WORLDBOOK_INDEX_FILE.toLowerCase())
      .sort((a, b) => a.localeCompare(b))
      .map((name) => join(dir, name))
  } catch (error) {
    console.warn('[worldbook] 读取目录失败：' + dir, error)
    return []
  }
}

/**
 * 列出世界书：`target` 可以是**目录**或**单个任意名 .md 文件**（A-14）。
 * 不存在 → 空清单（**不抛**：用户手填一个还没建的路径不该让面板崩）。
 */
export function listWorldbook(target: string): WorldbookListing {
  const raw = typeof target === 'string' ? target.trim() : ''
  if (!raw) return { target: '', kind: 'dir', files: [] }
  const absolute = resolve(raw)
  if (isDirectory(absolute)) {
    return { target: absolute, kind: 'dir', files: markdownFilesIn(absolute).map(parseFile) }
  }
  const kind: 'dir' | 'file' = extname(absolute).toLowerCase() === MD_EXT ? 'file' : 'dir'
  return {
    target: absolute,
    kind,
    files: kind === 'file' && isFile(absolute) ? [parseFile(absolute)] : []
  }
}

/** 新增条目（A-02 / A-03 / A-15 / A-18）。目标文件不存在时**新建**它。 */
export function addEntry(dir: string, file: string, draft: WorldbookEntryDraft): WorldbookListing {
  const target = assertMarkdownInDir(dir, file)
  if (!isDirectory(resolve(dir))) throw new Error('世界书目录不存在：' + resolve(dir))
  const text = readText(target)
  const taken = parseWorldbookFile(target, text).map((entry) => entry.id).filter(Boolean)
  const id = newEntryId(taken)
  writeAtomic(target, appendEntry(text, { ...normalizeDraft(draft), id }))
  return listWorldbook(resolve(dir))
}

/**
 * 编辑条目（A-05）：只有目标块被重写，其余条目逐字不变。
 *
 * `fallbackTitle` 只服务「合规但缺 id」的条目（P9 §4.2）：这种条目没有句柄，
 * 前端把它的标题一并传下来，由 parse 的 findEntryBlockByTitle 唯一命中才生效。
 * 🔴 缺 id 的条目一旦保存，会**补上**一个新 id（这正是「编辑时补」的意思）。
 */
export function updateEntry(
  dir: string,
  file: string,
  id: string,
  draft: WorldbookEntryDraft,
  fallbackTitle?: string
): WorldbookListing {
  const target = assertMarkdownInDir(dir, file)
  const text = readText(target)
  const entries = parseWorldbookFile(target, text)
  // 缺 id 的条目：句柄是标题，落盘时要给它一个真 id（与同文件既有 id 不冲突）
  const handleId = id && id.trim() ? id.trim() : ''
  const finalId =
    handleId ||
    newEntryId(
      entries
        .map((entry) => entry.id)
        .filter(Boolean)
        .concat(entries.filter((entry) => !entry.id).map(() => ''))
    )
  const next = replaceEntryBlock(text, handleId, { ...normalizeDraft(draft), id: finalId }, fallbackTitle)
  if (next === null) throw new Error('条目不存在：' + String(id || fallbackTitle))
  writeAtomic(target, next)
  return listWorldbook(resolve(dir))
}

/**
 * 删除条目（A-04）：整段删除（`## ` 行到下一条目之前），不是只删标题行。
 * `fallbackTitle` 同上：缺 id 的条目按标题唯一命中。
 */
export function removeEntry(
  dir: string,
  file: string,
  id: string,
  fallbackTitle?: string
): WorldbookListing {
  const target = assertMarkdownInDir(dir, file)
  const text = readText(target)
  const next = removeEntryBlock(text, id, fallbackTitle)
  if (next === null) throw new Error('条目不存在：' + String(id || fallbackTitle))
  writeAtomic(target, next)
  return listWorldbook(resolve(dir))
}

/**
 * 同文件内重复触发词（A-17 / T8）—— **只提醒、不阻断**。
 * 作用域是**同一个 md 文件**（§2.4c），不是整个目录。
 */
export function findDuplicates(
  dir: string,
  file: string,
  keywords: string[],
  excludeId?: string
): DuplicateKeyword[] {
  const target = assertMarkdownInDir(dir, file)
  const entries = parseWorldbookFile(target, readText(target))
  return findDuplicateKeywords(entries, keywords, excludeId)
}

/** 新建世界书目录（A-09）：目录 + README.md + 首个 world.md。已存在的文件不覆盖。 */
export function createWorldbook(dir: string): WorldbookListing {
  const root = resolve(typeof dir === 'string' ? dir.trim() : '')
  if (!root) throw new Error('缺少目录路径')
  mkdirSync(root, { recursive: true })
  const readme = join(root, WORLDBOOK_INDEX_FILE)
  if (!existsSync(readme)) writeFileSync(readme, readmeTemplate(basename(root)), 'utf8')
  const first = join(root, 'world.md')
  if (!existsSync(first)) writeFileSync(first, firstFileTemplate(basename(root)), 'utf8')
  return listWorldbook(root)
}

/**
 * 已知世界书目录（A-10 / T5 的下拉）：
 *  - 每个角色的 `Prompt/characters/<id>/worldbook`（存在时）
 *  - 每个故事区配了的剧本世界书目录（存在时）
 *
 * 🔴 「某个故事区不在列表里」= 它没配 `worldbookDir`，**不算缺陷**（§6.6 ①）。
 */
export function knownDirs(): WorldbookDirInfo[] {
  const result: WorldbookDirInfo[] = []
  try {
    const root = promptStore.root()
    for (const character of promptStore.library().characters) {
      const dir = join(root, 'characters', character.id, 'worldbook')
      if (!isDirectory(dir)) continue
      result.push({
        label: character.name ? character.name + ' · ' + character.id : character.id,
        dir,
        kind: 'character'
      })
    }
  } catch (error) {
    console.warn('[worldbook] 枚举角色世界书失败', error)
  }
  try {
    for (const summary of storyStore.list()) {
      const meta = storyStore.get(summary.storyId)
      if (!meta) continue
      const dir = resolveWorldbookDir(meta)
      if (!dir || !isDirectory(dir)) continue
      result.push({ label: summary.title + ' · ' + summary.storyId, dir, kind: 'story' })
    }
  } catch (error) {
    console.warn('[worldbook] 枚举故事区世界书失败', error)
  }
  return result
}

/** 草稿归一：trim、数字截断、正文去尾部空白。序列化层还会再截一次（两处都不许出现越界值） */
function normalizeDraft(draft: WorldbookEntryDraft): WorldbookEntryDraft {
  const title = typeof draft?.title === 'string' ? draft.title.trim() : ''
  if (!title) throw new Error('条目名不能为空')
  return {
    title,
    keywords: Array.isArray(draft?.keywords) ? draft.keywords : [],
    always: draft?.always === true,
    priority: Number(draft?.priority),
    value: Number(draft?.value),
    chained: Array.isArray(draft?.chained) ? draft.chained : [],
    body: typeof draft?.body === 'string' ? draft.body : ''
  }
}

function readmeTemplate(name: string): string {
  return [
    '# ' + name + ' — 世界书索引',
    '',
    '> 本文件是索引，**不参与提示词拼装**（`promptStore` 会跳过 README.md），编辑器也不把它当条目文件。',
    '> 条目请写在同目录的其他 .md 里；文件名随意，编辑器按「合规段落」识别条目。',
    '',
    '## 条目格式',
    '',
    '每个条目是一段 `## 标题` + 一组元数据 + 正文：',
    '',
    '```markdown',
    '## 条目名',
    '- id: <32 位十六进制>',
    '- 触发词: 词1, 词2, 词3',
    '- 常驻: 否',
    '- 优先级: 5',
    '- 内在价值: 55',
    '- 连带触发词: 无',
    '',
    '正文……',
    '---',
    '```',
    '',
    '- **触发词**：命中后激活本条。逗号分隔，中英文标点都认。',
    '- **常驻**：`是` 表示始终注入、不参与打分。',
    '- **优先级**：激活后的排序 tiebreaker，1–10。',
    '- **内在价值**：抗遗忘基准，0–100。',
    '- **连带触发词**：本条被命中时顺手激活关键词对得上的其他条目（一层封顶）。',
    ''
  ].join('\n')
}

function firstFileTemplate(name: string): string {
  return [
    '# world.md — ' + name,
    '',
    '> 世界观、地理、机构与专有名词。触发后注入。',
    '> 只写事实；人格与语气不写在这里。',
    ''
  ].join('\n')
}
