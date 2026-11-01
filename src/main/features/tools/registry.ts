import type { ToolDefinition } from '@shared/tools'
import type { ToolScope } from '@shared/types'

export interface ToolContext {
  /** 本次执行的边界：权限模式 + 会话绑定的工作区根目录 */
  scope: ToolScope
}

export interface ToolResult {
  ok: boolean
  output: string
}

export interface ToolImpl {
  definition: ToolDefinition
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

const implementations = new Map<string, ToolImpl>()

export function registerTool(impl: ToolImpl): void {
  implementations.set(impl.definition.name, impl)
}

export function listDefinitions(): ToolDefinition[] {
  return [...implementations.values()].map((impl) => impl.definition)
}

export function findTool(name: string): ToolImpl | undefined {
  return implementations.get(name)
}

export function definitionOf(name: string): ToolDefinition | undefined {
  return implementations.get(name)?.definition
}

/** 执行工具。任何异常都收敛成 { ok:false }，绝不让工具错误炸掉对话循环。 */
export async function executeTool(
  name: string,
  rawArguments: string,
  context: ToolContext
): Promise<ToolResult> {
  const impl = implementations.get(name)
  if (!impl) return { ok: false, output: '未注册的工具：' + name }

  let args: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(rawArguments || '{}') as unknown
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
  } catch {
    return { ok: false, output: '参数不是合法 JSON：' + rawArguments.slice(0, 200) }
  }

  try {
    return await impl.run(args, context)
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}
