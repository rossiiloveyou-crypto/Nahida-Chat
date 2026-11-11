/**
 * QQ 系列测试的共用脚手架（P4）。
 *
 * 做的事只有三件：用 esbuild 把主进程 TS 打成 CJS、把 electron 换成桩、
 * 提供统一的 check/汇总。**不替被测模块做任何判断** —— 断言全部写在各自的用例里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

export function loadEsbuild() {
  const pnpmDir = path.join(projectRoot, 'node_modules/.pnpm')
  const candidates = fs.existsSync(pnpmDir)
    ? fs.readdirSync(pnpmDir).filter((name) => name.startsWith('esbuild@'))
    : []
  for (const name of candidates) {
    const entry = path.join(pnpmDir, name, 'node_modules/esbuild/lib/main.js')
    if (fs.existsSync(entry)) return require(entry)
  }
  return require('esbuild')
}

/** 把 electron 换成最小桩。返回 userData 目录（测试自己往里写 settings.json）。 */
export function installElectronStub(userData) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-stub-'))
  const stub = path.join(sandbox, 'electron-stub.cjs')
  fs.writeFileSync(
    stub,
    [
      'const path = require("node:path")',
      'const userData = ' + JSON.stringify(userData),
      'module.exports = {',
      '  app: {',
      '    getPath: (key) => (key === "userData" ? userData : path.join(userData, String(key))),',
      '    getAppPath: () => ' + JSON.stringify(projectRoot) + ',',
      '    getName: () => "Nahida Chat",',
      '    getVersion: () => "0.1.0",',
      '    isPackaged: false,',
      '    on: () => {},',
      '    whenReady: async () => {}',
      '  },',
      '  shell: { openPath: async () => "", openExternal: async () => "" },',
      '  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },',
      '  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },',
      '  ipcMain: { handle: () => {}, on: () => {} },',
      '  nativeTheme: { shouldUseDarkColors: false, themeSource: "system", on: () => {} }',
      '}'
    ].join('\n'),
    'utf8'
  )
  const Module = require('node:module')
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return stub
    return original.call(this, request, ...rest)
  }
  return userData
}

/** 打一个测试专用 bundle。source 里写 re-export 即可。 */
export async function bundleModule(name, source, plugins = []) {
  const esbuild = loadEsbuild()
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-' + name + '-'))
  const entry = path.join(sandbox, 'entry.ts')
  fs.writeFileSync(entry, source, 'utf8')
  const outfile = path.join(sandbox, 'bundle.cjs')
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron'],
    alias: { '@shared': path.join(projectRoot, 'src/shared') },
    plugins,
    logLevel: 'silent'
  })
  return require(outfile)
}


/**
 * 带桩的打包（P2 新增）。
 *
 * 🔴 两个坑必须同时记住：
 * 1. **不要用 plugins 的 onResolve 给 './embedder' 这类相对说明符做桩**：本模块的 bundleModule
 *    固定传了 `alias: { '@shared': ... }`，esbuild 0.28 的 alias 会抢在插件 onResolve 之前裁决，
 *    插件返回的桩被静默忽略，真实实现照旧被 bundle 进去——桩「配了但没生效」。
 * 2. **只留一个 onResolve 回调**：两个 filter 都命中（通配与具体的相对说明符）时，esbuild 会并发跑两个回调、
 *    按返回顺序取第一个非 null，顺序不保证。把「桩文件判定」和「命中桩再解析」拆成两个回调，
 *    桩会在 @shared 解析之后才裁决，于是再次失效。
 *
 * 2026-11-11 P2 施工实测：这两条各踩一次，症状都是「stub 顶层副作用一次没跑、
 * 内存抽取走了真实 extract.ts（无 provider → 返回 []）」，表现为「写入 0 条」的假红。
 *
 * 做法：入口与 shim 都放沙箱，re-export 走正斜杠绝对路径（入口若落源码目录，相对说明符会解析到源码边上）；
 * 桩按绝对路径反查说明符，一个回调里一次裁决。
 *
 * @param {string} name 沙箱名（只影响临时目录名）
 * @param {string[]} exports re-export 语句列表，可写绝对路径
 * @param {Record<string, string>} stubs 说明符 → 桩文件绝对路径，例如 { './extract': '/tmp/extract-stub.ts' }
 */
export async function bundleModuleWithStubs(name, exports, stubs = {}) {
  const esbuild = loadEsbuild()
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-' + name + '-'))
  const shim = path.join(sandbox, 'shim.ts')
  fs.writeFileSync(shim, exports.map((line) => line.replace(/\\/g, '/')).join('\n'), 'utf8')
  const entry = path.join(sandbox, 'entry.ts')
  fs.writeFileSync(entry, 'export * from ' + JSON.stringify(shim.replace(/\\/g, '/')) + '\n', 'utf8')
  const outfile = path.join(sandbox, 'bundle.cjs')
  const stubEntries = Object.entries(stubs).map(([spec, file]) => ({
    spec: spec.replace(/\\/g, '/'),
    abs: path.resolve(file),
    file
  }))
  /**
   * 只按**说明符**判定（实测唯一有效的写法）。
   * 试过两条都失败：① 先把桩文件的绝对路径声明给 esbuild、再按绝对路径反查说明符；
   * ② 两个 onResolve 回调分工。两者都会让桩在 alias 之后才裁决，结果仍是真实实现进 bundle。
   */
  const pickStub = (args) => {
    const importer = (args.importer || '').replace(/\\/g, '/')
    for (const entry of stubEntries) {
      if (args.path === entry.spec && importer.includes('src/main/features/rag/')) return { path: entry.file }
    }
    return null
  }
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron'],
    alias: { '@shared': path.join(projectRoot, 'src/shared') },
    plugins: [{ name: 'fixed-stubs', setup: (build) => build.onResolve({ filter: /.*/ }, pickStub) }],
    logLevel: 'silent'
  })
  return require(outfile)
}

export function createChecker() {
  const results = []
  return {
    check(label, ok, extra) {
      results.push({ label, ok: Boolean(ok) })
      console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : '  → ' + String(extra)))
    },
    done() {
      const failed = results.filter((item) => !item.ok)
      console.log('')
      console.log('共 ' + String(results.length) + ' 项，通过 ' + String(results.length - failed.length) + ' 项')
      if (failed.length > 0) {
        console.log('失败：')
        for (const item of failed) console.log('  - ' + item.label)
        process.exit(1)
      }
    }
  }
}

export function p(rel) {
  return path.join(projectRoot, rel).replace(/\\/g, '/')
}
