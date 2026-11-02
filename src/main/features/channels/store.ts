import { app } from 'electron'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelChatType, ChannelId } from '@shared/channels'
import { channelKeyOf, parseChannelKey } from '@shared/channels'
import type {
  AccountPermissions,
  ChannelAccessConfig,
  ChannelAccount,
  ChannelGroup
} from '@shared/channelAccess'
import { DEFAULT_ACCOUNT_PERMISSIONS, DEFAULT_CHANNEL_ACCESS, isQqNumber } from '@shared/channelAccess'

/**
 * 渠道授权的落盘层（P6 G2 → **P9-R3 改 v2：按「人」授权**）。
 *
 * 真源：`userData/channels/access.json`。
 *
 * 🔴 **本 store 故意不做 mtime/size 缓存**（P6 §4.2 / J-23 / J-28）：
 *    缓存会在「外部进程改了文件、本进程随后写入」时**覆盖掉外部修改**。
 *    access.json 属于「用户可能手改、Plus 版也可能写」的共享文件，写入频率极低，
 *    每次 readFileSync 几十 KB 的代价可以忽略。
 *
 * 🔴 v2 的主体是**人**（QQ 号）+ **群**（群号），不是会话：
 *    旧模型的一条「会话条目」= 机器人号 + 群号，整个群共用一条权限记录 ⇒
 *    群里一个人有工具权限 = 全群都能干活。用户 2026-11-02 明确否掉了这个粒度。
 *
 * 🔴 语义：
 *    - 账号在 `accounts[]` 里 = 这个人被允许（具体能不能私聊 / 群聊 / 用工具看她自己的位）
 *    - 群在 `groups[]` 里 = 这个群允许她说话（**与「群里谁能触发她」是两件事**）
 *    - 删条目 = 撤权，但**不删任何历史会话/记忆**（只增不清）
 */

const FILE_VERSION = 2

export interface AccountDraft {
  userId: string
  label?: string
  permissions?: Partial<AccountPermissions>
  channel?: ChannelId
}

export interface GroupDraft {
  chatId: string
  label?: string
  channel?: ChannelId
}

export interface GatePatch {
  groupMemberGate?: boolean
  toolGate?: boolean
}

/**
 * 白名单在**会话维度**上的投影（区块面板要的是会话键，不是人）。
 *
 * 一个群 × 每个已知机器人号 = 若干条会话键；它们共享同一条群权限。
 */
