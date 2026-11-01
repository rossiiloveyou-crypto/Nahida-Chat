import { create } from 'zustand'
import type {
  ChatDelta,
  ChatDone,
  ChatFailure,
  ConversationMode,
  CreateSessionInput,
  Message,
  Session,
  UpdateSessionInput
} from '@shared/types'
import type { ToolApprovalTicket, ToolCallRecord } from '@shared/tools'

interface ChatStore {
  sessions: Session[]
  activeId: string | null
  ready: boolean
  streamingId: string | null
  approval: ToolApprovalTicket | null
  error: string | null
  /**
   * 还没有会话时，首页滑块选中的模式（P6 §4.6）。
   *
   * 存在这里而不是 ChatPage 的 useState：侧栏要据此决定「显示不显示工作区段」，
   * 所以这个值必须是**跨组件可见**的真源。有活动会话时以会话自己的 mode 为准，
   * 这个字段只负责「草稿态」。
   */
  draftMode: ConversationMode
  setDraftMode: (mode: ConversationMode) => void
  init: () => Promise<void>
  createSession: (input?: CreateSessionInput) => Promise<void>
  updateSession: (patch: UpdateSessionInput) => Promise<void>
  removeSession: (id: string) => Promise<void>
  /**
   * 从主进程重新拉一遍会话列表。
   *
   * 用在"主进程单方面改过会话"之后 —— 典型场景：删掉一个工作区，
   * 主进程把绑在上面的会话改绑并落盘了，渲染层手里的副本还带着失效 id。
   * 这时不要在渲染层自己推算改绑目标（那等于把顺位规则实现两遍，
   * 而且渲染层的 catalog 可能已经过期，算出来就是错的），直接问主进程要结果。
   */
  resync: () => Promise<void>
  select: (id: string) => void
  send: (content: string) => Promise<void>
  stop: () => Promise<void>
  respondApproval: (approved: boolean, remember: boolean) => Promise<void>
  dismissError: () => void
}

let bootstrap: Promise<void> | null = null
let wired = false

function mapSession(sessions: Session[], sessionId: string, update: (session: Session) => Session): Session[] {
  return sessions.map((session) => (session.id === sessionId ? update(session) : session))
}

function mapMessage(session: Session, messageId: string, update: (message: Message) => Message): Session {
  return {
    ...session,
    messages: session.messages.map((message) => (message.id === messageId ? update(message) : message))
  }
}

function appendDelta(session: Session, payload: ChatDelta): Session {
  return mapMessage(session, payload.messageId, (message) => ({
    ...message,
    content: message.content + payload.delta
  }))
}

/** 广播 reducer 会改写的四个字段。抽出来是为了能脱离 zustand 单独测（A0a）。 */
export interface ChatBroadcastState {
  sessions: Session[]
  streamingId: string | null
  approval: ToolApprovalTicket | null
  error: string | null
}

/**
 * 这条广播是不是「本窗口列表里的会话」。
 *
 * 存在的理由（J-19 / X-01）：mapSession 只保护 sessions 数组，但 streamingId /
 * approval / error 是**全局标量**，handler 里原来是无条件覆盖的。
 * QQ 会话的 sessionId 不在本窗口列表里 —— 它的广播必须整体丢弃，
 * 否则用户在桌面聊天时会被 QQ 消息抢走「正在生成」状态（停止按钮消失）。
 */
export function ownedByWindow(sessions: Session[], sessionId: string): boolean {
  return sessions.some((session) => session.id === sessionId)
}

export function reduceDelta(state: ChatBroadcastState, payload: ChatDelta): Partial<ChatBroadcastState> {
  if (!ownedByWindow(state.sessions, payload.sessionId)) return state
  return {
    streamingId: payload.sessionId,
    sessions: mapSession(state.sessions, payload.sessionId, (session) => appendDelta(session, payload))
  }
}

export function reduceDone(state: ChatBroadcastState, payload: ChatDone): Partial<ChatBroadcastState> {
  if (!ownedByWindow(state.sessions, payload.sessionId)) return state
  return {
    streamingId: null,
    approval: null,
    sessions: mapSession(state.sessions, payload.sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.id === payload.messageId
          ? { ...message, content: payload.content, status: 'done' as const, toolCalls: payload.toolCalls }
          : message
      )
    }))
  }
}

