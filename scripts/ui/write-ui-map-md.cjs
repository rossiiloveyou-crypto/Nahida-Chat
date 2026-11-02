#!/usr/bin/env node
/**
 * 由 ui-map-v{版本}.json 自动生成 docs/ui/UI_MAP.md。
 *
 * 为什么自动生成：多个 agent 会并行改 UI 并重跑截图，手写 UI_MAP.md 一定会漏——
 * 新增视图会在文档里留下裸英文标题，元素编号后移也来不及同步。
 * 这里只保留少量"人写"的部分（需求对照表、变更记录、已知约束），其余由坐标 JSON 渲染。
 *
 * 用法：
 *   node ~/.dsh/agents-global/ui-map/write-ui-map-md.cjs <ui-map-vX.json> [--out=<UI_MAP.md>]
 */
const fs = require('node:fs')
const path = require('node:path')

const jsonPath = process.argv.find((a) => !a.startsWith('--') && a.endsWith('.json'))
if (!jsonPath) {
  console.error('用法: node write-ui-map-md.cjs <ui-map-vX.json> [--out=<UI_MAP.md>]')
  process.exit(1)
}
const outArg = process.argv.find((a) => a.startsWith('--out='))
const outPath = outArg ? outArg.slice(6) : path.join(path.dirname(path.resolve(jsonPath)), 'UI_MAP.md')

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const version = data.version
const size = data.contentSize || { width: 1280, height: 860 }
const viewIds = Object.keys(data.views)

/** 视图标题：已知的用中文，未知的用路由 id 兜底并标注"待补标题"。 */
const KNOWN_TITLES = {
  'chat-empty': '对话首页（只保留 Chat/Agent 滑块）',
  // P6 起首帧是 Chat 模式，侧栏有意不渲染工作区段；这两个视图负责把
  // 「工作区列表」和「零工作区门禁态」重新变成可定位的（见 generate-ui-map.cjs 的 click / workspaces）
  'chat-agent': '对话首页 · Agent 模式（侧栏含工作区列表）',
  'chat-agent-gated': '对话首页 · Agent 模式 + 零工作区（输入区门禁态）',
  // P9：空态图里没有任何消息，MessageList 的头像与气泡一个都不存在。
  // 这张用演示模式跑了两轮真实对话，把「AI 头像 / 用户头像 / 气泡」变成可定位的。
  'chat-conversation': '对话中（含 AI 头像与用户头像）',
  'settings-models': '设置 · 模型配置',
  'settings-prompts': '设置 · 提示词库',
  'settings-memory': '设置 · 长期记忆',
  'settings-zones': '设置 · 区块',
  // P9-R3：渠道控制台从「按会话」重做成「按人」，三张图覆盖 A/B/C/D 四个区。
  'settings-channels': '设置 · 渠道控制台（QQ 号白名单 / 群白名单）',
  'settings-channels-lower': '设置 · 渠道控制台（下半屏 / 鉴权开关）',
  'settings-channels-observe': '设置 · 渠道控制台（旁听库）',
  'settings-zones-lower': '设置 · 区块（下半屏 / 行为开关）',
  'settings-qq': '设置 · QQ 接入',
  'settings-qq-lower': '设置 · QQ 接入（下半屏 / 行为开关）',
  'settings-qq-events': '设置 · QQ 接入（最近事件）',
  'settings-tools': '设置 · 工具权限',
  'settings-appearance': '设置 · 外观',
  'settings-about': '设置 · 关于'
}

/**
 * 现有 UI_MAP.md 里"人写"的段落，按标题原样保留。
 *
 * 这里刻意不用正则。原来的写法是
 *   new RegExp('^## ' + name + '\\n([\\s\\S]*?)(?=\\n## |$)', 'm')
 * 在 m 标志下 `$` 会匹配**每一行的行尾**，所以惰性量词一上来就满足了结束条件，
 * 捕获组永远返回空串——结果是每次重跑都把「需求对照」「变更记录」「已知约束」三段清空。
 * 用 indexOf + 找下一个 '## ' 标题替代，语义直白且不受标志位影响。
 */
