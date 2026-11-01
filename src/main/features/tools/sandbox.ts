import { isAbsolute, resolve, sep } from 'node:path'
import type { ToolScope } from '@shared/types'

/**
 * 路径闸：决定文件类工具「能碰哪里」。
 *
 * 注意它不决定「能不能碰」——那由权限模式决定（见 permission.ts）。
 * 完全访问模式下这里直接放行，路径由模型自己填，出错由操作系统报；
 * 只读/审批模式下只允许 scope.root 内的路径，防止模型被提示词注入策反后去读用户其它文件。
 *
 * scope.root 来自**当前会话绑定的工作区**，不是全局设置——这就是多工作区的落点：
 * 两个会话可以同时开在两个不同目录，各自的文件边界互不影响。
 */
export function resolveToolPath(input: string, scope: ToolScope): string {
  if (scope.mode === 'full') {
    return isAbsolute(input) ? resolve(input) : resolve(scope.root || '.', input)
  }

  if (!scope.root) throw new Error('当前会话没有绑定工作区，无法执行文件类工具')
  const root = resolve(scope.root)
  const target = isAbsolute(input) ? resolve(input) : resolve(root, input)
  if (target === root || target.startsWith(root + sep)) return target
  throw new Error(
    '路径不在当前工作区内：' + input +
      '\n当前工作区：' + root +
      '\n（换一个工作区，或切到「完全访问」）'
  )
}

export function relativeToWorkspace(target: string, scope: ToolScope): string {
  const base = resolve(scope.root || target)
  return target.startsWith(base + sep) ? target.slice(base.length + 1).split(sep).join('/') : target
}
