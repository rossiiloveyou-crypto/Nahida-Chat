/**
 * 主进程 / 预加载 / 渲染进程共用的数据契约。
 * 任何跨进程传递的结构都先在这里定义，避免三端各写一份。
 */
import type { ToolApprovalTicket, ToolCallRecord } from './tools'

export type MessageRole = 'system' | 'user' | 'assistant'

export type MessageStatus = 'streaming' | 'done' | 'error'

export interface Message {
  id: string
  role: MessageRole
  content: string
  createdAt: number
  status: MessageStatus
  /** 该条助手消息发起过的工具调用（含状态与结果） */
  toolCalls?: ToolCallRecord[]
}

/** 会话模式：chat = 纯对话（不提供工具），agent = 可调用工具完成任务 */
export type ConversationMode = 'chat' | 'agent'

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  /** 这段会话用哪个角色的提示词（Prompt/characters/<id>/） */
  characterId: string
  /** chat / agent，决定注入哪份风格提示词以及是否开放工具 */
  mode: ConversationMode
  /** 本会话绑定哪个工作区（Settings.workspaces 里的 id）；null/缺省 = 用当前活动工作区 */
  workspaceId?: string | null
  /** 本会话指定用哪个档案；null/缺省 = 跟随默认档案 */
  modelProfileId?: string | null
  /** 本会话指定用哪个模型；null/缺省 = 用档案的 defaultModel */
  modelId?: string | null
}

export type ProviderId = 'mock' | 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama'

/** 单个模型在档案里的展示配置（不参与请求，只影响界面提示） */
export interface ModelOptions {
  /** 上下文窗口，单位 token；用于界面展示与将来的裁剪判断 */
  contextWindowTokens: number
  /** 是否支持图片输入 */
  multimodal: boolean
}

/**
 * 一套模型档案：服务商 + 地址 + 凭据 + 可切换的模型清单。
 * 对话默认使用「默认档案」的 defaultModel；单个会话可以临时切到别的档案/模型，
 * 切换结果写在 Session.modelProfileId / modelId 上，不改档案本身。
 */
export interface ModelProfile {
  id: string
  /** 档案名，用户可改；留空时回落到服务商名 */
  name: string
  provider: ProviderId
  baseUrl: string
  apiKey: string
  /** 档案内可选模型，至少一个 */
  models: string[]
  /** 默认模型，必须存在于 models 中 */
  defaultModel: string
  /** 采样温度，0 ~ 2 */
  temperature: number
  /** 每个模型的展示配置，键为模型 ID */
  modelOptions: Record<string, ModelOptions>
  createdAt: number
  updatedAt: number
}

/** 新建 / 编辑档案时提交的草稿，id 缺省表示新建 */
export interface ModelProfileDraft {
  id?: string
  name: string
  provider: ProviderId
  baseUrl: string
  apiKey: string
  models: string[]
  defaultModel: string
  temperature: number
  modelOptions: Record<string, ModelOptions>
}

/** 档案列表 + 当前默认档案 */
export interface ModelProfileCatalog {
  profiles: ModelProfile[]
  defaultProfileId: string | null
}

/** 连接测试入参：直接传草稿，不要求先落盘 */
export interface ModelTestRequest {
  provider: ProviderId
  baseUrl: string
  apiKey: string
  model: string
}

export interface ModelTestResult {
  ok: boolean
  latencyMs: number
  error: string | null
  /** 模型回包的片段，便于确认真的连通了 */
  sample: string | null
}

/** 「获取可用模型」入参：同样直接传草稿，不要求先落盘 */
export interface ModelDiscoveryRequest {
  provider: ProviderId
  baseUrl: string
  apiKey: string
}

/** 服务商报回来的一个可选模型 */
export interface DiscoveredModel {
  /** 真实模型 ID，配置与请求都用它 */
  id: string
  /** 展示名；服务商没给就为 null，界面回落到 id */
  name: string | null
  /** 服务商公布的上文窗口；没给就为 null */
  contextWindowTokens: number | null
  /** 服务商公布是否支持图片输入；没给就为 null */
  multimodal: boolean | null
}

export interface ModelDiscoveryResult {
  ok: boolean
  latencyMs: number
  error: string | null
  models: DiscoveredModel[]
}

/** 主题模式：light 浅色 / dark 深色 / system 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * 外观设置。
 *
 * 为什么只有 theme 一个字段：字号是独立能力（另一套令牌 + 另一套判据），
 * 混进来会让本次出图验收无法归因，见 PHASE-1 §一 非目标。
 */
