/**
 * 探针（P5 §7.2）：打印 compose() 的分段结构，供 before / after 差集比对。
 *
 * 🔴 本脚本**不进 test 链**（它会 git show 旧版源码，跑在 CI 里没有意义）。
 * 用法：
 *   node scripts/test/probe-story-worldbook.mjs            # after（当前工作区）
 *   node scripts/test/probe-story-worldbook.mjs --before   # before（e7ccc9e 的 compose）
 *   node scripts/test/probe-story-worldbook.mjs --force-override   # 自检：证明探针能打出 story-ovr
 *
 * 判据（蓝图 §7.2）：
 *   ① before → after 差集非空，且能看到 story-def / story-ovr 两条新行
 *   ② chat 那行 before / after **完全一致**（老路径零变化）
 *   ③ 差集为空 = 判失败（要么改动没生效，要么探针没测到）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { bundleModule, projectRoot } from './qq-test-util.mjs'

const before = process.argv.includes('--before')
const forceOverride = process.argv.includes('--force-override')
const require = createRequire(import.meta.url)
const SEP = '\n\n---\n\n'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p5-probe-user-'))
const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p5-probe-app-'))

// electron 桩（getAppPath 必须可指向临时 Prompt 根）
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p5-probe-stub-'))
const stub = path.join(sandbox, 'electron-stub.cjs')
fs.writeFileSync(stub, [
  'const path = require("node:path")',
  'const userData = ' + JSON.stringify(userData),
  'const appPath = ' + JSON.stringify(appPath),
  'module.exports = {',
  '  app: { getPath: (k) => (k === "userData" ? userData : path.join(userData, String(k))),',
  '    getAppPath: () => appPath, getName: () => "Nahida Chat", getVersion: () => "0.1.0",',
  '    isPackaged: false, on: () => {}, whenReady: async () => {} },',
  '  shell: { openPath: async () => "", openExternal: async () => "" },',
  '  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },',
  '  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },',
  '  ipcMain: { handle: () => {}, on: () => {} },',
  '  nativeTheme: { shouldUseDarkColors: false, themeSource: "system", on: () => {} }',
  '}'].join('\n'), 'utf8')
const Module = require('node:module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stub
  return originalResolve.call(this, request, ...rest)
}

/* ── 假 Prompt 根（不碰用户真实 Prompt/）──────────────────────────── */

const PROMPT = path.join(appPath, 'Prompt')
const CHAR = path.join(PROMPT, 'characters', 'probechar')
const write = (rel, body) => {
  const file = path.join(PROMPT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
}
write('shared/base.md', 'BASE')
write('shared/tone.md', 'TONE')
write('shared/tool_usage.md', 'TOOL')
write('characters/probechar/soul.md', '# 探针角色 · Soul\n\nSOUL')
write('characters/probechar/canon/c1.md', 'CANON')
write('characters/probechar/worldbook/wb.md', 'WORLDBOOK_DEFAULT')
write('characters/probechar/modes/chat.md', 'MODE_CHAT')
write('characters/probechar/styles/chat.md', 'STYLE_CHAT')

const WB = path.join(userData, 'stories', 'probe-wb')
fs.mkdirSync(WB, { recursive: true })
fs.writeFileSync(path.join(WB, 'x.md'), 'WORLDBOOK_STORY', 'utf8')

/* ── 取源码：after = 工作区；before = e7ccc9e ──────────────────────── */

const promptStoreRel = 'src/main/features/prompt/promptStore.ts'
let source
if (before) {
  source = execFileSync('git', ['-C', projectRoot, 'show', 'e7ccc9e:' + promptStoreRel], { encoding: 'utf8' })
  fs.writeFileSync(path.join(appPath, '_before-promptStore.ts'), source, 'utf8')
} else {
  source = fs.readFileSync(path.join(projectRoot, promptStoreRel), 'utf8')
}

// before 版的 import 里没有 @shared/story；after 版有 —— esbuild 需要 alias，bundleModule 已带
const entryFile = before
  ? path.join(appPath, '_before-promptStore.ts')
  : path.join(projectRoot, promptStoreRel)

const mod = await bundleModule('probe-story-worldbook', 'export { promptStore } from ' + JSON.stringify(entryFile.replace(/\\/g, '/')).replace(/^"|"$/g, "'") , [])
const { promptStore } = mod

/* ── 三种场景 ─────────────────────────────────────────────────────── */

const label = (section) => {
  const head = section.split('\n').map((line) => line.trim()).filter(Boolean)[0] || '(空)'
  return head.slice(0, 20)
}
const dump = (name, text) => {
  const parts = text ? text.split(SEP) : []
  console.log(name.padEnd(10) + '| ' + parts.map(label).join(' | '))
}

const storyOpts = (mode) => ({
  story: { worldbookDir: WB, worldbookMode: mode, profile: 'PROFILE' }
})

if (before) {
  // 施工前的 compose 只有两个参数位，故事场景根本传不进去。
  // 而且 e7ccc9e（P3 出口提交）的 MODE_RULES 里**没有 story 键**（P4 的改动未提交），
  // 所以旧版传 'story' 会当场抛 ERR_INVALID_ARG_TYPE —— 这本身就是 before 侧的一条观测，
  // 至少说明「P5 之前 compose 完全不认故事模式」。
  for (const mode of ['chat', 'agent']) {
    dump(mode === 'chat' ? 'chat' : 'agent', promptStore.compose('probechar', mode))
  }
  try {
    dump('story-def', promptStore.compose('probechar', 'story'))
    dump('story-ovr', promptStore.compose('probechar', 'story'))
  } catch (error) {
    console.log('story-def | (旧版 compose 传 story 直接抛：' + error.code + ')')
    console.log('story-ovr | (同上)')
  }
} else if (forceOverride) {
  dump('chat', promptStore.compose('probechar', 'chat'))
  dump('story-def', promptStore.compose('probechar', 'story', storyOpts('override')))
  dump('story-ovr', promptStore.compose('probechar', 'story', storyOpts('override')))
} else {
  dump('chat', promptStore.compose('probechar', 'chat'))
  dump('story-def', promptStore.compose('probechar', 'story', storyOpts('default')))
  dump('story-ovr', promptStore.compose('probechar', 'story', storyOpts('override')))
}
