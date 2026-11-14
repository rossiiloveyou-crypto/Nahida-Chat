import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chatService } from '../chat/chatService'
import { memoryService } from '../rag'
import { summaryService } from '../summary/service'
import { storyStore } from '../story/store'
import { closeAllStoryMemory, closeStoryMemory } from '../story/memory'

/**
 * P7（M13 + M14）：「清空全部数据」的**唯一编排单元**。
 *
 * 🔴 为什么必须是主进程的一个函数、而不是渲染层连调四个 IPC：
 *    ① 中途失败会留下「半清空」状态，用户不知道清到哪一步；
 *    ② 顺序（先 stop 再删）在渲染层根本无法保证 —— 在飞的生成会在 finally 里
 *       persist()，把刚删掉的会话写回来（P3 的 D-04 同源坑）。
 *
 * 🔴 顺序就是判据（不许调换）：
 *    确认 → 备份并逐项校验 → 停所有在飞任务 → 清会话写回 [] → 清主库三表 →
 *    清摘要 → 删 stories/ → 删 zones.json.retired-bak → 复核。
 *
 * 🔴 本函数**不重启**：重启由 IPC 层在把报告回给渲染层之后触发
 *    （否则用户看到的是「点了就闪退」，而不是「删完了，正在重启」）。
 *
 * 🔴 删除面：sessions.json（写回 []） / memory.db 三表 / stories/ 整目录 /
 *    summaries.json 的 items；外加 zones.json.retired-bak（H-C-14 用户裁决）。
 * 🔴 保留面一个字节都不碰：settings.json / observe/ / snowluma/ / models/ / presets/ /
 *    channels/ / qq/settings.json / workspace/ / memory.db.p5-backup / Local Storage / Cookies。
 */
export interface WipeReport {
  /** 清掉的会话条数 */
  sessions: number
  memories: number
  histories: number
  personas: number
  summaries: number
  /** 删掉的故事区目录数 */
  stories: number
  /** 备份落在哪（用户可以自己去看） */
  backupDir: string
  ok: boolean
  detail: string
}

export interface WipeOptions {
  confirmed: boolean
  /**
   * 备份目录的**父目录**；缺省 = userData 的上一级（%APPDATA%）。
   * 只给测试用 —— 生产路径不接受渲染层传值（否则用户能把它指到任意位置）。
   */
  backupRoot?: string
}

/** 必须进备份的四个文件（其余保留项不属于「聊天与记忆」，无需备份） */
const BACKUP_FILES = ['sessions.json', 'memory.db', 'summaries.json', 'settings.json'] as const
/** SQLite 侧车文件：不备份（内容属于主库；且合法为空） */
const SIDECAR = /\.db-(?:wal|shm)$/i
/** 这个相对路径是不是一个 SQLite 库（顶层 memory.db 与 stories/<id>/memory.db 都算） */
function isSqliteDb(rel: string): boolean {
  return /(^|[\\/])memory\.db$/.test(rel)
}
/** 区块数据的历史副本（H-C-14：用户裁决「一起删了」） */
const RETIRED_ZONES_FILE = 'zones.json.retired-bak'
export const BACKUP_PREFIX = 'Nahida Chat.p7-backup-'

interface BackupPair {
  rel: string
  from: string
  to: string
}

function emptyReport(detail: string): WipeReport {
  return {
    sessions: 0,
    memories: 0,
    histories: 0,
    personas: 0,
    summaries: 0,
    stories: 0,
    backupDir: '',
    ok: false,
    detail
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 备份目录名的时间戳：YYYYMMDD-HHmmss（本地时区，人能读） */
function stamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  )
}

/**
 * memory.db 的一致快照（J-17）。
 *
 * 🔴 为什么不是直接 copyFileSync：WAL 模式下主文件与 -wal 里各有一半页面，
 *    单拷主文件会得到「少最近几十条」的库。VACUUM INTO 由 SQLite 自己写出一致快照。
 * ⚠️ 它要求目标文件不存在，所以目标是新目录里的新文件。
 */
