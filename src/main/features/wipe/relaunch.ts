import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { POST_WIPE_FLAG } from '@shared/constants'

/**
 * P7 · 清空之后的「重启」。
 *
 * 🔴 D-5（真机缺陷，2026-11-15）：原来是 `setImmediate(() => { app.relaunch(); app.exit(0) })`。
 *    实测 app.relaunch 本身没坏 —— 探针（带窗口 + 子进程）连续重启 12 次，次次拿到单实例锁。
 *    坏的是**渲染层怎么加载**：开发模式下窗口 loadURL(ELECTRON_RENDERER_URL)，而那个 vite
 *    dev server 住在 electron-vite 进程里，它 `ps.on('close', () => process.exit())` —— 旧 electron
 *    一退出，dev server 立刻跟着死。于是新实例拿到的是 ERR_CONNECTION_REFUSED
 *    （探针实测 did-fail-load -102），用户看到的就是白屏 = 「自动重启不成功」。
 *
 * 所以这里按**渲染层怎么加载**分叉，不按「怎么重启」分叉：
 *   1. 开发模式（有 ELECTRON_RENDERER_URL）：只有把整条 dev 链路（vite + electron）重拉起来才有页面，
 *      用同一份 node + pnpm 入口 spawn 一个 detached 的 `pnpm dev`（stdio 丢弃，界面没了也不影响它）；
 *   2. 拿不到 pnpm 入口（例如打包后的可执行文件）：退回原生 relaunch，并用 POST_WIPE_FLAG 告诉
 *      新实例「别连 dev server，直接读构建产物」；
 *   3. 生产 / 无 dev server：渲染层是 file://，原生 relaunch 就够。
 *
 * 🔴 另一条真机教训：退出用 `app.quit()` 而不是 `app.exit(0)`。
 *    app.exit() 不触发 before-quit，QQ 宿主子进程（snowluma-host）会被落成孤儿；
 *    app.quit() 会跑 before-quit → qqHost.stop()。代价是 quit 理论上可能被拦，
 *    所以配一个 FORCE_EXIT_MS 看门狗强制退出。
 */

/** quit 被拦住时，多久之后强制退出（毫秒） */
export const FORCE_EXIT_MS = 3000

export interface RelaunchInput {
  /** 有值 = 开发模式，渲染层来自 vite dev server */
  rendererUrl: string | undefined
  isPackaged: boolean
  /** 应用根目录，作为 relaunch 的入口参数 */
  appPath: string
  /** npm_node_execpath：真正的 node.exe（不是 electron.exe） */
  nodePath: string | undefined
  /** npm_execpath：pnpm 的入口 .cjs，用它才能跑回 `pnpm dev` */
  pnpmEntry: string | undefined
  /** 包目录（PNPM_SCRIPT_SRC_DIR / INIT_CWD），pnpm dev 必须在它下面跑 */
  scriptDir: string | undefined
  /** out/renderer/index.html 是否存在 —— 决定能不能退到「读构建产物」 */
  builtRendererExists: boolean
}

export type RelaunchPlan =
  | { kind: 'electron-relaunch'; args: string[]; why: string }
  | { kind: 'spawn-dev'; nodePath: string; args: string[]; cwd: string; why: string }

/** 纯函数：给定环境，决定用什么方式重启。单测直接打这个，不碰进程。 */
export function planRelaunch(input: RelaunchInput): RelaunchPlan {
  const devMode =
    !input.isPackaged && typeof input.rendererUrl === 'string' && input.rendererUrl.length > 0

  if (!devMode) {
    return {
      kind: 'electron-relaunch',
      args: [input.appPath],
      why: '渲染层走 file://，原生 relaunch 就够'
    }
  }
  if (input.nodePath && input.pnpmEntry && input.scriptDir) {
    return {
      kind: 'spawn-dev',
      nodePath: input.nodePath,
      args: [input.pnpmEntry, 'dev'],
      cwd: input.scriptDir,
      why: 'dev server 随旧实例一起退出，只能整条 dev 链路重拉'
    }
  }
  if (input.builtRendererExists) {
    return {
      kind: 'electron-relaunch',
      args: [input.appPath, POST_WIPE_FLAG],
      why: '拿不到 pnpm 入口，改读已构建的 index.html（跳过 dev server）'
    }
  }
  return {
    kind: 'electron-relaunch',
    args: [input.appPath],
    why: '既拿不到 pnpm 入口也没有构建产物，只能原样重启（会白屏，但不假装成功）'
  }
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string; detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv }
) => { unref: () => void }

export interface RelaunchDeps {
  spawn?: SpawnLike
  relaunch?: (options: { args: string[] }) => void
  quit?: () => void
  exit?: (code: number) => void
  schedule?: (fn: () => void, ms: number) => unknown
}

function envInput(): RelaunchInput {
  const env = process.env
  return {
    rendererUrl: env['ELECTRON_RENDERER_URL'],
    isPackaged: app.isPackaged === true,
    appPath: app.getAppPath(),
    nodePath: env['npm_node_execpath'],
    pnpmEntry: env['npm_execpath'],
    scriptDir: env['PNPM_SCRIPT_SRC_DIR'] ?? env['INIT_CWD'],
    builtRendererExists: existsSync(join(__dirname, '../renderer/index.html'))
  }
}

/** 执行重启。返回所选方案，便于测试与日志。 */
export function relaunchAfterWipe(
  overrides: Partial<RelaunchInput> = {},
  deps: RelaunchDeps = {}
): RelaunchPlan {
  const input: RelaunchInput = { ...envInput(), ...overrides }
  const plan = planRelaunch(input)

  if (plan.kind === 'spawn-dev') {
    const env: NodeJS.ProcessEnv = { ...process.env }
    // 端口可能变，交给新起的 dev server 自己写；继承旧地址会让新实例连到已死的那一个
    delete env['ELECTRON_RENDERER_URL']
    const spawnImpl = deps.spawn ?? (spawn as unknown as SpawnLike)
    const child = spawnImpl(plan.nodePath, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
      env
    })
    child.unref()
  } else {
    const relaunchImpl = deps.relaunch ?? ((options: { args: string[] }) => app.relaunch(options))
    relaunchImpl({ args: plan.args })
  }

  // 顺序不能反：先起新进程，再退出旧进程
  const quitImpl = deps.quit ?? (() => app.quit())
  quitImpl()

  const exitImpl = deps.exit ?? ((code: number) => app.exit(code))
  const scheduleImpl = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const timer = scheduleImpl(() => exitImpl(0), FORCE_EXIT_MS)
  if (
    timer !== null &&
    typeof timer === 'object' &&
    typeof (timer as { unref?: unknown }).unref === 'function'
  ) {
    ;(timer as { unref: () => void }).unref()
  }
  return plan
}
