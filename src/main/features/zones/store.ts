import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import type {
  Zone,
  ZoneConfig,
  ZoneDraft,
  ZoneExternalMember,
  ZoneMemberDraft,
  ZonesFile
} from '@shared/zones'
import { ROOT_ZONE_ID, ZONES_FILE_VERSION } from '@shared/zones'

/**
 * 区块配置的持久化（P5 G2）。
 *
 * 目录：`userData/zones.json` —— 与 `memory.db` **同级**（一个域表、一个记忆库，
 * 备份与回滚时一眼能看全）。存储纪律与 `qq/store.ts` 完全一致：
 *  - 写：write tmp → rename（原子）
 *  - 读：文件不存在 → 默认单 root；JSON 解析失败 / 根区块不合法 → 重建默认，**不抛**
 *  - 归一化：丢弃缺字段的成员、按 key 去重、一个外部会话只留在一个区块
 *
 * 三条不变量（照抄 Cyrene zones/zone-store.ts 的教训 E9/E11）：
 *  1. root 有且仅有一个、不可删、不可改名；缺失或重复 → 整个文件重建
 *  2. 一个外部会话同一时刻只属一个区块
 *  3. 加成员时**先校验上限、再移除旧成员**（顺序反了会出现「校验失败但旧成员已没了」）
 */

const ROOT_ZONE_NAME = '主区块'
const CHAT_ID_PATTERN = /^[^\s:]{1,64}$/

export const DEFAULT_ROOT_ZONE_CONFIG: ZoneConfig = { injectOwnerProfile: true, observeGroupMessages: false }
export const DEFAULT_ZONE_CONFIG: ZoneConfig = { injectOwnerProfile: false, observeGroupMessages: true }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function createRootZone(now: number = Date.now()): Zone {
  return {
    zoneId: ROOT_ZONE_ID,
    zoneName: ROOT_ZONE_NAME,
    isRoot: true,
    createdAt: now,
    config: { ...DEFAULT_ROOT_ZONE_CONFIG },
    members: []
  }
}

function cloneZone(zone: Zone): Zone {
  return {
    ...zone,
    config: { ...zone.config },
    members: zone.members.map((member) => ({ ...member }))
  }
}

function normalizeMember(raw: unknown): ZoneExternalMember | null {
  const record = asRecord(raw)
  if (!record) return null
  const key = text(record.key)
  const chatId = text(record.chatId)
  const chatType = record.chatType === 'group' ? 'group' : record.chatType === 'private' ? 'private' : null
  if (!key || !chatId || !chatType) return null
  if (!CHAT_ID_PATTERN.test(chatId)) return null
  const displayName = text(record.displayName)
  return {
    kind: 'external',
    key,
    channel: 'qq',
    chatType,
    chatId,
    ...(displayName ? { displayName } : {})
  }
}

function normalizeConfig(raw: unknown, fallback: ZoneConfig): ZoneConfig {
  const record = asRecord(raw) ?? {}
  return {
    injectOwnerProfile:
      typeof record.injectOwnerProfile === 'boolean' ? record.injectOwnerProfile : fallback.injectOwnerProfile,
    observeGroupMessages:
      typeof record.observeGroupMessages === 'boolean'
        ? record.observeGroupMessages
        : fallback.observeGroupMessages
  }
}

function normalizeZone(raw: unknown): Zone | null {
  const record = asRecord(raw)
  if (!record) return null
  const zoneId = text(record.zoneId)
  if (!zoneId) return null
  // isRoot 认两处：id 是 root，或文件里被标成 root（后者用来识别「两个 root」的坏文件）
  const isRoot = zoneId === ROOT_ZONE_ID || record.isRoot === true
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? record.createdAt
    : Date.now()
  const members: ZoneExternalMember[] = []
  if (Array.isArray(record.members)) {
    for (const item of record.members) {
      const member = normalizeMember(item)
      if (member) members.push(member)
    }
  }
  // root 至多 1 个私聊：坏文件里的多余私聊直接丢掉（不抛，修好它）
  const kept = isRoot ? capRootMembers(members) : members
  return {
    zoneId,
    zoneName: isRoot ? ROOT_ZONE_NAME : text(record.zoneName) || zoneId,
    isRoot,
    createdAt,
    config: normalizeConfig(record.config, isRoot ? DEFAULT_ROOT_ZONE_CONFIG : DEFAULT_ZONE_CONFIG),
    members: kept
  }
}

