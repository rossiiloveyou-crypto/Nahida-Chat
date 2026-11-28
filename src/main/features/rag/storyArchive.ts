import { createHash } from 'node:crypto'
import type { Session } from '@shared/types'
import type { MemoryStore } from './store'
import { storyArchiveStore } from '../story/memory'
import { branchVisibility } from '../story/visibility'
import type { Message } from '@shared/types'
import { STORY_CHUNK_CHARS, STORY_CHUNK_OVERLAP } from '@shared/constants'
import { requestEmbeddingBackfill } from './embedPendings'
import { sanitizeChunkText } from './sanitize'

export interface Round {
  index: number
  messages: Message[]
}

export interface StoryChunk {
  index: number
  text: string
  startOffset: number
  endOffset: number
}

/** Close on assistant; adjacent assistants extend that same round. Status belongs to the scheduler. */
export function splitRounds(messages: Message[]): { rounds: Round[]; trailing: Message[] } {
  const rounds: Round[] = []
  let cursor = 0
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== 'assistant') continue
    if (i > 0 && messages[i - 1].role === 'assistant') {
      rounds[rounds.length - 1].messages.push(messages[i])
    } else {
      rounds.push({ index: rounds.length, messages: messages.slice(cursor, i + 1) })
    }
    cursor = i + 1
  }
  return { rounds, trailing: messages.slice(cursor) }
}

const ROLE_LABELS: Record<Message['role'], string> = {
  narration: '【旁白】', user: '【用户】', assistant: '【角色】', system: '【系统】'
}

/** A UTF-16 boundary may move left by one, but never bisects an existing surrogate pair. */
function safeBoundary(text: string, offset: number): number {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? offset - 1
    : offset
}

/** Offsets address the exact role-labelled messages joined by a single newline (end exclusive). */
export function sliceRound(round: Round, options?: { sanitize?: boolean }): StoryChunk[] {
  const parts = options?.sanitize
    ? round.messages.flatMap(message => {
      const body = sanitizeChunkText(message.content)
      return body ? [ROLE_LABELS[message.role] + body] : []
    })
    : round.messages.map(message => ROLE_LABELS[message.role] + message.content)
  const text = parts.join('\n')
  const chunks: StoryChunk[] = []
  let pendingStart = 0
  let pendingEnd = 0
  const emit = (startOffset: number, endOffset: number): void => {
    if (endOffset > startOffset) {
      chunks.push({ index: chunks.length, text: text.slice(startOffset, endOffset), startOffset, endOffset })
    }
  }
  const flush = (): void => {
    emit(pendingStart, pendingEnd)
    pendingStart = pendingEnd
  }
  const append = (start: number, end: number): void => {
    if (pendingEnd > pendingStart && end - pendingStart > STORY_CHUNK_CHARS) flush()
    if (pendingStart === pendingEnd) pendingStart = start
    pendingEnd = end
  }
  let offset = 0
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) {
      append(offset, offset + 1)
      offset += 1
    }
    const end = offset + parts[i].length
    if (end - offset <= STORY_CHUNK_CHARS) {
      append(offset, end)
    } else {
      flush()
      let start = offset
      while (end - start > STORY_CHUNK_CHARS) {
        let cut = safeBoundary(text, start + STORY_CHUNK_CHARS)
        // Last sentence ending in the 800..1200 UTF-16 window wins; retain its punctuation.
        for (let boundary = cut; boundary >= start + 800; boundary -= 1) {
          if ('。！？…；\n'.includes(text[boundary - 1])) {
            cut = boundary
            break
          }
        }
        emit(start, cut)
        // A protected pair can increase the overlap by one UTF-16 code unit.
        start = safeBoundary(text, cut - STORY_CHUNK_OVERLAP)
      }
      pendingStart = start
      pendingEnd = end
    }
    offset = end
  }
  flush()
  return chunks
}