export function reduceError(state: ChatBroadcastState, payload: ChatFailure): Partial<ChatBroadcastState> {
  if (!ownedByWindow(state.sessions, payload.sessionId)) return state
  return {
    streamingId: null,
    approval: null,
    error: payload.message,
    sessions: mapSession(state.sessions, payload.sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.id === payload.messageId ? { ...message, status: 'error' as const } : message
      )
    }))
  }
}

/** 🔴 不属于本窗口时**保留当前票据**：写成「清空」会让桌面正在等的审批在 QQ 来消息时消失。 */
export function reduceApproval(state: ChatBroadcastState, ticket: ToolApprovalTicket): Partial<ChatBroadcastState> {
  if (!ownedByWindow(state.sessions, ticket.sessionId)) return state
  return { approval: ticket }
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  sessions: [],
  activeId: null,
  ready: false,
  streamingId: null,
  approval: null,
  error: null,
  draftMode: 'chat',

  setDraftMode: (mode) => set({ draftMode: mode }),

  init: async () => {
    if (!bootstrap) {
      bootstrap = (async () => {
        if (!wired) {
          wired = true

          window.nahida.chat.onDelta((payload) => {
            set((state) => reduceDelta(state, payload))
          })

          window.nahida.chat.onTool((payload) => {
            set((state) => ({
              sessions: mapSession(state.sessions, payload.sessionId, (session) =>
                mapMessage(session, payload.messageId, (message) => ({ ...message, toolCalls: payload.calls }))
              )
            }))
          })

          window.nahida.chat.onApproval((ticket) => set((state) => reduceApproval(state, ticket)))

          window.nahida.chat.onDone((payload: ChatDone) => {
            set((state) => reduceDone(state, payload))
          })

          window.nahida.chat.onError((payload: ChatFailure) => {
            set((state) => reduceError(state, payload))
          })
        }

        const sessions = await window.nahida.chat.listSessions()
        // 首次启动不自动建会话：留空让首页显示「选择 Chat / Agent」的入口
        set({ sessions, activeId: sessions[0]?.id ?? null, ready: true })
      })()
    }
    await bootstrap
  },

  createSession: async (input) => {
    const session = await window.nahida.chat.createSession(input)
    set((state) => ({ sessions: [session, ...state.sessions], activeId: session.id, error: null, approval: null }))
  },

  updateSession: async (patch) => {
    const activeId = get().activeId
    if (!activeId) return
    const updated = await window.nahida.chat.updateSession(activeId, patch)
    set((state) => ({
      sessions: state.sessions.map((session) => (session.id === updated.id ? updated : session))
    }))
  },

  removeSession: async (id) => {
    await window.nahida.chat.deleteSession(id)
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id)
      const activeId = state.activeId === id ? (sessions[0] ? sessions[0].id : null) : state.activeId
      return { sessions, activeId }
    })
  },

  resync: async () => {
    const sessions = await window.nahida.chat.listSessions()
    set((state) => ({
      sessions,
      // 活动会话如果还在就保持不动，否则顺位到第一条（和删除会话的规则一致）
      activeId: sessions.some((s) => s.id === state.activeId)
        ? state.activeId
        : (sessions[0]?.id ?? null)
    }))
  },

  select: (id) => set({ activeId: id, error: null }),

  send: async (content) => {
    const sessionId = get().activeId
    const text = content.trim()
    if (!sessionId || !text) return
    set({ error: null, streamingId: sessionId })
    try {
      const result = await window.nahida.chat.send({ sessionId, content: text })
      set((state) => ({
        sessions: mapSession(state.sessions, sessionId, (session) => {
          const messages = session.messages.slice()
          const assistantIndex = messages.findIndex((m) => m.id === result.assistantMessage.id)
          const userIndex = messages.findIndex((m) => m.id === result.userMessage.id)
          if (assistantIndex === -1) {
            if (userIndex === -1) messages.push(result.userMessage)
            messages.push(result.assistantMessage)
            return { ...session, messages }
          }
          if (userIndex === -1) messages.splice(assistantIndex, 0, result.userMessage)
          return { ...session, messages }
        })
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message, streamingId: null })
    }
  },

  stop: async () => {
    const sessionId = get().activeId
    if (!sessionId) return
    await window.nahida.chat.stop(sessionId)
    set({ streamingId: null, approval: null })
  },

  respondApproval: async (approved, remember) => {
    const ticket = get().approval
    if (!ticket) return
    set({ approval: null })
    await window.nahida.tools.respond({ requestId: ticket.requestId, approved, remember })
  },

  dismissError: () => set({ error: null })
}))

export type { ToolCallRecord }
