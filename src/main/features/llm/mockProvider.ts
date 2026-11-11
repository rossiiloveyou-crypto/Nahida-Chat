import type { LlmProvider, LlmRequest } from './types'

/**
 * 离线演示适配器：不联网、不需要 key，保证首装即可跑通整条链路（含工具调用审批）。
 * UI 上会明确标注「演示模式」，不冒充真实模型输出。
 */
export const mockProvider: LlmProvider = {
  id: 'mock',
  label: '演示模式',
  offline: true,
  async *stream(request: LlmRequest) {
    const last = request.messages[request.messages.length - 1]

    // 工具结果已经回来了 -> 做一次总结
    if (last && last.role === 'tool') {
      yield { type: 'text', text: buildToolSummary(last.content) }
      yield { type: 'finish', reason: 'stop' }
      return
    }

    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')
    const input = lastUser ? lastUser.content : ''
    const wantsTool = /工作区|目录|文件|列表|ls|工具/i.test(input)
    const hasListTool = request.tools.some((tool) => tool.name === 'fs.list_dir')

    if (wantsTool && hasListTool) {
      yield {
        type: 'tool_call',
        call: { id: 'mock_call_1', name: 'fs.list_dir', arguments: JSON.stringify({ path: '.' }) }
      }
      yield { type: 'finish', reason: 'tool_calls' }
      return
    }

    // 演示模式也吐一段「思考」，否则离线状态下思考块永远看不到，
    // 而这个功能恰恰是首装就能验的第一印象。内容明确写成「这是演示」，
    // 不冒充真实模型的推理。
    for (const chunk of split(buildReasoning(input), 6)) {
      await sleep(18, request.signal)
      if (request.signal.aborted) return
      yield { type: 'reasoning', text: chunk }
    }

    for (const chunk of split(buildReply(input), 5)) {
      await sleep(24, request.signal)
      if (request.signal.aborted) return
      yield { type: 'text', text: chunk }
    }
    yield { type: 'finish', reason: 'stop' }
  }
}

/** 演示用思考文本：明说是演示，不伪装成真实推理 */
function buildReasoning(input: string): string {
  const head = input.trim().slice(0, 20) || '（空输入）'
  return [
    '（演示模式的思考过程，不是真实模型的推理）',
    '先确认这条链路：用户说了「' + head + '」，',
    '接下来要做的不是调用远程模型，而是本地回显一段说明，',
    '同时验证「思考增量 -> 折叠块 -> 正文开始后自动收起」这条渲染链路。'
  ].join('')
}

function buildToolSummary(result: string): string {
  const preview = result.length > 400 ? result.slice(0, 400) + '…' : result
  return ['工具执行完了，工作区里现在是这样：', '', preview, '', '要读某个文件，直接说文件名。'].join('\n')
}

function buildReply(input: string): string {
  const trimmed = input.trim()
  const head = trimmed.length > 0 ? trimmed.slice(0, 40) : '（空输入）'
  return [
    '这是演示模式的本地回显，用来验证「输入 -> 流式渲染 -> 落库」这条链路，',
    '没有调用任何远程模型。你刚才说的是：',
    '',
    '> ' + head,
    '',
    '接下来可以做的事：',
    '1. 说「看看工作区」，会触发一次真实的工具调用（fs.list_dir），弹出审批卡；',
    '2. 打开左下角「设置」，切到 OpenAI 兼容 / Anthropic / Gemini / Ollama 之一；',
    '3. 在 Prompt/ 目录里新增提示词文件，它会自动出现在设置页的系统提示词列表。'
  ].join('\n')
}

function split(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}
