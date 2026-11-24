import type {
  AppInfo,
  ConversationMode,
  CreateSessionInput,
  UpdateSessionInput,
  ChatApproval,
  ChatDelta,
  ChatDone,
  ChatFailure,
  ChatReasoning,
  ChatToolUpdate,
  MemoryDraft,
  MemoryEntry,
  MemoryRecallHit,
  MemoryStatus,
  StoryRecallStatus,
  PersonaHistoryEntry,
  Message,
  ModelDiscoveryRequest,
  ModelDiscoveryResult,
  ModelProfileCatalog,
  ModelProfileDraft,
  ModelTestRequest,
  ModelTestResult,
  PromptLibrary,
  SendInput,
  SendResult,
  Session,
  Settings,
  SummaryStatus,
  WorkspaceCatalog,
  WorkspaceDraft
} from './types'
import type { ImportPreview, ImportRequest, ExportRequest, TransferResult } from './transfer'
import type { ToolApprovalReply, ToolDefinition } from './tools'
import type { StRegexScript } from './regex'
import type { BridgeConfig, BridgeHealth, BridgeOverrideState } from './bridge'
import type { QqEventFeedItem, QqSettings, QqStatusPayload } from './qq'
import type { ChannelStatusPayload } from './channels'
import type { ChannelAccount, ChannelAccessConfig, ChannelGroup } from './channelAccess'
import type { ObserveConversation, ObserveRecord, ObserveStatus } from './observe'
import type { QqHostStatus, QqProcessSnapshot } from './qqHost'
import type { MemoryModelProgress } from './types'
import type {
  DuplicateKeyword,
  WorldbookDirInfo,
  WorldbookEntryDraft,
  WorldbookListing
} from './worldbook'
import type {
  StoryBranch,
  StoryBranchesFile,
  StoryBranchItem,
  StoryDeleteResult,
  StoryDeriveDraft,
  StoryDraft,
  StoryMeta,
  StoryMetaPatch,
  StorySearchHit,
  StorySummary
} from './story'

/** 请求回复不携带新消息，待回复内容来自会话尾部历史。 */
export interface RequestReplyInput {
  sessionId: string
}

export interface MemoryUserRow {
  userId: string
  label: string
  inAllowList: boolean
  personaCount: number
  memoryCount: number
  historyCount: number
  lastAt: number
}

export interface MemoryPersonaRow {
  personaId: string
  isActive: boolean
  memoryCount: number
  historyCount: number
  createdAt: number
}

export interface MemoryUserDetail {
  userId: string
  label: string
  inAllowList: boolean
  personas: MemoryPersonaRow[]
  sessions: Array<{ sessionId: string; title: string; updatedAt: number }>
  dbPath: string
  userDataPath: string
}

/**
 * P7：「清空全部数据」的清单项。willDelete 每一条都必须能在 `wipeAllData` 里找到对应动作 ——
 * 少一项是漏删，多一项是误删（判据 WP-01…WP-11 逐项比对）。
 */
export interface WipePreviewItem {
  path: string
  detail: string
  bytes: number
}

export interface WipeKeepItem {
  path: string
  why: string
}

export interface WipePreview {
  willDelete: WipePreviewItem[]
  willKeep: WipeKeepItem[]
}

/** 一次性验证码（M15/M16）。code 由**主进程**生成并校验，渲染层只负责显示 */
export interface WipeCaptcha {
  /** 8 位小写 hex */
  code: string
  /** 过期毫秒数（防「开了框去泡茶」） */
  ttlMs: number
}

/** 清空后的报告（与 main/features/wipe 的 WipeReport 同形） */
export interface WipeReport {
  sessions: number
  memories: number
  histories: number
  personas: number
  summaries: number
  stories: number
  backupDir: string
  ok: boolean
  detail: string
}

export type WipeFailReason = 'no_captcha' | 'expired' | 'wrong' | 'too_many_failures' | 'failed'

export interface WipeExecuteResult {
  ok: boolean
  reason?: WipeFailReason
  report?: WipeReport
}

export interface MemoryDeleteReport {
  userId: string
  personaId: string | null
  memories: number
  histories: number
  personas: number
  summaries: number
  sessions: number
  stillAuthorized: boolean
}

type Unsubscribe = () => void

/**
 * 预加载层通过 contextBridge 暴露到 window.nahida 的唯一接口面。
 * 渲染进程只能从这里拿能力，拿不到 Node / ipcRenderer 本体。
 */
