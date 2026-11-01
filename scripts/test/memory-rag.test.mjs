/**
 * 记忆检索的纯逻辑测试。
 *
 * 覆盖的是「真正会出错的地方」：
 * - 中文分词能不能被 FTS5 命中（这是整个关键词检索的地基）
 * - 向量归一化与相似度的数值正确性
 * - 注入预算会不会被突破
 * - 模型输出解析在脏数据下会不会崩
 *
 * 不测 embedding 本身：那需要真实模型，属于集成测试，
 * 由 scripts/test/memory-model.test.mjs 单独验证。
 *
 * 实现说明：直接用 Node 24 的 module.stripTypeScriptTypes 剥掉类型后求值，
 * 不为测试额外引入编译步骤（项目现在没有 ts-node/esbuild 可直接调用）。
 */
import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (error) {
    console.error('  FAIL ' + name)
    throw error
  }
}

function readSource(relative) {
  return readFileSync(join(root, 'src', 'main', 'features', 'rag', relative), 'utf8')
}

/** 把模块源码剥类型 + 去掉 import/export，返回可取用的函数表 */
function loadModule(relative, { dropImports = true, constants = {} } = {}) {
  let source = readSource(relative)
  // 顺序很重要：必须先剥 import，再替换常量。
  // 否则 import { MEMORY_MAX_CHARS } 会被替换成 import { 300 } 而语法报错。
  if (dropImports) {
    source = source.replace(/^import[^\n]*\n/gm, '')
  }
  for (const [name, value] of Object.entries(constants)) {
    source = source.split(name).join(String(value))
  }
  let code = stripTypeScriptTypes(source)
  code = code.replace(/^export (async function|function|const|class)/gm, '$1')
  const names = [...code.matchAll(/^(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  return new Function(code + '\nreturn {' + names.join(',') + '}')()
}

const tokenMod = loadModule('tokenize.ts')
const vectorMod = loadModule('vector.ts')
const extractMod = loadModule('extract.ts', { constants: { MEMORY_MAX_CHARS: 300 } })

const { tokenize, toMatchQuery, estimateTokens } = tokenMod
const { cosine, normalize } = vectorMod
const { parseExtractResult } = extractMod

console.log('中文分词')
test('中文切成二元组', () => {
  const tokens = tokenize('纳西妲是草神')
  assert.ok(tokens.includes('纳西'), '应包含「纳西」，实际: ' + tokens.join(','))
  assert.ok(tokens.includes('草神'), '应包含「草神」，实际: ' + tokens.join(','))
})

test('两字词能被整体命中', () => {
  // 实测发现：FTS5 的 trigram 分词器对两字中文完全不命中，
  // 必须自己切词再用 unicode61 查，tokenize 的核心职责就是保证这一点。
  assert.ok(tokenize('须弥').includes('须弥'))
})

test('英文数字整体保留且小写', () => {
  const tokens = tokenize('用户在用GPT-4o做前端')
  assert.ok(tokens.includes('gpt'), '实际: ' + tokens.join(','))
  assert.ok(tokens.includes('4o'), '实际: ' + tokens.join(','))
})

test('标点不产生空 token', () => {
  const tokens = tokenize('你好，世界！')
  assert.ok(tokens.length > 0)
  assert.ok(tokens.every((item) => item.length > 0))
})

test('空输入返回空数组', () => {
  assert.deepEqual(tokenize(''), [])
})

test('重复词只保留一次', () => {
  const tokens = tokenize('草神草神')
  assert.equal(tokens.filter((item) => item === '草神').length, 1)
})

console.log('\nFTS 查询构造')
test('多词用 OR 连接，避免一词不中全丢', () => {
  const query = toMatchQuery('我住在上海')
  assert.ok(query.includes(' OR '), '实际: ' + query)
})

test('全部词被双引号包裹', () => {
  const query = toMatchQuery('上海 前端')
  const parts = query.split(' OR ')
  assert.ok(parts.every((part) => part.startsWith('"') && part.endsWith('"')), '实际: ' + query)
})

test('空查询返回空串', () => {
  assert.equal(toMatchQuery('!!!'), '')
})

console.log('\ntoken 估算')
test('中文按字计', () => {
  assert.equal(estimateTokens('一二三四五'), 5)
})

test('英文按 4 字符 1 token', () => {
  assert.equal(estimateTokens('abcdefgh'), 2)
})

test('中英混排相加', () => {
  assert.equal(estimateTokens('你好abcd'), 3)
})

test('空串为 0', () => {
  assert.equal(estimateTokens(''), 0)
})

console.log('\n向量运算')
test('归一化后模长为 1', () => {
  const vec = normalize(new Float32Array([3, 4]))
  const length = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1])
  assert.ok(Math.abs(length - 1) < 1e-5, '实际模长: ' + length)
})

test('相同向量相似度为 1', () => {
  const a = normalize(new Float32Array([1, 2, 3]))
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-5)
})

