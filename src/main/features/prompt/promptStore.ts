import { app, shell } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type {
  ConversationMode,
  PromptCharFile,
  PromptCharacter,
  PromptLibrary,
  PromptSharedFile
} from '@shared/types'

const MARKDOWN = /\.(md|txt)$/i

/** 目录约定：角色 = 一个文件夹；模式规则与表达风格各占一层。 */
const SOUL_FILES = ['soul.md', 'soul.txt']
/** 模式规则：这个模式下她该做什么、边界在哪。 */
const MODE_RULES: Record<ConversationMode, string> = {
  chat: 'modes/chat.md',
  agent: 'modes/agent.md'
}
/** 表达风格：这个模式下她怎么说话。 */
const STYLE_FILES: Record<ConversationMode, string> = {
  chat: 'styles/chat.md',
  agent: 'styles/agent.md'
}
const SHARED_BASE = 'shared/base.md'
const SHARED_TONE = 'shared/tone.md'
/** 只对 Agent 模式生效：有工具才有工具纪律。 */
const SHARED_TOOL_USAGE = 'shared/tool_usage.md'
/** 原作台词样本目录：给她「说话长什么样」的语感参照，可以不填。 */
const CANON_DIR = 'canon'

/** 设置页的全局文件清单：顺序即注入顺序。 */
const SHARED_SPEC: Array<{ id: string; label: string; scope: PromptSharedFile['scope'] }> = [
  { id: SHARED_BASE, label: '全局底线规则', scope: 'both' },
  { id: SHARED_TONE, label: '语气与句式', scope: 'both' },
  { id: SHARED_TOOL_USAGE, label: '工具使用规范', scope: 'agent' }
]

/**
 * 提示词库：整个 Prompt/ 目录就是资产，用户直接用编辑器改文件。
 *
 * 结构（多角色，从第一版就按这个来）：
 *   Prompt/
 *   ├─ shared/base.md                 全局底线规则（所有角色、所有模式）
 *   ├─ shared/tone.md                 语气与句式规则（所有角色、所有模式）
 *   ├─ shared/tool_usage.md           工具使用规范（仅 Agent 模式）
 *   └─ characters/<角色>/
 *      ├─ soul.md                     人格核心
 *      ├─ canon/*.md                  原作台词样本（_ 前缀与 README 不注入）
 *      ├─ worldbook/*.md              背景设定
 *      ├─ modes/{chat,agent}.md       模式规则：这个模式下该做什么
 *      └─ styles/{chat,agent}.md      表达风格：这个模式下怎么说话
 *
 * 程序只负责"按顺序拼接"，不在代码里写死任何角色人格。
 */
class PromptStore {
  root(): string {
    // 先判 isPackaged：process.resourcesPath 只在 Electron 里有值，
    // 裸 Node 环境下 join(undefined, ...) 会直接抛类型错误。
    if (app.isPackaged && process.resourcesPath) {
      const packaged = join(process.resourcesPath, 'prompt')
      if (existsSync(packaged)) return packaged
    }
    return join(app.getAppPath(), 'Prompt')
  }

  /** 设置页用：有哪些角色、每个角色有哪些文件、缺哪个。 */
  library(): PromptLibrary {
    const root = this.root()
    const entries = existsSync(join(root, 'characters'))
      ? readdirSync(join(root, 'characters'), { withFileTypes: true })
      : []

    const characters: PromptCharacter[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, 'characters', entry.name)
      const name = readCharacterName(dir, entry.name)
      characters.push({
        id: entry.name,
        name,
        files: describeCharacterFiles(root, entry.name),
        complete: existsSync(join(dir, SOUL_FILES[0])) || existsSync(join(dir, SOUL_FILES[1]))
      })
    }

