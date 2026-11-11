import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CONTEXT_WINDOW_RANGE,
  DEFAULT_APPEARANCE,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_SUMMARY_SETTINGS,
  MEMORY_BUDGET_RANGE,
  MEMORY_TOP_K_RANGE,
  SUMMARY_CHARS_RANGE,
  SUMMARY_TRIGGER_RANGE,
  SUMMARY_WINDOW_RANGE,
  TEMPERATURE_RANGE,
  isProviderId,
  providerMeta
} from '@shared/constants'
import { promptStore } from '../prompt/promptStore'
import { isDirectory, normalizeDir, workspaceLabel } from '../workspace'
import type {
  AppearanceSettings,
  MemorySettings,
  ModelOptions,
  ModelProfile,
  ModelProfileCatalog,
  ModelProfileDraft,
  PermissionMode,
  PermissionSettings,
  SummarySettings,
  ProviderId,
  Settings,
  Workspace,
  WorkspaceCatalog,
  WorkspaceDraft
} from '@shared/types'

export function defaultWorkspaceRoot(): string {
  return join(app.getPath('userData'), 'workspace')
}

/**
 * 渠道工作区根的缺省值（P3 / M21）。
 *
 * 与 `defaultWorkspaceRoot()` 同一个目录，但**语义独立**：那是「桌面默认工作区」，
 * 这是「渠道会话唯一允许落地的根」。两者今天恰好同路径，不代表明天还要一起改。
 *
 * 🔴 为什么额外 `mkdirSync`：`sandbox.ts` 的 resolve 不检查目录存在性，
 *    缺目录要等首个工具调用才由 OS 报 ENOENT，报错文案对用户毫无解释力。
 *    `recursive: true` 对已存在目录是 no-op，代价可忽略。
 * 🔴 为什么**不**写进 `defaultSettings()`：写进去会让所有老配置在首次 save() 时
 *    被补上一份冗余值，改数据目录后两份值会不一致（同一语义两处载体）。
 */
export function defaultChannelWorkspaceDir(): string {
  const dir = defaultWorkspaceRoot()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 目录建不出来（只读盘 / 权限）不在本函数里报错：
    // 真正的失败应该在工具执行时带着「路径 + 原因」冒出来，而不是在设置读取路径上炸。
  }
  return dir
}

/** 默认档案 ID 固定，升级时不用猜用户改过哪个。 */
const DEFAULT_PROFILE_ID = 'profile-default'

/** 内置默认工作区 ID 固定：迁移老配置时不用现造一个猜不到 id 的条目。 */
const DEFAULT_WORKSPACE_ID = 'workspace-default'

/**
 * 解析某个会话实际落在哪个工作区目录。
 *
 * 三步回落，每一步都保证"返回一个真实可用的绝对路径"：
 * 会话绑定的 → 当前活动工作区 → 清单第一条。
 * 这样删掉某个工作区之后，老会话不会因为找不到目录就整个对话报错。
 */
export function resolveWorkspace(settings: Settings, workspaceId?: string | null): Workspace | null {
  const list = Array.isArray(settings.workspaces) ? settings.workspaces : []
  if (list.length === 0) return null
  return (
    (workspaceId ? list.find((item) => item.id === workspaceId) : undefined) ??
    list.find((item) => item.id === settings.activeWorkspaceId) ??
    list[0]
  )
}

/** 默认值延迟到 app ready 之后求值（userData 路径依赖 app）。 */
export function defaultSettings(): Settings {
  const now = Date.now()
  const profile: ModelProfile = {
    id: DEFAULT_PROFILE_ID,
    name: '演示模式',
    provider: 'mock',
    baseUrl: '',
    apiKey: '',
    models: ['demo'],
    defaultModel: 'demo',
    temperature: 0.7,
    modelOptions: { demo: { contextWindowTokens: DEFAULT_CONTEXT_WINDOW, multimodal: false } },
    createdAt: now,
    updatedAt: now
  }
  const workspace: Workspace = {
    id: DEFAULT_WORKSPACE_ID,
    name: '默认工作区',
    dir: defaultWorkspaceRoot(),
    createdAt: now,
    updatedAt: now
  }
  return {
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.defaultModel,
    temperature: profile.temperature,
    modelProfiles: [profile],
    defaultProfileId: profile.id,
    defaultCharacterId: 'nahida',
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    permission: { mode: 'approve' },
    memory: { ...DEFAULT_MEMORY_SETTINGS },
    summary: { ...DEFAULT_SUMMARY_SETTINGS },
    appearance: { ...DEFAULT_APPEARANCE }
  }
}

