/**
 * 「获取可用模型」的解析测试。
 *
 * 真实世界里这个接口的返回格式比文档写的乱得多：
 * 有的服务商给 data[]，有的给 models[]，Gemini 的 name 还带 "models/" 前缀，
 * 中转站经常只实现一部分。这里逐个格式验证解析结果，不联网。
 *
 * 跑法：pnpm test:discovery
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

function loadModule(relative, { constants = {}, rename = {} } = {}) {
  let source = readFileSync(join(root, 'src', 'main', 'features', 'settings', relative), 'utf8')
  source = source.replace(/^import[^\n]*\n/gm, '')
  for (const [name, value] of Object.entries(constants)) {
    source = source.split(name).join(String(value))
  }
  let code = stripTypeScriptTypes(source)
  code = code.replace(/^export (async function|function|const|class)/gm, '$1')
  for (const [from, to] of Object.entries(rename)) {
    code = code.replace(new RegExp('\\b' + from + '\\b', 'g'), to)
  }
  const names = [...code.matchAll(/^(?:async function|function|const|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  return new Function(code + '\nreturn {' + names.join(',') + '}')()
}

const mod = loadModule('modelDiscovery.ts', {
  constants: { MODEL_TEST_TIMEOUT_MS: 20000, providerMeta: '(v) => ({ label: v })' }
})
const { parseModelList } = mod

console.log('OpenAI 兼容格式')
test('data[].id 被正确提取', () => {
  const models = parseModelList('openai', JSON.stringify({
    object: 'list',
    data: [
      { id: 'gpt-4.1', object: 'model' },
      { id: 'gpt-4o-mini', object: 'model' }
    ]
  }))
  assert.deepEqual(models.map((m) => m.id), ['gpt-4.1', 'gpt-4o-mini'])
})
test('空条目与重复 id 被过滤', () => {
  const models = parseModelList('openai', JSON.stringify({
    data: [{ id: 'a' }, { id: '' }, { id: 'a' }, { id: '  ' }]
  }))
  assert.deepEqual(models.map((m) => m.id), ['a'])
})
test('中转站给的 context_window 被采纳', () => {
  const models = parseModelList('openai', JSON.stringify({
    data: [{ id: 'm', context_window: 200000 }]
  }))
  assert.equal(models[0].contextWindowTokens, 200000)
})
test('没给上下文窗口时为 null，不瞎猜', () => {
  const models = parseModelList('openai', JSON.stringify({ data: [{ id: 'm' }] }))
  assert.equal(models[0].contextWindowTokens, null)
})
test('input_modalities 含 image 时标记多模态', () => {
  const models = parseModelList('openai', JSON.stringify({
    data: [{ id: 'm', input_modalities: ['text', 'image'] }]
  }))
  assert.equal(models[0].multimodal, true)
})

console.log('Anthropic 格式')
test('data[].id 与 display_name', () => {
  const models = parseModelList('anthropic', JSON.stringify({
    data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', max_input_tokens: 200000 }]
  }))
  assert.equal(models[0].id, 'claude-sonnet-4-5')
  assert.equal(models[0].name, 'Claude Sonnet 4.5')
  assert.equal(models[0].contextWindowTokens, 200000)
})

console.log('Gemini 格式')
test('去掉 models/ 前缀', () => {
  const models = parseModelList('gemini', JSON.stringify({
    models: [
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576 }
    ]
  }))
  assert.equal(models[0].id, 'gemini-2.5-pro')
  assert.equal(models[0].name, 'Gemini 2.5 Pro')
  assert.equal(models[0].contextWindowTokens, 1048576)
})

console.log('Ollama 格式')
test('models[].name 作为调用名保留标签', () => {
  const models = parseModelList('ollama', JSON.stringify({
    models: [{ name: 'qwen3:8b' }, { name: 'llama3.1:8b' }]
  }))
  assert.deepEqual(models.map((m) => m.id), ['llama3.1:8b', 'qwen3:8b'])
})

console.log('脏数据容错')
test('非 JSON 返回空数组而不是抛异常', () => {
  assert.deepEqual(parseModelList('openai', '<html>404</html>'), [])
})
test('JSON 但不是对象时返回空', () => {
  assert.deepEqual(parseModelList('openai', '[1,2,3]'), [])
})
test('结构对不上时返回空', () => {
  assert.deepEqual(parseModelList('openai', JSON.stringify({ error: 'bad key' })), [])
})
test('结果按 id 排序，便于用户查找', () => {
  const models = parseModelList('openai', JSON.stringify({
    data: [{ id: 'z-model' }, { id: 'a-model' }]
  }))
  assert.deepEqual(models.map((m) => m.id), ['a-model', 'z-model'])
})

console.log('\n共 ' + passed + ' 项通过')
