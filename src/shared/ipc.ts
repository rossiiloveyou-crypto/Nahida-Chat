/**
 * IPC 频道常量。主进程注册 handler、预加载订阅事件都用这里的键，
 * 禁止在业务代码里手写字符串频道名。
 */
export const IPC = {
  appInfo: 'app:info',

  settingsGet: 'settings:get',
  settingsSave: 'settings:save',

  modelProfileList: 'model-profile:list',
  modelProfileSave: 'model-profile:save',
  modelProfileDelete: 'model-profile:delete',
  modelProfileSetDefault: 'model-profile:set-default',
  modelProfileTest: 'model-profile:test',
  modelDiscover: 'model-profile:discover',

  promptLibrary: 'prompt:library',
  promptOpen: 'prompt:open',
  promptOpenCharacter: 'prompt:open-character',

  toolList: 'tool:list',
  toolRespond: 'tool:respond',

  workspaceList: 'workspace:list',
  workspaceSave: 'workspace:save',
  workspaceDelete: 'workspace:delete',
  workspaceSetActive: 'workspace:set-active',
  workspacePickDir: 'workspace:pick-directory',
  workspaceOpen: 'workspace:open',

  memoryStatus: 'memory:status',
  memoryList: 'memory:list',
  memorySave: 'memory:save',
  memoryDelete: 'memory:delete',
  memoryClear: 'memory:clear',
  memoryRecall: 'memory:recall',
  memoryOpenModel: 'memory:open-model',

  chatList: 'chat:list',
  chatCreate: 'chat:create',
  chatUpdate: 'chat:update',
  chatDelete: 'chat:delete',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',

  chatDelta: 'chat:delta',
  chatTool: 'chat:tool',
  chatApproval: 'chat:approval',
  chatDone: 'chat:done',
  chatError: 'chat:error',

  // QQ 接入（P4）：宿主状态 / 进程 / 设置 / 最近事件
  // P6：绑定表下线（3 个绑定通道已删除），授权改由下面的 channels:* 承担
  qqStatus: 'qq:status',
  qqProcesses: 'qq:processes',
  qqLoad: 'qq:load',
  qqUnload: 'qq:unload',
  qqRestart: 'qq:restart',
  qqSettingsGet: 'qq:settings',
  qqSettingsSave: 'qq:settings-save',
  qqLogs: 'qq:logs',
  /** 主进程 → 渲染层：最近事件推送（渲染层订阅，不发请求） */
  qqEvent: 'qq:event',

  // 区块（P5）：记忆域 / 群角色绑定
  zoneList: 'zone:list',
  zoneCreate: 'zone:create',
  zoneRename: 'zone:rename',
  zoneDelete: 'zone:delete',
  zoneConfig: 'zone:config',
  zoneMemberAdd: 'zone:member-add',
  zoneMemberRemove: 'zone:member-remove',
  zoneAdopt: 'zone:adopt',
  zoneStats: 'zone:stats',
  /** P6：未归区的白名单会话（区块面板 C 区，只读） */
  zoneUnzoned: 'zone:unzoned',

  // 渠道授权（P6 → P9-R3 v2：按「人」授权）。真源 userData/channels/access.json
  channelsConfig: 'channels:config',
  channelsGates: 'channels:gates',
  channelsAccount: 'channels:account',
  channelsRemoveAccount: 'channels:remove-account',
  channelsGroup: 'channels:group',
  channelsRemoveGroup: 'channels:remove-group',
  channelsUin: 'channels:uin',
  channelsSessions: 'channels:sessions',
  channelsStatus: 'channels:status',

  // 旁听库（P8）：只增不清的群语料。**没有** delete / clear 通道，这是设计不是遗漏
  observeStatus: 'observe:status',
  observeConversations: 'observe:conversations',
  observeTail: 'observe:tail',
  observeOpenDir: 'observe:open-dir'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