export interface ChannelSessionView {
  key: string
  uin: string
  chatType: ChannelChatType
  chatId: string
  label: string
  lastAt: number
  /** 会话级的展示用权限位（只读投影，判定不信它） */
  permissions: { respond: boolean; tool: boolean }
}

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

  /** 读一次原始文件（不归一化）。不存在 / 读不出来 → null */
  readRaw(): unknown {
    if (!existsSync(this.filePath)) return null
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * 读整份配置（归一化后）。**每次调用都读盘**（见文件头）。
   *
   * 文件不存在 → 默认值（groupMemberGate=false / toolGate=true / 空名单）。
   * 文件损坏 → 备份成 access.json.bad-<ts> 后返回默认值（**绝不静默清空用户的授权表**）。
   * v1 文件 → **在内存里**按迁移规则转成 v2（真正的落盘迁移由 migrateToV2 显式做）。
   */
  config(): ChannelAccessConfig {
    if (!existsSync(this.filePath)) return { ...DEFAULT_CHANNEL_ACCESS, accounts: [], groups: [], uins: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      this.quarantine()
      return { ...DEFAULT_CHANNEL_ACCESS, accounts: [], groups: [], uins: [] }
    }
    return normalizeConfig(parsed)
  }

  /** 原子写整份配置（.tmp + rename；同盘 rename 是原子替换） */
  writeConfig(config: ChannelAccessConfig): ChannelAccessConfig {
    this.persist({ ...config, version: FILE_VERSION })
    return config
  }

  /** 两个总开关 */
  setGates(patch: GatePatch): ChannelAccessConfig {
    const config = this.config()
    if (patch.groupMemberGate !== undefined) config.groupMemberGate = patch.groupMemberGate === true
    if (patch.toolGate !== undefined) config.toolGate = patch.toolGate === true
    return this.writeConfig(config)
  }

  /** 新增或更新一个账号（权限是**部分更新**：只覆盖传了的位） */
  upsertAccount(draft: AccountDraft): ChannelAccessConfig {
    const channel: ChannelId = draft.channel ?? 'qq'
    const userId = String(draft.userId ?? '').trim()
    if (!userId) throw new Error('QQ 号不能为空')
    if (!isQqNumber(userId)) throw new Error('QQ 号只能是数字')

    const config = this.config()
    const index = config.accounts.findIndex((item) => item.channel === channel && item.userId === userId)
    const prev = index >= 0 ? config.accounts[index] : null
    const now = Date.now()
    const next: ChannelAccount = {
      channel,
      userId,
      label: draft.label !== undefined ? String(draft.label).trim() : (prev?.label ?? ''),
      addedAt: prev?.addedAt ?? now,
      lastAt: prev?.lastAt ?? 0,
      permissions: {
        private: draft.permissions?.private ?? prev?.permissions.private ?? DEFAULT_ACCOUNT_PERMISSIONS.private,
        group: draft.permissions?.group ?? prev?.permissions.group ?? DEFAULT_ACCOUNT_PERMISSIONS.group,
        tool: draft.permissions?.tool ?? prev?.permissions.tool ?? DEFAULT_ACCOUNT_PERMISSIONS.tool
      }
    }
    if (index >= 0) config.accounts[index] = next
    else config.accounts.push(next)
    return this.writeConfig(config)
  }

  /** 撤掉一个人。返回是否真的删掉了 */
  removeAccount(userId: string): boolean {
    const config = this.config()
    const next = config.accounts.filter((item) => item.userId !== String(userId ?? ''))
    if (next.length === config.accounts.length) return false
    config.accounts = next
    this.persist(config)
    return true
  }

  /** 新增或更新一个群 */
  upsertGroup(draft: GroupDraft): ChannelAccessConfig {
    const channel: ChannelId = draft.channel ?? 'qq'
    const chatId = String(draft.chatId ?? '').trim()
    if (!chatId) throw new Error('群号不能为空')
    if (!isQqNumber(chatId)) throw new Error('群号只能是数字')

    const config = this.config()
    const index = config.groups.findIndex((item) => item.channel === channel && item.chatId === chatId)
    const prev = index >= 0 ? config.groups[index] : null
    const next: ChannelGroup = {
      channel,
      chatId,
      label: draft.label !== undefined ? String(draft.label).trim() : (prev?.label ?? ''),
      addedAt: prev?.addedAt ?? Date.now(),
      lastAt: prev?.lastAt ?? 0
    }
    if (index >= 0) config.groups[index] = next
    else config.groups.push(next)
    return this.writeConfig(config)
  }

  /** 撤掉一个群。返回是否真的删掉了 */
  removeGroup(chatId: string): boolean {
    const config = this.config()
    const next = config.groups.filter((item) => item.chatId !== String(chatId ?? ''))
    if (next.length === config.groups.length) return false
    config.groups = next
    this.persist(config)
    return true
  }

  /**
   * 记下一个「机器人自己的登录号」。
   *
   * 为什么需要：群白名单存的是**群号**，而区块 / 旁听用的是**会话键**
   * （`qq:<uin>:group:<群号>`）。没有 uin 就展不开成会话。
   * 本方法由 bridge（收到消息时）与面板（识别到已注入进程时）调用。
   * 不认识的人/群一个都不加 —— 它只记「我们自己登录了哪些号」。
   */
  addUin(uin: string): void {
    const value = String(uin ?? '').trim()
    if (!isQqNumber(value)) return
    const config = this.config()
    if (config.uins.includes(value)) return
    config.uins = [...config.uins, value]
    this.persist(config)
  }

  /** 这条**会话键**在不在白名单（**不看权限位**）。区块面板的守卫用它 */
  has(key: string): boolean {
    const parsed = parseChannelKey(key)
    if (!parsed) return false
    const config = this.config()
    if (parsed.chatType === 'group') {
      return config.groups.some((item) => item.chatId === parsed.chatId)
    }
    return config.accounts.some((item) => item.userId === parsed.chatId)
  }

  /**
   * 把白名单展开成**会话维度**（区块面板的候选集）。
   *
   * 展开规则：
   *   群：每个已知机器人号 × 每个群 → 一条会话键。没有已知 uin 时展不开，返回空。
   *   私聊：每个账号 → 一条会话键（uin 取第一个已知机器人号；不知道时跳过）。
   */
  sessions(): ChannelSessionView[] {
    const config = this.config()
    const out: ChannelSessionView[] = []
    const uins = config.uins.length > 0 ? config.uins : []
    for (const group of config.groups) {
      for (const uin of uins) {
        out.push({
          key: channelKeyOf(uin, 'group', group.chatId),
          uin,
          chatType: 'group',
          chatId: group.chatId,
          label: group.label,
          lastAt: group.lastAt,
          permissions: { respond: true, tool: false }
        })
      }
    }
    for (const account of config.accounts) {
      for (const uin of uins.length > 0 ? [uins[0]] : []) {
        out.push({
          key: channelKeyOf(uin, 'private', account.userId),
          uin,
          chatType: 'private',
          chatId: account.userId,
          label: account.label,
          lastAt: account.lastAt,
          permissions: { respond: account.permissions.private, tool: account.permissions.tool }
        })
      }
    }
    return out
  }

  /** 记一次命中（面板的「最近活动」）。条目不存在时静默返回 */
  touch(key: string, at: number = Date.now()): void {
    const parsed = parseChannelKey(key)
    if (!parsed) return
    const config = this.config()
    if (parsed.chatType === 'group') {
      const group = config.groups.find((item) => item.chatId === parsed.chatId)
      if (!group) return
      group.lastAt = at
    } else {
      const account = config.accounts.find((item) => item.userId === parsed.chatId)
      if (!account) return
      account.lastAt = at
    }
    this.persist(config)
  }

  /**
   * v1（会话级）→ v2（人 + 群）迁移。**幂等**：已经是 v2 就直接返回。
   *
   * 两条硬要求：
   *  1. 迁移前**先备份**（`access.v1.backup.json`，一份，不覆盖已存在的）——
   *     这是唯一一次破坏性改写用户权限数据的操作；
   *  2. 迁移后行为**必须与迁移前完全一致**（见 PHASE-9 §15.3.2 表）。
   */
  migrateToV2(): { migrated: boolean; accounts: number; groups: number; backedUp: boolean } {
    if (!existsSync(this.filePath)) return { migrated: false, accounts: 0, groups: 0, backedUp: false }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      return { migrated: false, accounts: 0, groups: 0, backedUp: false }
    }
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    if (!record) return { migrated: false, accounts: 0, groups: 0, backedUp: false }
    if (record.version === FILE_VERSION) return { migrated: false, accounts: 0, groups: 0, backedUp: false }

    const backupPath = join(this.dirPath, 'access.v1.backup.json')
    let backedUp = false
    if (!existsSync(backupPath)) {
      try {
        copyFileSync(this.filePath, backupPath)
        backedUp = true
      } catch {
        /* 备份失败仍然继续：迁移本身用原子写，失败不会留下半份文件 */
      }
    }

    const config = normalizeConfig(raw)
    this.persist(config)
    try {
      appendFileSync(
        join(this.dirPath, 'migration.log'),
        new Date().toISOString() + ' migrated v1 → v2：' + String(config.accounts.length) + ' 个账号 / ' + String(config.groups.length) + ' 个群\n',
        'utf8'
      )
    } catch {
      /* 日志写不了不算失败 */
    }
    return { migrated: true, accounts: config.accounts.length, groups: config.groups.length, backedUp }
  }

  private persist(config: ChannelAccessConfig): void {
    mkdirSync(this.dirPath, { recursive: true })
    const file: ChannelAccessConfig = {
      version: FILE_VERSION,
      groupMemberGate: config.groupMemberGate === true,
      toolGate: config.toolGate !== false,
      accounts: config.accounts,
      groups: config.groups,
      uins: config.uins
    }
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  /**
   * 损坏文件隔离：**原地改名**，绝不删除用户数据。
   *
   * 后缀必须**唯一**（毫秒 + 自增序号 + existsSync 兜底）：
   * 原来只用 Date.now()，同一毫秒内连续两次隔离会命中同一个目标名，
   * rename 在 Windows 上是覆盖式的 ⇒ 第一次的备份被第二次悄悄吃掉。
   */
  private quarantine(): void {
    try {
      const base = this.filePath + '.bad-' + Date.now()
      let target = base
      let seq = 1
      while (existsSync(target) && seq < 1000) {
        target = base + '-' + seq
        seq += 1
      }
      renameSync(this.filePath, target)
    } catch {
      /* 备份失败也不阻塞：宁可这次读不到，也不要抛异常把 QQ 整体打死 */
    }
  }
}