function snapshotMemoryDb(from: string, to: string): boolean {
  try {
    const db = new DatabaseSync(from)
    try {
      db.exec("VACUUM INTO '" + to.replace(/'/g, "''") + "'")
    } finally {
      db.close()
    }
  } catch {
    // 库坏 / 被别的事务占住 → 落到逐字节拷贝（至少还能拿回大部分）
  }
  if (existsSync(to)) return true
  try {
    copyFileSync(from, to)
  } catch {
    return false
  }
  return existsSync(to)
}

/** 列要备份的（源 → 备份）配对：四个关键文件 + 每个故事区目录里的全部文件 */
function planBackup(userData: string, backupDir: string): BackupPair[] {
  const pairs: BackupPair[] = []
  for (const name of BACKUP_FILES) {
    const from = join(userData, name)
    if (existsSync(from)) pairs.push({ rel: name, from, to: join(backupDir, name) })
  }
  const storiesDir = join(userData, 'stories')
  if (existsSync(storiesDir)) {
    for (const entry of readdirSync(storiesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(storiesDir, entry.name)
      let files: Array<{ name: string; isDirectory: () => boolean }> = []
      try {
        files = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (file.isDirectory()) continue
        // 🔴 侧车文件不是独立数据：-wal 的内容属于 memory.db，-shm 是共享内存索引，
        //    而且它们**可以是 0 字节**（SQLite 正常关闭时会把 WAL 截断）。
        //    备份主库 = 备份了数据；再拷一份 -wal 既无意义，又会踩「空文件」判据
        //    （D-3 真机缺陷：只要用户打开过任何一个故事，清空就永久失败）。
        if (SIDECAR.test(file.name)) continue
        pairs.push({
          rel: join('stories', entry.name, file.name),
          from: join(dir, file.name),
          to: join(backupDir, 'stories', entry.name, file.name)
        })
      }
    }
  }
  return pairs
}

/**
 * 清空全部数据。返回报告；调用方（IPC 层）负责在报告发出**之后**重启应用。
 */
export async function wipeAllData(opts: WipeOptions): Promise<WipeReport> {
  if (opts?.confirmed !== true) return emptyReport('需要显式确认（confirmed: true）')

  const userData = app.getPath('userData')
  const backupRoot =
    typeof opts.backupRoot === 'string' && opts.backupRoot.trim()
      ? opts.backupRoot.trim()
      : join(userData, '..')
  const backupDir = join(backupRoot, BACKUP_PREFIX + stamp())

  /* ② 备份 —— 失败就一个字节都不删（这是本 Phase 唯一的安全网） */
  const pairs = planBackup(userData, backupDir)
  try {
    mkdirSync(backupDir, { recursive: true })
  } catch (error) {
    return emptyReport('备份目录建不出来，未删除任何东西：' + messageOf(error))
  }
  for (const pair of pairs) {
    let ok = false
    // 🔴 目标父目录必须先建：VACUUM INTO 与 copyFileSync 都不会替我们建目录，
    //    而 stories/<id>/ 这一层在备份目录里还不存在（第一次备份失败就是踩在这里）。
    try {
      mkdirSync(dirname(pair.to), { recursive: true })
    } catch {
      return emptyReport('备份目录建不出来（' + pair.rel + '），未删除任何东西')
    }
    // 🔴 按**文件名**判定，不是按完整相对路径：stories/<id>/memory.db 与顶层 memory.db
    //    一样是 WAL 库，裸拷同样会漏掉还没 checkpoint 的页面（J-17 的原理对故事库一样成立）。
    if (isSqliteDb(pair.rel)) {
      ok = snapshotMemoryDb(pair.from, pair.to)
    } else {
      try {
        copyFileSync(pair.from, pair.to)
        ok = existsSync(pair.to)
      } catch {
        ok = false
      }
    }
    if (!ok) return emptyReport('备份失败（' + pair.rel + '），未删除任何东西')
  }
  // ③ 逐项校验：不是走过场 —— 只复制了 story.json 的「备份」看起来也成功
  for (const pair of pairs) {
    if (!existsSync(pair.to)) return emptyReport('备份校验失败（缺 ' + pair.rel + '），未删除任何东西')
    const written = statSync(pair.to).size
    const srcSize = statSync(pair.from).size
    // 🔴 0 字节**不一定是失败**：源本来就是 0 字节时，备份是 0 字节才是忠实复制。
    //    只有「源有内容而备份是空」才算失败（D-3 的真缺陷是反过来把合法空文件判成错）。
    if (srcSize > 0 && written <= 0) {
      return emptyReport('备份校验失败（' + pair.rel + ' 是空文件），未删除任何东西')
    }
    // VACUUM INTO 会压实页面，大小必然与源库不同 —— 只有非库文件比大小
    if (isSqliteDb(pair.rel)) continue
    if (srcSize !== written) {
      return emptyReport('备份校验失败（' + pair.rel + ' 大小不一致），未删除任何东西')
    }
  }

  /* ④ 停所有在飞任务 —— 必须在删之前：否则关停时的 persist() 会把会话写回来 */
  chatService.abortAll()

  /* ⑤ 清会话并写回 []（M14：写回空数组，不是删掉文件） */
  const sessions = chatService.wipeAllSessions()

  /* ⑥ 清主库三表 —— 不复用 clear()：它只删 memories，人设历史与注册表会留着 */
  const wiped = memoryService.wipeAllTenants()

  /* ⑦ 清摘要（M13 补录项：摘要会被无条件注入，比事实记忆更「像记忆」） */
  const summariesBefore = summaryService.status().sessionCount
  summaryService.clear()
  const summaries = summariesBefore - summaryService.status().sessionCount

  /* ⑧ 删 stories/ 整目录（先关句柄再删；Windows 上留着句柄会 EPERM） */
  const storiesDir = join(userData, 'stories')
  let stories = 0
  if (existsSync(storiesDir)) {
    for (const meta of storyStore.list()) {
      try {
        closeStoryMemory(meta.storyId)
      } catch {
        // 句柄早已关掉：不影响后续删除
      }
    }
    closeAllStoryMemory()
    try {
      for (const entry of readdirSync(storiesDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) stories += 1
      }
    } catch {
      stories = 0
    }
    try {
      rmSync(storiesDir, { recursive: true, force: true })
    } catch (error) {
      return {
        sessions,
        memories: wiped.memories,
        histories: wiped.histories,
        personas: wiped.personas,
        summaries,
        stories: 0,
        backupDir,
        ok: false,
        detail: 'stories/ 删除失败（句柄未关或被占用）；备份保留在 ' + backupDir + '：' + messageOf(error)
      }
    }
  }

  /* ⑨ H-C-14：区块数据的历史副本一起删 */
  const retired = join(userData, RETIRED_ZONES_FILE)
  if (existsSync(retired)) {
    try {
      rmSync(retired, { force: true })
    } catch {
      // 删不掉不致命：它没有任何读者
    }
  }

  /* ⑩ 复核：不接受「没报错」当作「删掉了」（R10） */
  const problems: string[] = []
  const sessionsFile = join(userData, 'sessions.json')
  let sessionsEmpty = false
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionsFile, 'utf8'))
    sessionsEmpty = Array.isArray(parsed) && parsed.length === 0
  } catch {
    sessionsEmpty = false
  }
  if (!sessionsEmpty) problems.push('sessions.json 不是 []')
  if (memoryService.list().length !== 0) problems.push('memories 未清零')
  if (memoryService.listUserIds().length !== 0) problems.push('人设注册表或人设历史仍有残留')
  if (summaryService.status().sessionCount !== 0) problems.push('摘要未清空')
  if (existsSync(storiesDir)) problems.push('stories/ 仍存在')

  return {
    sessions,
    memories: wiped.memories,
    histories: wiped.histories,
    personas: wiped.personas,
    summaries,
    stories,
    backupDir,
    ok: problems.length === 0,
    detail:
      problems.length === 0 ? '已清空；备份在 ' + backupDir : '清空后复核未通过：' + problems.join('；')
  }
}
