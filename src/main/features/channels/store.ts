import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChannelAccessDraft,
  ChannelAccessEntry,
  ChannelAccessFile,
  ChannelId
} from '@shared/channels'
import { DEFAULT_CHANNEL_PERMISSIONS, channelKeyOf, parseChannelKey } from '@shared/channels'

/**
 * 渠道白名单的落盘层（P6 G2）。真源：userData/channels/access.json。
 *
 * 🔴 **本 store 故意不做 mtime/size 缓存**（与 ZoneStore 相反，见 P6 §4.2）：
 *    缓存会在「外部进程改了文件、本进程随后写入」时**覆盖掉外部修改**。
 *    access.json 属于「用户可能手改、Plus 版也可能写」的共享文件，写入频率极低，
 *    每次 readFileSync 几十字节的代价可以忽略。
 *
 * 🔴 语义：**有条目 = 在白名单**。删条目 = 撤权，但**不删任何历史会话/记忆**
 *    （只增不清；撤权只影响「以后还响不响应」）。
 */

const FILE_VERSION = 1

export class ChannelAccessStore {
  private readonly dirPath: string
  private readonly filePath: string

  constructor(dir?: string) {
    this.dirPath = dir ?? join(app.getPath('userData'), 'channels')
    this.filePath = join(this.dirPath, 'access.json')
  }

  get dir(): string {
    return this.dirPath
  }

  get file(): string {
    return this.filePath
  }

  /**
   * 读全部条目。**每次调用都读盘**（见文件头理由）。
   * 文件不存在 → 返回 []（读操作不产生副作用；写盘只发生在 upsert/remove/touch）。
   * 文件损坏 → 备份成 access.json.bad-<ts> 后返回 []（绝不静默清空用户的授权表）。
   */
  entries(): ChannelAccessEntry[] {
    if (!existsSync(this.filePath)) return []
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.quarantine()
      return []
    }
    const file = parsed as Partial<ChannelAccessFile> | null
    if (!file || typeof file !== 'object' || !Array.isArray(file.entries)) {
      this.quarantine()
      return []
    }
    const out: ChannelAccessEntry[] = []
    const seen = new Set<string>()
    for (const item of file.entries) {
      const entry = normalizeEntry(item)
      if (!entry) continue
      if (seen.has(entry.key)) continue // 同一 key 只认第一条（不改写用户文件，只在内存里去重）
      seen.add(entry.key)
      out.push(entry)
    }
    return out
  }

  get(key: string): ChannelAccessEntry | null {
    return this.entries().find((item) => item.key === key) ?? null
  }

  /** 是否在白名单（**不看权限位**）。bridge 用它区分 unbound 与 no-permission。 */
  has(key: string): boolean {
    return this.get(key) !== null
  }

  /**
   * 新增或更新。permissions 是**部分更新**：只覆盖传了的位，其余沿用旧值。
   * 新建时缺省 DEFAULT_CHANNEL_PERMISSIONS（respond=true / tool=false）。
   */
  upsert(draft: ChannelAccessDraft): ChannelAccessEntry {
    const channel: ChannelId = draft.channel ?? 'qq'
    const uin = String(draft.uin ?? '').trim()
    const chatId = String(draft.chatId ?? '').trim()
    const chatType = draft.chatType
    if (!uin) throw new Error('QQ 号不能为空')
    if (!chatId) throw new Error('会话号不能为空')
    if (chatType !== 'private' && chatType !== 'group') throw new Error('会话类型只能是 private / group')
    if (chatType === 'private' && uin !== chatId) {
      // 私聊的 chatId 就是对方 QQ 号；写成别的几乎一定是表单填错
      throw new Error('私聊的会话号必须等于 QQ 号')
    }

    const key = channelKeyOf(uin, chatType, chatId, channel)
    const list = this.entries()
    const now = Date.now()
    const index = list.findIndex((item) => item.key === key)
    const prev = index >= 0 ? list[index] : null
    const next: ChannelAccessEntry = {
      key,
      channel,
      uin,
      chatType,
      chatId,
      label: draft.label !== undefined ? String(draft.label).trim() : (prev?.label ?? ''),
      permissions: {
        respond:
          draft.permissions?.respond ??
          prev?.permissions.respond ??
          DEFAULT_CHANNEL_PERMISSIONS.respond,
        tool: draft.permissions?.tool ?? prev?.permissions.tool ?? DEFAULT_CHANNEL_PERMISSIONS.tool
      },
      lastAt: prev?.lastAt ?? 0,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    if (index >= 0) list[index] = next
    else list.push(next)
    this.persist(list)
    return next
  }

  /** 撤权。返回是否真的删掉了（用于 IPC 回执） */
  remove(key: string): boolean {
    const list = this.entries()
    const next = list.filter((item) => item.key !== key)
    if (next.length === list.length) return false
    this.persist(next)
    return true
  }

  /** 记一次命中。条目不存在时静默返回（不要因为「面板还没刷新」写出一条空记录） */
  touch(key: string, at: number = Date.now()): void {
    const list = this.entries()
    const entry = list.find((item) => item.key === key)
    if (!entry) return
    entry.lastAt = at
    // 注意：touch **不**更新 updatedAt —— 那是「用户改配置」的时间，面板按它排序会乱
    this.persist(list)
  }

  private persist(entries: ChannelAccessEntry[]): void {
    mkdirSync(this.dirPath, { recursive: true })
    const file: ChannelAccessFile = { version: FILE_VERSION, entries }
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmp, this.filePath) // 同盘 rename 是原子替换；半写文件永远不会出现在正式路径上
  }

  private quarantine(): void {
    try {
      renameSync(this.filePath, this.filePath + '.bad-' + Date.now())
    } catch {
      /* 备份失败也不阻塞：宁可这次读不到，也不要抛异常把 QQ 整体打死 */
    }
  }
}

