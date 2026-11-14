/**
 * P5 渲染层契约（\`MPU-nn\`）：读源码断言，不跑 DOM。
 *
 * 与 \`channels-ui-contract.test.mjs\` 同一套手法：面板的实质行为由数据层判据
 * （\`MP-nn\`）守着，这里只盯「渲染层有没有退回旧形态」——全局清空按钮、全库平铺、
 * 旧文案、列数对不上的表、危险区跑到页面中间。
 *
 * 跑法：node scripts/test/memory-panel-ui-contract.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const read = (rel) => fs.readFileSync(p(rel), 'utf8')

const sectionSource = read('src/renderer/src/features/settings/sections/MemorySection.tsx')
const cssSource = read('src/renderer/src/styles/global.css')
const ragSource = read('src/main/features/rag/index.ts')
const mainSources = {
  'commands/run.ts': fs.existsSync(p('src/main/features/commands/run.ts')) ? read('src/main/features/commands/run.ts') : '',
  'ipc/memory.ts': read('src/main/ipc/memory.ts')
}

check('MPU-01 渲染层不再调用全库 clear()', (sectionSource.match(/memory\.clear\(/g) ?? []).length === 0)
check('MPU-01 渲染层不再出现「清空全部记忆」', !sectionSource.includes('清空全部记忆'))
check('MPU-02 M24 文案在位：启用 RAG 记忆', sectionSource.includes('启用 RAG 记忆'))
check('MPU-02 M24 文案在位：聊天记录与对话摘要照常', sectionSource.includes('聊天记录与对话摘要照常'))
check('MPU-02 旧文案「启用长期记忆」已消失', !sectionSource.includes('启用长期记忆'))
check('MPU-02 条数标题改称 RAG 事实条数', sectionSource.includes('RAG 事实条数'))

// 「按人删除」在源码里出现多次（注释、确认框、按钮），取**最后一次**才是那个按钮。
const dangerIndex = sectionSource.lastIndexOf('按人删除')
const titles = ['对话摘要（窗口外的对话）', '运行状态', '检索参数', '检索调试', '按人查看与清理', '危险区']
check('MPU-03 危险区在页面最底部（按人删除晚于所有分区标题）',
  dangerIndex > 0 && titles.every((title) => {
    const at = sectionSource.indexOf(title)
    return at >= 0 && at < dangerIndex
  }),
  dangerIndex)

check('MPU-04 确认框写了「仍然可以」', sectionSource.includes('仍然可以'))
check('MPU-04 确认框写了「群聊」边界', sectionSource.includes('群聊'))
check('MPU-04 确认框写了「故事区」边界', sectionSource.includes('故事区'))
check('MPU-04 确认框逐面报数（会删掉 + 不会删掉）', sectionSource.includes('会删掉：') && sectionSource.includes('不会删掉：'))

check('MPU-05 渲染层不再调全库 memory.list()', (sectionSource.match(/memory\.list\(/g) ?? []).length === 0)
check('MPU-05 列表走按人接口 users()', sectionSource.includes('memory.users()'))

const gridOf = (selector) => {
  const at = cssSource.indexOf(selector)
  if (at < 0) return null
  const block = cssSource.slice(at, cssSource.indexOf('}', at))
  const match = block.match(/grid-template-columns:\s*([^;]+);/)
  return match ? match[1].trim() : null
}
const memoryGrid = gridOf('.qq-table--memory .qq-table__head')
const personaGrid = gridOf('.qq-table--memory-personas .qq-table__head')
const countTracks = (value) => (value ? value.split(/\s+(?![^(]*\))/).length : 0)
check('MPU-06 按人表 CSS 存在且 5 列', countTracks(memoryGrid) === 5, memoryGrid)
check('MPU-06 人设表 CSS 存在且 5 列', countTracks(personaGrid) === 5, personaGrid)
check('MPU-06 两张表不复用 --accounts 的列宽', !cssSource.includes('.qq-table--accounts .qq-table__head,\n.qq-table--memory'))

check('MPU-07 详情页显示真实 dbPath', sectionSource.includes('selected.dbPath'))
check('MPU-07 详情页注明单库租户列', sectionSource.includes('租户列'))
check('MPU-08 注入标记【长期记忆 · 未被改动', ragSource.includes('【长期记忆 ·'))
check('MPU-09 ipc/memory.ts 不写 ROOT_USER_ID 兜底', !mainSources['ipc/memory.ts'].includes('ROOT_USER_ID'))

done()
