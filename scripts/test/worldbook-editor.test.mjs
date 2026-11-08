/**
 * 世界书编写器（P9）—— A-01…A-18。
 *
 * 测的是**真实边界**（不是把实现重写一遍）：
 *  - 真解析仓库里 73 条真实世界书（A-11），但**只读**，绝不写 Prompt/；
 *  - 所有写操作都在 mkdtemp 临时目录里（A-02…A-09 / A-13…A-18）；
 *  - 守恒判据用**原文切片逐字比对**（A-04 / A-05），不是「条目数没变」。
 *
 * 跑法：node scripts/test/worldbook-editor.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-worldbook-'))
installElectronStub(userData)
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ defaultCharacterId: 'nahida' }), 'utf8')

const mod = await bundleModule(
  'worldbook-editor',
  [
    `export * from '${p('src/main/features/worldbook/parse.ts')}'`,
    `export { filterWorldbookEntries } from '${p('src/renderer/src/features/worldbook/filter.ts')}'`,
    `export { listWorldbook, parseFile, addEntry, updateEntry, removeEntry, createWorldbook, knownDirs, findDuplicates, assertMarkdownInDir } from '${p('src/main/features/worldbook/editor.ts')}'`,
    `export { StoryStore } from '${p('src/main/features/story/store.ts')}'`,
    `export { IPC } from '${p('src/shared/ipc.ts')}'`
  ].join('\n')
)
const {
  parseWorldbookFile,
  serializeEntry,
  splitKeywords,
  isConformingEntry,
  findEntryBlock,
  addEntry,
  updateEntry,
  removeEntry,
  createWorldbook,
  knownDirs,
  findDuplicates,
  listWorldbook,
  assertMarkdownInDir,
  StoryStore,
  IPC,
  filterWorldbookEntries
} = mod

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, text) => fs.writeFileSync(file, text, 'utf8')

/** 建一个隔离的世界书目录，并在里面放若干 .md */
function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wb-'))
  for (const [name, text] of Object.entries(files)) write(path.join(dir, name), text)
  return dir
}

/**
 * 调一个可能抛的实现：抛错 → 记一条**红**并返回 null。
 * 🔴 为什么需要：突变（M1/M2…）常常让被测函数直接抛异常。若断言处不兜，
 *    Node 会在第一条抛错处整体崩掉，**后面所有断言都不会执行** ——
 *    那时日志里只剩「exit=1」而没有任何「共 N 项」分母，就分不清
 *    「守卫生效」与「根本没跑到」（J-24 / J-21）。
 */
function safe(label, fn) {
  try {
    const value = fn()
    // 🔴 成功也要记一条：否则「共 N 项」的分母会随突变与否变动（69 ↔ 70…），
    //    那时「红了几条」与「少跑了几条」又分不清了（J-21 / J-24 的同一条纪律）。
    check(label, true)
    return value
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error))
    return null
  }
}

/** 一条样例（与 Prompt/…/README.md 的模板逐字同构） */
function sampleEntry({ title, id, keywords = '钟楼, 雾', always = '否', priority = 5, value = 55, chained = '无', body = '正文内容。' }) {
  return [
    '## ' + title,
    '- id: ' + id,
    '- 触发词: ' + keywords,
    '- 常驻: ' + always,
    '- 优先级: ' + priority,
    '- 内在价值: ' + value,
    '- 连带触发词: ' + chained,
    '',
    body,
    '',
    '---',
    ''
  ].join('\n')
}

function draft(extra = {}) {
  return {
    title: '新条目',
    keywords: ['甲', '乙'],
    always: false,
    priority: 5,
    value: 55,
    chained: [],
    body: '新正文。',
    ...extra
  }
}