/** Hash ordered, length-framed field tuples; JSON escaping also preserves lone UTF-16 surrogates. */
export function contentVersion(messages: Message[]): string {
  const hash = createHash('sha256')
  for (const message of messages) {
    const item = JSON.stringify([message.id, message.role, message.content, message.createdAt, message.status])
    hash.update(String(Buffer.byteLength(item, 'utf8')) + ':')
    hash.update(item)
  }
  return hash.digest('hex')
}

export interface StoryArchiveRoute {
  storyId: string | null
}

type ArchiveStore = Pick<MemoryStore, 'upsertStoryRound'> & Partial<Pick<MemoryStore,
  'getStoryRound' | 'getStoryMessageOwners' | 'getStoryMessageState' | 'setStoryMessageState' | 'isStoryMessageInterrupted'>>

interface CompletionReceipt {
  messageId: string
  version: string
  interrupted: boolean
}

type ArchiveSession = Pick<Session, 'id' | 'messages' | 'storyId'>

interface ArchiveSnapshot {
  live: ArchiveSession
  generation: number
  key: string
  version?: string
  storyId: string
  branchId: string
  tenant: { userId: string; personaId: string }
  messages: Message[]
  receipts: CompletionReceipt[]
}

/** Per-story single flight; snapshots arriving during a run are merged per branch, never discarded. */
export class StoryArchiveService {
  private readonly jobs = new Map<string, Map<string, ArchiveSnapshot>>()
  private readonly retryReceipts = new Map<string, CompletionReceipt[]>()
  private readonly generations = new Map<string, { generation: number; live: ArchiveSession }>()
  private readonly latest = new Map<string, ArchiveSnapshot>()
  private readonly deletedStories = new Set<string>()
  private readonly drains = new Map<string, Promise<void>>()

  async flush(storyId: string): Promise<void> {
    await this.drains.get(storyId)
  }

  isForgotten(storyId: string): boolean {
    return this.deletedStories.has(storyId)
  }

  /** Story ids are never reused: prevent pending work and late completion hooks resurrecting a deleted DB. */
  forget(storyId: string): void {
    if (!storyId) return
    this.deletedStories.add(storyId)
    this.jobs.get(storyId)?.clear()
    for (const [key, snapshot] of this.latest) {
      if (snapshot.storyId === storyId) this.latest.delete(key)
    }
    for (const map of [this.generations, this.retryReceipts]) {
      for (const key of map.keys()) {
        if (JSON.parse(key)[0] === storyId) map.delete(key)
      }
    }
  }

  /** Cancel snapshots without permanently retiring the story; future schedules remain valid. */
  cancel(storyId: string): void {
    this.jobs.get(storyId)?.clear()
    for (const [key, snapshot] of this.latest) {
      if (snapshot.storyId === storyId) {
        this.retainReceipts(snapshot)
        this.latest.delete(key)
      }
    }
  }

  /** Editing only marks memory; the next schedule performs any disk work and rebuilding. */
  invalidate(session: ArchiveSession): void {
    if (!session.storyId || this.deletedStories.has(session.storyId) ||
        !session.id?.trim() || !this.jobs.has(session.storyId)) return
    const key = JSON.stringify([session.storyId, session.id])
    this.generations.set(key, {
      generation: (this.generations.get(key)?.generation ?? 0) + 1, live: session
    })
  }

  private isCurrent(snapshot: ArchiveSnapshot): boolean {
    const state = this.generations.get(JSON.stringify([snapshot.storyId, snapshot.branchId]))
    const live = state?.live ?? snapshot.live
    const version = snapshot.version ??= contentVersion(snapshot.messages)
    return !this.deletedStories.has(snapshot.storyId) && this.latest.get(snapshot.key) === snapshot &&
      (state?.generation ?? 0) === snapshot.generation &&
      live.id === snapshot.branchId && live.storyId === snapshot.storyId &&
      snapshot.live.id === snapshot.branchId && snapshot.live.storyId === snapshot.storyId &&
      contentVersion(live.messages) === version &&
      (live === snapshot.live || contentVersion(snapshot.live.messages) === version) &&
      live.messages.every((message, index) =>
        message.copiedFromMessageId === snapshot.messages[index]?.copiedFromMessageId)
  }

