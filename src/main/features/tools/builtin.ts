import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { registerClockTools } from './clock'
import { registerTool } from './registry'
import { relativeToWorkspace, resolveToolPath } from './sandbox'

const MAX_LIST_ENTRIES = 200
const MAX_READ_BYTES = 64 * 1024

/**
 * 内置工具集。
 *
 * readOnly 是唯一的自我描述字段：它决定在「只读」和「审批」模式下
 * 这个工具能不能直接跑。写入/执行类工具（M3 后期）声明 readOnly: false 即可，
 * 不需要再回来改权限代码。
 *
 * 时间工具在 ./clock 里单独实现：它同时服务「工具调用」和「每轮 system 注入」两条路，
 * 两处必须共用同一份格式化代码，所以不能塞回这个文件。
 */
export function registerBuiltinTools(): void {
  registerClockTools()

  registerTool({
    definition: {
      name: 'fs.list_dir',
      title: '列出目录',
      description: '列出工作区内某个目录下的文件和子目录。path 为相对工作区根目录的路径，默认 "."。',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的路径，默认 "."' }
        },
        required: []
      }
    },
    async run(args, context) {
      const input = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.'
      const target = resolveToolPath(input, context.scope)
      const entries = await readdir(target, { withFileTypes: true })

      const lines: string[] = []
      for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
        if (entry.isDirectory()) {
          lines.push('[目录] ' + entry.name)
        } else {
          const info = await stat(join(target, entry.name)).catch(() => null)
          const size = info ? info.size : 0
          lines.push('[文件] ' + entry.name + '  ' + formatSize(size))
        }
      }

      const header =
        '工作区路径：' + relativeToWorkspace(target, context.scope) + '（' + entries.length + ' 项）'
      const more =
        entries.length > MAX_LIST_ENTRIES ? ['…还有 ' + (entries.length - MAX_LIST_ENTRIES) + ' 项未显示'] : []
      return { ok: true, output: [header, ...lines, ...more].join('\n') }
    }
  })

  registerTool({
    definition: {
      name: 'fs.read_file',
      title: '读取文件',
      description: '读取工作区内的一个文本文件，最多返回 64KB。path 为相对工作区根目录的路径。',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的文件路径' }
        },
        required: ['path']
      }
    },
    async run(args, context) {
      const input = typeof args.path === 'string' ? args.path.trim() : ''
      if (!input) throw new Error('缺少参数 path')
      const target = resolveToolPath(input, context.scope)
      const info = await stat(target)
      if (!info.isFile()) throw new Error('不是普通文件：' + input)

      const buffer = await readFile(target)
      const slice = buffer.subarray(0, MAX_READ_BYTES)
      if (slice.includes(0)) throw new Error('疑似二进制文件，已拒绝读取：' + input)

      const text = slice.toString('utf8')
      const truncated = buffer.length > MAX_READ_BYTES
      const header =
        '文件：' +
        relativeToWorkspace(target, context.scope) +
        '（' + buffer.length + ' 字节' + (truncated ? '，已截断' : '') + '）'
      return { ok: true, output: header + '\n\n' + text }
    }
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K'
  return (bytes / 1024 / 1024).toFixed(1) + 'M'
}

/** 仅用于日志，避免把用户目录全路径打到控制台 */
export function displayName(path: string): string {
  const parts = path.split(sep)
  return parts.length > 2 ? basename(path) : path
}