/**
 * 配置存储：userData/settings.json。
 * 写入走临时文件 + rename，避免半截 JSON 把配置写坏。
 * TODO(M2): apiKey 换成 Electron safeStorage 加密后再落盘。
 */
class SettingsStore {
  private cache: Settings | null = null

  private get file(): string {
    return join(app.getPath('userData'), 'settings.json')
  }

  get(): Settings {
    if (!this.cache) this.cache = this.load()
    return clone(this.cache)
  }

  save(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.get(), ...patch }
    // ── P2：chatTools 深合并（先读后并）──
    // 浅合并会让一次只传 { chatTools: { groupEnabled: false } } 时，
    // 把整个 chatTools 覆盖掉（用户之前勾的 enabled/tools 全丢）。
    // 这里把 patch.chatTools 与已存的 chatTools 逐字段合并，缺省字段不覆盖。
    //
    // 🔴 prev 必须从 this.get()（覆盖前的旧值）读：next.chatTools 此刻已经是 patch 里的新值。
    // 🔴 patch.chatTools.tools 可能是 undefined（只关总开关/群聊开关时），用 ?? {} 兜住。
    // 🔴 缺省字段一律保持 undefined，不许填 false —— groupEnabled 的缺省语义是「开」（M02），
    //    在这里填 false 会把默认开变成默认关，capability.ts 的 === false 判空会立刻出错。
    // 🔴 this.get() 返回 clone，prev 不是 cache 引用，改它不会污染缓存。
    if (patch.chatTools !== undefined) {
      const prev = this.get().chatTools ?? {}
      next.chatTools = {
        ...prev,
        ...patch.chatTools,
        tools: { ...(prev.tools ?? {}), ...(patch.chatTools.tools ?? {}) }
      }
    }
    next.temperature = clamp(next.temperature, TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max)
    next.permission = normalizePermission(next.permission)
    normalizeWorkspaces(next)
    next.memory = normalizeMemory(next.memory)
    next.summary = normalizeSummary(next.summary)
    next.appearance = normalizeAppearance(next.appearance)
    // 档案是唯一真源：任何整体保存都要重新归一化并把镜像字段对齐
    normalizeProfiles(next)
    next.defaultCharacterId = ensureCharacter(next.defaultCharacterId)
    this.cache = next
    this.flush(next)
    return clone(next)
  }

  listProfiles(): ModelProfileCatalog {
    const settings = this.get()
    return { profiles: settings.modelProfiles, defaultProfileId: settings.defaultProfileId }
  }

  /** 新建或更新一个档案；返回归一化后的完整目录。 */
  saveProfile(draft: ModelProfileDraft): ModelProfileCatalog {
    const settings = this.get()
    const normalized = normalizeDraft(draft)
    if (!normalized) throw new Error('档案配置不完整：需要服务商、地址、至少一个模型')

    const now = Date.now()
    const existing = draft.id ? settings.modelProfiles.find((item) => item.id === draft.id) : undefined

    if (existing) {
      // 同服务商 + 同地址 + 同默认模型只允许一条，避免下拉里出现无法区分的两行
      const duplicated = settings.modelProfiles.some(
        (item) => item.id !== existing.id && sameIdentity(item, normalized)
      )
      if (duplicated) throw new Error('已存在相同服务商与模型的档案')
      settings.modelProfiles = settings.modelProfiles.map((item) =>
        item.id === existing.id
          ? { ...normalized, id: existing.id, createdAt: existing.createdAt, updatedAt: now }
          : item
      )
    } else {
      if (settings.modelProfiles.some((item) => sameIdentity(item, normalized))) {
        throw new Error('已存在相同服务商与模型的档案')
      }
      const created: ModelProfile = {
        ...normalized,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now
      }
      settings.modelProfiles = [...settings.modelProfiles, created]
      if (!settings.defaultProfileId) settings.defaultProfileId = created.id
    }

    normalizeProfiles(settings)
    this.cache = settings
    this.flush(settings)
    return { profiles: clone(settings).modelProfiles, defaultProfileId: settings.defaultProfileId }
  }

  deleteProfile(id: string): ModelProfileCatalog {
    const settings = this.get()
    if (!settings.modelProfiles.some((item) => item.id === id)) {
      return { profiles: settings.modelProfiles, defaultProfileId: settings.defaultProfileId }
    }
    settings.modelProfiles = settings.modelProfiles.filter((item) => item.id !== id)
    if (settings.defaultProfileId === id) settings.defaultProfileId = settings.modelProfiles[0]?.id ?? null
    if (settings.modelProfiles.length === 0) {
      // 删光了就明确回到演示模式，别让镜像字段再把刚删掉的档案造回来
      settings.provider = 'mock'
      settings.baseUrl = ''
      settings.apiKey = ''
      settings.model = 'demo'
      settings.temperature = 0.7
      settings.defaultProfileId = null
      settings.modelProfiles = []
      this.cache = settings
      this.flush(settings)
      return { profiles: [], defaultProfileId: null }
    }
    normalizeProfiles(settings)
    this.cache = settings
    this.flush(settings)
    return { profiles: clone(settings).modelProfiles, defaultProfileId: settings.defaultProfileId }
  }

  setDefaultProfile(id: string): ModelProfileCatalog {
    const settings = this.get()
    if (!settings.modelProfiles.some((item) => item.id === id)) {
      throw new Error('档案不存在: ' + id)
    }
    settings.defaultProfileId = id
    normalizeProfiles(settings)
    this.cache = settings
    this.flush(settings)
    return { profiles: clone(settings).modelProfiles, defaultProfileId: settings.defaultProfileId }
  }

  listWorkspaces(): WorkspaceCatalog {
    const settings = this.get()
    return { workspaces: settings.workspaces, activeWorkspaceId: settings.activeWorkspaceId }
  }

  /** 新建或更新一个工作区；返回归一化后的完整清单。 */
  saveWorkspace(draft: WorkspaceDraft): WorkspaceCatalog {
    const settings = this.get()
    const rawDir = typeof draft.dir === 'string' ? draft.dir.trim() : ''
    if (!rawDir) throw new Error('工作区需要一个目录')
    const dir = normalizeDir(rawDir)
    if (!isDirectory(dir)) throw new Error('目录不存在或不是文件夹：' + dir)

    const now = Date.now()
    const existing = draft.id ? settings.workspaces.find((item) => item.id === draft.id) : undefined
    const name = (draft.name ?? '').trim() || workspaceLabel(dir)

    if (existing) {
      // 同一个目录只允许出现一次，否则侧栏会出现两条一模一样的行
      if (settings.workspaces.some((item) => item.id !== existing.id && item.dir === dir)) {
        throw new Error('这个目录已经是另一个工作区了')
      }
      settings.workspaces = settings.workspaces.map((item) =>
        item.id === existing.id ? { ...item, name, dir, updatedAt: now } : item
      )
    } else {
      if (settings.workspaces.some((item) => item.dir === dir)) {
        throw new Error('这个目录已经是另一个工作区了')
      }
      const created: Workspace = { id: randomUUID(), name, dir, createdAt: now, updatedAt: now }
      settings.workspaces = [...settings.workspaces, created]
      if (!settings.activeWorkspaceId) settings.activeWorkspaceId = created.id
      // 新建成功 = 用户不再处于「主动选空」状态（P6 §4.4）。
      // 不清这个标记的话，「删空 → 新建 → 再删空」的第二次删空会被当成「从没建过」，
      // 于是又自动补一个默认工作区，用户会再次看到「删不掉」。
      settings.workspaceOptOut = false
    }

    normalizeWorkspaces(settings)
    this.cache = settings
    this.flush(settings)
    return { workspaces: clone(settings).workspaces, activeWorkspaceId: settings.activeWorkspaceId }
  }

  /**
   * 删除工作区。
   *
   * 只要还剩至少一个，活动工作区顺位到第一条；**全删光时保持空**（P6 G1）。
   * 空清单不是「功能坏死」而是「用户显式选择的状态」：Agent 输入会在渲染层
   * 与 chatService.toolScopeOf 两侧被拦住，因此不会出现「空根乱撞」。
   *
   * 这里必须**显式 flush**：改动前 normalizeWorkspaces 全删光时会补一条默认工作区，
   * 落盘靠的是那次副作用；改成允许空之后它不再「补一条」，只改内存不落盘的话
   * 重启就复活（蓝图 §4.3，本 Phase 第二个隐蔽坑）。
   */
  deleteWorkspace(id: string): WorkspaceCatalog {
    const settings = this.get()
    const before = settings.workspaces.length
    settings.workspaces = settings.workspaces.filter((item) => item.id !== id)
    if (settings.workspaces.length === before) {
      return { workspaces: settings.workspaces, activeWorkspaceId: settings.activeWorkspaceId }
    }
    // 用户显式删了，就尊重「空」这个状态；以后不再自动补默认工作区。
    // 注意：只有删到 0 才置 true，删剩 1 个时置 false（这时不是「主动选空」）。
    settings.workspaceOptOut = settings.workspaces.length === 0
    if (settings.activeWorkspaceId === id) settings.activeWorkspaceId = null
    normalizeWorkspaces(settings)
    this.cache = settings
    this.flush(settings)
    return { workspaces: clone(settings).workspaces, activeWorkspaceId: settings.activeWorkspaceId }
  }

  setActiveWorkspace(id: string): WorkspaceCatalog {
    const settings = this.get()
    if (!settings.workspaces.some((item) => item.id === id)) {
      throw new Error('工作区不存在: ' + id)
    }
    settings.activeWorkspaceId = id
    this.cache = settings
    this.flush(settings)
    return { workspaces: clone(settings).workspaces, activeWorkspaceId: settings.activeWorkspaceId }
  }

  private load(): Settings {
    const base = defaultSettings()
    try {
      if (!existsSync(this.file)) return base
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      // 老配置（有 toolPolicy / workspaceRoots）会被 normalizePermission 迁移成新形态
      const merged: Settings = {
        ...base,
        ...parsed,
        permission: normalizePermission(
          (parsed as { permission?: LegacyPermissionSettings }).permission,
          parsed as LegacyPermissionFields
        ),
        memory: normalizeMemory(parsed.memory ?? base.memory),
        // 老配置没有这一段 → 补默认值。这是「升级即生效」的唯一入口。
        summary: normalizeSummary(parsed.summary ?? base.summary),
        appearance: normalizeAppearance(parsed.appearance ?? base.appearance)
      }
      // 工作区清单的迁移：单工作区时代只有一个 workspaceDir，把它变成清单第一条，
      // 用户原本选好的目录不能因为升级就丢掉。
      merged.workspaces = Array.isArray(parsed.workspaces)
        ? parsed.workspaces
        : legacyWorkspacesFrom(parsed as { permission?: LegacyPermissionSettings } & LegacyPermissionFields)
      merged.activeWorkspaceId =
        typeof parsed.activeWorkspaceId === 'string' ? parsed.activeWorkspaceId : null
      normalizeWorkspaces(merged)
      // 迁移完就把旧字段扔掉，别让它们一直躺在文件里误导后来的人
      delete (merged as unknown as LegacyPermissionFields).toolPolicy
      delete (merged as unknown as LegacyPermissionFields).workspaceRoots
      // M0 的配置只有扁平的 provider/baseUrl/apiKey/model：清掉默认档案，
      // 交给 normalizeProfiles 从旧的扁平字段现造一条，否则默认值会盖掉用户配置。
      merged.modelProfiles = Array.isArray(parsed.modelProfiles) ? parsed.modelProfiles : []
      merged.defaultProfileId = typeof parsed.defaultProfileId === 'string' ? parsed.defaultProfileId : null
      normalizeProfiles(merged)
      merged.defaultCharacterId = ensureCharacter(
        typeof parsed.defaultCharacterId === 'string' ? parsed.defaultCharacterId : base.defaultCharacterId
      )
      return merged
    } catch {
      return base
    }
  }

  private flush(value: Settings): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      console.error('[settings] 写入失败', error)
    }
  }
}