/* ───────────────────────── A-01 解析样例 ───────────────────────── */
{
  const text =
    sampleEntry({ title: '钟楼', id: 'a'.repeat(32), keywords: '钟楼, 雾', always: '是', priority: 9, value: 88 }) +
    '\n' +
    sampleEntry({ title: '花海', id: 'b'.repeat(32), keywords: '甘露，花灵、帕蒂', always: '否', priority: 3, value: 40 })
  const entries = parseWorldbookFile('sample.md', text)
  // 🔴 逐条读时一律走空对象兜底：解析被破坏时要出「红」，而不是让后面的断言**还没跑就崩**
  //    （J-24：突变行必须能区分「红了」与「根本没执行」）。崩溃会让 A-11 这类后续守卫整段失明。
  const first = entries[0] ?? {}
  const second = entries[1] ?? {}
  check('A-01a 解析出 2 条', entries.length === 2, entries.length)
  check('A-01b 中英文逗号都切（2 项）', JSON.stringify(first.keywords) === JSON.stringify(['钟楼', '雾']), first.keywords)
  check('A-01c 中文逗号与顿号都切（3 项）', JSON.stringify(second.keywords) === JSON.stringify(['甘露', '花灵', '帕蒂']), second.keywords)
  check('A-01d 常驻 是/否 → true/false', first.always === true && second.always === false)
  check('A-01e 优先级/价值是数字', first.priority === 9 && first.value === 88 && second.priority === 3 && second.value === 40)
  check('A-01f 正文不含结尾分隔线', !String(first.body ?? '').includes('---') && first.body === '正文内容。', JSON.stringify(first.body))
}

