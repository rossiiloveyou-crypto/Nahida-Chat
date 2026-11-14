import { app, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { DEFAULT_PERSONA_ID } from '@shared/persona'
import type { MemoryDeleteReport, MemoryPersonaRow, MemoryUserDetail, MemoryUserRow } from '@shared/api'
import { channelStore } from '../features/channels/store'
import { chatService } from '../features/chat/chatService'
import { memoryService } from '../features/rag'
import { summaryService } from '../features/summary/service'

function listUsers(): MemoryUserRow[] {
  const accounts = channelStore.config().accounts
  const byAccount = new Map(accounts.map((account) => [account.userId, account]))
  const byMemoryCount = new Map(memoryService.countByUser().map((row) => [row.userId, row.count]))
  const userIds = new Set([...memoryService.listUserIds(), ...accounts.map((account) => account.userId)])

  return [...userIds].sort().map((userId) => {
    const account = byAccount.get(userId)
    const personas = memoryService.listPersonas(userId)
    return {
      userId,
      label: userId === 'root' ? '本机' : account?.label ?? '',
      inAllowList: Boolean(account),
      personaCount: personas.length,
      memoryCount: byMemoryCount.get(userId) ?? 0,
      historyCount: personas.reduce((total, persona) => total + memoryService.countHistory(userId, persona.personaId), 0),
      lastAt: account?.lastAt ?? 0
    }
  })
}

function userDetail(userId: string): MemoryUserDetail {
  const accounts = channelStore.config().accounts
  const account = accounts.find((item) => item.userId === userId)
  const accessRows = new Map(accounts.map((item) => [item.userId, item]))
  const personas: MemoryPersonaRow[] = memoryService.listPersonas(userId).map((persona) => ({
    personaId: persona.personaId,
    isActive: persona.isActive,
    memoryCount: memoryService.countByPersona(userId).find((row) => row.personaId === persona.personaId)?.count ?? 0,
    historyCount: memoryService.countHistory(userId, persona.personaId),
    createdAt: persona.createdAt
  }))
  const sessions = chatService.listSessions()
    .filter((session) => {
      const parts = session.id.split(':')
      return parts.length >= 4 && parts[0] === 'qq' && parts[2] === 'private' && parts.slice(3).join(':') === userId
    })
    .map((session) => ({ sessionId: session.id, title: session.title, updatedAt: session.updatedAt }))

  return {
    userId,
    label: userId === 'root' ? '本机' : account?.label ?? '',
    inAllowList: accessRows.has(userId),
    personas: personas.sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.createdAt - b.createdAt),
    sessions,
    dbPath: memoryService.status(undefined).dbPath,
    userDataPath: app.getPath('userData')
  }
}

function deleteUser(userId: string): MemoryDeleteReport {
  const summaries = summaryService.forgetByUser(userId)
  const sessions = chatService.deleteSessionsOfUser(userId)
  const { histories, memories, personas } = memoryService.deleteByUser(userId)
  const stillAuthorized = channelStore.config().accounts.some((account) => account.userId === userId)
  return { userId, personaId: null, memories, histories, personas, summaries, sessions, stillAuthorized }
}

function deletePersona(userId: string, personaId: string): MemoryDeleteReport {
  const persona = memoryService.listPersonas(userId).find((item) => item.personaId === personaId)
  if (!persona) throw new Error('人设不存在')
  if (personaId === DEFAULT_PERSONA_ID || persona.isActive) throw new Error('默认人设或激活人设不能删除')
  const histories = memoryService.countHistory(userId, personaId)
  const memories = memoryService.countByPersona(userId).find((item) => item.personaId === personaId)?.count ?? 0
  const sessionIds = chatService.listSessions()
    .filter((session) => {
      const parts = session.id.split(':')
      return userId === 'root'
        ? parts.length < 4 || parts[0] !== 'qq'
        : parts.length >= 4 && parts[0] === 'qq' && parts[2] === 'private' && parts.slice(3).join(':') === userId
    })
    .map((session) => session.id)
  const removedMemories = memoryService.deletePersonaWithData(userId, personaId)
  const removedSummaryCount = sessionIds.reduce((count, sessionId) => count + Number(summaryService.forgetPersona(sessionId, personaId)), 0)
  return {
    userId,
    personaId,
    memories: removedMemories,
    histories,
    personas: 1,
    summaries: removedSummaryCount,
    sessions: 0,
    stillAuthorized: channelStore.config().accounts.some((account) => account.userId === userId)
  }
}

export function registerMemoryIpcHandlers(): void {
  ipcMain.handle(IPC.memoryUsers, () => listUsers())
  ipcMain.handle(IPC.memoryUserDetail, (_event, userId: string) => userDetail(String(userId ?? '')))
  ipcMain.handle(IPC.memoryUserEntries, (_event, userId: string, personaId: string) => ({
    entries: memoryService.listByTenant(String(userId ?? ''), String(personaId ?? '')),
    history: memoryService.recentHistory(String(userId ?? ''), String(personaId ?? ''), 20)
  }))
  ipcMain.handle(IPC.memoryDeleteUser, (_event, userId: string) => deleteUser(String(userId ?? '')))
  ipcMain.handle(IPC.memoryDeletePersona, (_event, userId: string, personaId: string) =>
    deletePersona(String(userId ?? ''), String(personaId ?? ''))
  )
  // 🔴 打开的是 **userData**，不是 modelPath（M19 / J-14 的同源坑：memoryOpenModel 打开的是模型目录）。
  //    静态 import shell 而不是 `await import('electron')`：动态 import 在 CJS 产物里会退化
  //    成真正的 ESM 解析，测试环境（以及任何 external 打包）直接 ERR_MODULE_NOT_FOUND。
  ipcMain.handle(IPC.memoryOpenDir, () => shell.openPath(app.getPath('userData')))
}
