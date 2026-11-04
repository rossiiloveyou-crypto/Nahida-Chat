/**
 * 提示词库行为测试。
 * 关注真实边界：多角色目录、缺文件时跳过而不是崩、Chat/Agent 各注入自己那一层、
 * Agent 独享工具规范、角色目录被删后行为仍然确定。
 *
 * 跑法：pnpm test:prompt
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')

function loadEsbuild() {
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

const esbuild = loadEsbuild()
const workDir = path.join(os.tmpdir(), 'nahida-prompt-test-' + process.pid + '-' + Date.now())
const promptRoot = path.join(workDir, 'Prompt')
fs.mkdirSync(promptRoot, { recursive: true })

const stubPath = path.join(workDir, 'electron-stub.cjs')
fs.writeFileSync(
  stubPath,
  'module.exports = {' +
    ' app: {' +
    ' getPath: () => ' + JSON.stringify(workDir) + ',' +
    ' getAppPath: () => ' + JSON.stringify(workDir) + ',' +
    ' isPackaged: false },' +
    ' shell: { openPath: async () => \'\' }' +
    ' }',
  'utf8'
)

const outFile = path.join(workDir, 'promptStore.cjs')
await esbuild.build({
  entryPoints: [path.join(projectRoot, 'src/main/features/prompt/promptStore.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: outFile,
  external: ['electron'],
  alias: { '@shared': path.join(projectRoot, 'src/shared') },
  logLevel: 'silent'
})

const Module = require('node:module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stubPath
  return originalResolve.call(this, request, ...rest)
}

function write(relative, content) {
  const absolute = path.join(promptRoot, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content, 'utf8')
}

const results = []
const check = (label, ok, extra) => results.push({ label, ok, extra })

try {
  // ---- 结构：两个角色 + 三个全局文件 ----
  write('shared/base.md', '# 全局规则\n\n不要编造事实。')
  write('shared/tone.md', '# 语气规则\n\n不用对举句式。')
  write('shared/tool_usage.md', '# 工具规范\n\n事实以工具返回为准。')
  write('characters/nahida/soul.md', '# 纳西妲 · Soul\n\n你是纳西妲。')
  write('characters/nahida/worldbook/a.md', '# 须弥\n\n教令院所在。')
  write('characters/nahida/worldbook/b.md', '# 世界树\n\n知识的载体。')
  write('characters/nahida/modes/chat.md', '# Chat 规则\n\n没有工具就说没有工具。')
  write('characters/nahida/modes/agent.md', '# Agent 规则\n\n只在工作区内操作。')
  write('characters/nahida/styles/chat.md', '# 闲聊风格\n\n短一点。')
  write('characters/nahida/styles/agent.md', '# Agent 风格\n\n先说要做什么。')
  write('characters/nahida/canon/quotes.md', '# 台词基准\n\n<!-- 填写说明：不要进提示词 -->\n- 「会一直陪着你。」')
  write('characters/nahida/canon/_template.md', '# 台词模板\n\n- 「[待补]」')
  write('characters/nahida/canon/draft.md', '# 台词草稿\n\n- 「[待补：还没填]」')
  write(
    'characters/nahida/canon/escaped.md',
    '# 转义台词\n\n&lt;!-- 这段说明不能进提示词 --&gt;\n\n- 「像月莲找到了莲叶。」'
  )
  write('characters/nahida/canon/Template.md', '# 大写模板副本\n\n- 「[待补]」')
  write('characters/other/soul.md', '# 另一个角色\n\n你是别人。')

  const { promptStore } = require(outFile)

  // ---- library() ----
  const library = promptStore.library()
  check('识别出两个角色', library.characters.length === 2, library.characters.map((c) => c.id).join(','))
  const nahida = library.characters.find((c) => c.id === 'nahida')
  check('角色名取 soul.md 一级标题', nahida.name === '纳西妲', nahida.name)
  check('缺 styles 的角色不算 complete', library.characters.find((c) => c.id === 'other').complete === true)
  check('nahida 标记为 complete', nahida.complete === true)
  check('文件清单标记缺失项', nahida.files.find((f) => f.id === 'soul.md').exists === true)
  check('角色按 id 排序', library.characters[0].id === 'nahida', library.characters[0].id)
  check('library 返回绝对路径', path.isAbsolute(library.root), library.root)
  check('全局文件清单 = base + tone + tool_usage', library.sharedFiles.length === 3, library.sharedFiles.map((f) => f.id).join(','))
  check('tool_usage 标记为仅 Agent', library.sharedFiles.find((f) => f.id === 'shared/tool_usage.md')?.scope === 'agent')
  check('tone 标记为两种模式', library.sharedFiles.find((f) => f.id === 'shared/tone.md')?.scope === 'both')
  check('角色清单包含模式规则层', nahida.files.some((f) => f.id === 'modes/chat.md') && nahida.files.some((f) => f.id === 'modes/agent.md'))
  check('角色清单包含台词层', nahida.files.some((f) => f.id === 'canon'), nahida.files.map((f) => f.id).join(','))

  // ---- compose(): 顺序与内容 ----
  const chat = promptStore.compose('nahida', 'chat')
  const agent = promptStore.compose('nahida', 'agent')

  check('chat 含全局规则', chat.includes('不要编造事实'))
  check('chat 含语气规则', chat.includes('不用对举句式'))
  check('chat 含人格核心', chat.includes('你是纳西妲'))
  check('chat 含原作台词', chat.includes('会一直陪着你'))
  check('台词里的 HTML 注释不进提示词', !chat.includes('填写说明'), chat.includes('填写说明'))
  check('_ 前缀的模板文件不被读取', !chat.includes('「[待补]」'), chat.includes('「[待补]」'))
  check('没填完的台词文件（含占位符）不注入', !chat.includes('还没填'), chat.includes('还没填'))
  check('已填写的台词仍然注入', chat.includes('会一直陪着你'))
  check('被转义的注释也能剥掉', !chat.includes('这段说明不能进提示词'), chat.includes('这段说明不能进提示词'))
  check('转义注释旁边的台词照常注入', chat.includes('像月莲找到了莲叶'))
  check('Template.md 这类副本不被当成正式台词', !chat.includes('大写模板副本'), chat.includes('大写模板副本'))
  check('提示词里不残留 HTML 实体', !chat.includes('&lt;') && !chat.includes('&gt;'))
  check('chat 含 worldbook', chat.includes('教令院所在') && chat.includes('知识的载体'))
  check('chat 含 chat 模式规则', chat.includes('没有工具就说没有工具'))
  check('chat 含 chat 风格', chat.includes('短一点'))
  check('chat 不含 agent 模式规则', !chat.includes('只在工作区内操作'))
  check('chat 不含 agent 风格', !chat.includes('先说要做什么'))
  check('chat 不含工具规范', !chat.includes('事实以工具返回为准'))
  check('agent 含 agent 模式规则', agent.includes('只在工作区内操作'))
  check('agent 含 agent 风格', agent.includes('先说要做什么'))
  check('agent 含工具规范', agent.includes('事实以工具返回为准'))
  check('agent 不含 chat 模式规则', !agent.includes('没有工具就说没有工具'))
  check('agent 不含 chat 风格', !agent.includes('短一点'))

  const order = ['不要编造事实', '不用对举句式', '你是纳西妲', '会一直陪着你', '教令院所在', '没有工具就说没有工具', '短一点']
    .map((text) => chat.indexOf(text))
  check(
    '拼装顺序 = 全局 → 语气 → 人格 → 台词 → 设定 → 模式规则 → 风格',
    order.every((value, index) => index === 0 || (value > order[index - 1] && value >= 0)),
    order.join(',')
  )

  const agentOrder = ['不要编造事实', '你是纳西妲', '只在工作区内操作', '先说要做什么', '事实以工具返回为准']
    .map((text) => agent.indexOf(text))
  check(
    'Agent 顺序 = … → 模式规则 → 风格 → 工具规范（工具规范压轴）',
    agentOrder.every((value, index) => index === 0 || (value > agentOrder[index - 1] && value >= 0)),
    agentOrder.join(',')
  )

  // ---- 缺文件时跳过而不是报错 ----
  write('characters/partial/soul.md', '# 半成品角色\n\n只有人格。')
  const partial = promptStore.compose('partial', 'chat')
  check('缺 worldbook/modes/styles 也能拼出人格', partial.includes('只有人格'))
  check('缺文件时不抛错', typeof partial === 'string')
  check('缺模式规则时仍保留全局段', partial.includes('不要编造事实') && partial.includes('不用对举句式'))

  const missing = promptStore.compose('does-not-exist', 'chat')
  check(
    '角色不存在时退回全局 + 语气，不带人格',
    missing.includes('不要编造事实') && missing.includes('不用对举句式') && !missing.includes('你是纳西妲'),
    missing.length
  )

  // ---- P1 · M04：chat 有工具时才注入工具规范（A-16 / A-17，成对判定）----
  const chatNoTools = promptStore.compose('nahida', 'chat', { toolsEnabled: false })
  const chatWithTools = promptStore.compose('nahida', 'chat', { toolsEnabled: true })
  check('A-16a chat + toolsEnabled:false 不含工具规范', !chatNoTools.includes('事实以工具返回为准'))
  check('A-16b chat + toolsEnabled:true 含工具规范（与 a 成对，防零样本假通过）', chatWithTools.includes('事实以工具返回为准'))
  check('A-16c chat 不传 opts 时按「无工具」处理（老调用方行为不变）', !chat.includes('事实以工具返回为准'))
  check('A-16d chat 带工具时其余各段一字不少', ['不要编造事实', '你是纳西妲', '会一直陪着你', '教令院所在', '短一点'].every((text) => chatWithTools.includes(text)))
  check(
    'A-16e chat 带工具时工具规范仍压轴（排在风格之后）',
    chatWithTools.indexOf('事实以工具返回为准') > chatWithTools.indexOf('短一点')
  )
  check('A-17 agent 不传 opts 也注入（行为不变）', agent.includes('事实以工具返回为准'))
  check('A-17b agent + toolsEnabled:false 仍注入（agent 恒有工具，不因传参降级）', promptStore.compose('nahida', 'agent', { toolsEnabled: false }).includes('事实以工具返回为准'))

  const missingAgent = promptStore.compose('does-not-exist', 'agent')
  check(
    '角色不存在时 Agent 仍保留工具规范',
    missingAgent.includes('事实以工具返回为准') && !missingAgent.includes('你是纳西妲'),
    missingAgent.length
  )
  check('角色不存在时 Chat 不注入工具规范', !promptStore.compose('does-not-exist', 'chat').includes('事实以工具返回为准'))

  // ---- 文件缺失标记 ----
  const afterMissing = promptStore.library().characters.find((c) => c.id === 'partial')
  check('partial 的 styles 标记为缺失', afterMissing.files.find((f) => f.id === 'styles/chat.md').exists === false)
  check('partial 的 modes 标记为缺失', afterMissing.files.find((f) => f.id === 'modes/chat.md').exists === false)
  check('partial 缺 soul 时 complete 仍为 true（soul 在）', afterMissing.complete === true)

  // ---- 删除角色目录后 library 不再列出它 ----
  fs.rmSync(path.join(promptRoot, 'characters/other'), { recursive: true, force: true })
  const afterDelete = promptStore.library()
  check('删除角色目录后不再出现', afterDelete.characters.every((c) => c.id !== 'other'))
  check('默认角色回落到存在的角色', promptStore.defaultCharacterId() === 'nahida', promptStore.defaultCharacterId())

  // ---- 非法角色目录拒绝打开 ----
  let rejected = false
  try {
    await promptStore.openCharacter('../escape')
  } catch {
    rejected = true
  }
  check('非法角色目录被拒绝', rejected)
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log((item.ok ? 'PASS ' : 'FAIL ') + item.label + (item.extra === undefined ? '' : ' :: ' + item.extra))
}
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过')
if (failed.length > 0) process.exitCode = 1
