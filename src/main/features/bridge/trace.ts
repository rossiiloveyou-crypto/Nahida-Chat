/** 每轮只记诊断计数与步骤，不记录消息正文或提示词正文。 */
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_TRACE_BYTES = 2 * 1024 * 1024

export interface BridgeTraceDisk {
  injected: number
  expectedLines: number
  actualLines: number
  deleted: boolean
  backupDelta: number
  file: string
  waitMs: number
}

export interface BridgeTraceRecord {
  at: string
  sessionId: string
  before: number
  sent: number
  inChat: number
  /** chat 中未标 is_system 的行数，是 coreChat 过滤代理值，不是出站证明。 */
  inPrompt: number
  promptsWritten: number
  cardName: string
  steps: string[]
  disk?: BridgeTraceDisk
}

export function appendBridgeTrace(record: BridgeTraceRecord, userData = app.getPath('userData')): void {
  const directory = join(userData, 'nc-bridge')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'bridge-trace.jsonl')
  const line = JSON.stringify(record) + '\n'
  if (existsSync(file) && statSync(file).size + Buffer.byteLength(line, 'utf8') > MAX_TRACE_BYTES) {
    const backup = join(directory, 'bridge-trace.1.jsonl')
    rmSync(backup, { force: true })
    renameSync(file, backup)
  }
  appendFileSync(file, line, 'utf8')
}