/**
 * 角色目录被删掉时回落到第一个可用角色，避免新会话拼不出提示词。
 * 读目录失败（权限、打包缺资源）时保留原值，绝不能因为提示词目录异常就把整份配置冲掉。
 */
function ensureCharacter(id: string | undefined): string {
  try {
    const library = promptStore.library()
    if (id && library.characters.some((item) => item.id === id)) return id
    return library.characters[0]?.id ?? id ?? 'nahida'
  } catch {
    return id ?? 'nahida'
  }
}

/** 当前对话应该用的档案：默认档案优先，取不到顺位第一个。 */
export function activeProfile(settings: Settings): ModelProfile | null {
  if (!settings.modelProfiles || settings.modelProfiles.length === 0) return null
  return (
    settings.modelProfiles.find((item) => item.id === settings.defaultProfileId) ??
    settings.modelProfiles[0]
  )
}

/**
 * 解析某个会话实际该用的档案与模型。
 *
 * 会话可以单独指定档案/模型（composer 下方那个选择器就是干这个的），
 * 指定值找不到时静默回落到默认档案——用户删了档案不该让老会话发不出消息。
 */
export function resolveProfile(
  settings: Settings,
  profileId?: string | null,
  modelId?: string | null
): { profile: ModelProfile | null; model: string } {
  const picked = profileId
    ? settings.modelProfiles.find((item) => item.id === profileId)
    : undefined
  const profile = picked ?? activeProfile(settings)
  if (!profile) return { profile: null, model: '' }
  const model = modelId && profile.models.includes(modelId) ? modelId : profile.defaultModel
  return { profile, model }
}