    return {
      root,
      exists: existsSync(root),
      characters: characters.sort((a, b) => a.id.localeCompare(b.id)),
      sharedFiles: SHARED_SPEC.map((item) => ({
        id: item.id,
        label: item.label,
        relativePath: item.id,
        scope: item.scope,
        exists: existsSync(join(root, item.id))
      }))
    }
  }

  /**
   * 拼出本轮要用的 system 提示词。
   *
   * 顺序固定（越靠后越贴近这次回答，权重越高）：
   *   全局底线 -> 统一语气 -> 人格核心 -> 原作台词 -> 背景设定 -> 模式规则 -> 表达风格 -> [Agent] 工具规范
   *
   * 分层理由：
   * - 前两段跨角色跨模式，「她是谁」不随模式变；
   * - 中间四段是角色的稳定事实（台词样本紧贴人格，因为它就是人格的说话证据）；
   * - 模式规则与表达风格按会话模式二选一，互不污染；
   * - 工具规范只对「这一轮真有工具」的模式生效（agent 恒有；chat 由 opts 告知），
   *   放最后压轴，因为它是执行纪律，不该被语气覆盖。
   *
   * 任何一环缺失都跳过而不是报错，保证用户删文件时对话还能继续。
   * 角色目录整个不在时，全局段与工具规范仍然照发——缺人格不等于失去执行纪律。
   */
  compose(
    characterId: string,
    mode: ConversationMode,
    opts?: { toolsEnabled?: boolean }
  ): string {
    const root = this.root()
    const sections: string[] = []

    push(sections, readIfExists(join(root, SHARED_BASE)))
    push(sections, readIfExists(join(root, SHARED_TONE)))

    const dir = join(root, 'characters', characterId)
    if (existsSync(dir)) {
      for (const soulName of SOUL_FILES) {
        const text = readIfExists(join(dir, soulName))
        if (text) {
          push(sections, text)
          break
        }
      }

      // 台词样本：先解转义再剥注释，模板里的填写说明不会跑到模型面前。
      // 还留着「[待补」的说明文件也没填过，同样跳过——占位符不该出现在人设里。
      for (const file of listMarkdown(join(dir, CANON_DIR))) {
        const body = normalizeCanon(readIfExists(file))
        if (body && !body.includes('[待补')) push(sections, body)
      }

      for (const file of listMarkdown(join(dir, 'worldbook'))) {
        push(sections, readIfExists(file))
      }

      push(sections, readIfExists(join(dir, MODE_RULES[mode])))
      push(sections, readIfExists(join(dir, STYLE_FILES[mode])))
    }

    // 工具规范只在「这一轮确实有工具」时注入 ——
    // 没有工具却给纪律，等于让模型去查一份空目录，还会污染闲聊语感（M01 的初衷）。
    // agent 恒有工具（P1 的 capability.ts 保证），chat 由调用方按本轮 definitions 告知。
    const wantsToolRules = mode === 'agent' || (mode === 'chat' && opts?.toolsEnabled === true)
    if (wantsToolRules) {
      push(sections, readIfExists(join(root, SHARED_TOOL_USAGE)))
    }

    return sections.join('\n\n---\n\n')
  }

  /** 打开提示词库目录（交给系统文件管理器）。 */
  async openLibrary(): Promise<string> {
    const root = this.root()
    const error = await shell.openPath(root)
    return error
  }

  /** 打开某个角色的目录。 */
  async openCharacter(characterId: string): Promise<string> {
    const dir = resolve(this.root(), 'characters', characterId)
    const base = resolve(this.root(), 'characters')
    if (!dir.startsWith(base + sep)) throw new Error('非法角色目录: ' + characterId)
    return shell.openPath(dir)
  }

  /** 默认角色：第一个带 soul.md 的目录，找不到就 nahida。 */
  defaultCharacterId(): string {
    const library = this.library()
    return library.characters.find((item) => item.complete)?.id ?? library.characters[0]?.id ?? 'nahida'
  }
}

function describeCharacterFiles(root: string, characterId: string): PromptCharFile[] {
  const dir = join(root, 'characters', characterId)
  // 顺序 = compose() 的拼装顺序：人格 -> 设定 -> 模式规则 -> 表达风格
  const spec: Array<{ id: string; label: string }> = [
    { id: 'soul.md', label: '人格核心' },
    { id: 'canon', label: '原作台词基准' },
    { id: 'worldbook', label: '背景设定' },
    { id: 'modes/chat.md', label: 'Chat 模式规则' },
    { id: 'modes/agent.md', label: 'Agent 模式规则' },
    { id: 'styles/chat.md', label: 'Chat 表达风格' },
    { id: 'styles/agent.md', label: 'Agent 表达风格' }
  ]
  return spec.map((item) => {
    const absolute = join(dir, item.id)
    return {
      id: item.id,
      label: item.label,
      relativePath: 'characters/' + characterId + '/' + item.id,
      exists: existsSync(absolute)
    }
  })
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return []
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...listMarkdown(absolute))
    } else if (
      entry.isFile()
      && MARKDOWN.test(entry.name)
      && entry.name.toLowerCase() !== 'readme.md'
      // _ 前缀 = 模板/草稿，不参与拼装（台词模板 _template.md 靠这条）
      && !entry.name.startsWith('_')
      // 文件名里带 template 的副本同样视为模板（Windows 上大小写不敏感，
      // 用户复制出 Template.md 这种副本时不该被当成正式台词重复注入）
      && !/^_?template\.(md|txt)$/i.test(entry.name)
    ) {
      result.push(absolute)
    }
  }
  return result
}

/**
 * 台词文件清洗：解开 HTML 实体转义，再剥掉注释。
 *
 * 为什么先解转义：从网页/聊天窗口复制出来的文本会把 < > " 转成 &lt; &gt; &quot;，
 * 注释符号一旦被转义，stripComments 就认不出来，整段填写说明会原样进提示词。
 * 这一步只还原这五个实体，不动正文里的其它字符。
 */
function normalizeCanon(text: string): string {
  const decoded = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
  return decoded.replace(/<!--[\s\S]*?-->/g, '').trim()
}

function readIfExists(path: string): string {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return ''
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 角色显示名：取 soul.md 一级标题里 "·" 之前的部分（"纳西妲 · Soul" -> "纳西妲"），
 * 没有标题就退回目录名。目录名仍然是稳定 id，界面展示不受改名影响。
 */
function readCharacterName(dir: string, fallback: string): string {
  for (const fileName of SOUL_FILES) {
    const text = readIfExists(join(dir, fileName))
    const match = text.match(/^#\s+(.+)$/m)
    if (match && match[1]) {
      const raw = match[1].trim()
      const short = raw.split('·')[0].trim()
      return short || raw
    }
  }
  return fallback
}

function push(sections: string[], text: string): void {
  if (text) sections.push(text)
}

export const promptStore = new PromptStore()
