/**
 * 思考过程（reasoning）链路测试。
 *
 * 两件事分开验，别混：
 * 1. **解析**：四家协议各自把"思考"从"正文"里分出来（字段名各不相同，错一个就静默丢失）；
 * 2. **隔离**：思考只进 message.reasoning 与广播，**绝不**进 content、绝不回灌下一轮。
 *    第 2 条比第 1 条重要 —— 回灌会让每轮 token 翻倍，DeepSeek 还会直接 400。
 *
 * fetch 用桩：本判据测解析，不测网络。
 *
 * 跑法：node scripts/test/reasoning-stream.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-reasoning-'))
installElectronStub(userData)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    defaultCharacterId: 'nahida',
    provider: 'mock',
    permission: { mode: 'readonly' },
    memory: { enabled: false, autoExtract: false }
  }),
  'utf8'
)

/* ── fetch 桩：把预设的帧喂给适配器 ───────────────────────────────── */
function sseResponse(frames) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        const line = typeof frame === 'string' ? frame : JSON.stringify(frame)
        controller.enqueue(encoder.encode('data: ' + line + '\n\n'))
      }
      controller.close()
    }
  })
  return new Response(body, { status: 200 })
}

function ndjsonResponse(frames) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'))
      controller.close()
    }
  })
  return new Response(body, { status: 200 })
}

let nextResponse = null
globalThis.fetch = async () => nextResponse

async function collect(provider, settings) {
  const events = []
  for await (const event of provider.stream({
    messages: [{ role: 'user', content: '你好' }],
    settings,
    signal: new AbortController().signal,
    tools: []
  })) {
    events.push(event)
  }
  return {
    reasoning: events.filter((e) => e.type === 'reasoning').map((e) => e.text).join(''),
    text: events.filter((e) => e.type === 'text').map((e) => e.text).join(''),
    calls: events.filter((e) => e.type === 'tool_call').length,
    last: events[events.length - 1]
  }
}

const llm = await bundleModule('reasoning-llm', [
  `export { openAiCompatibleProvider } from '${p('src/main/features/llm/openAiProvider.ts')}'`,
  `export { anthropicProvider } from '${p('src/main/features/llm/anthropicProvider.ts')}'`,
  `export { geminiProvider } from '${p('src/main/features/llm/geminiProvider.ts')}'`,
  `export { ollamaProvider } from '${p('src/main/features/llm/ollamaProvider.ts')}'`
].join('\n'))

const openAiSettings = {
  provider: 'openai-compatible',
  baseUrl: 'http://stub.local/v1',
  apiKey: 'k',
  model: 'm',
  temperature: 0.7
}

/* ── 1. OpenAI 兼容：三种字段名都要认 ─────────────────────────────── */
nextResponse = sseResponse([
  { choices: [{ delta: { reasoning_content: '先看看用户' } }] },
  { choices: [{ delta: { reasoning_content: '问的是什么' } }] },
  { choices: [{ delta: { content: '答案是 42' } }] },
  '[DONE]'
])
let out = await collect(llm.openAiCompatibleProvider, openAiSettings)
check('openai reasoning_content → 思考', out.reasoning === '先看看用户问的是什么', out.reasoning)
check('openai 正文与思考分离', out.text === '答案是 42', out.text)
check('openai 思考没有混进正文', !out.text.includes('先看看用户'))

nextResponse = sseResponse([
  { choices: [{ delta: { reasoning: 'OpenRouter 的写法' } }] },
  { choices: [{ delta: { content: 'ok' } }] },
  '[DONE]'
])
out = await collect(llm.openAiCompatibleProvider, openAiSettings)
check('openai reasoning（OpenRouter）→ 思考', out.reasoning === 'OpenRouter 的写法', out.reasoning)

nextResponse = sseResponse([
  { choices: [{ delta: { thinking: '自建网关的写法' } }] },
  { choices: [{ delta: { content: 'ok' } }] },
  '[DONE]'
])
out = await collect(llm.openAiCompatibleProvider, openAiSettings)
check('openai thinking（自建网关）→ 思考', out.reasoning === '自建网关的写法', out.reasoning)

