/**
 * 验证「测试连接」的解析逻辑对每种服务商返回都能给出正确结论。
 * 用本地模拟服务，不依赖真实 API Key。
 */
import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

// 把 modelTest.ts 剥类型后加载（它只依赖 shared/constants 的两个常量）
let source = readFileSync(join(root, 'src/main/features/settings/modelTest.ts'), 'utf8')
source = source.replace(/^import[^\n]*\n/gm, '')
source = source.replace(/MODEL_TEST_TIMEOUT_MS/g, '20000')
source = source.replace(/providerMeta\(\s*provider\s*\)\.label/g, '"服务商"')
// export async function 有两种写法，统一处理
let code = stripTypeScriptTypes(source)
code = code.replace(/^export\s+(async\s+function|function|const|let|class)/gm, '$1')
const names = [...code.matchAll(/^(?:async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
const mod = new Function(code + '\nreturn {' + names.join(',') + '}')()
const { testModelConnection } = mod

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + name + (detail ? '  (' + detail + ')' : '')) }
  else { failed++; console.error('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')) }
}

const BASE = 'http://127.0.0.1:18080/v1'

console.log('测试连接 - OpenAI 兼容')
const ok = await testModelConnection({ provider: 'openai-compatible', baseUrl: BASE, apiKey: 'sk-test-key-123456', model: 'test-model' })
check('能连上并拿到回包', ok.ok === true, ok.error || '')
check('sample 被正确解析出来', typeof ok.sample === 'string' && ok.sample.length > 0, ok.sample ? ok.sample.slice(0, 40) : '空')
check('耗时被记录', typeof ok.latencyMs === 'number' && ok.latencyMs >= 0, ok.latencyMs + 'ms')

console.log('\n错误分支')
const badKey = await testModelConnection({ provider: 'openai-compatible', baseUrl: BASE, apiKey: 'x', model: 'test-model' })
check('无效 key 返回 not ok', badKey.ok === false)
check('错误信息含状态码 401', String(badKey.error).includes('401'), String(badKey.error).slice(0, 60))

const noKey = await testModelConnection({ provider: 'openai-compatible', baseUrl: BASE, apiKey: '', model: 'test-model' })
check('空 key 也被服务端拒绝（说明确实发出去了）', noKey.ok === false, String(noKey.error).slice(0, 50))

const noUrl = await testModelConnection({ provider: 'openai-compatible', baseUrl: '', apiKey: 'k', model: 'm' })
check('空 baseUrl 在本地就被拦下', noUrl.ok === false && String(noUrl.error).includes('baseUrl'), noUrl.error)

const noModel = await testModelConnection({ provider: 'openai-compatible', baseUrl: BASE, apiKey: 'sk-test-key-123456', model: '' })
check('空 model 在本地就被拦下', noModel.ok === false && String(noModel.error).includes('模型'), noModel.error)

const badHost = await testModelConnection({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test-key-123456', model: 'm' })
check('连不上的地址给出错误而不是崩', badHost.ok === false, String(badHost.error).slice(0, 50))

console.log('\nmock 档案')
const mock = await testModelConnection({ provider: 'mock', baseUrl: '', apiKey: '', model: 'demo' })
check('演示模式恒为 ok 且不联网', mock.ok === true && mock.latencyMs === 0)

console.log('\n通过 ' + passed + '，失败 ' + failed)
process.exit(failed > 0 ? 1 : 0)