function readPreservedSections(file) {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, 'utf8')
  const kept = {}
  const wanted = ['需求 → 位置 → 代码', '变更记录', '已知约束']
  for (const name of wanted) {
    const marker = '## ' + name + '\n'
    const start = text.indexOf(marker)
    if (start < 0) continue
    const rest = text.slice(start + marker.length)
    const next = rest.search(/^## /m)
    kept[name] = (next < 0 ? rest : rest.slice(0, next)).trim()
  }
  return kept
}

const preserved = readPreservedSections(outPath)
const fmt = (v) => 'x' + v.left + ' y' + v.top + ' ' + v.width + 'x' + v.height

let md = ''
md += '# UI 定位图（UI_MAP）\n\n'
md += '> **以图为准。** 本文由 `ui-map-v' + version + '.json` 自动生成，只做索引；有冲突时以 PNG 为准。\n'
md += '> 重新生成：`pnpm ui:map` 后跑 `node ~/.dsh/agents-global/ui-map/write-ui-map-md.cjs docs/ui/ui-map-v' + version + '.json`\n'
md += '> 截图尺寸：**' + size.width + 'x' + size.height + ' 内容区**，不含系统标题栏。\n\n'

md += '## 怎么读这张图\n\n'
md += '- **细线 = 8px**，**粗线 = 64px**；一格 = 可以说"第 7 行第 C 列"。\n'
md += '- 列标 **A/B/C...** 沿顶部，行标 **1/2/3...** 沿左侧，从内容区左上角起算。\n'
md += '- **紫色框 + 字母** = 区域；**绿色框 + 数字** = 元素，编号在元素左上角。\n'
md += '- 报位置任选：`B7`、`C7-F9`、`区域 B`、`元素 5`。\n\n'

md += '## 网格调试开关\n\n'
md += '| 操作 | 效果 |\n| --- | --- |\n'
md += '| `Ctrl + Shift + G`（macOS `Cmd`） | 运行时显示 / 隐藏网格与编号 |\n'
md += '| URL 加 `?grid=1` | 以开启状态启动（截图脚本用这个） |\n'
md += '| `pnpm ui:map` | 重新生成全部截图与坐标 JSON |\n'
md += '| `node ~/.dsh/agents-global/ui-map/verify-map.cjs docs/ui/ui-map-v' + version + '-*.png` | 自检图里是否真有网格 |\n\n'
md += '网格覆盖层只在调试时使用，不参与业务；生产打包默认关闭。\n\n---\n\n'

md += '## 主图\n\n'
md += '![UI 总览](./ui-map-v' + version + '.png)\n\n---\n\n'

for (const name of viewIds) {
  const view = data.views[name]
  const title = KNOWN_TITLES[name] || name + '（待补中文标题）'
  md += '## ' + title + '\n\n'
  md += '![' + name + '](./ui-map-v' + version + '-' + name + '.png)\n\n'

  md += '### 区域\n\n| 编号 | 区域 | 坐标 |\n| --- | --- | --- |\n'
  for (const reg of view.regions || []) {
    const parts = String(reg.label).split(' ')
    const code = parts[0]
    const rest = parts.slice(1).join(' ')
    md += '| ' + code + ' | ' + rest + ' | ' + fmt(reg) + ' |\n'
  }

  md += '\n### 元素\n\n| 编号 | 元素 | 坐标 |\n| --- | --- | --- |\n'
  for (const t of view.targets || []) {
    md += '| ' + t.index + ' | ' + t.label + ' | ' + fmt(t) + ' |\n'
  }
  md += '\n'
}

md += '---\n\n'
md += '## 需求 → 位置 → 代码\n\n'
md += preserved['需求 → 位置 → 代码'] || '| 需求 | 图上位置 | 代码 |\n| --- | --- | --- |\n| _待补_ | | |'
md += '\n\n## 变更记录\n\n'
md += preserved['变更记录'] || '_待补_'
md += '\n\n## 已知约束\n\n'
md += preserved['已知约束'] ||
  '- 坐标只对 **' + size.width + 'x' + size.height + '** 有效；窗口更窄时响应式布局会变化，须重新出图。\n' +
  '- 元素编号按 DOM 顺序生成，**新增控件会让后面的编号后移** —— 改完 UI 必须重跑截图并重新生成本文。'

fs.writeFileSync(outPath, md, 'utf8')
console.log('已生成 ' + outPath + '（视图 ' + viewIds.length + ' 个）')