function sameIdentity(
  profile: { provider: ProviderId; baseUrl: string; defaultModel: string },
  draft: { provider: ProviderId; baseUrl: string; defaultModel: string }
): boolean {
  return (
    profile.provider === draft.provider &&
    profile.baseUrl.trim() === draft.baseUrl.trim() &&
    profile.defaultModel === draft.defaultModel
  )
}

function normalizeDraft(draft: ModelProfileDraft): Omit<ModelProfile, 'id' | 'createdAt' | 'updatedAt'> | null {
  const provider = isProviderId(draft.provider) ? draft.provider : 'openai-compatible'
  const models = [...new Set((draft.models ?? []).map((item) => item.trim()).filter(Boolean))]
  const defaultModel = (draft.defaultModel ?? '').trim() || models[0] || ''
  if (models.length === 0) return null
  if (!models.includes(defaultModel)) return null
  const baseUrl = (draft.baseUrl ?? '').trim()
  // 演示模式允许空地址；其余必须是 http(s)
  if (provider !== 'mock') {
    if (!baseUrl) return null
    try {
      const parsed = new URL(baseUrl)
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null
    } catch {
      return null
    }
  }
  const modelOptions: Record<string, ModelOptions> = {}
  for (const model of models) {
    const source = draft.modelOptions?.[model]
    modelOptions[model] = {
      contextWindowTokens: clampInt(
        source?.contextWindowTokens,
        CONTEXT_WINDOW_RANGE.min,
        CONTEXT_WINDOW_RANGE.max,
        DEFAULT_CONTEXT_WINDOW
      ),
      multimodal: typeof source?.multimodal === 'boolean' ? source.multimodal : false
    }
  }
  const name = (draft.name ?? '').trim() || providerMeta(provider).label
  return {
    name,
    provider,
    baseUrl,
    apiKey: (draft.apiKey ?? '').trim(),
    models,
    defaultModel,
    temperature: clamp(draft.temperature, TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max),
    modelOptions
  }
}

