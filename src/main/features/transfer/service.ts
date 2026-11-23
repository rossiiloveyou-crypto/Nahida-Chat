import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { dialog } from 'electron'
import { isChannelSessionId } from '@shared/channels'
import {
  MAX_TRANSFER_BYTES,
  type ExportRequest,
  type ImportPreview,
  type ImportRequest,
  type ParsedTransfer,
  type TransferResult
} from '@shared/transfer'
import type { ImportedFrom, Message } from '@shared/types'
import { chatService, INTERRUPTED_NOTICE } from '../chat/chatService'
import { promptStore } from '../prompt/promptStore'
import { settingsStore } from '../settings/settingsStore'
import { registerImportedBranch } from '../story/importBranch'
import { isStoryId } from '../story/paths'
import { createStory, getStory, storyStoreOf } from '../story/service'
import { uniqueFileName } from './names'
import { assertTransferMessageLimit, isRecord, serializeNc } from './ncFormat'
import { parseTransfer, resolveStName, serializeSt } from './stFormat'

const PREVIEW_TTL = 10 * 60 * 1000
const MAX_PREVIEWS = 16
interface PendingImport {
  path: string
  sha256: string
  mtimeMs: number
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}
const pending = new Map<string, PendingImport>()
let picking = false
let importing = false
let exporting = false

function transferError(error: unknown, fallback: string): string {
  // Node 文件错误包含绝对路径，不跨 IPC 返回。
  if (error instanceof Error && !('code' in error)) return error.message
  return fallback
}

async function readSource(path: string): Promise<{ text: string; sha256: string; mtimeMs: number }> {
  if (!(await stat(path)).isFile()) throw new Error('请选择普通对话文件')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  const bytesExceeded = (size: number): never => {
    throw new Error('对话文件大小为 ' + size + ' 字节，超过 64 MiB（' + MAX_TRANSFER_BYTES + ' 字节）上限')
  }
  try {
    const info = await fd.stat()
    if (!info.isFile()) throw new Error('请选择普通对话文件')
    if (info.size > MAX_TRANSFER_BYTES) bytesExceeded(info.size)
    const bytes = Buffer.allocUnsafe(info.size + 1)
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await fd.read(bytes, count, bytes.length - count, count)
      if (!bytesRead) break
      count += bytesRead
    }
    const end = await fd.stat()
    if (end.size > MAX_TRANSFER_BYTES) bytesExceeded(end.size)
    if (count !== info.size || end.mtimeMs !== info.mtimeMs || end.size !== info.size) {
      throw new Error('源文件读取时发生变化，请重新选择')
    }
    const raw = bytes.subarray(0, count)
    return { text: raw.toString('utf8'), sha256: createHash('sha256').update(raw).digest('hex'), mtimeMs: info.mtimeMs }
  } finally {
    await fd.close()
  }
}

function sourceTitle(path: string): string {
  return basename(path).replace(/(?:\.nc\.json|\.jsonl|\.json)$/i, '')
}

function dropPreview(token: string): void {
  const preview = pending.get(token)
  if (preview) clearTimeout(preview.timer)
  pending.delete(token)
}

function makePreview(token: string, path: string, parsed: ParsedTransfer, fingerprint: string): ImportPreview {
  const roleCounts: ImportPreview['roleCounts'] = { user: 0, assistant: 0, narration: 0, system: 0 }
  let first: Message | undefined
  let last: Message | undefined
  let messageCount = 0
  for (const { messages } of parsed.sessions) {
    messageCount += messages.length
    for (const message of messages) {
      roleCounts[message.role]++
      first ??= message
      last = message
    }
  }
  assertTransferMessageLimit(messageCount)
  const summarize = (message: Message | undefined): string | null =>
    message ? message.content.slice(0, 320).replace(/\s+/g, ' ').trim().slice(0, 160) : null
  const characters = promptStore.library().characters
  const normalize = (name: string): string => name.normalize('NFKC').trim().toLowerCase()
  const wantedName = normalize((parsed.format === 'st'
    ? resolveStName(parsed.characterName, sourceTitle(path))
    : parsed.characterName) ?? '')
  const wantedId = parsed.sessions[0]?.characterId
  const match = characters.find((character) => character.id === wantedId)
    ?? (wantedName ? characters.find((character) => normalize(character.name) === wantedName) : undefined)
    ?? (wantedName ? characters.find((character) => {
      const name = normalize(character.name)
      return name && (wantedName.includes(name) || name.includes(wantedName))
    }) : undefined)
  const defaultId = settingsStore.get().defaultCharacterId
  return {
    token,
    fileName: basename(path),
    format: parsed.format,
    title: parsed.title,
    characterName: parsed.characterName,
    userName: parsed.userName,
    sessionCount: parsed.sessions.length,
    messageCount,
    roleCounts,
    skippedLines: parsed.skippedLines,
    discardedFields: parsed.discardedFields,
    firstMessageSummary: summarize(first),
    lastMessageSummary: summarize(last),
    suggestedCharacterId: match?.id ?? characters.find((character) => character.id === defaultId)?.id ?? characters[0]?.id ?? defaultId,
    characterMatched: Boolean(match),
    duplicateCount: chatService.countTransferImports(fingerprint)
  }
}

