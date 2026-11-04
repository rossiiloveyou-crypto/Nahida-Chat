/**
 * P7 G9 渠道控制台 —— 渲染层源码契约测试（12 项）。
 *
 * 渲染层没有 DOM 测试设施（既有测试全是 node 脚本跑主进程逻辑），
 * 本套用「读文件 + 断言结构」替代。它不是 UI 测试，但能挡住真实故障：
 *  - 两块白名单里的某一块被人「清理」掉（用户原话形状被破坏）
 *  - 面板偷偷复制一遍主进程校验（J-34：两套规则必然分叉）
 *  - 主进程被顺手改了（P7 的硬约束：src/main/ 零改动，由 B1 命令单独验）
 *
 * 跑法：node scripts/test/channels-ui-contract.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')
const settingsDir = path.join(projectRoot, 'src/renderer/src/features/settings')
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8')

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
}

const nav = read('src/renderer/src/features/settings/nav.ts')
const icons = read('src/renderer/src/features/settings/icons.tsx')
const page = read('src/renderer/src/features/settings/SettingsPage.tsx')
const section = read('src/renderer/src/features/settings/sections/ChannelsSection.tsx')
const useZones = read('src/renderer/src/features/settings/useZones.ts')
const zonesSection = read('src/renderer/src/features/settings/sections/ZonesSection.tsx')

// 1 · nav 里 channels 的顺序在 zones 之后、qq 之前
const navArray = nav.slice(nav.indexOf('SETTINGS_NAV'))
const iZones = navArray.indexOf("id: 'zones'")
const iChannels = navArray.indexOf("id: 'channels'")
const iQq = navArray.indexOf("id: 'qq'")
check(
  '1 · nav.ts 的 channels 位置在 zones 之后、qq 之前',
  iZones >= 0 && iChannels > iZones && iQq > iChannels,
  'zones=' + iZones + ' channels=' + iChannels + ' qq=' + iQq
)

// 2 · label 是「渠道控制台」
check('2 · channels 的 label 是「渠道控制台」', nav.includes("label: '渠道控制台'"))

// 3 · icons 导出 IconChannels
check(
  '3 · icons.tsx 导出 IconChannels',
  /export function IconChannels\s*\(/.test(icons) || /export const IconChannels\s*=/.test(icons)
)

// 4 · SettingsPage 有 channels 分支
check("4 · SettingsPage.tsx 含 active === 'channels'", page.includes("active === 'channels'"))

// 5 · 四块各自成区（P9-R3 重做后的形状）
//
// P9-R3 把「按会话」改成「按人」，面板从 A/B 两块变成四块：
//   A0 机器人账号 / A QQ 号白名单 / B 群白名单 / C 鉴权开关 / E 渠道工作区 / D 数据位置
//   （P3 补 E 区：M21 的「可配置」落点，J-01 要求它必须有可见入口）
// 区域名是字面量（data-ui-region="…"），断言直接查四个字面量都在。
const regions = (section.match(/data-ui-region="[^"]+"/g) || []).map((item) =>
  item.replace(/data-ui-region="|"/g, '')
)
check(
  '5 · 面板含 QQ 号白名单 / 群白名单 / 鉴权开关 三个区域',
  regions.some((item) => item.includes('QQ 号白名单')) &&
    regions.some((item) => item.includes('群白名单')) &&
    regions.some((item) => item.includes('鉴权开关')),
  regions.join(' | ')
)

// 5b · P3：渠道工作区区必须存在且带标注（J-01：看得见的开关必须有行为断言，见 channel-tool-path）
check(
  '5b · 面板含「渠道工作区」区域（P3 / M21 的可配置落点）',
  regions.some((item) => item.includes('渠道工作区')),
  regions.join(' | ')
)
check(
  '5c · 渠道工作区路径有 data-ui-target 标注（出图后能被指认）',
  /data-ui-target="渠道工作区路径"/.test(section)
)

// 5d · P3 复核补正：F 渠道模型区**只读展示**，且真的接上了档案回落
//
// 为什么要有这一条：F 区是「新增提示，不改变行为」。但「不改变行为」这句话本身也要能变红 ——
// 一旦有人顺手给它加一个写入路径（选择器 / settings.save / 会话 update），
// 它就变成了功能变更，而 P3 的结论是那件事归 BL-12。
// 同时守住另一头：不许把主进程的 resolveProfile 抄一份判定逻辑进来（J-34）。
check(
  '5d · 面板含「渠道模型」区域（P3 复核补正的只读提示）',
  regions.some((item) => item.includes('渠道模型')),
  regions.join(' | ')
)
check(
  '5e · 渠道模型值有 data-ui-target 标注（出图后能被指认）',
  /data-ui-target="渠道当前模型"/.test(section)
)
{
  // 只读的三条硬边界，全部用「出现即红」的写法：
  //   ① 不许出现任何 settings.save({ channelModel… }) 之类的新设置项
  //   ② 不许对会话调用 updateSession / modelProfileId 写入
  //   ③ 不许把 resolveProfile 的判定抄进渲染层（只允许同形的 find ?? [0]，见 ChatPage:69）
  const writesModel = /channelModelProfileId|channelModelId/.test(section)
  const updatesSession = /updateSession\s*\(/.test(section)
  const ownsResolve = /function\s+resolveProfile|const\s+resolveProfile/.test(section)
  // 回落形状：必须按 defaultProfileId 找、找不到取 [0]、再从档案的 defaultModel 取模型名
  const picksProfile =
    /catalog\.profiles\.find\(\(item\) => item\.id === [\w.]*catalog\.defaultProfileId\)/.test(section) &&
    /\.profiles\[0\]/.test(section) &&
    /\.defaultModel/.test(section)
  check(
    '5f · 渠道模型区不含任何写入路径（无新设置项 / 无 updateSession / 无自建 resolveProfile）',
    !writesModel && !updatesSession && !ownsResolve && picksProfile,
    '设置项=' + writesModel + ' updateSession=' + updatesSession + ' 自建判定=' + ownsResolve + ' 回落形状=' + picksProfile
  )
}

// 6 · 「按人」与「按群」是两张表，各自有独立列宽类（J-62）
check(
  '6 · 账号表与群表各用独立的列宽类（J-62：列数不同必须单独一条 grid）',
  section.includes('qq-table--accounts') && section.includes('qq-table--groups')
)

// 7 · 没有硬编码色值
const hex = section.match(/#[0-9a-fA-F]{3,6}\b/g) || []
check('7 · ChannelsSection.tsx 没有硬编码色值', hex.length === 0, hex.join(','))

// 8 · 渲染层不重复实现主进程校验（三条并用）
//
// ⚠️ 只断言「那条中文文案不出现」是不够的：主进程的文案一改，这条就变成**恒真**，
//    测试永远绿而什么也没守住（复核 X-01 指出）。所以改成三条并用：
//    ① 不出现任何 throw new Error(   —— 面板不做校验，只转发
//    ② 不出现旧文案                —— 挡住「有人把那条规则又抄回来」
//    ③ 不出现号码相等比较           —— 挡住换个写法重造同一个 bug
const hasThrow = /throw\s+new\s+Error\s*\(/.test(section)
const hasOldCopy = section.includes('私聊的会话号必须等于 QQ 号')
const hasEqCompare = /uin\s*[!=]==?\s*chatId|chatId\s*[!=]==?\s*uin/.test(section)
check(
  '8 · 面板不重复实现主进程校验（无 throw / 无旧文案 / 无号码相等比较）',
  !hasThrow && !hasOldCopy && !hasEqCompare,
  'throw=' + hasThrow + ' 旧文案=' + hasOldCopy + ' 相等比较=' + hasEqCompare
)

// 9 · useZones 不含 bindings
check(
  '9 · useZones.ts 不含 bindings',
  !/\bbindings\b/.test(useZones),
  (useZones.match(/\bbindings\b/g) || []).length
)

// 10 · 渲染层不出现 QqBinding
const rendererFiles = []
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) walk(full)
    else if (/\.(ts|tsx)$/.test(item.name)) rendererFiles.push(full)
  }
}
walk(path.join(projectRoot, 'src/renderer'))
const bindingHits = rendererFiles.filter((file) => fs.readFileSync(file, 'utf8').includes('QqBinding'))
check('10 · 渲染层不含 QqBinding', bindingHits.length === 0, bindingHits.join(','))

// 11 · ZonesSection 的候选来自 zones.unzoned（主进程白名单投影）
check(
  '11 · ZonesSection 的候选来自 zones.unzoned',
  zonesSection.includes('zones.unzoned')
)

// 12 · 区块面板空态文案指向渠道控制台
check('12 · 区块面板空态文案指向渠道控制台', zonesSection.includes('渠道控制台'))

/* ── P9-R2 / R3：面板契约（13…20） ──────────────────────────────────────── */