  /** A derived done status alone is not evidence that its source assistant completed. */
  private inheritCopiedReceipts(snapshot: ArchiveSnapshot, round: Round, store: ArchiveStore): boolean {
    const copied = round.messages.filter((message) => message.role === 'assistant' && message.copiedFromMessageId)
    if (copied.length === 0) return true
    const bounds = branchVisibility(snapshot.storyId, snapshot.branchId).bounds
    if (!bounds.has(snapshot.branchId)) return false
    const sourceRound = round.messages.every((message) => message.copiedFromMessageId)
      ? round.messages.map((message) => ({ ...message, id: message.copiedFromMessageId!, status: 'done' as const }))
      : null
    const lastIndex = snapshot.messages.indexOf(round.messages[round.messages.length - 1])
    let complete = true
    for (const message of copied) {
      const local = store.getStoryMessageState?.(snapshot.branchId, message.id, contentVersion([message])) ?? null
      if (local !== null) {
        if (local) complete = false
        continue
      }
      const messageIndex = snapshot.messages.indexOf(message)
      const sourceVersion = contentVersion([{ ...message, id: message.copiedFromMessageId!, status: 'done' }])
      let evidence: boolean | null = null
      for (const [branchId, bound] of bounds) {
        if (branchId === snapshot.branchId || (bound !== null &&
            (!Number.isSafeInteger(bound) || bound < messageIndex))) continue
        const state = store.getStoryMessageState?.(branchId, message.copiedFromMessageId!, sourceVersion) ?? null
        if (state === true) { evidence = true; break }
        if (state === false) evidence ??= false
        if (state === null && sourceRound && (bound === null || lastIndex <= bound)) {
          const archived = store.getStoryRound?.(snapshot.storyId, branchId, round.index)
          if (archived?.valid === 1 && archived.first_message_id === sourceRound[0].id &&
              archived.last_message_id === sourceRound[sourceRound.length - 1].id &&
              archived.content_version === contentVersion(sourceRound) &&
              !sourceRound.some((item) => item.role === 'assistant' &&
                store.getStoryMessageState?.(branchId, item.id, contentVersion([item])) === true)) evidence ??= false
        }
      }
      if (evidence === null) { complete = false; continue }
      if (!this.isCurrent(snapshot)) return false
      const receipt = { messageId: message.id, version: contentVersion([message]), interrupted: evidence }
      snapshot.receipts.push(receipt)
      store.setStoryMessageState?.(snapshot.branchId, receipt.messageId, receipt.version, evidence)
      if (evidence) complete = false
    }
    return complete
  }

  private retainReceipts(snapshot: ArchiveSnapshot): void {
    if (this.deletedStories.has(snapshot.storyId) || snapshot.receipts.length === 0) return
    const key = JSON.stringify([snapshot.storyId, snapshot.branchId])
    this.retryReceipts.set(key, [...(this.retryReceipts.get(key) ?? []), ...snapshot.receipts])
  }

  constructor(private readonly getStore: (storyId: string) => ArchiveStore = storyArchiveStore) {}

