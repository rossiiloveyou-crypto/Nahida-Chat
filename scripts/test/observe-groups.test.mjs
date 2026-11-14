/**
 * 旁听群号「收起 + 弹层搜索」—— O-01…O-09 纯函数 + 4 条结构守卫。
 *
 * 报障：群号在设置页平铺，一屏全是数字（刷屏）。改成面板只留概要 + 入口，
 * 细节进弹层，弹层里能按 群号 / 群名 / 账号 搜。
 *
 * 测的是真边界：匹配口径（AND、大小写、群聊/私聊关键字）与「表格确实搬出了面板」。
 *
 * 跑法：node scripts/test/observe-groups.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { bundleModule, createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()

const mod = await bundleModule(
  'observe-groups',
  "export * from '" + p('src/renderer/src/features/settings/observeFilter.ts') + "'"
)
const { filterObserveConversations, countObserveKinds } = mod

/* ───────────────────── 样本 ───────────────────── */
const row = (chatType, uin, chatId, label) => ({
  key: 'qq:' + uin + ':' + chatType + ':' + chatId,
  uin,
  chatType,
  chatId,
  label,
  segments: 1,
  bytes: 1024,
  lines: 12,
  lastAt: 1700000000000
})
const LIST = [
  row('group', '10001', '123456789', '时钟研究小组'),
  row('group', '10002', '123456789', '时钟研究小组'),
  row('group', '10001', '987654321', '雨夜读书会'),
  row('private', '10001', '20001', '')
]

/* ───────────────────── 匹配口径 ───────────────────── */
check('O-01 空查询原样返回（同一个数组引用，不复制不排序）', filterObserveConversations(LIST, '') === LIST && filterObserveConversations(LIST, '   ') === LIST, 'identity')
check('O-02 按完整群号命中 2 行（两个账号各一行）', filterObserveConversations(LIST, '123456789').length === 2, String(filterObserveConversations(LIST, '123456789').length))
check('O-03 按**部分**群号命中（人不会把 9 位背全）', filterObserveConversations(LIST, '4567').length === 2, String(filterObserveConversations(LIST, '4567').length))
check('O-04 按群名命中', filterObserveConversations(LIST, '读书').length === 1 && filterObserveConversations(LIST, '读书')[0].chatId === '987654321', JSON.stringify(filterObserveConversations(LIST, '读书').map((i) => i.chatId)))
check('O-05 按账号 uin 命中（看某个号记了哪些）', filterObserveConversations(LIST, '10002').length === 1, String(filterObserveConversations(LIST, '10002').length))
check(
  'O-06 多词是 AND：群号 + 账号 → 只剩一行',
  filterObserveConversations(LIST, '123456789 10002').length === 1 &&
    filterObserveConversations(LIST, '123456789 10002')[0].uin === '10002',
  JSON.stringify(filterObserveConversations(LIST, '123456789 10002').map((i) => i.uin))
)
check('O-07 群聊 / 私聊也能当关键词（筛类型）', filterObserveConversations(LIST, '群聊').length === 3 && filterObserveConversations(LIST, '私聊').length === 1, JSON.stringify({ g: filterObserveConversations(LIST, '群聊').length, p: filterObserveConversations(LIST, '私聊').length }))
check('O-08 没有命中 → 空数组（不抛）', Array.isArray(filterObserveConversations(LIST, '不存在的群')) && filterObserveConversations(LIST, '不存在的群').length === 0, 'empty')
check('O-09 群 / 私聊计数', (() => { const k = countObserveKinds(LIST); return k.groups === 3 && k.privates === 1 })(), JSON.stringify(countObserveKinds(LIST)))

/* ───────────────────── 结构守卫 ───────────────────── */
const readText = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
const panel = readText('src/renderer/src/features/settings/sections/ObservePanel.tsx')
const dialog = readText('src/renderer/src/features/settings/sections/ObserveGroupsDialog.tsx')
const css = readText('src/renderer/src/styles/global.css')

check(
  'O-10 面板不再平铺群号表（表格只剩 tail 那一张）',
  !/qq-table--observe[^-]/.test(panel) && panel.includes('data-ui-target="旁听群号概要"'),
  'panel-collapsed'
)
check(
  'O-11 面板有「打开群号一览」入口，且没记录时禁用',
  panel.includes('data-ui-target="打开群号一览"') && /disabled=\{observe\.loading \|\| observe\.conversations\.length === 0\}/.test(panel),
  'entry-button'
)
check(
  'O-12 弹层有搜索框 + 命中计数 + Esc 关闭',
  dialog.includes('data-ui-target="旁听群号搜索"') &&
    dialog.includes('命中 ') &&
    dialog.includes("event.key === 'Escape'") &&
    dialog.includes('filterObserveConversations('),
  'dialog-search'
)
check(
  'O-13 弹层没有任何删除 / 清空旁听的入口（只增不清）',
  !/清空旁听|删除旁听|clearObserve|observe\.clear/.test(dialog + panel),
  'readonly'
)
check(
  'O-14 弹层是遮罩 + 独立面板，表格在弹层里滚',
  css.includes('.observe-dialog {') && css.includes('.observe-dialog__body {') && css.includes('.story-dialog__backdrop'),
  'modal-css'
)

done()
