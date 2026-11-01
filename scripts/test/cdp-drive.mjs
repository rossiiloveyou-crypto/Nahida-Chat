/**
 * 通过 CDP 在真实渲染进程里执行 JS，调用 window.nahida。
 * 这条路径与用户点按钮完全等价（preload 暴露的同一个 API），
 * 但不依赖鼠标坐标。
 */
const CDP_HTTP = 'http://127.0.0.1:9222'

async function main() {
  const list = await (await fetch(CDP_HTTP + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.title.includes('Nahida'))
  if (!page) throw new Error('找不到页面')
  console.log('页面:', page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })

  function send(method, params) {
    return new Promise((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.result && res.result.exceptionDetails) {
      const d = res.result.exceptionDetails
      throw new Error('页面内异常: ' + (d.exception ? d.exception.description : d.text))
    }
    return res.result && res.result.result ? res.result.result.value : undefined
  }

  let passed = 0
  let failed = 0
  function check(name, cond, detail) {
    if (cond) { passed += 1; console.log('  ok  ' + name + (detail ? '  (' + String(detail).slice(0, 70) + ')' : '')) }
    else { failed += 1; console.error('  FAIL ' + name + (detail ? '  (' + String(detail).slice(0, 70) + ')' : '')) }
  }

  console.log('\n1. window.nahida 是否就位')
  const apiShape = await evaluate('Object.keys(window.nahida || {}).sort()')
  check('preload 暴露了 API', Array.isArray(apiShape) && apiShape.length > 0, (apiShape || []).join(','))
  check('memory 命名空间存在', apiShape.includes('memory'), '')

  console.log('\n2. 模型档案（真实 IPC）')
  const catalog = await evaluate('window.nahida.modelProfiles.list()')
  const active = catalog.profiles.find((p) => p.id === catalog.defaultProfileId)
  check('读到档案列表', Array.isArray(catalog.profiles) && catalog.profiles.length > 0, catalog.profiles.length + ' 个')
  check('默认档案是测试档案', active && active.id === 'profile-mocktest', active ? active.name : '无')
  check('baseUrl 正确', active && active.baseUrl === 'http://127.0.0.1:18080/v1', active ? active.baseUrl : '')

  console.log('\n3. 测试连接按钮（真实 IPC → 真实 fetch）')
  const testResult = await evaluate(`
    window.nahida.modelProfiles.test({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:18080/v1',
      apiKey: 'sk-test-key-123456',
      model: 'test-model'
    })
  `)
  check('连接成功', testResult.ok === true, testResult.error || '')
  check('拿到 sample', typeof testResult.sample === 'string' && testResult.sample.length > 0, testResult.sample)
  check('记录耗时', typeof testResult.latencyMs === 'number', testResult.latencyMs + 'ms')

  console.log('\n4. 错误 key 能被识破')
  const badResult = await evaluate(`
    window.nahida.modelProfiles.test({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:18080/v1',
      apiKey: 'wrong',
      model: 'test-model'
    })
  `)
  check('错误 key 返回失败', badResult.ok === false, badResult.error)

  console.log('\n5. 记忆接口（真实 IPC）')
  const memStatus = await evaluate('window.nahida.memory.status()')
  check('读到记忆状态', memStatus && typeof memStatus.entryCount === 'number', '库中 ' + memStatus.entryCount + ' 条')
  check('模型路径正确', String(memStatus.modelPath).includes('bge-m3'), memStatus.modelPath)

  const saved = await evaluate(`window.nahida.memory.save({ content: '用户住在上海市徐汇区' })`)
  check('能手动添加记忆', Array.isArray(saved) && saved.some((m) => m.content.includes('上海')), saved.length + ' 条')

  const listed = await evaluate('window.nahida.memory.list()')
  check('列表能读回', Array.isArray(listed) && listed.length > 0, listed.length + ' 条')

  console.log('\n6. 试召回（真实向量 + 真实 FTS5）')
  const hits = await evaluate(`window.nahida.memory.recall('我住在哪里')`)
  check('召回有结果', Array.isArray(hits) && hits.length > 0, (hits || []).length + ' 条')
  if (hits && hits.length > 0) {
    check('召回正确内容', hits[0].content.includes('上海'), hits[0].content)
    check('给出了分数', typeof hits[0].score === 'number', '综合 ' + hits[0].score.toFixed(3))
    check('分数高于阈值', hits[0].score >= 0.55, hits[0].score.toFixed(3))
  }

  console.log('\n7. 清理')
  const cleared = await evaluate('window.nahida.memory.clear()')
  check('能清空', Array.isArray(cleared) && cleared.length === 0)

  console.log('\n通过 ' + passed + '，失败 ' + failed)
  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('驱动失败:', e.message)
  process.exit(1)
})