/* ── 归一化 ─────────────────────────────────────────────────────────────── */

/**
 * 把任意形状的文件内容归一化成 v2。
 *
 * 三种输入都要能读：
 *   - v2（有 accounts / groups）
 *   - v1（有 entries 数组）—— 在内存里按迁移规则转，**不落盘**
 *   - 垃圾 → 默认值（不抛）
 */
export function normalizeConfig(input: unknown): ChannelAccessConfig {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
  const config: ChannelAccessConfig = {
    version: FILE_VERSION,
    groupMemberGate: record?.groupMemberGate === true, // 缺省 false：默认不收紧（用户 11-02 裁决）
    toolGate: record?.toolGate !== false, // 缺省 true：工具权限默认校验
    accounts: [],
    groups: [],
    uins: []
  }
  if (!record) return config

  if (Array.isArray(record.accounts)) {
    const seen = new Set<string>()
    for (const item of record.accounts) {
      const account = normalizeAccount(item)
      if (!account) continue
      if (seen.has(account.userId)) continue // 重复只留第一条
      seen.add(account.userId)
      config.accounts.push(account)
    }
  }
  if (Array.isArray(record.groups)) {
    const seen = new Set<string>()
    for (const item of record.groups) {
      const group = normalizeGroup(item)
      if (!group) continue
      if (seen.has(group.chatId)) continue
      seen.add(group.chatId)
      config.groups.push(group)
    }
  }
  if (Array.isArray(record.uins)) {
    for (const item of record.uins) {
      const value = String(item ?? '').trim()
      if (!isQqNumber(value) || config.uins.includes(value)) continue
      config.uins.push(value)
    }
  }

  // v1：把会话级条目折算成「人 + 群」
  if (Array.isArray(record.entries)) {
    migrateEntries(record.entries, config)
  }
  return config
}