const css = read('src/renderer/src/styles/global.css')
const observeSection = read('src/renderer/src/features/settings/sections/ObservePanel.tsx')

// 13 · C14：账号表的 grid 值个数 == 表头列数（J-62：换了列数却沿用别人的类名会让表头折行）
{
  const headMatch = section.match(/qq-table--accounts[\s\S]{0,200}?<\/div>/)
  const headCells = (section.match(/qq-table--accounts[\s\S]{0,600}?<div className="qq-table__head">([\s\S]*?)<\/div>/) || ['', ''])[1]
  const cellCount = (headCells.match(/<span>/g) || []).length
  const rule = (css.match(/\.qq-table--accounts \.qq-table__head,\s*\n\.qq-table--accounts \.qq-table__row \{\s*\n\s*grid-template-columns:([^;]+);/) || ['', ''])[1]
  const valueCount = rule.trim().split(/\s+(?![^(]*\))/).filter(Boolean).length
  check(
    '13 · C14 账号表 grid 值个数 === 表头列数（J-62）',
    cellCount > 0 && valueCount === cellCount,
    '表头 ' + String(cellCount) + ' 列 / grid ' + String(valueCount) + ' 值' + (headMatch ? '' : '')
  )
}

// 14 · 群表的 grid 值个数 == 表头列数
{
  const headCells = (section.match(/qq-table--groups[\s\S]{0,600}?<div className="qq-table__head">([\s\S]*?)<\/div>/) || ['', ''])[1]
  const cellCount = (headCells.match(/<span>/g) || []).length
  const rule = (css.match(/\.qq-table--groups \.qq-table__head,\s*\n\.qq-table--groups \.qq-table__row \{\s*\n\s*grid-template-columns:([^;]+);/) || ['', ''])[1]
  const valueCount = rule.trim().split(/\s+(?![^(]*\))/).filter(Boolean).length
  check(
    '14 · 群表 grid 值个数 === 表头列数（J-62）',
    cellCount > 0 && valueCount === cellCount,
    '表头 ' + String(cellCount) + ' 列 / grid ' + String(valueCount) + ' 值'
  )
}

// 15 · R2/C1：旁听表头 8 列，第 2 列文案 = 「账号」
{
  const headCells = (observeSection.match(/<div className="qq-table__head">([\s\S]*?)<\/div>/) || ['', ''])[1]
  const labels = (headCells.match(/<span>([^<]*)<\/span>/g) || []).map((item) => item.replace(/<\/?span>/g, ''))
  check('15 · R2-C1 旁听表头 8 列且第 2 列是「账号」', labels.length === 8 && labels[1] === '账号', labels.join(' | '))
}

// 16 · R2-C2：每行渲染 item.uin
check(
  '16 · R2-C2 行里渲染 item.uin（账号列有值）',
  /item\.uin/.test(observeSection) && /title=\{'记录账号 uin：' \+ item\.uin\}/.test(observeSection),
  ''
)

// 17 · R2/C5：.qq-table--observe 的 grid 是 8 个值 **且宽度预算够**
//
// 「列数对」不等于「显示得出来」。第一版 8 列写死 540px 固定宽，
// 678px 的表只剩 138px 给两个 fr 列（各 69px），实测群号截成「7...」、名称截成「<...」。
// 这里把宽度也一起断言：固定列合计 + 7 个 10px gap 之后，剩下的必须 ≥ 200px。
{
  const rule = (css.match(/\.qq-table--observe \.qq-table__head,\s*\n\.qq-table--observe \.qq-table__row \{\s*\n\s*grid-template-columns:([^;]+);/) || ['', ''])[1]
  const parts = rule.trim().split(/\s+(?![^(]*\))/).filter(Boolean)
  const fixed = parts
    .filter((item) => /^\d+px$/.test(item))
    .reduce((sum, item) => sum + Number(item.replace('px', '')), 0)
  const frCount = parts.filter((item) => item.includes('fr')).length
  // 渠道控制台内容区 720px − 两个 21px 内边距 ≈ 678px；8 列之间 7 个 gap，每个 10px
  const remaining = 678 - fixed - 7 * 10
  check('17a · R2-C5 .qq-table--observe 的 grid 是 8 个值', parts.length === 8, String(parts.length) + ' 值：' + rule.trim())
  check(
    '17b · R2-C5 固定列之外还给 fr 列留下 ≥200px（否则群号会被截断）',
    remaining >= 200 && frCount === 2,
    '固定列合计 ' + fixed + 'px，剩余 ' + remaining + 'px，fr 列 ' + frCount + ' 个'
  )
}

// 18 · R2/C8：跨号角标只在 >1 时渲染
check(
  '18 · R2-C8 跨号角标 qq-tag-multi 只在 >1 时出现',
  observeSection.includes('qq-tag-multi') && /\(accountCount\.get\(item\.chatId\) \?\? 0\) > 1/.test(observeSection)
)

// 19 · R2/C7：面板不再定时轮询 status()
{
  const hook = read('src/renderer/src/features/settings/useObserve.ts')
  check('19 · R2-C7 useObserve.ts 里 setInterval 命中 = 0', !/setInterval/.test(hook), (hook.match(/setInterval/g) || []).length)
}

// 20 · R2-C4：跨号提示的**判定与数字**都必须对
//
// 原来的实现是 `new Set(chatId).size !== conversations.length`，只用来决定「显不显示」，
// 但正文里却写了「其中 {会话总数} 项…」—— 那是把**总数**当成了**被多号共记的个数**。
// 实测 26 个会话 / 5 个被共记，面板会写「其中 26 项」，是错的。
// 现在分开算：multiChatIds（≥2 个账号的会话号个数）+ duplicateRows（多出来的行数）。
check(
  '20a · R2-C4 跨号提示只在「确实有被多号共记的会话」时出现',
  /const multiChatIds = \[\.\.\.accountCount\.values\(\)\]\.filter\(\(count\) => count > 1\)\.length/.test(
    observeSection
  ) && /\{multiChatIds > 0 && \(/.test(observeSection)
)
check(
  '20b · R2-C4 提示里的数字用 multiChatIds 与 duplicateRows，不是会话总数',
  /\{multiChatIds\}/.test(observeSection) &&
    /\{duplicateRows\}/.test(observeSection) &&
    !/其中 \{total\?\.conversations \?\? 0\} 项/.test(observeSection)
)
check(
  '20c · R2-C4 duplicateRows = 会话数 − 去重后的会话号数',
  /const duplicateRows = observe\.conversations\.length - accountCount\.size/.test(observeSection)
)

// 21 · 「群成员鉴权」与「工具调用拦截」两个总开关的文案都要写清「模型看得到工具」
check(
  '21 · 工具开关文案写清「模型照常看得到工具」（J-65）',
  section.includes('模型照常看得到工具') && section.includes('我没有这个权限')
)

/* ---------- 汇总 ---------- */
let failed = 0
for (const item of checks) {
  if (item.ok) console.log('  ok   ' + item.name)
  else {
    failed += 1
    console.log('  FAIL ' + item.name + (item.detail ? '  :: ' + item.detail : ''))
  }
}
console.log('')
console.log('channels-ui-contract: ' + (checks.length - failed) + '/' + checks.length + ' passed')
if (failed > 0) {
  console.log('FAIL')
  process.exitCode = 1
} else {
  console.log('PASS')
}