/**
 * 隐藏窗口的 preload（P4 §1 第 6 行）。
 *
 * 只做一件事：把页面侧的单向事件通道挂到 `window.ncEmit` 上，让 ST 页面里的
 * `STREAM_TOKEN_RECEIVED` 能逐字回推到主进程（F-01 的流式增量）。
 *
 * 🔴 为什么是「源码常量 + 运行期落盘」而不是一个独立的构建入口：
 *    preload **必须是一个独立的 .js 文件路径**（Electron 按文件加载，不能从 bundle 里 import）。
 *    要让 electron-vite 多产一个 `out/preload/bridge.js`，就得改 `electron.vite.config.ts` 的
 *    preload 段——那属于 P1/P3 的构建面，本 Phase 不碰。落盘位置是 **userData 下的应用私有目录**，
 *    不是 ST 的目录（M2 / J-07：桥接绝不写 ST 磁盘）。
 * 🔴 `contextIsolation: false` 是 ST 页面本身的要求（P0 实测：隔离下 `SillyTavern.getContext()` 拿不到
 *    我们要的那批引用），所以这里直接挂 `window`，不用 contextBridge。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BRIDGE_IPC } from '@shared/bridge'

/** preload 的落盘文件名。改它 = 老进程会继续用旧文件，非必要不动 */
export const BRIDGE_PRELOAD_FILE = 'bridge-preload.cjs'

/**
 * preload 正文。
 *
 * 生成的字符串必须满足两件事：
 * 1. 只暴露 `window.ncEmit` 一个入口（PHASE-4 §1 第 6 行的原话：只暴露 `window.ncEmit`）；
 * 2. **吞掉一切异常**：页面里的 emit 失败绝不能让 ST 的那一轮生成炸掉。
 */
export function preloadSource(): string {
  return [
    '// 由 src/main/features/bridge/preload.ts 生成，改那里而不是改这个文件',
    'const { ipcRenderer } = require("electron")',
    'const CHANNEL = ' + JSON.stringify(BRIDGE_IPC.event),
    'window.ncEmit = function (name, payload) {',
    '  try {',
    '    ipcRenderer.send(CHANNEL, { name: String(name), payload: payload === undefined ? null : payload, at: Date.now() })',
    '  } catch (error) {',
    '    // 事件通道断掉不该影响 ST 的生成',
    '  }',
    '}',
    'window.ncEmitReady = true',
    ''
  ].join('\n')
}

/**
 * 确保 preload 文件在 `dir` 里且内容是最新的，返回它的绝对路径。
 *
 * 内容比对后再写：进程内多次重建窗口不该反复落盘（也避免杀软把每次都写当成可疑行为）。
 */
export function ensurePreloadFile(dir: string): string {
  const file = join(dir, BRIDGE_PRELOAD_FILE)
  const source = preloadSource()
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = ''
  }
  if (current === source) return file
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, source, 'utf8')
  return file
}
