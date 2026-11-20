#!/usr/bin/env node
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifact, stamp, delay } from './st-env.probe.mjs'

export async function startStub(port = Number(process.env.NC_STUB_PORT || 8129)) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid stub port')
  const report = { probe: 'st-stub', startedAt: new Date().toISOString(), port, calls: [], checks: [], failure: null }
  let seq = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1').pathname
    const call = { method: req.method, url, status: 404 }
    report.calls.push(call)
    const json = (status, body) => { call.status = status; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    try {
      if (req.method === 'GET' && url === '/v1/models') return json(200, { object: 'list', data: [{ id: 'nc-stub', object: 'model', owned_by: 'nc-probe' }] })
      if (req.method !== 'POST' || url !== '/v1/chat/completions') return json(404, { error: 'unknown route' })
      let text = ''
      for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) return json(413, { error: 'body too large' }) }
      let body
      try { body = JSON.parse(text) } catch { return json(400, { error: 'invalid JSON' }) }
      const fixed = 'NC-STUB-REPLY-' + (++seq)
      Object.assign(call, { model: body.model, stream: body.stream === true, messages: Array.isArray(body.messages) ? body.messages.length : null, reply: fixed })
      const base = { id: 'nc-stub-' + seq, created: Math.floor(Date.now() / 1000), model: 'nc-stub' }
      if (!body.stream) return json(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: fixed }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      call.status = 200
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      for (const piece of fixed.match(/.{1,4}/g)) {
        if (res.destroyed) return
        res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }) + '\n\n')
        await delay(20)
      }
      res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      res.end('data: [DONE]\n\n')
    } catch (error) { if (!res.headersSent) json(500, { error: 'stub request failed' }); else res.end(); call.error = error.message }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  let closed = false
  return { report, async close() {
    if (closed) return
    closed = true
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    report.finishedAt = new Date().toISOString()
    const file = artifact('st-stub.' + stamp() + '.json', JSON.stringify(report, null, 2) + '\n')
    console.log('STUB_ARTIFACT ' + file)
    return file
  } }
}
export async function selfTestStub(stub) {
  const url = 'http://127.0.0.1:' + stub.report.port
  const models = await fetch(url + '/v1/models').then(r => r.json())
  const completion = await fetch(url + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'nc-stub', messages: [] }) }).then(r => r.json())
  const sse = await fetch(url + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'nc-stub', stream: true, messages: [] }) }).then(r => r.text())
  const missing = await fetch(url + '/missing')
  stub.report.checks.push({ name: 'models', pass: models.data[0].id === 'nc-stub' }, { name: 'json', pass: /NC-STUB-REPLY-/.test(completion.choices[0].message.content) }, { name: 'sse', pass: sse.startsWith('data: ') && sse.endsWith('data: [DONE]\n\n') }, { name: '404', pass: missing.status === 404 })
  if (stub.report.checks.some(c => !c.pass)) throw new Error('Stub self-test failed')
  console.log('PASS STUB_SELFTEST ' + JSON.stringify(stub.report.checks))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stub
  try {
    stub = await startStub()
    if (process.argv.includes('--self-test')) await selfTestStub(stub)
    else await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  } catch (error) { if (stub) stub.report.failure = error.message; console.error(error.message); process.exitCode = 1 }
  finally { await stub?.close() }
}