  schedule(session: Pick<Session, 'id' | 'messages' | 'storyId'>, route: StoryArchiveRoute,
    tenant: { userId: string; personaId: string },
    completion?: { messageId: string; interrupted: boolean }): void {
    try {
      // route is the existing memoryRouteOf result; branch identity is session.id, as in branchVisibility.
      if (!route.storyId || this.deletedStories.has(route.storyId) ||
          session.storyId !== route.storyId || !session.id?.trim() ||
          !tenant.userId?.trim() || !tenant.personaId?.trim()) return
      const key = JSON.stringify([route.storyId, session.id, tenant.userId, tenant.personaId])
      const branchKey = JSON.stringify([route.storyId, session.id])
      const generation = this.generations.get(branchKey)?.generation ?? 0
      if (this.generations.has(branchKey)) this.generations.set(branchKey, { generation, live: session })
      const snapshot: ArchiveSnapshot = {
        live: session, generation, key,
        storyId: route.storyId,
        branchId: session.id,
        tenant: { ...tenant },
        messages: session.messages.map(({ id, role, content, createdAt, status, copiedFromMessageId }) =>
          ({ id, role, content, createdAt, status, copiedFromMessageId })),
        receipts: []
      }
      const completed = completion && snapshot.messages.find((message) => message.id === completion.messageId)
      if (completed && completion) snapshot.receipts.push({ ...completion, version: contentVersion([completed]) })
      const receiptKey = JSON.stringify([snapshot.storyId, snapshot.branchId])
      snapshot.receipts.unshift(...(this.retryReceipts.get(receiptKey) ?? []))
      this.retryReceipts.delete(receiptKey)
      this.latest.set(key, snapshot)
      const pending = this.jobs.get(snapshot.storyId)
      if (pending) {
        snapshot.receipts.unshift(...(pending.get(key)?.receipts ?? []))
        pending.set(key, snapshot)
        return
      }
      const queue = new Map([[key, snapshot]])
      this.jobs.set(snapshot.storyId, queue)
      const drain = this.drain(snapshot.storyId, queue)
      this.drains.set(snapshot.storyId, drain)
      void drain.finally(() => {
        if (this.drains.get(snapshot.storyId) === drain) this.drains.delete(snapshot.storyId)
      })
    } catch (error) {
      this.report(error)
    }
  }

  private report(error: unknown): void {
    // Identifiers/content stay out of the warning; one failed snapshot produces one observable event.
    console.warn('[story-archive] 归档失败，后续轮重试', error)
  }

