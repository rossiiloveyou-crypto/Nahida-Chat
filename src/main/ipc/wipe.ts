import { app, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { WipeCaptcha, WipeExecuteResult, WipePreview } from '@shared/api'
import { chatService } from '../features/chat/chatService'
import { memoryService } from '../features/rag'
import { summaryService } from '../features/summary/service'
import { storyStore } from '../features/story/store'
import { wipeAllData } from '../features/wipe'
import { relaunchAfterWipe } from '../features/wipe/relaunch'

/**
 * P7 · 「清空全部数据」的 IPC 层（薄转发 + **验证码状态机**）。
 *
 * 🔴 验证码的真值只在**主进程**：
 *    - 渲染层拿到的 code 只用于显示，它不是权威；
 *    - 若前端自己 Math.random() 再送去比对，任何人打开 DevTools 就能读到它，
 *      验证码等于没有（S4：可绕过 = 这个 Phase 没做）。
 *
 * 🔴 failures 按「本次弹框」计数（wipeCaptcha 里清零），不是按进程累计：
 *    M16 的「错 3 次」指的是这一个框里错 3 次。按进程累计会让用户错一次、关掉、
 *    重开、再错一次就被锁死。
 */

/**
 * 🔴 TTL 存在的理由：弹框生成码之后用户可能去泡茶。
 *    没有过期时间的话，一个五分钟前显示的码仍然有效 —— 那和「码固定」区别不大。
 */
const CAPTCHA_TTL_MS = 5 * 60_000
/** M16：错 3 次关闭弹框并提示「删除失败」 */
const MAX_FAILURES = 3

interface CaptchaState {
  code: string
  createdAt: number
}

let current: CaptchaState | null = null
let failures = 0

/** 测试用：把状态机复位（生产路径不需要，重启一次就回到初始态） */
export function resetWipeCaptchaForTest(): void {
  current = null
  failures = 0
}

function bytesOf(userData: string, rel: string): number {
  try {
    const stat = statSync(join(userData, rel))
    return stat.isDirectory() ? -1 : stat.size
  } catch {
    return 0
  }
}

function storiesStats(userData: string): { count: number; bytes: number } {
  const dir = join(userData, 'stories')
  if (!existsSync(dir)) return { count: 0, bytes: 0 }
  let count = 0
  let bytes = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      count += 1
      for (const file of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (file.isDirectory()) continue
        try {
          bytes += statSync(join(dir, entry.name, file.name)).size
        } catch {
          // 单个文件读不到不影响清单：字节数只是给用户看的量级
        }
      }
    }
  } catch {
    return { count, bytes }
  }
  return { count, bytes }
}

/**
 * 清单：要删什么 / 要留什么。
 *
 * 🔴 这张表就是 §1.3 的实现 —— 少一项是漏删，多一项是误删（WP-01…WP-11 逐项比对）。
 * 🔴 它**不生成码**：M15 要求「点清空按钮后才生成」。
 */
export function buildWipePreview(): WipePreview {
  const userData = app.getPath('userData')
  const story = storiesStats(userData)
  let sessions = 0
  try {
    sessions = chatService.listSessions().length
  } catch {
    sessions = 0
  }
  let users = 0
  try {
    users = memoryService.listUserIds().length
  } catch {
    users = 0
  }
  let summaries = 0
  try {
    summaries = summaryService.status().sessionCount
  } catch {
    summaries = 0
  }

  return {
    willDelete: [
      {
        path: 'sessions.json',
        detail: sessions + ' 个会话（清空后写回 []，文件保留）',
        bytes: bytesOf(userData, 'sessions.json')
      },
      {
        path: 'memory.db 三张表',
        detail: users + ' 个用户的记忆 / 人设历史 / 人设注册（清数据，不删库文件）',
        bytes: bytesOf(userData, 'memory.db')
      },
      {
        path: 'stories/',
        detail: story.count + ' 个故事及其各自的记忆库（整目录删除）',
        bytes: story.bytes
      },
      {
        path: 'summaries.json',
        detail: summaries + ' 份对话摘要（摘要会被无条件注入，所以它也算「记得的东西」）',
        bytes: bytesOf(userData, 'summaries.json')
      },
      {
        path: 'zones.json.retired-bak',
        detail: '区块数据的历史副本（你 2026-11-14 裁决「一起删了」）',
        bytes: bytesOf(userData, 'zones.json.retired-bak')
      }
    ],
    willKeep: [
      { path: 'settings.json', why: '模型 / API Key / 记忆与摘要的参数' },
      { path: 'channels/', why: '授权 —— 删数据不删人，清完你仍然能对话' },
      { path: 'observe/', why: '群聊语料（只增不清，代码层没有删除能力）' },
      { path: 'snowluma/', why: 'QQ 宿主运行时与 QQ 侧消息库' },
      { path: 'presets/', why: '你手调的预设快照' },
      { path: 'workspace/', why: '工具的工作区文件（你的文件，不是聊天数据）' },
      { path: 'qq/settings.json', why: 'QQ 面板的行为设置' },
      { path: 'memory.db.p5-backup', why: '改造前的旧库副本（memory-scope-counts 套件依赖它）' },
      { path: 'models/', why: '向量模型（本机可能没有；有就不动）' },
      { path: 'Local Storage / Cookies', why: 'Electron 自带，未验证内容，宁少不清' }
    ]
  }
}

/** 当前验证码状态（只读快照，给测试与诊断用；不改状态） */
export function wipeCaptchaState(): { active: boolean; failures: number } {
  return { active: current !== null, failures }
}

export function registerWipeIpcHandlers(): void {
  ipcMain.handle(IPC.wipePreview, (): WipePreview => buildWipePreview())

  // M15：点「我明白，生成验证码」之后才生成；每次开弹框都换新码
  ipcMain.handle(IPC.wipeCaptcha, (): WipeCaptcha => {
    current = { code: randomBytes(4).toString('hex'), createdAt: Date.now() }
    failures = 0
    return { code: current.code, ttlMs: CAPTCHA_TTL_MS }
  })

  ipcMain.handle(IPC.wipeExecute, async (_event, input?: { code?: string }): Promise<WipeExecuteResult> => {
    if (!current) return { ok: false, reason: 'no_captcha' }
    if (Date.now() - current.createdAt > CAPTCHA_TTL_MS) {
      current = null
      failures = 0
      return { ok: false, reason: 'expired' }
    }
    const given = String(input?.code ?? '').trim()
    if (given !== current.code) {
      failures += 1
      if (failures >= MAX_FAILURES) {
        // M16：第 3 次 → 码作废、弹框关闭、提示「删除失败」
        current = null
        failures = 0
        return { ok: false, reason: 'too_many_failures' }
      }
      // M16：前 1、2 次 → 留在弹框、清空输入、码不变
      return { ok: false, reason: 'wrong' }
    }

    const report = await wipeAllData({ confirmed: true })
    current = null
    failures = 0
    if (!report.ok) return { ok: false, reason: 'failed', report }
    // M14：报告先回给渲染层，再重启 —— 用 setImmediate 让 IPC 回复先发出去。
    // 🔴 顺序反了用户看到的是「点了就闪退」，而不是「删完了，正在重启」。
    // 🔴 D-5：重启怎么走由 features/wipe/relaunch.ts 决定 —— 开发模式下 app.relaunch()
    //    会把窗口指回已经随旧实例退出的 dev server（ERR_CONNECTION_REFUSED 白屏），
    //    所以那里改成重拉整条 dev 链路。别把这里换回 app.relaunch()。
    setImmediate(() => relaunchAfterWipe())
    return { ok: true, report }
  })
}