nextResponse = sseResponse([
  { choices: [{ delta: { content: '只有正文' } }] },
  '[DONE]'
])
out = await collect(llm.openAiCompatibleProvider, openAiSettings)
check('openai 没有思考时不产生 reasoning 事件', out.reasoning === '', JSON.stringify(out.reasoning))

/* ── 2. Anthropic：extended thinking ───────────────────────────────── */
const anthropicSettings = { ...openAiSettings, provider: 'anthropic', baseUrl: 'http://stub.local/v1' }
nextResponse = sseResponse([
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先拆解问题' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再计算' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '计算结果 7' } }
])
out = await collect(llm.anthropicProvider, anthropicSettings)
check('anthropic thinking_delta → 思考', out.reasoning === '先拆解问题再计算', out.reasoning)
check('anthropic 正文不受影响', out.text === '计算结果 7', out.text)
check('anthropic signature_delta 被忽略', !out.reasoning.includes('sig'))

/* ── 3. Gemini：part.thought ───────────────────────────────────────── */
const geminiSettings = { ...openAiSettings, provider: 'gemini', baseUrl: 'http://stub.local/v1beta' }
nextResponse = sseResponse([
  { candidates: [{ content: { parts: [{ text: '这是思考', thought: true }] } }] },
  { candidates: [{ content: { parts: [{ text: '这是正文', thought: false }] } }] }
])
out = await collect(llm.geminiProvider, geminiSettings)
check('gemini thought:true → 思考', out.reasoning === '这是思考', out.reasoning)
check('gemini thought:false 是正文', out.text === '这是正文', out.text)

/* ── 4. Ollama：message.thinking ───────────────────────────────────── */
const ollamaSettings = { ...openAiSettings, provider: 'ollama', baseUrl: 'http://stub.local', apiKey: '' }
nextResponse = ndjsonResponse([
  { message: { role: 'assistant', thinking: '本地模型先想一下', content: '' }, done: false },
  { message: { role: 'assistant', content: '想好了' }, done: false },
  { done: true }
])
out = await collect(llm.ollamaProvider, ollamaSettings)
check('ollama message.thinking → 思考', out.reasoning === '本地模型先想一下', out.reasoning)
check('ollama 正文与思考分离', out.text === '想好了', out.text)

/* ── 5. 端到端：思考进 message.reasoning、广播到 sink、不进 content ──── */
const ragStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-reasoning-stubs-'))
const ragStub = path.join(ragStubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  'export const memoryService = { async buildContextBlock() { return "" }, extractInBackground() {}, activePersona() { return null }, upsertPersona() {}, appendHistory() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n',
  'utf8'
)
const plugin = {
  name: 'stub-reasoning-rag',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) =>
      args.importer.endsWith('chatService.ts') ? { path: ragStub } : null
    )
  }
}
const chat = await bundleModule(
  'reasoning-chat',
  [
    `export { chatService, sessionHistoryToLlm } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { HeadlessSink } from '${p('src/main/features/chat/sink.ts')}'`
  ].join('\n'),
  [plugin]
)

const session = chat.chatService.createSession({ mode: 'chat', title: '思考链路' })
const sink = new chat.HeadlessSink()
const outcome = await chat.chatService.sendAwait({ sessionId: session.id, content: '你好' }, sink)

const stored = chat.chatService.listSessions().find((item) => item.id === session.id)
const assistant = stored.messages.filter((item) => item.role === 'assistant').pop()

check('演示模式端到端跑完', outcome.status === 'done', outcome.status)
check('思考被累积到 sink', sink.reasoningContent.length > 0, sink.reasoningContent.length)
check('思考落进 message.reasoning', Boolean(assistant.reasoning) && assistant.reasoning.length > 0)
check('思考进去的不进正文', !assistant.content.includes('演示模式的思考过程'))
check('正文照常生成', assistant.content.includes('演示模式'))

const history = chat.sessionHistoryToLlm({ messages: stored.messages })
const assistantHistory = history.filter((item) => item.role === 'assistant')
check('历史里没有任何 reasoning 字段', assistantHistory.every((item) => !('reasoning' in item)))
check(
  '历史里的正文不含思考文本',
  assistantHistory.every((item) => !item.content.includes('演示模式的思考过程'))
)

done()