/** 单条归一化。缺 key 或 key 不合形状的条目直接丢弃（不猜） */
function normalizeEntry(input: unknown): ChannelAccessEntry | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const key = typeof raw.key === 'string' ? raw.key : ''
  const parsed = parseChannelKey(key)
  if (!parsed) return null
  const perms = (raw.permissions ?? {}) as Record<string, unknown>
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
  return {
    key,
    channel: parsed.channel,
    uin: parsed.uin,
    chatType: parsed.chatType,
    chatId: parsed.chatId,
    label: typeof raw.label === 'string' ? raw.label : '',
    permissions: {
      respond: perms.respond !== false, // 缺省 true：老文件没有 permissions 字段时保持「能回」
      tool: perms.tool === true // 缺省 false：权限位必须显式给
    },
    lastAt: num(raw.lastAt, 0),
    createdAt: num(raw.createdAt, 0),
    updatedAt: num(raw.updatedAt, 0)
  }
}

/** 主进程默认实例（userData/channels） */
export const channelStore = new ChannelAccessStore()

/**
 * 一次性迁移：userData/qq/bindings.json → channels/access.json（P6 §4.9）。
 *
 * 规则：
 *  - 只补**不存在**的 key（access.json 里已有的不覆盖 —— 用户可能已经在控制台里改过权限）
 *  - 全部按 default 权限（respond=true / tool=false）；P4 的绑定本来就是「能回」
 *  - bindings.json **不删不改**；迁移记录写进 channels/migration.log（追加，只增不清）
 *  - 返回真正补进去的条数；0 表示无事发生
 *
 * 迁移必须**显式调用**（main/index.ts 启动时一次），不要在构造函数里偷偷跑 —— 副作用必须可预期。
 */
export function migrateFromBindings(store: ChannelAccessStore = channelStore): number {
  const legacy = join(app.getPath('userData'), 'qq', 'bindings.json')
  if (!existsSync(legacy)) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(legacy, 'utf8'))
  } catch {
    return 0
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { bindings?: unknown[] } | null)?.bindings
  if (!Array.isArray(list)) return 0
  const existing = new Set(store.entries().map((item) => item.key))
  let added = 0
  for (const raw of list) {
    const item = raw as Record<string, unknown>
    const uin = String(item.uin ?? '').trim()
    const chatType = item.chatType === 'group' ? 'group' : 'private'
    const chatId = String(item.chatId ?? '').trim()
    if (!uin || !chatId) continue
    const key = channelKeyOf(uin, chatType, chatId)
    if (existing.has(key)) continue
    const displayName = typeof item.displayName === 'string' ? item.displayName : ''
    store.upsert({ uin, chatType, chatId, ...(displayName ? { label: displayName } : {}) })
    existing.add(key)
    added += 1
  }
  if (added > 0) {
    mkdirSync(store.dir, { recursive: true })
    appendFileSync(join(store.dir, 'migration.log'), new Date().toISOString() + ' migrated ' + added + ' bindings\n', 'utf8')
  }
  return added
}
