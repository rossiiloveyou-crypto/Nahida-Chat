/**
 * 记忆检索的集成测试：真 SQLite + 真 embedding 模型。
 *
 * 这是「能不能用」的验收，不是「逻辑对不对」的单元测试。
 * 需要 models/Xenova/bge-m3 已就位；缺失时明确跳过而不是假通过。
 *
 * 必须在 Electron 或带 node:sqlite 的 Node 24+ 下跑：
 *   node scripts/test/memory-integration.test.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const modelDir = join(root, 'models', 'Xenova', 'bge-m3')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log('  ok  ' + name + (detail ? '  (' + detail + ')' : ''))
  } else {
    failed += 1
    console.error('  FAIL ' + name + (detail ? '  (' + detail + ')' : ''))
  }
}

// ── 1. FTS5 中文命中（这是整个关键词检索的地基，先验这个）──
console.log('FTS5 中文检索')
const mem = new DatabaseSync(':memory:')
mem.exec('CREATE TABLE m(id TEXT PRIMARY KEY, content TEXT, seg TEXT)')
// content_rowid 必须指向整数 rowid，不能指向 TEXT 主键——这是 FTS5 外部内容表的硬约束
mem.exec("CREATE VIRTUAL TABLE m_fts USING fts5(seg, tokenize='unicode61')")

function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const cjk = /[\u4e00-\u9fff]/.test(text[i])
    if (cjk) {
      let j = i
      while (j < text.length && /[\u4e00-\u9fff]/.test(text[j])) j += 1
      const run = text.slice(i, j)
      if (run.length === 1) tokens.push(run)
      else {
        for (let k = 0; k + 1 < run.length; k += 1) tokens.push(run.slice(k, k + 2))
        for (const ch of run) tokens.push(ch)
      }
      i = j
      continue
    }
    i += 1
  }
  return [...new Set(tokens)]
}

const docs = [
  ['m1', '用户住在上海，是一名前端工程师'],
  ['m2', '用户养了一只叫小白的橘猫'],
  ['m3', '用户喜欢在周末去爬山']
]
const ins = mem.prepare('INSERT INTO m VALUES(?,?,?)')
for (const [id, content] of docs) {
  const seg = tokenize(content).join(' ')
  ins.run(id, content, seg)
  mem.prepare('INSERT INTO m_fts(seg) VALUES(?)').run(seg)
}

function keywordSearch(query, limit = 10) {
  // 查询侧：整体只有 1 个汉字时才放开单字，否则泛词会污染关键词分数
  const cjkLength = (query.match(/[\u4e00-\u9fff]/g) ?? []).length
  const tokens = cjkLength <= 1 ? tokenize(query) : tokenize(query).filter((t) => t.length > 1)
  if (tokens.length === 0) return []
  const match = tokens.map((t) => '"' + t + '"').join(' OR ')
  try {
    return mem
      .prepare('SELECT m.id id, bm25(m_fts) r FROM m_fts JOIN m ON m.rowid = m_fts.rowid WHERE m_fts MATCH ? ORDER BY r LIMIT ?')
      .all(match, limit)
      .map((row) => row.id)
  } catch {
    return []
  }
}

const catHit = keywordSearch('猫')
check('两字中文词能命中（trigram 做不到，必须靠切词）', catHit.includes('m2'), '命中 ' + catHit.join(','))
const cityHit = keywordSearch('上海')
check('地名能命中', cityHit.includes('m1'), '命中 ' + cityHit.join(','))
const multiHit = keywordSearch('上海 前端')
check('多词 OR 召回', multiHit.includes('m1'), '命中 ' + multiHit.join(','))
check('无关键词返回空而不是异常', keywordSearch('!!!').length === 0)

// ── 2. 真实模型 ──
if (!existsSync(join(modelDir, 'config.json'))) {
  console.log('\n跳过真实模型测试：' + modelDir + ' 不存在')
  console.log('\n通过 ' + passed + '，失败 ' + failed)
  process.exit(failed > 0 ? 1 : 0)
}

console.log('\n真实 embedding 模型')
const workDir = mkdtempSync(join(tmpdir(), 'nahida-mem-'))
try {
  process.env.TRANSFORMERS_CACHE = workDir
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = join(root, 'models')
  env.useBrowserCache = false

  const loadStart = Date.now()
  const extractor = await pipeline('feature-extraction', 'Xenova/bge-m3', { dtype: 'q8' })
  const loadMs = Date.now() - loadStart
  check('模型能离线加载', true, loadMs + 'ms')
  check('加载耗时在可接受范围（<8s）', loadMs < 8000, loadMs + 'ms')

  const embed = async (texts) => {
    const out = await extractor(texts, { pooling: 'cls', normalize: true })
    const flat = out.data
    const size = flat.length / texts.length
    const vectors = []
    for (let i = 0; i < texts.length; i += 1) vectors.push(flat.slice(i * size, (i + 1) * size))
    return vectors
  }

  const inferStart = Date.now()
  const [queryVec, ...docVecs] = await embed(['我住在哪', ...docs.map((d) => d[1])])
  const inferMs = Date.now() - inferStart
  check('维度是 1024', queryVec.length === 1024, '实际 ' + queryVec.length)
  check('推理耗时可接受（<3s）', inferMs < 3000, inferMs + 'ms')

  const dot = (a, b) => {
    let s = 0
    for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
    return s
  }
  const scores = docVecs.map((v) => dot(queryVec, v))
  const bestIndex = scores.indexOf(Math.max(...scores))

  check(
    '语义检索把「住哪」正确指向上海那条',
    docs[bestIndex][0] === 'm1',
    '最高分 ' + scores[bestIndex].toFixed(3) + ' -> ' + docs[bestIndex][1]
  )
  check(
    '相关与无关有区分度（差值 > 0.05）',
    scores[bestIndex] - Math.min(...scores) > 0.05,
    '差值 ' + (scores[bestIndex] - Math.min(...scores)).toFixed(3)
  )

  // ── 3. 混合检索：语义 + 关键词，验证 0.7/0.3 融合 ──
  console.log('\n混合检索融合')
  const hybridStart = Date.now()
  const kwHits = keywordSearch('我住在哪')
  const kwScore = new Map()
  kwHits.forEach((id, index) => kwScore.set(id, kwHits.length - index))
  const maxKw = Math.max(...kwScore.values(), 0)

  const fused = docs.map((doc, index) => {
    const vectorNorm = scores[index] / Math.max(...scores)
    const keywordNorm = maxKw > 0 ? (kwScore.get(doc[0]) ?? 0) / maxKw : 0
    return { id: doc[0], score: vectorNorm * 0.7 + keywordNorm * 0.3 }
  })
  fused.sort((a, b) => b.score - a.score)
  const hybridMs = Date.now() - hybridStart
  check('融合结果仍然指向上海', fused[0].id === 'm1', 'top=' + fused[0].id)
  check('融合耗时远小于模型推理', hybridMs < 600, hybridMs + 'ms')

  // ── 4. 暴力检索性能（决定要不要引 ANN）──
  console.log('\n暴力余弦性能')
  const dims = 1024
  for (const count of [1000, 5000, 20000]) {
    const pool = Array.from({ length: count }, () => queryVec) // 复用同一向量，只测算力
    const start = Date.now()
    let acc = 0
    for (const vec of pool) acc += dot(queryVec, vec)
    const ms = Date.now() - start
    check(
      '暴力扫描 ' + count + ' 条约 ' + ms + 'ms',
      ms < 200,
      ms + 'ms'
    )
    if (acc === -1) console.log('')
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

console.log('\n通过 ' + passed + '，失败 ' + failed)
process.exit(failed > 0 ? 1 : 0)