  private async drain(storyId: string, queue: Map<string, ArchiveSnapshot>): Promise<void> {
    try {
      // Do not open SQLite or hash/slice inside runStream.finally, even before the first await.
      await new Promise<void>((resolve) => setImmediate(resolve))
      while (queue.size > 0) {
        const [key, snapshot] = queue.entries().next().value!
        queue.delete(key)
        // A preceding snapshot may have failed after this one was already enqueued.
        const receiptKey = JSON.stringify([storyId, snapshot.branchId])
        snapshot.receipts.unshift(...(this.retryReceipts.get(receiptKey) ?? []))
        this.retryReceipts.delete(receiptKey)
        try {
          if (!this.isCurrent(snapshot)) {
            this.retainReceipts(snapshot)
            continue
          }
          const { rounds } = splitRounds(snapshot.messages)
          // Lazy backfill of every completed historical round, independent of memory/summary switches.
          let store: ArchiveStore | undefined
          if (snapshot.receipts.length > 0) {
            store = this.getStore(storyId)
            for (const receipt of snapshot.receipts) {
              if (!this.isCurrent(snapshot)) break
              store.setStoryMessageState?.(
                snapshot.branchId, receipt.messageId, receipt.version, receipt.interrupted)
            }
          }
          // Resolve every historical identity before any slot is overwritten by a shifted round.
          let ownership: ReturnType<MemoryStore['getStoryMessageOwners']> | undefined
          let sourceOwnership: Map<string, NonNullable<typeof ownership>> | undefined
          const ownersFor = (archive: ArchiveStore): NonNullable<typeof ownership> => {
            if (!ownership) {
              ownership = archive.getStoryMessageOwners?.(storyId, snapshot.branchId,
                snapshot.messages.map((message) => message.id)) ?? []
              sourceOwnership = new Map()
              if (snapshot.messages.some((message) => message.copiedFromMessageId)) {
                const copiedIds = snapshot.messages.flatMap((message) =>
                  message.copiedFromMessageId ? [message.copiedFromMessageId] : [])
                for (const [branchId] of branchVisibility(storyId, snapshot.branchId).bounds) {
                  if (branchId !== snapshot.branchId) sourceOwnership.set(branchId,
                    archive.getStoryMessageOwners?.(storyId, branchId, copiedIds) ?? [])
                }
              }
            }
            return ownership
          }
          for (const round of rounds) {
            if (!this.isCurrent(snapshot)) break
            if (round.messages.some((message) => !message.id ||
                (message.role === 'assistant' && message.status !== 'done'))) continue
            const first = round.messages[0]
            const last = round.messages[round.messages.length - 1]
            store ??= this.getStore(storyId)
            if (!this.inheritCopiedReceipts(snapshot, round, store)) continue
            if (round.messages.some((message) => message.role === 'assistant' &&
                store!.isStoryMessageInterrupted?.(snapshot.branchId, message.id, contentVersion([message])))) continue
            const messageIds = round.messages.map((message) => message.id)
            const ids = new Set(messageIds)
            const owners = ownersFor(store).filter((owner) => ids.has(owner.message_id))
            let unprovenCopy = false
            const bounds = sourceOwnership?.size ? branchVisibility(storyId, snapshot.branchId).bounds : new Map()
            for (const message of round.messages) {
              if (!message.copiedFromMessageId || owners.some((item) => item.message_id === message.id)) continue
              const index = snapshot.messages.indexOf(message)
              const inherited = [...(sourceOwnership ?? [])].flatMap(([branchId, rows]) => {
                const bound = bounds.get(branchId)
                if (!bounds.has(branchId) || (bound !== null &&
                    (!Number.isSafeInteger(bound) || index > bound!))) return []
                return rows.filter((row) => row.message_id === message.copiedFromMessageId)
                  .map((row) => ({ ...row, message_id: message.id }))
              })
              if (inherited.length === 0) unprovenCopy = true
              owners.push(...inherited)
            }
            if (unprovenCopy) continue
            const owner = owners[0]
            // Deleting separators can merge rounds owned by different tenants: withhold the merged round.
            if (owners.some((item) => item.tenant_user !== owner.tenant_user ||
                item.tenant_persona !== owner.tenant_persona)) continue
            const input = {
              storyId, branchId: snapshot.branchId, roundIndex: round.index,
              tenantUser: owner?.tenant_user ?? snapshot.tenant.userId,
              tenantPersona: owner?.tenant_persona ?? snapshot.tenant.personaId,
              firstMessageId: first.id, lastMessageId: last.id, messageIds,
              contentVersion: contentVersion(round.messages),
              roles: round.messages.map((message) => message.role),
              startedAt: first.createdAt, chunks: sliceRound(round, { sanitize: true })
            }
            if (!this.isCurrent(snapshot)) break
            const previous = store.getStoryRound?.(storyId, snapshot.branchId, round.index)
            if (previous?.content_version === input.contentVersion && previous.valid === 1) continue
            // Q7: persist NULL vectors first; inference belongs to the deferred worker.
            store.upsertStoryRound(input)
            requestEmbeddingBackfill({ storyId, branchId: snapshot.branchId })
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
          if (!this.isCurrent(snapshot)) this.retainReceipts(snapshot)
        } catch (error) {
          this.retainReceipts(snapshot)
          this.report(error)
        } finally {
          if (this.latest.get(snapshot.key) === snapshot) this.latest.delete(snapshot.key)
        }
      }
    } catch (error) {
      this.report(error)
    } finally {
      if (this.jobs.get(storyId) === queue) this.jobs.delete(storyId)
      for (const [key, snapshot] of this.latest) {
        if (snapshot.storyId === storyId) this.latest.delete(key)
      }
      for (const key of this.generations.keys()) {
        if (JSON.parse(key)[0] === storyId) this.generations.delete(key)
      }
    }
  }
}

export const storyArchiveService = new StoryArchiveService()