function validShape(value: unknown, keys: string[], optionalText: string[] = []): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key) || optionalText.includes(key))
    && optionalText.every((key) => value[key] === undefined || typeof value[key] === 'string')
}

function validateImport(request: ImportRequest): void {
  if (!validShape(request, ['token', 'target'], ['title']) || typeof request.token !== 'string') {
    throw new Error('导入请求无效')
  }
  const target = request.target
  if (target?.kind === 'session' && validShape(target, ['kind', 'mode', 'characterId']) &&
      (target.mode === 'chat' || target.mode === 'agent') && typeof target.characterId === 'string') return
  if (target?.kind === 'story-branch' && validShape(target, ['kind', 'storyId', 'makeActive']) &&
      isStoryId(target.storyId) && (target.makeActive === undefined || typeof target.makeActive === 'boolean')) return
  if (target?.kind === 'new-story' && validShape(target, ['kind', 'characterId', 'worldbookMode'], ['synopsis', 'profile', 'worldbookDir', 'background']) &&
      typeof target.characterId === 'string' && [undefined, 'default', 'override'].includes(target.worldbookMode)) return
  throw new Error('导入目标或模式无效')
}

function cleanMessage(message: Message): Message {
  // 扁平投影：源 id、外部引用、路径、扩展字段均不进入新的会话对象。
  const { role, content, createdAt, status, reasoning, warnings, error } = message
  return {
    id: randomUUID(), role, content, createdAt,
    status: status === 'streaming' ? 'error' : status,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(warnings === undefined ? {} : { warnings: [...warnings] }),
    ...(error !== undefined || status === 'streaming' ? { error: error || (status === 'streaming' ? INTERRUPTED_NOTICE : error) } : {}),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map((call) => ({
      id: randomUUID(), name: call.name, title: call.title, readOnly: call.readOnly, arguments: call.arguments,
      status: call.status, result: call.result, error: call.error, startedAt: call.startedAt, durationMs: call.durationMs
    })) })
  }
}

function applyImport(request: ImportRequest, parsed: ParsedTransfer, sha256: string): TransferResult {
  const { target } = request
  const story = target.kind === 'story-branch' ? getStory(target.storyId) : null
  if (target.kind === 'story-branch' && !story) throw new Error('目标故事区不存在')
  const characterId = target.kind === 'story-branch' ? story!.characterId : target.characterId
  if (!promptStore.hasCharacter(characterId)) throw new Error('所选角色不存在，请检查提示词库')
  if (target.kind !== 'session' && parsed.sessions.length !== 1) throw new Error('故事区每次仅支持导入一个会话')
  const previous = story ? chatService.listSessionsByStory(story.storyId) : []
  const source: ImportedFrom = { fingerprint: sha256.slice(0, 16), format: parsed.format, importId: randomUUID() }
  let newStoryId: string | undefined
  try {
    const sessions = chatService.commitImportedSessions(() => parsed.sessions.map((data, i) => {
      const title = (i === 0 ? request.title?.trim() : undefined) || data.title.trim()
      let id: string
      if (target.kind === 'new-story') {
        const created = createStory({
          title, characterId, synopsis: target.synopsis, profile: target.profile,
          worldbookMode: target.worldbookMode, worldbookDir: target.worldbookDir, background: target.background
        })
        newStoryId = created.meta.storyId
        id = created.sessionId
      } else {
        id = chatService.createSession(target.kind === 'session'
          ? { mode: target.mode, characterId, title }
          : { mode: 'story', storyId: target.storyId, characterId, title }).id
      }
      return chatService.initializeImportedSession(id, data.messages.map(cleanMessage), source)
    }), target.kind === 'story-branch'
      ? ([session]) => registerImportedBranch(session, previous, target.makeActive !== false)
      : undefined)
    return {
      ok: true,
      sessionIds: sessions.map((session) => session.id),
      storyId: story?.storyId ?? newStoryId,
      sessionCount: sessions.length,
      messageCount: sessions.reduce((count, session) => count + session.messages.length, 0),
      warnings: parsed.skippedLines ? ['跳过 ' + parsed.skippedLines + ' 行无效记录'] : []
    }
  } catch (error) {
    if (newStoryId && !storyStoreOf().removeDir(newStoryId)) {
      throw new Error('导入失败，新建故事区清理失败，请检查存储目录')
    }
    throw error
  }
}