function capRootMembers(members: ZoneExternalMember[]): ZoneExternalMember[] {
  let privateUsed = 0
  const kept: ZoneExternalMember[] = []
  for (const member of members) {
    if (member.chatType === 'private') {
      if (privateUsed >= 1) continue
      privateUsed += 1
    }
    kept.push(member)
  }
  return kept
}

/** 解析成合法区块列表；root 缺失 / 重复 / 结构不对 → null（调用方重建）。 */
function normalizeFile(raw: unknown): Zone[] | null {
  const record = asRecord(raw)
  const list = Array.isArray(raw) ? raw : record && Array.isArray(record.zones) ? record.zones : null
  if (!list) return null

  const zones: Zone[] = []
  const ids = new Set<string>()
  for (const item of list) {
    const zone = normalizeZone(item)
    if (!zone) continue
    if (ids.has(zone.zoneId)) continue
    ids.add(zone.zoneId)
    zones.push(zone)
  }
  if (zones.filter((zone) => zone.isRoot).length !== 1) return null

  // 不变量 2：一个 key 只留在一个区块（以文件里先出现的为准）
  const seen = new Set<string>()
  for (const zone of zones) {
    zone.members = zone.members.filter((member) => {
      if (seen.has(member.key)) return false
      seen.add(member.key)
      return true
    })
  }
  // root 永远排第一：面板与统计都依赖这个顺序
  zones.sort((a, b) => (a.isRoot === b.isRoot ? a.createdAt - b.createdAt : a.isRoot ? -1 : 1))
  return zones
}

function newZoneId(): string {
  return 'zone_' + Date.now().toString(36) + '_' + randomBytes(3).toString('hex')
}

export class ZoneStore {
  private readonly explicitDir: string | null
  /** 读盘快照：键是 mtime+size，写时更新。外部改文件仍会因签名变化被重新读取。 */
  private cache: { signature: string; zones: Zone[] } | null = null

  /** 传 dir 可把存储放到别处（测试用）；缺省是 userData */
  constructor(dir?: string) {
    this.explicitDir = dir ? dir : null
  }

  get dir(): string {
    return this.explicitDir ?? app.getPath('userData')
  }

  get file(): string {
    return join(this.dir, 'zones.json')
  }

  listZones(): Zone[] {
    return this.load().map(cloneZone)
  }

  getZone(zoneId: string): Zone | null {
    const zone = this.load().find((item) => item.zoneId === zoneId)
    return zone ? cloneZone(zone) : null
  }

  getRootZone(): Zone {
    const root = this.load().find((zone) => zone.isRoot)
    // load() 保证有且仅有一个 root，这里只是类型收窄
    return cloneZone(root ?? createRootZone())
  }

  /** 按外部会话键反查区块（P5 的核心查询：域解析走它） */
  findZoneByExternalKey(key: string): Zone | null {
    const zone = this.load().find((item) => item.members.some((member) => member.key === key))
    return zone ? cloneZone(zone) : null
  }

  createZone(draft: ZoneDraft): Zone {
    const zones = this.load()
    const zoneName = text(draft.zoneName) || '新区块'
    const now = Date.now()
    const zone: Zone = {
      zoneId: newZoneId(),
      zoneName,
      isRoot: false,
      createdAt: now,
      config: { ...DEFAULT_ZONE_CONFIG },
      members: []
    }
    zones.push(zone)
    this.persist(zones)
    return cloneZone(zone)
  }

  /** root 不可改名：返回原值（不抛，面板不会因此报错） */
  renameZone(zoneId: string, name: string): Zone | null {
    const zones = this.load()
    const zone = zones.find((item) => item.zoneId === zoneId)
    if (!zone) return null
    if (zone.isRoot) return cloneZone(zone)
    const next = text(name)
    if (!next) return cloneZone(zone)
    zone.zoneName = next
    this.persist(zones)
    return cloneZone(zone)
  }

  updateZoneConfig(zoneId: string, patch: Partial<ZoneConfig>): Zone | null {
    const zones = this.load()
    const zone = zones.find((item) => item.zoneId === zoneId)
    if (!zone) return null
    if (typeof patch.injectOwnerProfile === 'boolean') zone.config.injectOwnerProfile = patch.injectOwnerProfile
    if (typeof patch.observeGroupMessages === 'boolean') zone.config.observeGroupMessages = patch.observeGroupMessages
    this.persist(zones)
    return cloneZone(zone)
  }

