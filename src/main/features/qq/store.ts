import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { QqSettings } from '@shared/qq'
import { DEFAULT_QQ_SETTINGS, QQ_SETTINGS_LIMITS } from '@shared/qq'
import { normalizeThresholds } from '@shared/persona'

/**
 * QQ 设置的持久化（P4 G3）。
 *
 * P6：本文件原本还管「外部会话 ↔ 本机会话」的绑定表，绑定表已废弃 ——
 * 授权改由 features/channels 的 access.json 承担，会话 id 由外部键直接算出。
 * `userData/qq/bindings.json` **原地保留、不再读取**（只增不清，绝不自动删除用户数据）。
 *
 * 目录是 `userData/qq`，**不是** `userData/snowluma`：后者是 SL 自己的 cwd
 * （config/ logs/ data/ 全在里面），混在一起会让备份与清理无法区分（蓝图 §2.2）。
 *
 * 存储纪律：
 *  - 写：write tmp → rename（原子；与 chatService.persist 同款）
 *  - 读：文件不存在 → 默认值；JSON 解析失败 → **记 warn + 回落默认值，不抛**
 *    （一个坏文件不该让 QQ 功能整体瘫痪）
 *  - 归一化：数字字段钳到区间，缺字段回落默认值
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, raw))
}

export function normalizeSettings(value: unknown): QqSettings {
  const raw = asRecord(value) ?? {}
  const limits = QQ_SETTINGS_LIMITS
  const mode = raw.typingMode === 'status' || raw.typingMode === 'off' ? raw.typingMode : 'text'
  const typingTextRaw = text(raw.typingText)
  return {
    typingMode: mode,
    typingText: typingTextRaw
      ? Array.from(typingTextRaw).slice(0, limits.typingText.maxLength).join('')
      : DEFAULT_QQ_SETTINGS.typingText,
    typingEventType: clampInt(
      raw.typingEventType,
      limits.typingEventType.min,
      limits.typingEventType.max,
      DEFAULT_QQ_SETTINGS.typingEventType
    ),
    groupRequireMention:
      typeof raw.groupRequireMention === 'boolean'
        ? raw.groupRequireMention
        : DEFAULT_QQ_SETTINGS.groupRequireMention,
    atOnGroupReply:
      typeof raw.atOnGroupReply === 'boolean' ? raw.atOnGroupReply : DEFAULT_QQ_SETTINGS.atOnGroupReply,
    segmentDelayMs: clampInt(
      raw.segmentDelayMs,
      limits.segmentDelayMs.min,
      limits.segmentDelayMs.max,
      DEFAULT_QQ_SETTINGS.segmentDelayMs
    ),
    maxSegments: clampInt(
      raw.maxSegments,
      limits.maxSegments.min,
      limits.maxSegments.max,
      DEFAULT_QQ_SETTINGS.maxSegments
    ),
    maxCharsPerSegment: clampInt(
      raw.maxCharsPerSegment,
      limits.maxCharsPerSegment.min,
      limits.maxCharsPerSegment.max,
      DEFAULT_QQ_SETTINGS.maxCharsPerSegment
    ),
    rateLimitPerUser: clampInt(
      raw.rateLimitPerUser,
      limits.rateLimitPerUser.min,
      limits.rateLimitPerUser.max,
      DEFAULT_QQ_SETTINGS.rateLimitPerUser
    ),
    rateLimitPerChannel: clampInt(
      raw.rateLimitPerChannel,
      limits.rateLimitPerChannel.min,
      limits.rateLimitPerChannel.max,
      DEFAULT_QQ_SETTINGS.rateLimitPerChannel
    ),
    errorReplyText:
      typeof raw.errorReplyText === 'string' ? raw.errorReplyText.slice(0, 200) : DEFAULT_QQ_SETTINGS.errorReplyText,
    // 🔴 不做深合并：normalizeThresholds 已经是「逐字段回落出厂值」，
    //    再套一层合并会让「用户把某条设成 none」被误判成「没设」（none 是假值，?? 会跳过它）。
    commandThresholds: normalizeThresholds(raw.commandThresholds)
  }
}

export class QqStore {
  private readonly explicitDir: string | null

  /** 传 dir 可把存储放到别处（测试用）；缺省是 userData/qq */
  constructor(dir?: string) {
    this.explicitDir = dir ? dir : null
  }

  get dir(): string {
    return this.explicitDir ?? join(app.getPath('userData'), 'qq')
  }

  get settingsFile(): string {
    return join(this.dir, 'settings.json')
  }

  settings(): QqSettings {
    return normalizeSettings(this.readJson(this.settingsFile))
  }

  saveSettings(patch: Partial<QqSettings>): QqSettings {
    const next = normalizeSettings({ ...this.settings(), ...patch })
    this.writeJson(this.settingsFile, next)
    return next
  }

  private readJson(file: string): unknown {
    try {
      if (!existsSync(file)) return null
      return JSON.parse(readFileSync(file, 'utf8')) as unknown
    } catch (error) {
      console.warn('[qq-store] 读取失败，回落默认值：' + file, error)
      return null
    }
  }

  private writeJson(file: string, value: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      console.error('[qq-store] 落盘失败：' + file, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
}

/** 主进程单例（渲染层不直接拿它，走 IPC） */
export const qqStore = new QqStore()