export interface NahidaApi {
  transfer: {
    pickImport: () => Promise<ImportPreview | null>
    import: (request: ImportRequest) => Promise<TransferResult>
    export: (request: ExportRequest) => Promise<TransferResult>
  }
  /**
   * 主进程注入的初始主题（**同步值，非 Promise**）。
   *
   * 渲染层必须在 createRoot 之前决定 <html data-theme>，异步拿会造成
   * "先画浅色一帧再变深色"——就是要治的白闪（PHASE-1 D5）。
   */
  readonly initialTheme: 'light' | 'dark'
  app: {
    info: () => Promise<AppInfo>
  }
  settings: {
    get: () => Promise<Settings>
    save: (patch: Partial<Settings>) => Promise<Settings>
  }
  /** 模型档案：增删改查 + 默认档案 + 连接测试 */
  modelProfiles: {
    list: () => Promise<ModelProfileCatalog>
    save: (draft: ModelProfileDraft) => Promise<ModelProfileCatalog>
    remove: (id: string) => Promise<ModelProfileCatalog>
    setDefault: (id: string) => Promise<ModelProfileCatalog>
    test: (request: ModelTestRequest) => Promise<ModelTestResult>
    /** 向服务商要一份可用模型清单，供用户勾选 */
    discover: (request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>
  }
  /** 提示词库：只拿目录结构，正文由用户直接改文件 */
  prompts: {
    library: () => Promise<PromptLibrary>
    /** 用系统文件管理器打开 Prompt/ 根目录，返回空串表示成功 */
    openLibrary: () => Promise<string>
    /** 打开 userData/prompt/characters，返回空串表示成功。 */
    openUserRoot: () => Promise<string>
    openCharacter: (characterId: string) => Promise<string>
  }
  tools: {
    list: () => Promise<ToolDefinition[]>
    respond: (reply: ToolApprovalReply) => Promise<void>
  }
  /**
   * 显示层正则（P3）：取 ST 的 `regex_scripts` 清单。
   *
   * 🔴 读盘失败返回**空数组**（不是 reject）：显示层坏掉不能连累聊天，
   *    渲染层拿到空数组就退化成「只做 markdown」。
   */
  regex: {
    listScripts: (request?: { stDir?: string }) => Promise<StRegexScript[]>
    scriptsState: (request?: { stDir?: string; refresh?: boolean }) => Promise<import('./types').DisplayScriptsState>
  }
  /**
   * ST 桥接：健康度、进程与日志。生成仍只从 chatService 的路由发起。
   * 运行配置由主进程 host 校验并保存，故事开关仍在 Settings.bridge.enabled。
   */
  bridge: {
    health: () => Promise<BridgeHealth>
    /** 打开进程与可见窗口；不强制模型连通。可配置 stRoot / port / nodePath。 */
    openSt: (config?: Partial<BridgeConfig>) => Promise<BridgeHealth>
    stopSt: () => Promise<BridgeHealth>
    openLog: () => Promise<void>
    /** 默认空；仅故事桥接每轮注入。清空并保存后停止注入。 */
    override: {
      get: () => Promise<BridgeOverrideState>
      save: (text: string) => Promise<BridgeOverrideState>
    }
  }
  /**
   * 工作区清单（多工作区）。
   *
   * 每个会话绑定其中一个，文件类工具的路径闸以它为根。
   * 系统文件选择对话框只在主进程调（渲染进程没有 Node 能力）。
   */
  workspaces: {
    list: () => Promise<WorkspaceCatalog>
    save: (draft: WorkspaceDraft) => Promise<WorkspaceCatalog>
    remove: (id: string) => Promise<WorkspaceCatalog>
    setActive: (id: string) => Promise<WorkspaceCatalog>
    /** 弹系统目录选择框；用户取消返回空串 */
    pickDirectory: () => Promise<string>
    /** 用系统文件管理器打开某个工作区目录，返回空串表示成功 */
    open: (id: string) => Promise<string>
  }
  /** 长期记忆：状态、增删改、检索调试 */
  memory: {
    status: () => Promise<MemoryStatus>
    list: () => Promise<MemoryEntry[]>
    save: (draft: MemoryDraft) => Promise<MemoryEntry[]>
    remove: (id: string) => Promise<MemoryEntry[]>
    clear: () => Promise<MemoryEntry[]>
    /** 用一段文本试召回，界面能看到每条命中的分数 */
    recall: (query: string) => Promise<MemoryRecallHit[]>
    /** 打开模型目录，让用户知道该往哪放文件 */
    openModelDir: () => Promise<string>
    /** 一键下载并配置向量模型（userData/models），装完自动生效 */
    downloadModel: () => Promise<{ ok: boolean; dir?: string; error?: string; status: MemoryStatus }>
    /** 订阅下载进度；返回取消订阅函数 */
    onModelProgress: (handler: (progress: MemoryModelProgress) => void) => () => void
    users: () => Promise<MemoryUserRow[]>
    userDetail: (userId: string) => Promise<MemoryUserDetail>
    userEntries: (userId: string, personaId: string) => Promise<{ entries: MemoryEntry[]; history: PersonaHistoryEntry[] }>
    deleteUser: (userId: string) => Promise<MemoryDeleteReport>
    deletePersona: (userId: string, personaId: string) => Promise<MemoryDeleteReport>
    openDir: () => Promise<string>
  }
  /**
   * 对话摘要（窗口外对话的滚动压缩）。
   *
   * 🔴 与 `memory` 不是一回事：memory 是「按 query 检索事实」的 RAG 库，
   * summary 是「把对话压成四段文本、无条件注入」的窗口。配置在 Settings.summary。
   */
  summary: {
    /** 整体状态：有多少会话已有摘要、多少条消息被覆盖、数据文件在哪 */
    status: () => Promise<SummaryStatus>
    /** 忘掉某条会话的摘要（下一次请求会回落全量历史） */
    forget: (sessionId: string) => Promise<SummaryStatus>
    /** 清空全部摘要（只删摘要，不动聊天记录与 RAG 记忆） */
    clear: () => Promise<SummaryStatus>
  }
  /**
   * 清空全部数据（P7）。**不可撤销** —— 唯一的安全网是执行前自动做的备份。
   *
   * 🔴 三步分开是有意的：preview 只列清单（用户先看清删什么/留什么），
   *    captcha 才生成一次性码（M15：点「我明白」之后才生成），execute 带码执行。
   * 🔴 执行成功 → 主进程在把报告回给渲染层之后**立即重启**（M14）。
   */
  wipe: {
    /** 要删什么 / 要留什么（含各自字节数），不生成码 */
    preview: () => Promise<WipePreview>
    /** 生成一次性 8 位 hex 码；每次调用都换新码并清零失败计数 */
    captcha: () => Promise<WipeCaptcha>
    /** 带码执行；reason 只有 no_captcha / expired / wrong / too_many_failures / failed */
    execute: (code: string) => Promise<WipeExecuteResult>
  }
  chat: {
    listSessions: () => Promise<Session[]>
    createSession: (input?: CreateSessionInput) => Promise<Session>
    updateSession: (id: string, patch: UpdateSessionInput) => Promise<Session>
    deleteSession: (id: string) => Promise<void>
    send: (input: SendInput) => Promise<SendResult>
    queueMessage: (input: SendInput) => Promise<Message>
    requestReply: (input: RequestReplyInput) => Promise<Message>
    /** 故事区旁白：只追加一条旁白消息并落盘，不调用模型；下次 send 时作为 system 下发 */
    narrate: (sessionId: string, content: string) => Promise<Message>
    stop: (sessionId: string) => Promise<void>
    /**
     * 重试最后一条回复：清空它的正文与思考后重跑一轮，**不新增用户消息**。
     * 返回那条 assistant 消息的重置态（渲染层据此先清气泡，增量随后到达）。
     */
    retry: (sessionId: string, messageId: string) => Promise<Message>
    /** 逐字保存用户/旁白正文，不启动生成。 */
    update: (sessionId: string, messageId: string, content: string) => Promise<Message>
    /** 原子保存并截断后续历史，返回新 assistant 占位。 */
    resend: (sessionId: string, messageId: string, content: string) => Promise<Message>
    /** 删除一条消息（正在生成时拒绝） */
    deleteMessage: (sessionId: string, messageId: string) => Promise<void>
    onDelta: (handler: (payload: ChatDelta) => void) => Unsubscribe
    /** 思考增量（DeepSeek reasoning_content / Anthropic thinking / Gemini thought） */
    onReasoning: (handler: (payload: ChatReasoning) => void) => Unsubscribe
    onTool: (handler: (payload: ChatToolUpdate) => void) => Unsubscribe
    onApproval: (handler: (payload: ChatApproval) => void) => Unsubscribe
    onDone: (handler: (payload: ChatDone) => void) => Unsubscribe
    onError: (handler: (payload: ChatFailure) => void) => Unsubscribe
  }
  /**
   * QQ 接入（P4）。
   *
   * 进程列表只读，**绝不自动注入**（M2）：注入必须由用户点选具体 PID。
   * P6：绑定表已下线 —— 谁能响应由 `channels`（userData/channels/access.json）决定。
   */
  qq: {
    status: () => Promise<QqStatusPayload>
    processes: () => Promise<QqProcessSnapshot[]>
    load: (pid: number) => Promise<QqProcessSnapshot>
    unload: (pid: number) => Promise<QqProcessSnapshot>
    /** 宿主 degraded 时的手动重启（不会注入任何 QQ 进程） */
    restart: () => Promise<QqHostStatus>
    getSettings: () => Promise<QqSettings>
    saveSettings: (patch: Partial<QqSettings>) => Promise<QqSettings>
    logs: (limit?: number) => Promise<{ level: string; line: string }[]>
    /** 主进程推送的「最近事件」（判定结果），返回退订函数 */
    onEvent: (handler: (payload: QqEventFeedItem) => void) => Unsubscribe
  }
  /**
   * 渠道授权（P6 → **P9-R3 v2：按「人」授权**）。
   *
   * 真源：`userData/channels/access.json`，用户可以直接手改（每次读盘，没有缓存）。
   * 判定主体是**发言人 QQ 号**，不是会话 —— 见 shared/channelAccess.ts。
   */
  channels: {
    /** 整份配置：账号 + 群 + 两个总开关 + 已知机器人号 */
    config: () => Promise<ChannelAccessConfig>
    /** 改两个总开关（groupMemberGate 默认关 / toolGate 默认开） */
    setGates: (patch: { groupMemberGate?: boolean; toolGate?: boolean }) => Promise<ChannelAccessConfig>
    /** 增改一个账号（权限是部分更新） */
    saveAccount: (draft: {
      userId: string
      label?: string
      permissions?: Partial<ChannelAccount['permissions']>
    }) => Promise<ChannelAccessConfig>
    removeAccount: (userId: string) => Promise<boolean>
    /** 增改一个群 */
    saveGroup: (draft: { chatId: string; label?: string }) => Promise<ChannelAccessConfig>
    removeGroup: (chatId: string) => Promise<boolean>
    /** 记一个机器人登录号（面板识别到已注入进程时调；不参与授权） */
    rememberUin: (uin: string) => Promise<ChannelAccessConfig>
    /** 白名单在会话维度上的投影（只读展示：会话键 / 群号 / 备注 / 权限位） */
    sessions: () => Promise<Array<{
      key: string
      uin: string
      chatType: 'private' | 'group'
      chatId: string
      label: string
      lastAt: number
      permissions: { respond: boolean; tool: boolean }
    }>>
    /** 数据目录 / 文件路径 / 计数（面板的「数据在哪」） */
    status: () => Promise<ChannelStatusPayload>
  }
  /**
   * 旁听库（P8）—— 群语料。**只增不清**，程序没有任何删除路径。
   *
   * 采集口径（2026-11-01「P8 就是群语料」）：群聊全采（不看白名单），私聊只采放行的。
   * 旁听内容不进 memory.db，当前也不参与任何 prompt —— 它是原料，不是行为。
   */
  /**
   * 世界书编写器（P9 / M26）。
   *
   * 🔴 target 可以是**目录**或**单个任意名 .md 文件**（`list` 自动判别）。
   * 🔴 `duplicates` 只提醒、不阻断（用户明确「不限制写入，仅作提醒」）—— 它没有写副作用。
   * 🔴 写操作只允许 worldbook 目录内的 `.md`；`README.md` 与越界路径一律在主进程抛。
   */
  worldbook: {
    /** 已知世界书目录：各角色的 worldbook + 各故事区配了的剧本世界书 */
    knownDirs: () => Promise<WorldbookDirInfo[]>
    /** 列条目（目录聚合 / 单文件）；只提取合规段落 */
    list: (target: string) => Promise<WorldbookListing>
    /** 新增条目：自动生成 32 位 id 写入目标 md */
    add: (dir: string, file: string, draft: WorldbookEntryDraft) => Promise<WorldbookListing>
    /**
     * 编辑条目：只重写目标块，其余字节逐字不变。
     * 🔴 fallbackTitle 只服务「合规但缺 id」的条目（没有句柄）—— 它保存时会补发一个新 id。
     */
    update: (
      dir: string,
      file: string,
      id: string,
      draft: WorldbookEntryDraft,
      fallbackTitle?: string
    ) => Promise<WorldbookListing>
    /** 删除条目：整段删除，其余字节逐字不变；fallbackTitle 同上 */
    remove: (dir: string, file: string, id: string, fallbackTitle?: string) => Promise<WorldbookListing>
    /** 新建世界书（目录 + README.md + world.md） */
    create: (dir: string) => Promise<WorldbookListing>
    /** 弹系统目录选择框；取消返回空串 */
    pickDir: () => Promise<string>
    /** 弹系统文件选择框（.md）；取消返回空串 */
    pickFile: () => Promise<string>
    /** 同文件内重复触发词（仅提示） */
    duplicates: (
      dir: string,
      file: string,
      keywords: string[],
      excludeId?: string
    ) => Promise<DuplicateKeyword[]>
  }
  observe: {
    status: () => Promise<ObserveStatus>
    conversations: () => Promise<ObserveConversation[]>
    /** 某会话最近 limit 条（面板抽屉用，1..200） */
    tail: (payload: {
      uin: string
      chatType: 'private' | 'group'
      chatId: string
      limit?: number
    }) => Promise<ObserveRecord[]>
    /** 用系统文件管理器打开 observe/ 根目录，返回空串表示成功 */
    openDir: () => Promise<string>
  }
  /**
   * 故事区（P4 / M12 的数据面）。
   *
   * 🔴 类型一律来自 `shared/story.ts` —— 两侧各写一份「差不多的接口」是本项目明令禁止的。
   * 🔴 删除必须带 `{ confirmed: true }`：缺省一律 `{ ok:false, reason:'need_confirm' }` 且**不删**。
   *    P7 的确认框打开前，这条参数就是唯一那道闸。
   */
  story: {
    /** 只读统计所有故事归档；不初始化库、不加载或下载模型。 */
    recallStatus: () => Promise<StoryRecallStatus>
    list: () => Promise<StorySummary[]>
    create: (draft: StoryDraft) => Promise<{ meta: StoryMeta; sessionId: string }>
    get: (storyId: string) => Promise<StoryMeta | null>
    remove: (storyId: string, opts?: { confirmed?: boolean }) => Promise<StoryDeleteResult>
    /** P6：这个区的分支列表（**扁平**，分支之间无父子依赖；P7 的抽屉直接用） */
    branches: (storyId: string) => Promise<StoryBranchItem[]>
    /** P6：从某条消息派生新分支（派生完即独立） */
    derive: (draft: StoryDeriveDraft) => Promise<{ branch: StoryBranch; sessionId: string }>
    /** P6：切换活跃分支，返回切换后的列表 */
    switchBranch: (storyId: string, branchId: string) => Promise<StoryBranchItem[]>
    /** P6：删分支（任意一条，只要不是最后一条），返回删完后的 branches.json */
    removeBranch: (storyId: string, branchId: string) => Promise<StoryBranchesFile>
    /** P7：取某条分支会话（带 messages）。branchId 省略 = 活跃分支 */
    session: (storyId: string, branchId?: string) => Promise<Session | null>
    /** P7：当前故事区全文检索（跨全部分支，命中上限 100） */
    search: (storyId: string, query: string) => Promise<StorySearchHit[]>
    /** P7：设置面板改 meta（白名单字段） */
    updateMeta: (storyId: string, patch: StoryMetaPatch) => Promise<StoryMeta | null>
    /** P7：读故事画像 profile.md（不存在 → 空串） */
    profileGet: (storyId: string) => Promise<string>
    /** P7：写故事画像（空串 = 删除文件） */
    profileSave: (storyId: string, text: string) => Promise<boolean>
    /** P7：选剧本世界书目录，返回空串 = 取消 */
    pickWorldbookDir: () => Promise<string>
    /** P8：列该故事区**自己库**里的长期记忆 */
    memoryList: (storyId: string) => Promise<MemoryEntry[]>
    /** P8：删一条故事记忆，返回删除后的完整列表 */
    memoryDelete: (storyId: string, id: string) => Promise<MemoryEntry[]>
    /** P8：清空该故事区的全部长期记忆，返回清空后的列表 */
    memoryClear: (storyId: string) => Promise<MemoryEntry[]>
  }
}