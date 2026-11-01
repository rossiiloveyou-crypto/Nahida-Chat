/**
 * 本地模拟的 OpenAI 兼容服务，用于在填入真实 API Key 之前验证接收链路。
 *
 * 它做三件事：
 * 1. 非流式 /chat/completions —— 给「测试连接」按钮用
 * 2. 流式 SSE /chat/completions —— 给真实对话用，逐 token 发
 * 3. 识别「记忆抽取」请求（system 里含"记忆提炼器"）并返回 JSON
 *
 * 用法：node scripts/test/mock-openai-server.mjs [port]
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] || 18080)

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

/** 判断这是不是记忆抽取请求 */
function isExtractRequest(body) {
  const messages = body.messages || []
  return messages.some(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('记忆提炼器')
  )
}

/** 从「用户刚说：xxx」里抠出原话 */
function extractUserText(body) {
  const messages = body.messages || []
  const user = messages.filter((m) => m.role === 'user').pop()
  if (!user || typeof user.content !== 'string') return ''
  return user.content.replace(/^用户刚说：/, '')
}

/** 极简规则：只在这几种句式上返回记忆，模拟真实模型的行为 */
function deriveMemories(text) {
  const facts = []
  for (const [pattern, template] of [
    [/我叫([\u4e00-\u9fffA-Za-z0-9]{1,12})/, (m) => '用户的名字是' + m[1]],
    [/(?:我)?住在([\u4e00-\u9fff]{2,12})(?:市|区|县)?/, (m) => '用户住在' + m[1]],
    [/(?:我)?是(?:一名|一个|个)?([\u4e00-\u9fffA-Za-z]{2,12}(?:工程师|设计师|老师|医生|学生))/, (m) => '用户的职业是' + m[1]],
    [/(?:我)?养了(?:一只|一个)?([\u4e00-\u9fffA-Za-z]{1,10})/, (m) => '用户养了' + m[1]],
    [/(?:我)?对([\u4e00-\u9fff]{2,10})过敏/, (m) => '用户对' + m[1] + '过敏'],
    [/(?:我)?喜欢([\u4e00-\u9fffA-Za-z]{2,14})/, (m) => '用户喜欢' + m[1]]
  ]) {
    const match = text.match(pattern)
    if (match) facts.push(template(match))
  }
  return facts
}

const server = createServer(async (req, res) => {
  const url = req.url || ''
  console.log('[mock] ' + req.method + ' ' + url)
  if (req.method !== 'POST' || !url.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  // 校验鉴权头，模拟真实服务的 401
  const auth = req.headers.authorization || ''
  // 模拟真实服务：token 必须是 sk- 开头且足够长
  if (!/^Bearer sk-[A-Za-z0-9_-]{8,}$/.test(auth)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }))
    return
  }

  const body = await readBody(req)
  const stream = body.stream === true

  // ── 记忆抽取请求 ──
  // 注意：产品代码用同一个流式 provider 发抽取请求（stream: true），
  // 所以这里必须按 SSE 回，不能直接回一坨 JSON——否则适配器的
  // sseEvents 读不到 data: 行，解析结果为空。
  if (isExtractRequest(body)) {
    const text = extractUserText(body)
    const memories = deriveMemories(text)
    const content = JSON.stringify({ memories })
    console.log('[mock]   -> 记忆抽取: ' + JSON.stringify(memories))

    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-extract',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        })
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    // 分片发出，模拟真实模型逐 token 吐 JSON
    const chunks = content.match(/[\s\S]{1,12}/g) || [content]
    for (const chunk of chunks) {
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: chunk } }] }) + '\n\n')
      await new Promise((r) => setTimeout(r, 4))
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  // ── 普通对话：回显「收到了什么」，方便肉眼确认记忆是否注入 ──
  const messages = body.messages || []
  const systemBlocks = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const memoryBlock = systemBlocks.find((c) => typeof c === 'string' && c.includes('【长期记忆'))
  const lastUser = messages.filter((m) => m.role === 'user').pop()
  const userText = lastUser ? String(lastUser.content) : ''

  const reply = memoryBlock
    ? '我看到了记忆：' + memoryBlock.replace(/[\r\n]+/g, ' ').slice(0, 120) + ' —— 你问的是「' + userText.slice(0, 20) + '」。'
    : '我没有收到任何长期记忆。你问的是「' + userText.slice(0, 20) + '」。'

  if (!stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }]
      })
    )
    return
  }

  // ── SSE 流式：逐字发，验证前端渲染 ──
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  const chars = [...reply]
  for (const ch of chars) {
    res.write(
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: ch } }] }) + '\n\n'
    )
    await new Promise((r) => setTimeout(r, 8))
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock] OpenAI 兼容服务已启动: http://127.0.0.1:' + PORT + '/v1')
  console.log('[mock] 任意 Bearer token 都接受（长度 > 10）')
})