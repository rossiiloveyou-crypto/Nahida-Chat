/**
 * QQ 设置存储（P6 改写：绑定表已下线，本套只剩「设置」）。
 *
 * 原 23 项里删掉的 11 项全与绑定 CRUD 有关（saveBinding / deleteBinding /
 * normalizeBindings / 绑定 key 拼接 / 绑定去重），它们的意图没有丢：
 *  - 「白名单语义」→ 搬到 channels-store.test.mjs（key 构造、去重、非法条目丢弃）
 *  - 「原子写 / 坏文件不抛」→ 保留在本套（设置文件走同一个 writeJson）
 *
 * 跑法：node scripts/test/qq-store.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-qq-store-test-'))
installElectronStub(userData)

const { QqStore, normalizeSettings } = await bundleModule(
  'store',
  `export { QqStore, normalizeSettings } from '${p('src/main/features/qq/store.ts')}'`
)

const dir = path.join(userData, 'qq')
const store = new QqStore(dir)
const settingsFile = path.join(dir, 'settings.json')

console.log('1 · 文件不存在 → 默认值')
const defaults = store.settings()
check('segmentDelayMs 默认 500', defaults.segmentDelayMs === 500, defaults.segmentDelayMs)
check('rateLimitPerChannel 默认 60', defaults.rateLimitPerChannel === 60, defaults.rateLimitPerChannel)

console.log('2-4 · 写入 → 重读 → 原子写')
const saved = store.saveSettings({ typingMode: 'off', maxCharsPerSegment: 99999 })
check('saveSettings 返回归一化后的新值', saved.typingMode === 'off' && saved.maxCharsPerSegment === 4000, saved.typingMode + '/' + saved.maxCharsPerSegment)
check('新实例重读还是新值', new QqStore(dir).settings().typingMode === 'off')
check('写入后没有 .tmp 残留', !fs.existsSync(settingsFile + '.tmp'), fs.readdirSync(dir).join(','))

console.log('5-8 · 数字字段钳制')
fs.writeFileSync(settingsFile, JSON.stringify({ maxSegments: 99, segmentDelayMs: -5 }), 'utf8')
const clampedHigh = store.settings()
check('maxSegments 99 → 20', clampedHigh.maxSegments === 20, clampedHigh.maxSegments)
check('segmentDelayMs -5 → 0', clampedHigh.segmentDelayMs === 0, clampedHigh.segmentDelayMs)
fs.writeFileSync(settingsFile, JSON.stringify({ maxSegments: 0, segmentDelayMs: 99999 }), 'utf8')
const clampedLow = store.settings()
check('maxSegments 0 → 1', clampedLow.maxSegments === 1, clampedLow.maxSegments)
check('segmentDelayMs 99999 → 5000', clampedLow.segmentDelayMs === 5000, clampedLow.segmentDelayMs)

console.log('9-11 · 文本字段')
check('未给的字段回落到默认值', clampedLow.typingText === '正在看…', clampedLow.typingText)
fs.writeFileSync(settingsFile, JSON.stringify({ typingMode: '瞎写' }), 'utf8')
check('typingMode 非法 → text', store.settings().typingMode === 'text', store.settings().typingMode)
fs.writeFileSync(settingsFile, JSON.stringify({ typingText: '一'.repeat(80) }), 'utf8')
check('typingText 超长截到 40 码点', Array.from(store.settings().typingText).length === 40, Array.from(store.settings().typingText).length)

console.log('12-14 · 空值 / 超长 / 多余字段')
fs.writeFileSync(settingsFile, JSON.stringify({ typingText: '   ', errorReplyText: 'x'.repeat(300) }), 'utf8')
const blank = store.settings()
check('typingText 只有空白 → 回落默认', blank.typingText === '正在看…', JSON.stringify(blank.typingText))
check('errorReplyText 截到 200 字', blank.errorReplyText.length === 200, blank.errorReplyText.length)
const extra = normalizeSettings({ ...blank, 未知字段: 1, memory: { enabled: true } })
check('多余字段被丢弃（白名单式归一化）', !('未知字段' in extra) && !('memory' in extra), Object.keys(extra).join(','))

console.log('15-16 · 坏文件 / 非法数字')
fs.writeFileSync(settingsFile, '不是 JSON', 'utf8')
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => {
  warnings.push(args.map(String).join(' '))
}
const broken = store.settings()
console.warn = originalWarn
check('坏文件 → 回落默认值且不抛', broken.rateLimitPerChannel === 60, broken.rateLimitPerChannel)
check('并且记了一条 warn', warnings.some((line) => line.includes('qq-store')), warnings.length + ' 条')
check('NaN 数字 → 回落默认值', normalizeSettings({ maxSegments: Number.NaN }).maxSegments === 10, normalizeSettings({ maxSegments: Number.NaN }).maxSegments)

console.log('17 · 旧绑定文件不再被读取（但原样保留）')
const legacy = path.join(dir, 'bindings.json')
fs.writeFileSync(legacy, '{坏掉的旧文件', 'utf8')
const legacyBefore = fs.readFileSync(legacy, 'utf8')
const stillOk = store.settings()
check('旧 bindings.json 存在也不影响设置读取', stillOk.typingMode === 'text' || stillOk.typingMode === 'off', stillOk.typingMode)
check('旧文件内容一个字节都没动', fs.readFileSync(legacy, 'utf8') === legacyBefore)

done()