/**
 * 归一化档案列表：补缺字段、去重、保证 defaultProfileId 指向存在的档案，
 * 最后把旧的扁平字段（provider/baseUrl/apiKey/model/temperature）镜像成默认档案的值。
 * 对话适配器只读扁平字段，所以镜像必须始终有效。
 */
function normalizeProfiles(settings: Settings): ModelProfile[] {
  const input = Array.isArray(settings.modelProfiles) ? settings.modelProfiles : []
  const now = Date.now()
  const profiles: ModelProfile[] = []
  const seen = new Set<string>()

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const provider = isProviderId(raw.provider) ? raw.provider : 'openai-compatible'
    const models = [...new Set((Array.isArray(raw.models) ? raw.models : []).map((item) => String(item).trim()).filter(Boolean))]
    const fallbackModel = typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : ''
    if (models.length === 0 && fallbackModel) models.push(fallbackModel)
    if (models.length === 0) continue
    const defaultModel = models.includes(fallbackModel) ? fallbackModel : models[0]
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : randomUUID()

    const modelOptions: Record<string, ModelOptions> = {}
    for (const model of models) {
      const source = raw.modelOptions?.[model]
      modelOptions[model] = {
        contextWindowTokens: clampInt(
          source?.contextWindowTokens,
          CONTEXT_WINDOW_RANGE.min,
          CONTEXT_WINDOW_RANGE.max,
          DEFAULT_CONTEXT_WINDOW
        ),
        multimodal: typeof source?.multimodal === 'boolean' ? source.multimodal : false
      }
    }

    const identity = provider + '|' + String(raw.baseUrl ?? '').trim() + '|' + defaultModel
    if (seen.has(identity)) continue
    seen.add(identity)

    profiles.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : providerMeta(provider).label,
      provider,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      models,
      defaultModel,
      temperature: clamp(
        typeof raw.temperature === 'number' ? raw.temperature : settings.temperature,
        TEMPERATURE_RANGE.min,
        TEMPERATURE_RANGE.max
      ),
      modelOptions,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now
    })
  }

  // 完全没有档案（首次升级 / 空配置）时，用旧的扁平字段现造一条，保证对话永远有东西可用
  if (profiles.length === 0) {
    const provider = isProviderId(settings.provider) ? settings.provider : 'mock'
    const meta = providerMeta(provider)
    const model = provider === 'mock' ? 'demo' : (settings.model || '').trim() || 'demo'
    profiles.push({
      id: DEFAULT_PROFILE_ID,
      name: meta.label,
      provider,
      baseUrl: (settings.baseUrl || meta.defaultBaseUrl).trim(),
      apiKey: settings.apiKey ?? '',
      models: [model],
      defaultModel: model,
      temperature: clamp(settings.temperature, TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max),
      modelOptions: { [model]: { contextWindowTokens: DEFAULT_CONTEXT_WINDOW, multimodal: false } },
      createdAt: now,
      updatedAt: now
    })
  }

  const defaultProfile =
    profiles.find((item) => item.id === settings.defaultProfileId) ?? profiles[0]
  settings.modelProfiles = profiles
  settings.defaultProfileId = defaultProfile.id
  settings.provider = defaultProfile.provider
  settings.baseUrl = defaultProfile.baseUrl
  settings.apiKey = defaultProfile.apiKey
  settings.model = defaultProfile.defaultModel
  settings.temperature = defaultProfile.temperature
  return profiles
}