/* ───────────────────────── A-02 新增（README 不被改） ───────────────────────── */
const base = makeDir({
  'README.md': '# 索引\n\n' + sampleEntry({ title: '模板示例', id: 'f'.repeat(32) }).replace(/\n/g, '\n> '),
  'world.md': sampleEntry({ title: '钟楼', id: 'a'.repeat(32), keywords: '钟楼' })
})
{
  const readmeBefore = sha(path.join(base, 'README.md'))
  const listing = safe('A-02 前置：addEntry 不抛错', () => addEntry(base, 'world.md', draft({ title: '花海', keywords: ['甘露'] }))) ?? { files: [] }
  const text = read(path.join(base, 'world.md'))
  const readmeAfter = sha(path.join(base, 'README.md'))
  check('A-02a 文件里出现新条目标题', text.includes('## 花海'))
  check('A-02b 新条目带 - id: 行', /## 花海\n- id: [0-9a-f]{32}/.test(text), text.split('\n').find((l) => l.includes('id:')))
  check('A-02c listWorldbook 读回该条目', listing.files.some((f) => f.entries.some((e) => e.title === '花海')))
  check('A-02d README.md 未被改（sha256 相同）', readmeBefore === readmeAfter)
}

/* ───────────────────────── A-03 id 形状与唯一 ───────────────────────── */
{
  const dir = makeDir({ 'w.md': sampleEntry({ title: '甲', id: '1'.repeat(32) }) })
  const listing = safe('A-03 前置：addEntry 不抛错', () => addEntry(dir, 'w.md', draft({ title: '乙' }))) ?? { files: [] }
  const ids = (listing.files[0]?.entries ?? []).map((e) => e.id)
  const fresh = ids.find((id) => id !== '1'.repeat(32)) ?? ''
  check('A-03a 新 id 是 32 位十六进制', /^[0-9a-f]{32}$/.test(fresh), fresh)
  check('A-03b 与同文件既有 id 不重复', new Set(ids).size === ids.length, ids.length)
}

/* ───────────────────────── A-04 删除守恒（J-10） ───────────────────────── */
function blockSlice(text, id) {
  const range = findEntryBlock(text, id)
  return range ? text.slice(range.start, range.end) : null
}
{
  const dir = makeDir({
    'w.md':
      sampleEntry({ title: '甲', id: 'a'.repeat(32), keywords: '甲' }) +
      sampleEntry({ title: '乙', id: 'b'.repeat(32), keywords: '乙' }) +
      sampleEntry({ title: '丙', id: 'c'.repeat(32), keywords: '丙' })
  })
  const file = path.join(dir, 'w.md')
  const before = read(file)
  const keepA = blockSlice(before, 'a'.repeat(32))
  const keepC = blockSlice(before, 'c'.repeat(32))
  const listing = safe('A-04 前置：removeEntry 不抛错', () => removeEntry(dir, 'w.md', 'b'.repeat(32))) ?? { files: [] }
  const after = read(file)
  check('A-04a 目标条目消失', !after.includes('## 乙') && !(listing.files[0]?.entries ?? []).some((e) => e.id === 'b'.repeat(32)))
  check('A-04b 前一条逐字不变', blockSlice(after, 'a'.repeat(32)) === keepA)
  check('A-04c 后一条逐字不变', blockSlice(after, 'c'.repeat(32)) === keepC)
  check('A-04d 条数守恒（3 → 2）', (listing.files[0]?.entries ?? []).length === 2, (listing.files[0]?.entries ?? []).length)
}

/* ───────────────────────── A-05 编辑守恒 ───────────────────────── */
{
  const dir = makeDir({
    'w.md':
      sampleEntry({ title: '甲', id: 'a'.repeat(32), keywords: '甲' }) +
      sampleEntry({ title: '乙', id: 'b'.repeat(32), keywords: '乙' }) +
      sampleEntry({ title: '丙', id: 'c'.repeat(32), keywords: '丙' })
  })
  const file = path.join(dir, 'w.md')
  const before = read(file)
  const keepA = blockSlice(before, 'a'.repeat(32))
  const keepC = blockSlice(before, 'c'.repeat(32))
  safe('A-05 前置：updateEntry 不抛错', () =>
    updateEntry(dir, 'w.md', 'b'.repeat(32), draft({ title: '乙改', keywords: ['乙新'], priority: 7, value: 77, body: '换过的正文。' }))
  )
  const after = read(file)
  const edited = parseWorldbookFile(file, after).find((e) => e.id === 'b'.repeat(32))
  check('A-05a 目标条目字段被更新', !!edited && edited.title === '乙改' && edited.priority === 7 && edited.value === 77 && edited.body === '换过的正文。', edited && edited.title)
  check('A-05b 前一条逐字不变', blockSlice(after, 'a'.repeat(32)) === keepA)
  check('A-05c 后一条逐字不变', blockSlice(after, 'c'.repeat(32)) === keepC)
  check('A-05d 其余条目数不变', parseWorldbookFile(file, after).length === 3)
}

/* ───────────────────────── A-06 原子写 + .bak ───────────────────────── */
{
  const dir = makeDir({ 'w.md': sampleEntry({ title: '甲', id: 'a'.repeat(32) }) })
  addEntry(dir, 'w.md', draft({ title: '乙' }))
  const names = fs.readdirSync(dir)
  check('A-06a 无 *.tmp 残留', names.every((name) => !name.endsWith('.tmp')), names.join(','))
  check('A-06b 存在写前备份 w.md.bak', names.includes('w.md.bak'), names.join(','))
  check('A-06c 备份内容是写前原文', read(path.join(dir, 'w.md.bak')).includes('## 甲') && !read(path.join(dir, 'w.md.bak')).includes('## 乙'))
}

/* ───────────────────────── A-07 / A-08 路径守卫 ───────────────────────── */
{
  const dir = makeDir({ 'w.md': sampleEntry({ title: '甲', id: 'a'.repeat(32) }), 'README.md': '# 索引\n' })
  const outside = path.join(path.dirname(dir), 'evil.md')
  let relThrow = ''
  let absThrow = ''
  try {
    addEntry(dir, '../evil.md', draft())
  } catch (error) {
    relThrow = String(error && error.message)
  }
  try {
    addEntry(dir, outside, draft())
  } catch (error) {
    absThrow = String(error && error.message)
  }
  check('A-07a 相对越界抛错', relThrow.includes('不在世界书目录内'), relThrow)
  check('A-07b 未写盘（目录外没有 evil.md）', !fs.existsSync(outside))
  check('A-07c 绝对越界抛错', absThrow.length > 0, absThrow)
  check('A-07d 非 .md 抛错', (() => { try { addEntry(dir, 'w.txt', draft()); return false } catch { return true } })())
}
{
  const dir = makeDir({ 'w.md': sampleEntry({ title: '甲', id: 'a'.repeat(32) }), 'README.md': '# 索引\n' })
  const listing = listWorldbook(dir)
  check('A-08a files 不含 README.md', listing.files.every((f) => path.basename(f.file).toLowerCase() !== 'readme.md'), listing.files.map((f) => path.basename(f.file)).join(','))
  let readmeThrow = ''
  try {
    addEntry(dir, 'README.md', draft())
  } catch (error) {
    readmeThrow = String(error && error.message)
  }
  check('A-08b 对 README.md add 抛错', readmeThrow.includes('README.md'), readmeThrow)
}

/* ───────────────────────── A-09 新建世界书 ───────────────────────── */
{
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wb-new-')), '我的世界书')
  const listing = createWorldbook(dir)
  check('A-09a 目录被建出', fs.existsSync(dir) && fs.statSync(dir).isDirectory())
  check('A-09b README.md 与首个 md 都在', fs.existsSync(path.join(dir, 'README.md')) && fs.existsSync(path.join(dir, 'world.md')))
  check('A-09c 首次列表不炸且 0 条', listing.kind === 'dir' && listing.files.every((f) => f.entries.length === 0), listing.files.length)
  check('A-09d README 的模板示例不被当成条目', parseWorldbookFile(path.join(dir, 'README.md'), read(path.join(dir, 'README.md'))).length === 0)
  const after = addEntry(dir, 'world.md', draft({ title: '首条' }))
  check('A-09e 新建后可立刻新增', after.files.some((f) => f.entries.some((e) => e.title === '首条')))
}

/* ───────────────────────── A-10 knownDirs ───────────────────────── */
{
  const storyWb = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-wb-story-'))
  write(path.join(storyWb, 'x.md'), sampleEntry({ title: '剧本', id: 'd'.repeat(32) }))
  new StoryStore().create({ title: '测试故事', characterId: 'nahida', worldbookDir: storyWb }, { characterId: 'nahida' })
  const dirs = knownDirs()
  const nahida = dirs.find((item) => item.kind === 'character' && item.dir.endsWith(path.join('characters', 'nahida', 'worldbook')))
  const story = dirs.find((item) => item.kind === 'story' && item.dir === path.resolve(storyWb))
  check('A-10a 含 nahida 角色 worldbook 绝对目录', !!nahida && path.isAbsolute(nahida.dir), nahida && nahida.dir)
  check('A-10b 含某故事区配置的 worldbookDir', !!story, story && story.label)
  check('A-10c 标签区分角色与故事', !!nahida && nahida.kind === 'character' && !!story && story.kind === 'story')
}

/* ───────────────────────── A-11 真实只读解析 ───────────────────────── */
{
  const dir = p('Prompt/characters/nahida/worldbook')
  const counts = {}
  for (const name of ['world.md', 'characters.md', 'story.md', 'nahida.md']) {
    const file = path.join(dir, name)
    // 🔴 解析抛异常也要落成一次「红」，不许让整个套件在这里崩掉（后面的守卫就全失明了）
    try {
      counts[name] = parseWorldbookFile(file, read(file)).length
    } catch (error) {
      counts[name] = -1
      console.log('        （' + name + ' 解析抛错：' + String(error && error.message) + '）')
    }
  }
  check('A-11a world.md 29 条', counts['world.md'] === 29, counts['world.md'])
  check('A-11b characters.md 20 条', counts['characters.md'] === 20, counts['characters.md'])
  check('A-11c story.md 12 条', counts['story.md'] === 12, counts['story.md'])
  check('A-11d nahida.md 12 条', counts['nahida.md'] === 12, counts['nahida.md'])
  check('A-11e 合计 73 条', Object.values(counts).reduce((a, b) => a + b, 0) === 73)
}

/* ───────────────────────── A-12 splitKeywords ───────────────────────── */
{
  const words = splitKeywords('a, b，c、d')
  check('A-12 splitKeywords 中英文逗号与顿号 → 4 项', JSON.stringify(words) === JSON.stringify(['a', 'b', 'c', 'd']), words)
}

/* ───────────────────────── A-13 只提取合规段落（配对照物，J-02） ───────────────────────── */
{
  const plain = '# 普通文档\n\n## 第一节\n\n一些说明。\n\n## 第二节\n\n更多说明。\n'
  const zero = parseWorldbookFile('plain.md', plain)
  const one = parseWorldbookFile('real.md', sampleEntry({ title: '真条目', id: 'a'.repeat(32) }))
  check('A-13a 普通 ## 小节 → 0 条', zero.length === 0, zero.length)
  check('A-13b 对照：真世界书条目 → 1 条', one.length === 1, one.length)
  check('A-13c isConformingEntry 对普通小节为假', isConformingEntry('## 第一节\n\n一些说明。') === false)
}

/* ───────────────────────── A-14 任意文件名 / 目录判别 ───────────────────────── */
{
  const dir = makeDir({
    '随便起的名字.md': sampleEntry({ title: '任意名', id: 'a'.repeat(32), keywords: '任意' }),
    'other.md': sampleEntry({ title: '另一个', id: 'b'.repeat(32), keywords: '另一' })
  })
  const single = listWorldbook(path.join(dir, '随便起的名字.md'))
  const whole = listWorldbook(dir)
  check('A-14a 单文件 → kind=file 且只解析该文件', single.kind === 'file' && single.files.length === 1 && single.files[0]?.entries?.[0]?.title === '任意名', single.kind)
  check('A-14b 目录 → kind=dir 且聚合 .md', whole.kind === 'dir' && whole.files.length === 2, whole.files.length)
}

/* ───────────────────────── A-15 零合规仍可写 ───────────────────────── */
{
  const dir = makeDir({ 'empty.md': '# 只有标题\n\n没有任何元数据。\n' })
  const before = parseWorldbookFile(path.join(dir, 'empty.md'), read(path.join(dir, 'empty.md')))
  const listing = safe('A-15 前置：addEntry 不抛错', () => addEntry(dir, 'empty.md', draft({ title: '第一条' }))) ?? { files: [] }
  check('A-15a 写前 0 条', before.length === 0)
  const firstAdded = listing.files[0]?.entries ?? []
  check('A-15b 追加成功且能读回 1 条', firstAdded.length === 1 && firstAdded[0]?.title === '第一条', firstAdded.length)
  check('A-15c 原有内容未被破坏', read(path.join(dir, 'empty.md')).includes('# 只有标题'))
}

/* ───────────────────────── A-16 围栏跳过 ───────────────────────── */
{
  const readme = path.join(p('Prompt/characters/nahida/worldbook'), 'README.md')
  const entries = parseWorldbookFile(readme, read(readme))
  check('A-16a 真实 README.md（含模板围栏）→ 0 条', entries.length === 0, entries.length)
  const fenced = '# doc\n\n```markdown\n' + sampleEntry({ title: '模板示例', id: 'f'.repeat(32) }) + '```\n'
  check('A-16b 围栏内的条目不被提取', parseWorldbookFile('f.md', fenced).length === 0)
  const outside = '# doc\n\n' + sampleEntry({ title: '围栏外', id: 'e'.repeat(32) }) + '\n```\ncode\n```\n'
  check('A-16c 对照：围栏外的条目仍被提取', parseWorldbookFile('o.md', outside).length === 1)
}

/* ───────────────────────── A-17 重复触发词检测 ───────────────────────── */
{
  const dir = makeDir({
    'w.md':
      sampleEntry({ title: '甲楼', id: 'a'.repeat(32), keywords: '钟楼, 古钟' }) +
      sampleEntry({ title: '乙雾', id: 'b'.repeat(32), keywords: '雾' })
  })
  const dup = findDuplicates(dir, 'w.md', ['钟楼', '雾'])
  const words = dup.map((item) => item.keyword).sort()
  check('A-17a 返回两项重复（钟楼 / 雾）', JSON.stringify(words) === JSON.stringify(['钟楼', '雾'].sort()), words)
  check('A-17b owners 指向占用条目标题', dup.some((item) => item.keyword === '钟楼' && item.owners.includes('甲楼')), JSON.stringify(dup))
  const self = findDuplicates(dir, 'w.md', ['钟楼'], 'a'.repeat(32))
  check('A-17c excludeId 时不把自己算重复', self.length === 0, JSON.stringify(self))
}

/* ───────────────────────── A-18 重复只提醒不阻断 ───────────────────────── */
{
  const dir = makeDir({ 'w.md': sampleEntry({ title: '甲楼', id: 'a'.repeat(32), keywords: '钟楼' }) })
  const listing = safe('A-18 前置：addEntry 不抛错', () => addEntry(dir, 'w.md', draft({ title: '乙', keywords: ['钟楼'] }))) ?? { files: [] }
  const afterAdd = listing.files[0]?.entries ?? []
  check('A-18a 撞词仍成功写入', afterAdd.some((e) => e.title === '乙'), afterAdd.map((e) => e.title).join(','))
  check('A-18b 磁盘上确有两个条目', parseWorldbookFile(path.join(dir, 'w.md'), read(path.join(dir, 'w.md'))).length === 2)
}

/* ───────────────────────── A-19 缺 id 条目：保留 + 可编辑（补 id） ───────────────────────── */
{
  const noId = ['## 无 id 条目', '- 触发词: 甲, 乙', '- 常驻: 否', '- 优先级: 4', '- 内在价值: 40', '', '正文。', '', '---', ''].join('\n')
  const dir = makeDir({ 'w.md': noId + sampleEntry({ title: '正常条目', id: 'a'.repeat(32), keywords: '丙' }) })
  const parsed = parseWorldbookFile(path.join(dir, 'w.md'), read(path.join(dir, 'w.md')))
  check('A-19a 缺 id 条目仍被列出并标 missingId', parsed.length === 2 && parsed[0].missingId === true && !parsed[1].missingId, JSON.stringify(parsed.map((e) => [e.title, e.missingId])))
  const keepNormal = blockSlice(read(path.join(dir, 'w.md')), 'a'.repeat(32))
  const listing = safe('A-19 前置：updateEntry（缺 id）不抛错', () =>
    updateEntry(dir, 'w.md', '', draft({ title: '无 id 条目', keywords: ['甲', '乙'], priority: 4, value: 40, body: '改过的正文。' }), '无 id 条目')
  ) ?? { files: [] }
  const after = read(path.join(dir, 'w.md'))
  const reparsed = parseWorldbookFile(path.join(dir, 'w.md'), after)
  const fixed = reparsed.find((e) => e.title === '无 id 条目')
  check('A-19c 保存后补上了 32 位 id', !!fixed && /^[0-9a-f]{32}$/.test(fixed.id) && !fixed.missingId, fixed && fixed.id)
  check('A-19d 正文被更新', !!fixed && fixed.body === '改过的正文。', fixed && fixed.body)
  check('A-19e 另一条逐字不变', blockSlice(after, 'a'.repeat(32)) === keepNormal)
  check('A-19f 条目数仍为 2', listing.files[0]?.entries?.length === 2, listing.files[0]?.entries?.length)
}

/* ───────────────────────── A-20 缺 id 条目可删除 / 同名不猜 ───────────────────────── */
{
  // 🔴 合规门槛：触发词 + 至少再 2 个次级键（只写「触发词 + 常驻」是不合规的，那样根本列不出来）
  const noId = ['## 无 id 条目', '- 触发词: 甲', '- 常驻: 否', '- 优先级: 3', '', '正文。', '', '---', ''].join('\n')
  const dir = makeDir({ 'w.md': noId + sampleEntry({ title: '正常条目', id: 'a'.repeat(32) }) })
  const keepNormal = blockSlice(read(path.join(dir, 'w.md')), 'a'.repeat(32))
  safe('A-20 前置：removeEntry（缺 id）不抛错', () => removeEntry(dir, 'w.md', '', '无 id 条目'))
  const after = read(path.join(dir, 'w.md'))
  check('A-20b 缺 id 条目被整段删除', !after.includes('## 无 id 条目'))
  check('A-20c 另一条逐字不变', blockSlice(after, 'a'.repeat(32)) === keepNormal)
  // 同名两条缺 id → 不猜（抛错且不写盘）
  const dup = makeDir({
    'd.md': ['## 同名', '- 触发词: 甲', '- 常驻: 否', '- 优先级: 3', '', 'A', '', '---', ''].join('\n')
      + ['## 同名', '- 触发词: 乙', '- 常驻: 否', '- 优先级: 4', '', 'B', '', '---', ''].join('\n')
  })
  const before = read(path.join(dup, 'd.md'))
  let threw = ''
  try {
    removeEntry(dup, 'd.md', '', '同名')
  } catch (error) {
    threw = String(error && error.message)
  }
  check('A-20d 同名两条缺 id → 抛错（不猜）', threw.length > 0, threw)
  check('A-20e 不猜时文件一字未改', read(path.join(dup, 'd.md')) === before)
}

/* ───────────────────────── A-21 条目搜索（标题 / 触发词） ───────────────────────── */
{
  const entries = [
    { title: '钟楼', keywords: ['指针', '三点'] },
    { title: '花海', keywords: ['甘露', 'Nightingale'] },
    { title: '世界树', keywords: ['禁忌知识'] }
  ]
  const byTitle = filterWorldbookEntries(entries, '花')
  const byKeyword = filterWorldbookEntries(entries, '禁忌')
  const caseInsensitive = filterWorldbookEntries(entries, 'night')
  const blank = filterWorldbookEntries(entries, '   ')
  const none = filterWorldbookEntries(entries, '不存在')
  check('A-21a 按标题命中', byTitle.length === 1 && byTitle[0].title === '花海', byTitle.map((e) => e.title).join(','))
  check('A-21b 按触发词命中', byKeyword.length === 1 && byKeyword[0].title === '世界树', byKeyword.map((e) => e.title).join(','))
  check('A-21c 触发词大小写无关', caseInsensitive.length === 1 && caseInsensitive[0].title === '花海', caseInsensitive.map((e) => e.title).join(','))
  check('A-21d 空查询返回全部且是新数组', blank.length === entries.length && blank !== entries)
  check('A-21e 无命中返回空数组', none.length === 0)
  check('A-21f 过滤不改原数组', entries.length === 3 && entries[0].title === '钟楼')
}

/* ───────────────────────── 通道存在性（J-01：控件必须有行为） ───────────────────────── */
{
  const channels = Object.keys(IPC).filter((key) => IPC[key].startsWith('worldbook:'))
  check('通道：worldbook:* 至少 8 个', channels.length >= 8, channels.join(','))
}

done()