export interface AppearanceSettings {
  theme: ThemeMode
}

export interface Settings {
  /** 模型来源；mock = 本地离线回显，用于验证链路。始终镜像默认档案。 */
  provider: ProviderId
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  /** 模型档案列表；直接读写请走 modelProfile 相关 IPC，保证镜像字段同步 */
  modelProfiles: ModelProfile[]
  /** 默认档案 ID；对话使用它的服务商、地址与默认模型 */
  defaultProfileId: string | null
  /** 新会话默认使用哪个角色（Prompt/characters/<id>/） */
  defaultCharacterId: string
  /** 工作区清单：每个会话绑定其中一个，文件类工具落在它的目录里 */
  workspaces: Workspace[]
  /** 当前活动工作区（新建会话默认绑定它）；清单为空时是 null */
  activeWorkspaceId: string | null
  /**
   * 用户是否**显式**清空过工作区清单（P6 G1）。
   *
   * 首次启动仍然给一个默认工作区（对新人友好）；只有用户主动删空之后才保持空。
   * 没有这个标记就分不清「从没建过」和「建了又删空」—— 两者在磁盘上都表现为空数组，
   * 于是 normalizeWorkspaces 只能二选一，而它原来选的是「一律补一条」，
   * 表现就是「删了又长回来」。
   *
   * 缺省（老配置 / undefined）= 从未显式删空 = 沿用旧行为（补默认工作区），升级无损。
   */
  workspaceOptOut?: boolean
  /** 工具权限模式 */
  permission: PermissionSettings
  /** 长期记忆检索（RAG）配置 */
  memory: MemorySettings
  /** 主题偏好。缺省（老配置）时按 DEFAULT_APPEARANCE 补齐，见 normalizeAppearance */
  appearance: AppearanceSettings
}

/**
 * 一个工作区 = 一个目录。
 *
 * 和旧版"全局只配一个 workspaceDir"的区别：工作区是**清单**，
 * 每个会话绑定其中一个（Session.workspaceId），侧栏把它们并列展示。
 * 工具的文件边界来自「当前会话绑定的工作区」，不再来自全局设置。
 */
export interface Workspace {
  id: string
  /** 展示名，用户可改；留空时回落到目录名 */
  name: string
  /** 绝对目录路径 */
  dir: string
  createdAt: number
  updatedAt: number
}

