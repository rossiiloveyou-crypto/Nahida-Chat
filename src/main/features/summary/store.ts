import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { emptySummary, type SessionSummary } from './types'

const FILE_VERSION = 1

interface SummaryFile {
  version: number
  items: Record<string, SessionSummary>
}

/**
 * 摘要落盘：`userData/summaries.json`，一个文件装所有会话。
 *
 * 为什么单独一个文件，不塞进 `sessions.json`：
 * 1. sessions.json 每轮都是**全量重写**，摘要进去会让写放大翻倍——而摘要只在压缩时变；
 * 2. Session 是三端契约（shared/types.ts），加字段会同时打穿 main / preload / renderer，
 *    还要给老会话写迁移。摘要属于主进程私有状态，放外面零成本；
 * 3. 摘要坏掉不该影响会话读写：两个文件互不牵连，删掉 summaries.json 只是丢掉记忆，
 *    不会丢聊天记录。
 */
export class SummaryStore {
  /**
   * 目录解析器做成可注入，理由与 MemoryService 注入 store 一致：
   * 纯逻辑要能在 main 进程之外被验证（单测、探针），不能一 import 就绑死 Electron。
   * 缺省仍然是 app.getPath('userData')，生产路径零变化。
   */
  private readonly resolveDir: () => string

  constructor(resolveDir: () => string = () => app.getPath('userData')) {
    this.resolveDir = resolveDir
  }

  /** 文件绝对路径（设置页「关于 → 数据目录」能看到这个目录） */
  file(): string {
    return join(this.resolveDir(), 'summaries.json')
  }

  load(): Map<string, SessionSummary> {
    const map = new Map<string, SessionSummary>()
    const file = this.file()
    if (!existsSync(file)) return map

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      // 文件坏了就当没有：摘要丢了是降级，抛出去会让整个聊天起不来
      console.warn('[summary] summaries.json 解析失败，按空处理', error)
      return map
    }

    const items =
      parsed && typeof parsed === 'object' && 'items' in parsed
        ? (parsed as SummaryFile).items
        : undefined
    if (!items || typeof items !== 'object') return map

    for (const [sessionId, raw] of Object.entries(items)) {
      const normalized = normalizeEntry(sessionId, raw)
      if (normalized) map.set(sessionId, normalized)
    }
    return map
  }

  save(map: Map<string, SessionSummary>): void {
    const file = this.file()
    const items: Record<string, SessionSummary> = {}
    for (const [sessionId, summary] of map) items[sessionId] = summary
    const payload: SummaryFile = { version: FILE_VERSION, items }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      // 落盘失败只降级到「内存里有效」，不让它冒到对话循环
      console.warn('[summary] 写入 summaries.json 失败', error)
    }
  }
}

/** 读盘即校验：手改坏字段、老版本缺字段，一律落回安全默认 */
function normalizeEntry(sessionId: string, raw: unknown): SessionSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Partial<SessionSummary>
  const base = emptySummary(sessionId)
  const sections = source.sections ?? base.sections

  return {
    sessionId,
    coveredCount:
      typeof source.coveredCount === 'number' && Number.isFinite(source.coveredCount)
        ? Math.max(0, Math.floor(source.coveredCount))
        : 0,
    anchorMessageId: typeof source.anchorMessageId === 'string' ? source.anchorMessageId : null,
    sections: {
      short_term: text(sections.short_term),
      long_term: text(sections.long_term),
      user_info: text(sections.user_info),
      promises: text(sections.promises)
    },
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : 0,
    lastError: typeof source.lastError === 'string' ? source.lastError : null,
    lastAttemptAt: typeof source.lastAttemptAt === 'number' ? source.lastAttemptAt : 0
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