  /** root 不可删：返回 false，且文件一个字节都不动 */
  deleteZone(zoneId: string): boolean {
    const zones = this.load()
    const index = zones.findIndex((item) => item.zoneId === zoneId)
    if (index < 0) return false
    if (zones[index].isRoot) return false
    zones.splice(index, 1)
    this.persist(zones)
    return true
  }

  addMember(draft: ZoneMemberDraft): Zone {
    const zones = this.load()
    const zone = zones.find((item) => item.zoneId === draft.zoneId)
    if (!zone) throw new Error('区块不存在：' + draft.zoneId)
    const member = normalizeMember({
      kind: 'external',
      channel: 'qq',
      key: draft.key,
      chatType: draft.chatType,
      chatId: draft.chatId,
      displayName: draft.displayName
    })
    if (!member) throw new Error('成员信息不完整：需要 key / chatType / chatId')

    // 不变量 3（E11）：**先校验上限，再移除旧成员**
    if (zone.isRoot && member.chatType === 'private') {
      const others = zone.members.filter((item) => item.chatType === 'private' && item.key !== member.key)
      if (others.length >= 1) throw new Error('主区块最多只能挂 1 个 QQ 私聊')
    }

    this.detach(zones, member.key)
    zone.members.push(member)
    this.persist(zones)
    return cloneZone(zone)
  }

  removeMember(zoneId: string, key: string): Zone | null {
    const zones = this.load()
    const zone = zones.find((item) => item.zoneId === zoneId)
    if (!zone) return null
    zone.members = zone.members.filter((member) => member.key !== key)
    this.persist(zones)
    return cloneZone(zone)
  }

  /** 全部已归区的外部会话键（面板与统计用） */
  listAssignedKeys(): Set<string> {
    const keys = new Set<string>()
    for (const zone of this.load()) {
      for (const member of zone.members) keys.add(member.key)
    }
    return keys
  }

  /** 批量把已存在的 QQ 绑定归到某区块（面板的「加入本区块」走它） */
  adoptMembers(
    zoneId: string,
    members: Array<{ key: string; chatType: 'private' | 'group'; chatId: string; displayName?: string }>
  ): { added: number; errors: string[] } {
    let added = 0
    const errors: string[] = []
    for (const member of members) {
      try {
        this.addMember({
          zoneId,
          key: member.key,
          chatType: member.chatType,
          chatId: member.chatId,
          ...(member.displayName ? { displayName: member.displayName } : {})
        })
        added += 1
      } catch (error) {
        errors.push((member.displayName || member.chatId) + '：' + (error instanceof Error ? error.message : String(error)))
      }
    }
    return { added, errors }
  }

  /** 从所有区块里摘掉这个 key（不落盘；调用方负责 persist） */
  private detach(zones: Zone[], key: string): void {
    for (const zone of zones) {
      zone.members = zone.members.filter((member) => member.key !== key)
    }
  }

  private load(): Zone[] {
    const signature = this.signature()
    if (this.cache && this.cache.signature === signature) return this.cache.zones

    let zones: Zone[] | null = null
    try {
      if (existsSync(this.file)) {
        const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
        zones = normalizeFile(parsed)
        if (!zones) {
          console.warn('[zones] zones.json 的根区块缺失或重复，重建默认区块')
          zones = [createRootZone()]
          this.persist(zones)
        }
      } else {
        zones = [createRootZone()]
        this.persist(zones)
      }
    } catch (error) {
      console.warn('[zones] 读取失败，回落默认单主区块', error)
      zones = [createRootZone()]
      try {
        this.persist(zones)
      } catch {
        // 落盘失败也不能让面板炸掉
      }
    }

    this.cache = { signature: this.signature(), zones }
    return zones
  }

  private signature(): string {
    try {
      const stat = statSync(this.file)
      return String(stat.mtimeMs) + ':' + String(stat.size)
    } catch {
      return 'missing'
    }
  }

  private persist(zones: Zone[]): void {
    const file: ZonesFile = { version: ZONES_FILE_VERSION, zones }
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
      renameSync(tmp, this.file)
      this.cache = { signature: this.signature(), zones }
    } catch (error) {
      console.error('[zones] 落盘失败：' + this.file, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
}

/** 主进程单例（渲染层不直接拿它，走 IPC） */
export const zoneStore = new ZoneStore()