/** 旧版本配置里可能还留着的字段，只用于迁移，不再被任何代码读取。 */
interface LegacyPermissionFields {
  toolPolicy?: { byRisk?: Record<string, string>; byTool?: Record<string, string> }
  workspaceRoots?: string[]
}

/**
 * 单工作区时代的 permission 形状：mode + workspaceDir。
 * 现在 workspaceDir 已经搬到 Settings.workspaces，这里只用于把老值捡回来。
 */
interface LegacyPermissionSettings {
  mode?: PermissionMode
  workspaceDir?: string
}

/** 老配置里的单工作区目录，包成清单；什么都没配的时候返回空数组，交给 normalizeWorkspaces 兜底。 */
function legacyWorkspacesFrom(
  parsed: { permission?: LegacyPermissionSettings } & LegacyPermissionFields
): Workspace[] {
  const candidates: string[] = []
  if (typeof parsed.permission?.workspaceDir === 'string') candidates.push(parsed.permission.workspaceDir)
  if (Array.isArray(parsed.workspaceRoots)) {
    for (const item of parsed.workspaceRoots) if (typeof item === 'string') candidates.push(item)
  }
  const now = Date.now()
  const seen = new Set<string>()
  const list: Workspace[] = []
  for (const raw of candidates) {
    const dir = normalizeDir(raw)
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    list.push({ id: randomUUID(), name: workspaceLabel(dir), dir, createdAt: now, updatedAt: now })
  }
  return list
}

const PERMISSION_MODES: PermissionMode[] = ['full', 'readonly', 'approve']

/**
 * 权限配置归一化。
 *
 * 注意 workspaceDir 已经不在这里了：目录边界改由「会话绑定的工作区」决定
 * （见 resolveToolPath 的 ToolScope）。这里只保留模式，并且在迁移时把老的
 * workspaceDir 读出来交给 legacyWorkspacesFrom —— 顺序上必须由 load() 先迁移。
 *
 * 老配置没有 permission 字段，只有 toolPolicy（按风险分级）与 workspaceRoots（目录白名单）：
 * - 风险分级全是 allow，或只有 read 是 allow 但 write/network/exec 被 deny → readonly/full
 * - 其余一律落到最保守的 approve（宁可多问一句，也不能默默放行）
 */