/** 工作区清单 + 当前活动工作区（新建会话默认绑定它） */
export interface WorkspaceCatalog {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

/** 新建 / 编辑工作区时提交的草稿 */
export interface WorkspaceDraft {
  id?: string
  name: string
  dir: string
}

/**
 * 工具权限模式。三种互斥姿态，取代原来的「按风险分级 + 目录白名单」。
 *
 * - full     完全访问：所有工具直接执行，文件工具不受目录限制
 * - readonly 只读：只有读取类工具能跑，写入/执行一律拒绝
 * - approve  审批：读取类直接跑，写入/执行要用户点确认
 */
export type PermissionMode = 'full' | 'readonly' | 'approve'

export interface PermissionSettings {
  mode: PermissionMode
}

/**
 * 一次工具执行的实际边界：权限模式 + 目录根。
 *
 * 目录根来自会话绑定的工作区（见 chatService.workspaceRootOf），
 * 所以同一个应用里不同会话可以落在不同目录，而权限模式仍是全局一份。
 */
export interface ToolScope {
  mode: PermissionMode
  root: string
}

/** 记忆检索的总开关与参数。改这里 = 改行为，不需要重启。 */
export interface MemorySettings {
  /** 总开关：关掉后既不写入也不召回，对话完全不受影响 */
  enabled: boolean
  /** 对话结束后是否自动从用户消息里提炼长期记忆 */
  autoExtract: boolean
  /** 每次召回注入的最大条数 */
  topK: number
  /** 注入内容的 token 预算上限（按字符数估算，1 汉字≈1 token） */
  budgetTokens: number
  /** 召回分数下限，低于此值宁可什么都不注入 */
  minScore: number
}

/** 一条长期记忆。sourceMessageId 用于在界面上溯源到原始对话。 */
export interface MemoryEntry {
  id: string
  /** 记忆正文，一句话事实 */
  content: string
  /** 来自哪个会话 / 哪条消息；用户手动添加时为空 */
  sourceSessionId: string | null
  sourceMessageId: string | null
  /** 重要度权重，召回时乘算；用户置顶 = 高权重 */
  weight: number
  createdAt: number
  lastHitAt: number | null
  hitCount: number
  /**
   * 所属记忆域（P5）：zone:root / zone:<zoneId> / solo:<externalKey>。
   * 可选 + 读时回落 root —— 旧数据与旧构造点都不用改（A43：三端共用类型只做加法）。
   */
  scopeId?: string
}

/** 记忆库状态，设置页用来展示"模型装没装、库有多大" */
export interface MemoryStatus {
  enabled: boolean
  /** embedding 模型是否可用 */
  modelReady: boolean
  modelId: string
  dimensions: number
  /** 模型目录绝对路径，装不上时告诉用户放哪 */
  modelPath: string
  entryCount: number
  /** 数据库文件路径 */
  dbPath: string
  /** 最近一次错误，正常时为 null */
  lastError: string | null
}

/** 新建 / 编辑一条记忆 */
export interface MemoryDraft {
  id?: string
  content: string
  weight?: number
}

/** 召回结果（调试用：让用户看到"她为什么记得"） */
export interface MemoryRecallHit {
  id: string
  content: string
  score: number
  vectorScore: number
  keywordScore: number
}

/** 提示词库里的一个文件（只描述路径，不回传正文） */
export interface PromptCharFile {
  id: string
  label: string
  relativePath: string
  exists: boolean
}

/** 一个角色 = Prompt/characters/ 下的一个文件夹 */
export interface PromptCharacter {
  id: string
  name: string
  files: PromptCharFile[]
  /** soul 文件是否存在；缺了就不算一个可用角色 */
  complete: boolean
}

/** Prompt/shared/ 下的全局文件；scope 说明它进哪几种模式 */
export interface PromptSharedFile {
  id: string
  label: string
  relativePath: string
  exists: boolean
  /** both = 所有模式；agent = 仅 Agent 模式（有工具才有工具纪律） */
  scope: 'both' | 'agent'
}

export interface PromptLibrary {
  /** Prompt/ 的绝对路径，设置页用来展示"改哪个文件" */
  root: string
  exists: boolean
  characters: PromptCharacter[]
  /** 顺序即注入顺序 */
  sharedFiles: PromptSharedFile[]
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userDataPath: string
  promptRoot: string
}

export interface SendInput {
  sessionId: string
  content: string
  /**
   * P9-R3：渠道消息的发言人（QQ 号）。桌面会话不传。
   *
   * ⚠️ 它**不是**权限判定入口 —— 工具闸门读的是 `ChatSink.senderId`
   * （那个由 bridge 在造 QqSink 时带上）。这里保留字段是为了让将来
   * 别的无窗口调用方（重放工具、CLI）也能标注发言人，不必另开一条契约。
   */
  senderId?: string
}

/** 新建会话时可选带入的初始设置 */
export interface CreateSessionInput {
  mode?: ConversationMode
  characterId?: string
  /** 绑定到哪个工作区；null/缺省 = 当前活动工作区 */
  workspaceId?: string | null
  modelProfileId?: string | null
  modelId?: string | null
  /**
   * P6：指定会话 id。**只给「渠道会话」用**（chatService.ensureChannelSession）。
   * 桌面新建会话仍然走 randomUUID()；IPC 的 chat:create 不透传它。
   */
  id?: string
  /** P6：指定标题。只给「渠道会话」用（标题来自白名单 label） */
  title?: string
}

export interface UpdateSessionInput {
  mode?: ConversationMode
  characterId?: string
  /** 换绑工作区；null 表示回到「跟随活动工作区」 */
  workspaceId?: string | null
  /** 传 null 表示回到「跟随默认档案」 */
  modelProfileId?: string | null
  /** 传 null 表示用档案的 defaultModel */
  modelId?: string | null
}

/** 主进程 -> 渲染进程 的流式事件载荷 */
export interface ChatDelta {
  sessionId: string
  messageId: string
  delta: string
}

export interface ChatDone {
  sessionId: string
  messageId: string
  content: string
  toolCalls: ToolCallRecord[]
}

export interface ChatFailure {
  sessionId: string
  messageId: string
  message: string
}

export interface ChatToolUpdate {
  sessionId: string
  messageId: string
  calls: ToolCallRecord[]
}

export type ChatApproval = ToolApprovalTicket

export interface SendResult {
  userMessage: Message
  assistantMessage: Message
}
