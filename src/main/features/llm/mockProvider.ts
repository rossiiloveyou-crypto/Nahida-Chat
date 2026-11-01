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

    for (const chunk of split(buildReply(input), 5)) {
      await sleep(24, request.signal)
      if (request.signal.aborted) return
      yield { type: 'text', text: chunk }
    }
    yield { type: 'finish', reason: 'stop' }
  }
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