function normalizePermission(
  input: LegacyPermissionSettings | undefined,
  legacy?: LegacyPermissionFields
): PermissionSettings {
  if (input && PERMISSION_MODES.includes(input.mode as PermissionMode)) {
    return { mode: input.mode as PermissionMode }
  }
  return { mode: inferModeFromLegacyPolicy(legacy?.toolPolicy) }
}

/**
 * 工作区清单归一化。
 *
 * 三条要求（P6 起第 1 条已修订，见 HUMAN 台账 H-27）：
 * 1. 空清单**是合法状态**，由 Settings.workspaceOptOut 区分「主动删空」与「从没建过」：
 *    从未删空 → 补一个默认工作区；显式删空 → 保持空，并在渲染层与主进程两侧拦住 Agent 输入；
 * 2. activeWorkspaceId 要么指向清单里真实存在的一条，要么是 null（空清单下就是 null）；
 * 3. 目录去重 —— 同一路径出现两次，侧栏会出现两行看起来一样的条目。
 *
 * 注意不校验目录是否存在：盘符可能临时掉线（U 盘、网络盘），
 * 那种时候应当照原样保留配置并在工具执行时报错，而不是悄悄删掉用户的工作区。
 */
function normalizeWorkspaces(settings: Settings): Workspace[] {
  const now = Date.now()
  const input = Array.isArray(settings.workspaces) ? settings.workspaces : []
  const list: Workspace[] = []
  const seen = new Set<string>()

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const rawDir = typeof raw.dir === 'string' ? raw.dir.trim() : ''
    if (!rawDir) continue
    const dir = normalizeDir(rawDir)
    if (seen.has(dir)) continue
    seen.add(dir)
    list.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID(),
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : workspaceLabel(dir),
      dir,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now
    })
  }

  // 空清单是否合法，取决于用户是否**显式**删空过（P6 G1 / 蓝图 §4.2）。
  // 只有「从没建过」才补默认；「建了又删空」必须保持空，否则删几次都会长回来。
  if (list.length === 0 && !settings.workspaceOptOut) {
    const dir = defaultWorkspaceRoot()
    list.push({ id: DEFAULT_WORKSPACE_ID, name: '默认工作区', dir, createdAt: now, updatedAt: now })
  }

  settings.workspaces = list
  // 硬要求 2 的修正版：activeWorkspaceId 要么指向清单里真实存在的一条，要么是 null。
  // 原写法是 active.id —— 空清单下 active 为 undefined，这里会直接抛 TypeError，
  // 而且只在「删到空」那一刻触发，平时测不出来（蓝图 §二 E2）。
  settings.activeWorkspaceId =
    list.find((item) => item.id === settings.activeWorkspaceId)?.id ?? list[0]?.id ?? null
  return list
}


function inferModeFromLegacyPolicy(policy: LegacyPermissionFields['toolPolicy']): PermissionMode {
  const byRisk = policy?.byRisk
  if (!byRisk) return 'approve'
  const risks = ['read', 'write', 'network', 'exec']
  if (risks.every((risk) => byRisk[risk] === 'allow')) return 'full'
  // 只读全放行、其余全拒绝 = 用户当时的意图就是"只能看"
  const readAllowed = byRisk.read === 'allow'
  const othersDenied = ['write', 'network', 'exec'].every((risk) => byRisk[risk] === 'deny')
  if (readAllowed && othersDenied) return 'readonly'
  return 'approve'
}

/** 记忆配置归一化：老配置文件没有这一段，必须补默认值而不是报错 */
function normalizeMemory(input: MemorySettings | undefined): MemorySettings {
  const base = DEFAULT_MEMORY_SETTINGS
  return {
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : base.enabled,
    autoExtract: typeof input?.autoExtract === 'boolean' ? input.autoExtract : base.autoExtract,
    topK: clampInt(input?.topK, MEMORY_TOP_K_RANGE.min, MEMORY_TOP_K_RANGE.max, base.topK),
    budgetTokens: clampInt(
      input?.budgetTokens,
      MEMORY_BUDGET_RANGE.min,
      MEMORY_BUDGET_RANGE.max,
      base.budgetTokens
    ),
    minScore: clamp(typeof input?.minScore === 'number' ? input.minScore : base.minScore, 0, 1)
  }
}