async function saveUnique(dir: string, stem: string, extension: string, text: string): Promise<string> {
  const names = new Set(await readdir(dir))
  while (true) {
    const name = uniqueFileName(stem, extension, names)
    const path = join(dir, name)
    let fd
    try {
      fd = await open(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      names.add(name)
      continue
    }
    try {
      try { await fd.writeFile(text, 'utf8') } finally { await fd.close() }
      return name
    } catch (error) {
      await unlink(path)
      throw error
    }
  }
}

export const transferService = {
  async pickImport(): Promise<ImportPreview | null> {
    if (picking || importing) throw new Error('正在处理另一个导入请求')
    picking = true
    try {
      const chosen = await dialog.showOpenDialog({
        title: '选择对话文件', properties: ['openFile'],
        filters: [{ name: '对话文件', extensions: ['jsonl', 'json'] }, { name: '所有文件', extensions: ['*'] }]
      })
      if (chosen.canceled || !chosen.filePaths[0]) return null
      const path = chosen.filePaths[0]
      const { text, sha256, mtimeMs } = await readSource(path)
      const parsed = parseTransfer(text, { mtimeMs, fallbackTitle: sourceTitle(path) })
      const token = randomUUID()
      const preview = makePreview(token, path, parsed, sha256.slice(0, 16))
      if (pending.size >= MAX_PREVIEWS) dropPreview(pending.keys().next().value!)
      const timer = setTimeout(() => dropPreview(token), PREVIEW_TTL)
      timer.unref()
      pending.set(token, { path, sha256, mtimeMs, expiresAt: Date.now() + PREVIEW_TTL, timer })
      return preview
    } catch (error) {
      throw new Error(transferError(error, '读取对话文件失败'))
    } finally {
      picking = false
    }
  },

  async import(request: ImportRequest): Promise<TransferResult> {
    if (importing || picking) return { ok: false, error: '正在处理另一个导入请求' }
    try {
      validateImport(request)
      const input = pending.get(request.token)
      if (!input || input.expiresAt <= Date.now()) {
        dropPreview(request.token)
        throw new Error('导入预览已失效，请重新选择文件')
      }
      importing = true
      const { text, sha256 } = await readSource(input.path)
      if (input.expiresAt <= Date.now() || sha256 !== input.sha256) {
        dropPreview(request.token)
        throw new Error('预览已过期或源文件已修改，请重新选择文件')
      }
      const parsed = parseTransfer(text, { mtimeMs: input.mtimeMs, fallbackTitle: sourceTitle(input.path) })
      const result = applyImport(request, parsed, sha256)
      dropPreview(request.token)
      return result
    } catch (error) {
      return { ok: false, error: transferError(error, '导入失败，请检查源文件与存储目录') }
    } finally {
      importing = false
    }
  },

  async export(request: ExportRequest): Promise<TransferResult> {
    if (exporting) return { ok: false, error: '正在处理另一个导出请求' }
    exporting = true
    const created: string[] = []
    let dir: string | undefined
    try {
      const valid = request?.scope === 'all' && validShape(request, ['format', 'scope'])
        || request?.scope === 'current' && validShape(request, ['format', 'scope', 'sessionId']) && typeof request.sessionId === 'string'
      if (!valid || (request.format !== 'nc' && request.format !== 'st')) throw new Error('导出请求无效')
      const sessions = request.scope === 'all' ? chatService.listDesktopSessions()
        : chatService.listSessions().filter((session) => session.id === request.sessionId && !isChannelSessionId(session.id))
      if (!sessions.length) throw new Error('没有可导出的桌面会话')
      const extension = request.format === 'nc' ? '.nc.json' : '.jsonl'
      const chosen = await dialog.showSaveDialog({
        title: request.format === 'st' && sessions.length > 1 ? '选择首个会话的保存位置（其余保存到同一目录）' : '导出对话',
        defaultPath: uniqueFileName(request.scope === 'all' && request.format === 'nc' ? 'Nahida Chat 对话备份' : sessions[0].title, extension, []),
        filters: [{ name: request.format === 'nc' ? 'NC 备份' : '酒馆对话', extensions: [request.format === 'nc' ? 'json' : 'jsonl'] }]
      })
      if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true }
      dir = dirname(chosen.filePath)
      const stem = sourceTitle(chosen.filePath)
      let narrationCount = 0
      if (request.format === 'nc') {
        created.push(await saveUnique(dir, stem, extension, serializeNc(sessions)))
      } else {
        const configuredUserName = settingsStore.get().userName
        const userName = (typeof configuredUserName === 'string' && configuredUserName.trim()) || 'User'
        const characters = new Map(promptStore.library().characters.map(({ id, name }) => [id, name]))
        for (const [i, session] of sessions.entries()) {
          const { text, narrationCount: count } = serializeSt(session.messages, {
            userName, characterName: characters.get(session.characterId) ?? session.characterId
          })
          narrationCount += count
          created.push(await saveUnique(dir, i ? session.title : stem, extension, text))
        }
      }
      return {
        ok: true, fileNames: created, sessionCount: sessions.length,
        messageCount: sessions.reduce((count, session) => count + session.messages.length, 0),
        warnings: narrationCount ? [narrationCount + ' 条旁白在酒馆侧会变成角色发言'] : []
      }
    } catch (error) {
      if (dir) await Promise.allSettled(created.map((name) => unlink(join(dir!, name))))
      return { ok: false, error: transferError(error, '导出失败，请检查保存目录') }
    } finally {
      exporting = false
    }
  }
}