/**
 * v1 条目 → v2（PHASE-9 §15.3.1 的逐条映射，**无损**）。
 *
 *  私聊条目 chatId=<X> → accounts[] 加 {userId:<X>, private: respond, group:true, tool}
 *     chatId 本来就是**对方**号（不是机器人号），直接就是 userId；uin 字段丢弃。
 *  群条目 chatId=<G>   → groups[] 加 <G>；旧条目的 tool **丢弃**（群级工具权限没有意义）
 */
function migrateEntries(entries: unknown[], config: ChannelAccessConfig): void {
  for (const item of entries) {
    const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    if (!raw) continue
    const key = typeof raw.key === 'string' ? raw.key : ''
    const parsed = parseChannelKey(key)
    if (!parsed) continue
    const perms = (raw.permissions ?? {}) as Record<string, unknown>
    const respond = perms.respond !== false
    const tool = perms.tool === true
    const lastAt = typeof raw.lastAt === 'number' && raw.lastAt >= 0 ? raw.lastAt : 0
    const addedAt = typeof raw.createdAt === 'number' && raw.createdAt > 0 ? raw.createdAt : Date.now()
    const label = typeof raw.label === 'string' ? raw.label : ''

    if (parsed.chatType === 'private') {
      if (!isQqNumber(parsed.chatId)) continue
      if (config.accounts.some((entry) => entry.userId === parsed.chatId)) continue
      config.accounts.push({
        channel: 'qq',
        userId: parsed.chatId,
        label,
        addedAt,
        lastAt,
        permissions: { private: respond, group: true, tool }
      })
    } else {
      if (!isQqNumber(parsed.chatId)) continue
      if (config.groups.some((entry) => entry.chatId === parsed.chatId)) continue
      config.groups.push({ channel: 'qq', chatId: parsed.chatId, label, addedAt, lastAt })
    }
    if (isQqNumber(parsed.uin) && !config.uins.includes(parsed.uin)) config.uins.push(parsed.uin)
  }
}

