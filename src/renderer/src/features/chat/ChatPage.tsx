import { useEffect, useState } from 'react'
import { providerMeta } from '@shared/constants'
import type { ConversationMode, ModelProfileCatalog } from '@shared/types'
import { ApprovalCard } from './components/ApprovalCard'
import { Composer } from './components/Composer'
import { EmptyState } from './components/EmptyState'
import { MessageList } from './components/MessageList'
import { useChatStore } from './store'
import { StoryDrawer } from '../story/StoryDrawer'
import { useStoryStore } from '../story/store'
import { useSettings } from '../settings/useSettings'
import { usePromptLibrary } from '../settings/usePromptLibrary'
import { useWorkspaces } from '../workspace/useWorkspaces'

// P4：故事模式只补字典键（角落徽章的文字）。**不是入口** —— 模式滑块仍只列 chat / agent。
const MODE_LABEL: Record<ConversationMode, string> = { chat: 'Chat', agent: 'Agent', story: '故事' }

export function ChatPage() {
  const init = useChatStore((s) => s.init)
  const ready = useChatStore((s) => s.ready)
  const sessions = useChatStore((s) => s.sessions)
  const activeId = useChatStore((s) => s.activeId)
  const streamingId = useChatStore((s) => s.streamingId)
  const approval = useChatStore((s) => s.approval)
  const error = useChatStore((s) => s.error)
  const send = useChatStore((s) => s.send)
  const narrate = useChatStore((s) => s.narrate)
  const stop = useChatStore((s) => s.stop)
  const createSession = useChatStore((s) => s.createSession)
  const updateSession = useChatStore((s) => s.updateSession)
  const respondApproval = useChatStore((s) => s.respondApproval)
  const dismissError = useChatStore((s) => s.dismissError)
  const { settings } = useSettings()
  const { library } = usePromptLibrary()
  const { catalog: workspaceCatalog, pickDirectory, save: saveWorkspace } = useWorkspaces()
  // P6 §4.6：模式真源在 store，侧栏也要读它（它决定工作区段显不显示）
  const draftMode = useChatStore((s) => s.draftMode)
  const setDraftMode = useChatStore((s) => s.setDraftMode)
  const [catalog, setCatalog] = useState<ModelProfileCatalog>({ profiles: [], defaultProfileId: null })
  // 还没有会话时选的模型先存在这里，建会话时一起带进去
  const [draftModel, setDraftModel] = useState<{ profileId: string; modelId: string } | null>(null)
  // 同理，还没有会话时选的工作区也先暂存
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null)
  // P7：检索命中后要滚动并高亮那条消息，2 秒后自动清除（淡出）
  const focusMessageId = useStoryStore((s) => s.focusMessageId)
  const setFocusMessageId = useStoryStore((s) => s.setFocus)

  useEffect(() => {
    void init()
  }, [init])

  // P7：检索命中高亮 2 秒后自动淡出（滚动由 MessageList 负责）
  useEffect(() => {
    if (!focusMessageId) return
    const timer = window.setTimeout(() => setFocusMessageId(null), 2000)
    return () => window.clearTimeout(timer)
  }, [focusMessageId, setFocusMessageId])

  // 角标要跟着 composer 里刚换的模型走，所以档案列表也要一份
  useEffect(() => {
    let alive = true
    window.nahida.modelProfiles
      .list()
      .then((next) => {
        if (alive) setCatalog(next)
      })
      .catch(() => {
        if (alive) setCatalog({ profiles: [], defaultProfileId: null })
      })
    return () => {
      alive = false
    }
  }, [])

  const active = sessions.find((s) => s.id === activeId) ?? null
  const messages = active ? active.messages : []
  const streaming = streamingId !== null && streamingId === activeId
  const pendingApproval = approval && approval.sessionId === activeId ? approval : null

  // 会话指定的档案优先；没指定就看默认档案；都没有才回落到扁平镜像字段
  const headerProfile =
    catalog.profiles.find((item) => item.id === (active?.modelProfileId ?? draftModel?.profileId)) ??
    catalog.profiles.find((item) => item.id === catalog.defaultProfileId) ??
    catalog.profiles[0] ??
    null
  const chosenProfileId = active?.modelProfileId ?? draftModel?.profileId ?? null
  const chosenModelId = active?.modelId ?? draftModel?.modelId ?? null
  const headerModel =
    (chosenModelId && headerProfile?.models.includes(chosenModelId) ? chosenModelId : null) ??
    headerProfile?.defaultModel ??
    ''
  const providerLabel = headerProfile
    ? providerMeta(headerProfile.provider).label
    : settings
      ? providerMeta(settings.provider).label
      : '演示模式'
  const modelHint = headerModel ? ' · ' + headerModel : ''

  // 工作区的解析顺序和模型一致：会话自己的 > 草稿 > 活动工作区 > 清单第一条
  const workspaceId =
    active?.workspaceId ??
    draftWorkspaceId ??
    workspaceCatalog.activeWorkspaceId ??
    workspaceCatalog.workspaces[0]?.id ??
    null
  const activeWorkspace = workspaceCatalog.workspaces.find((item) => item.id === workspaceId) ?? null

  const activeMode: ConversationMode = active ? active.mode : draftMode
  /**
   * P6 G3：Agent 模式下一个工作区都没有时必须拦住输入。
   *
   * 判据取**清单是否为空**，而不是 workspaceId 是否为空：workspaceId 有四级回落，
   * 清单为空时它才是 null；用清单长度更直接，也覆盖「会话绑的 workspaceId 已失效」。
   */
  const needsWorkspace = activeMode === 'agent' && workspaceCatalog.workspaces.length === 0
  const characterName =
    library?.characters.find((item) => item.id === (active?.characterId ?? settings?.defaultCharacterId))?.name ??
    '纳西妲'

  // 没有会话时发第一条消息：先按首页选中的模式建会话，再发
  const handleSend = async (text: string): Promise<void> => {
    if (!active) {
      await createSession({
        mode: draftMode,
        workspaceId: workspaceId,
        modelProfileId: draftModel?.profileId ?? null,
        modelId: draftModel?.modelId ?? null
      })
      await useChatStore.getState().send(text)
      return
    }
    await send(text)
  }

  // 旁白只在故事会话出现，所以这里不做“无会话先建区”的分支
  const handleNarrate = async (text: string): Promise<void> => {
    if (!active?.storyId) return
    await narrate(text)
  }

  // 换模型：有会话就写进会话，没有就先记在草稿上
  const handlePickModel = (profileId: string, modelId: string): void => {
    if (!active) {
      setDraftModel({ profileId, modelId })
      return
    }
    void updateSession({ modelProfileId: profileId, modelId })
  }

  // 换工作区：有会话就写进会话，没有就先记在草稿上
  const handlePickWorkspace = (nextId: string): void => {
    setDraftWorkspaceId(nextId)
    if (!active) return
    void updateSession({ workspaceId: nextId })
  }

  /**
   * P6 G3/G4：零工作区时点输入区 -> 直接弹系统目录选择框建一个。
   *
   * 复用 WorkspaceSection 的建区逻辑（pickDirectory + save），不新写一套：
   * 两套建区路径迟早会在「目录去重 / 名字回落」这类规则上分叉。
   * 建完 useWorkspaces 会 publish 新清单，needsWorkspace 立刻变 false，输入框自动解禁。
   */
  const handleCreateWorkspace = async (): Promise<void> => {
    try {
      const dir = await pickDirectory()
      if (!dir) return
      await saveWorkspace({ name: '', dir })
    } catch {
      // 失败原因由 useWorkspaces 写进 error，侧栏会显示；这里不应该阻断输入区
    }
  }

  // 空会话才允许切模式；有消息就只能新建对话
  const handleModeChange = async (mode: ConversationMode): Promise<void> => {
    setDraftMode(mode)
    if (!active || messages.length > 0) return
    try {
      await updateSession({ mode })
    } catch {
      // 空会话切换失败时保留本地选择，下次建会话仍按它来
    }
  }

  return (
    <section className="chat-page">
      <header className="chat-header" data-ui-region="A 对话头部">
        <div>
          <h2 className="chat-header__title">
            {active?.storyId && <span className="chat-header__badge">故事</span>}
            {active ? active.title : 'Nahida Chat'}
          </h2>
          <div className="chat-header__subtitle">
            {ready ? (messages.length > 0 ? messages.length + ' 条消息' : '准备就绪') : '正在载入…'}
            {activeWorkspace && (
              <>
                <span className="chat-header__sep">·</span>
                <span className="chat-header__workspace" title={activeWorkspace.dir}>
                  {activeWorkspace.name}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="chat-header__chips" data-ui-target="模式与模型角标">
          <span className={activeMode === 'agent' ? 'mode-chip is-agent' : 'mode-chip'}>
            {MODE_LABEL[activeMode]}
          </span>
          <span className="model-chip">
            <span className="model-chip__dot" />
            {providerLabel}
            {modelHint}
          </span>
        </div>
      </header>

      {error && (
        <div className="error-bar">
          <span>请求失败：{error}</span>
          <button onClick={dismissError}>忽略</button>
        </div>
      )}

      {/**
       * P7：故事会话的空态**绝不能**走 EmptyState ——
       * 那会把 Chat/Agent 滑块塞进故事里，handleModeChange 还能把 story 会话改成 chat。
       */}
      {/* P7：消息区与抽屉并排。抽屉不能盖住输入区（否则检索时连输入框都看不见）。 */}
      <div className="chat-body">
        {/**
         * P7：故事会话的空态**绝不能**走 EmptyState ——
         * 那会把 Chat/Agent 滑块塞进故事里，handleModeChange 还能把 story 会话改成 chat。
         */}
        {messages.length === 0 && active?.storyId ? (
          <div className="empty-state empty-state--story">
            <p className="empty-state__desc">这个故事还没有消息。在下方输入框继续写下去。</p>
          </div>
        ) : messages.length === 0 ? (
          <EmptyState
            mode={activeMode}
            onModeChange={(mode) => void handleModeChange(mode)}
            disabled={streaming}
          />
        ) : (
          <MessageList messages={messages} focusMessageId={focusMessageId} />
        )}

        {active?.storyId && <StoryDrawer storyId={active.storyId} title={active.title} />}
      </div>

      {pendingApproval && (
        <div className="approval-dock">
          <ApprovalCard
            ticket={pendingApproval}
            onRespond={(approved, remember) => void respondApproval(approved, remember)}
          />
        </div>
      )}

      <Composer
        disabled={ready ? false : true}
        streaming={streaming}
        onSend={(text) => void handleSend(text)}
        onNarrate={(text) => void handleNarrate(text)}
        canNarrate={Boolean(active?.storyId)}
        onStop={() => void stop()}
        draftProfileId={chosenProfileId}
        draftModelId={chosenModelId}
        onPickModel={handlePickModel}
        workspaceId={workspaceId}
        onPickWorkspace={handlePickWorkspace}
        needsWorkspace={needsWorkspace}
        onCreateWorkspace={() => void handleCreateWorkspace()}
      />
    </section>
  )
}
