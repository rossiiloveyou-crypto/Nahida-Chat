import type { StoryWorldbookMode } from './story'
import type { ConversationMode, Message, MessageRole } from './types'

export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024
export const MAX_TRANSFER_MESSAGES = 20_000

export type TransferFormat = 'st' | 'nc'

export interface ParsedTransferSession {
  title: string
  messages: Message[]
  characterId?: string
  mode?: ConversationMode
  createdAt?: number
  updatedAt?: number
}

/** 主进程内的解析结果。渲染层只接收 ImportPreview。 */
export interface ParsedTransfer {
  format: TransferFormat
  title: string
  characterName: string | null
  userName: string | null
  sessions: ParsedTransferSession[]
  skippedLines: number
  discardedFields: Record<string, number>
}

export interface ImportPreview {
  token: string
  fileName: string
  format: TransferFormat
  title: string
  characterName: string | null
  userName: string | null
  sessionCount: number
  messageCount: number
  roleCounts: Record<MessageRole, number>
  skippedLines: number
  discardedFields: Record<string, number>
  firstMessageSummary: string | null
  lastMessageSummary: string | null
  suggestedCharacterId: string
  characterMatched: boolean
  duplicateCount: number
}

export type ImportTarget =
  | { kind: 'session'; mode: Exclude<ConversationMode, 'story'>; characterId: string }
  | {
      kind: 'new-story'
      characterId: string
      synopsis?: string
      profile?: string
      worldbookDir?: string
      worldbookMode?: StoryWorldbookMode
      background?: string
    }
  | { kind: 'story-branch'; storyId: string; makeActive?: boolean }

export interface ImportRequest {
  /** 由主进程预览生成，绑定已解析的输入；无需传入文件路径。 */
  token: string
  title?: string
  target: ImportTarget
}

export type ExportRequest =
  | { format: TransferFormat; scope: 'current'; sessionId: string }
  | { format: TransferFormat; scope: 'all' }

export type TransferResult =
  | {
      ok: true
      sessionIds?: string[]
      storyId?: string
      fileNames?: string[]
      sessionCount: number
      messageCount: number
      warnings: string[]
    }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: string }