function normalizeAccount(input: unknown): ChannelAccount | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
  if (!raw) return null
  const userId = typeof raw.userId === 'string' ? raw.userId.trim() : ''
  if (!isQqNumber(userId)) return null // 空 / 非数字一律丢弃（不猜）
  const perms = (raw.permissions ?? {}) as Record<string, unknown>
  const addedAt = num(raw.addedAt, Date.now())
  return {
    channel: 'qq',
    userId,
    label: typeof raw.label === 'string' ? raw.label : '',
    addedAt,
    lastAt: num(raw.lastAt, 0),
    permissions: {
      // 三个位都按「缺省 = 默认值」处理，非法值同样回默认，不抛
      private: bool(perms.private, DEFAULT_ACCOUNT_PERMISSIONS.private),
      group: bool(perms.group, DEFAULT_ACCOUNT_PERMISSIONS.group),
      tool: bool(perms.tool, DEFAULT_ACCOUNT_PERMISSIONS.tool)
    }
  }
}

function normalizeGroup(input: unknown): ChannelGroup | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
  if (!raw) return null
  const chatId = typeof raw.chatId === 'string' ? raw.chatId.trim() : ''
  if (!isQqNumber(chatId)) return null
  return {
    channel: 'qq',
    chatId,
    label: typeof raw.label === 'string' ? raw.label : '',
    addedAt: num(raw.addedAt, Date.now()),
    lastAt: num(raw.lastAt, 0)
  }
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 主进程默认实例（userData/channels） */
export const channelStore = new ChannelAccessStore()

/**
 * 一次性迁移：userData/qq/bindings.json → channels/access.json（P6 §4.9）。
 *
 * 规则：
 *  - 只补**不存在**的账号 / 群（已有的不覆盖 —— 用户可能已经在控制台里改过权限）
 *  - 全部按默认权限（private=false / group=true / tool=false）；P4 的绑定本来就是「群里能回」
 *  - bindings.json **不删不改**；迁移记录写进 channels/migration.log（追加，只增不清）
 *  - 返回真正补进去的条数；0 表示无事发生
 *
 * 迁移必须**显式调用**（main/index.ts 启动时一次），不要在构造函数里偷偷跑。
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
  const list = Array.isArray(parsed) ? parsed : (parsed as { bindings?: unknown[] } | null)?.bindings
  if (!Array.isArray(list)) return 0
  const config = store.config()
  let added = 0
  for (const raw of list) {
    const item = raw as Record<string, unknown>
    const uin = String(item.uin ?? '').trim()
    const chatType = item.chatType === 'group' ? 'group' : 'private'
    const chatId = String(item.chatId ?? '').trim()
    if (!isQqNumber(uin) || !isQqNumber(chatId)) continue
    const displayName = typeof item.displayName === 'string' ? item.displayName : ''
    if (!config.uins.includes(uin)) config.uins.push(uin)
    if (chatType === 'group') {
      if (config.groups.some((entry) => entry.chatId === chatId)) continue
      config.groups.push({ channel: 'qq', chatId, label: displayName, addedAt: Date.now(), lastAt: 0 })
    } else {
      if (config.accounts.some((entry) => entry.userId === chatId)) continue
      config.accounts.push({
        channel: 'qq',
        userId: chatId,
        label: displayName,
        addedAt: Date.now(),
        lastAt: 0,
        permissions: { private: true, group: DEFAULT_ACCOUNT_PERMISSIONS.group, tool: false }
      })
    }
    added += 1
  }
  if (added > 0) {
    store.writeConfig(config)
    mkdirSync(store.dir, { recursive: true })
    appendFileSync(
      join(store.dir, 'migration.log'),
      new Date().toISOString() + ' migrated ' + String(added) + ' bindings\n',
      'utf8'
    )
  }
  return added
}