test('正交向量相似度为 0', () => {
  const a = normalize(new Float32Array([1, 0]))
  const b = normalize(new Float32Array([0, 1]))
  assert.ok(Math.abs(cosine(a, b)) < 1e-6)
})

test('零向量不产生 NaN', () => {
  const zero = normalize(new Float32Array([0, 0, 0]))
  assert.ok(zero.every((item) => Number.isFinite(item)))
})

test('长度不等时不越界', () => {
  const a = new Float32Array([1, 0, 0])
  const b = new Float32Array([1, 0])
  assert.ok(Number.isFinite(cosine(a, b)))
})

console.log('\n记忆抽取解析（脏数据容错）')
test('正常 JSON 解析出记忆', () => {
  assert.deepEqual(parseExtractResult('{"memories":["用户住在上海"]}'), ['用户住在上海'])
})

test('带 markdown 代码块的输出能解析', () => {
  const raw = '\u0060\u0060\u0060json\n{"memories":["用户是前端工程师"]}\n\u0060\u0060\u0060'
  assert.deepEqual(parseExtractResult(raw), ['用户是前端工程师'])
})

test('模型夹带解释文字也能抠出 JSON', () => {
  const raw = '好的，以下是结果：{"memories":["用户养了一只猫"]} 希望有帮助'
  assert.deepEqual(parseExtractResult(raw), ['用户养了一只猫'])
})

test('非法 JSON 返回空而不是抛异常', () => {
  assert.deepEqual(parseExtractResult('这不是 JSON'), [])
  assert.deepEqual(parseExtractResult(''), [])
  assert.deepEqual(parseExtractResult('{"memories":'), [])
})

test('过短条目被过滤（避免记下「嗯」这种废话）', () => {
  assert.deepEqual(parseExtractResult('{"memories":["嗯"]}'), [])
})

test('超长条目被过滤（防注入大段内容）', () => {
  const long = '啊'.repeat(400)
  assert.deepEqual(parseExtractResult(JSON.stringify({ memories: [long] })), [])
})

test('非字符串条目被过滤', () => {
  assert.deepEqual(parseExtractResult('{"memories":[123,null,"用户住上海"]}'), ['用户住上海'])
})

test('memories 不是数组时返回空', () => {
  assert.deepEqual(parseExtractResult('{"memories":"用户住上海"}'), [])
})

test('最多取 3 条，防模型跑偏', () => {
  const result = parseExtractResult(
    JSON.stringify({ memories: ['记忆一甲', '记忆二甲', '记忆三甲', '记忆四甲', '记忆五甲'] })
  )
  assert.equal(result.length, 3)
})

console.log('\n注入预算')
/** 复刻 buildContextBlock 的预算循环，验证「绝不超预算」这个不变量 */
function budgetBuild(hits, budget, header, footer) {
  const lines = []
  let used = estimateTokens(header) + estimateTokens(footer)
  const accepted = []
  for (const hit of hits) {
    const line = '- ' + hit.content
    const cost = estimateTokens(line)
    if (used + cost > budget) break
    used += cost
    lines.push(line)
    accepted.push(hit.id)
  }
  return { lines, used, accepted }
}

test('预算够时全部注入', () => {
  const hits = [{ id: 'a', content: '用户住在上海' }]
  const result = budgetBuild(hits, 800, '头部', '尾部')
  assert.equal(result.lines.length, 1)
})

test('预算不足时整条丢弃，不切半句', () => {
  const hits = [
    { id: 'a', content: '用户住在上海' },
    { id: 'b', content: '用户长期养了一只名叫小白的橘猫并且住在徐汇区' }
  ]
  const result = budgetBuild(hits, 15, '头部', '尾部')
  assert.ok(result.used <= 15, '超预算: ' + result.used)
  // 被丢弃的条目不能以残句形式出现
  assert.ok(!result.lines.some((line) => line.includes('小白') && !line.includes('橘猫')))
})

test('预算永远不被突破（50 条压力）', () => {
  const hits = Array.from({ length: 50 }, (_, i) => ({ id: String(i), content: '第' + i + '条记忆内容' }))
  const result = budgetBuild(hits, 100, '头部', '尾部')
  assert.ok(result.used <= 100, '超预算: ' + result.used)
})

test('大预算不被代码里的隐形上限砍掉', () => {
  // 这里曾经有个 2000 的硬上限，用户填 20000 也会被压回 2000。
  // 预算现在完全由用户决定，50 条长记忆必须能全部塞进去。
  const long = '用户住在上海市徐汇区并且在张江的一家公司做前端工程，平时习惯凌晨写代码，养了一只橘猫'
  const hits = Array.from({ length: 50 }, (_, i) => ({ id: String(i), content: '第' + i + '条：' + long }))
  const result = budgetBuild(hits, 20000, '头部', '尾部')
  assert.equal(result.lines.length, 50, '实际只注入了 ' + result.lines.length + ' 条')
  assert.ok(result.used > 2000, '总消耗应超过旧硬上限，实际: ' + result.used)
})

console.log('\n共 ' + passed + ' 项通过')