/**
 * 外观设置归一化。
 *
 * 为什么必须做：老配置（本字段不存在）读进来是 undefined，若不补默认值，
 * 渲染层读 settings.appearance.theme 会抛 TypeError；更隐蔽的是
 * —— 若不在这里归一化，save() 存进去的 appearance 会在下一次 save 时被
 * 「...this.get()」展开后原样保留（看似没事），但一旦上层传了非法值就永久写坏。
 * 范式照 normalizeMemory，逐字段给默认值、非法值一律落回默认。
 *
 * ★ 两个调用点缺一不可：get() 的合并路径（老配置 undefined）与 save() 的归一化
 *   （新写入的非法值）。只做一处会有具体后果，见 PHASE-1 §4.4。
 */
function normalizeAppearance(input: AppearanceSettings | undefined): AppearanceSettings {
  const base = DEFAULT_APPEARANCE
  const theme = input?.theme
  return {
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : base.theme
  }
}

/**
 * 对话摘要配置归一化。范式与 normalizeMemory 逐字一致：逐字段给默认值，
 * 非法值一律落回默认——设置文件是用户可手改的，不能信任。
 *
 * 🔴 两个调用点缺一不可（同 normalizeAppearance 的注释）：
 *    load() 的合并路径（老配置 undefined）与 save() 的归一化（用户写了非法值）。
 *    只做一处，前者会让老用户升级后读到 undefined 而崩，后者会让手改的字符串永久写坏。
 */
function normalizeSummary(input: SummarySettings | undefined): SummarySettings {
  const base = DEFAULT_SUMMARY_SETTINGS
  const int = (value: unknown, min: number, max: number, fallback: number): number =>
    clampSummaryInt(value, min, max, fallback)
  return {
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : base.enabled,
    triggerCount: int(
      input?.triggerCount,
      SUMMARY_TRIGGER_RANGE.min,
      SUMMARY_TRIGGER_RANGE.max,
      base.triggerCount
    ),
    windowCount: int(input?.windowCount, SUMMARY_WINDOW_RANGE.min, SUMMARY_WINDOW_RANGE.max, base.windowCount),
    shortTermMaxChars: int(
      input?.shortTermMaxChars,
      SUMMARY_CHARS_RANGE.min,
      SUMMARY_CHARS_RANGE.max,
      base.shortTermMaxChars
    ),
    longTermMaxChars: int(
      input?.longTermMaxChars,
      SUMMARY_CHARS_RANGE.min,
      SUMMARY_CHARS_RANGE.max,
      base.longTermMaxChars
    ),
    userInfoMaxChars: int(
      input?.userInfoMaxChars,
      SUMMARY_CHARS_RANGE.min,
      SUMMARY_CHARS_RANGE.max,
      base.userInfoMaxChars
    ),
    promisesMaxChars: int(
      input?.promisesMaxChars,
      SUMMARY_CHARS_RANGE.min,
      SUMMARY_CHARS_RANGE.max,
      base.promisesMaxChars
    )
  }
}

/**
 * 摘要配置专用的整数归一化，**不复用上面的 clampInt**。
 *
 * 🔴 差别只有一个但会出事：`Number(null) === 0`、`Number('') === 0`。
 *    这两个值在摘要里都是**合法值**（0 = 不截断 / 不保留），
 *    于是「字段没填」会被当成「用户想填 0」，语义正好反了——
 *    实测：手改成 `{"userInfoMaxChars": null}` 后，画像上限静默变成「不截断」。
 *    所以这里只认「数字」与「非空数字串」，其余（null / '' / 布尔 / 对象）一律落回默认。
 *
 * 没有改共享的 clampInt：它还被 normalizeMemory 用着，改它等于顺手动到 RAG 的归一化。
 */
function clampSummaryInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function clone(value: Settings): Settings {
  return {
    ...value,
    modelProfiles: value.modelProfiles.map((profile) => ({
      ...profile,
      models: [...profile.models],
      modelOptions: Object.fromEntries(
        Object.entries(profile.modelOptions).map(([key, option]) => [key, { ...option }])
      )
    })),
    workspaces: value.workspaces.map((workspace) => ({ ...workspace })),
    permission: { ...value.permission },
    memory: { ...value.memory },
    summary: { ...value.summary },
    appearance: { ...value.appearance }
  }
}

export const settingsStore = new SettingsStore()
