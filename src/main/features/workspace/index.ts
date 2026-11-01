import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const SEED = [
  '# 工作区',
  '',
  '这是 Nahida Chat 的工作区目录，Agent 模式下的文件读写默认落在这里。',
  '',
  '想换目录：对话页输入框下方的「工作区」选择器，或侧栏「工作区」列表里新建。',
  '想让模型能碰工作区以外的文件：把权限模式切到「完全访问」。',
  ''
].join('\n')

/**
 * 确保工作区目录存在，并且（可选）放一份 README 供演示工具调用。
 *
 * 只有「首次创建默认工作区」时才 seed；用户自己选好的目录我们绝不往里写东西 ——
 * 往别人的项目根里塞 README 是很讨厌的行为。
 */
export function ensureWorkspace(root: string, seed = false): void {
  try {
    mkdirSync(root, { recursive: true })
    if (!seed) return
    const readme = join(root, 'README.md')
    if (!existsSync(readme)) writeFileSync(readme, SEED, 'utf8')
  } catch (error) {
    console.warn('[workspace] 初始化失败', error)
  }
}

/** 目录是否真实存在且确实是个目录（不是文件、不是失效的盘符）。 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 展示名：优先用用户填的，其次是目录名。
 *
 * 为什么不拿绝对路径当标题：侧栏宽 236px，长的盘符路径会被截断成
 * 只剩前缀，反而分不清是哪几个工作区。
 */
export function workspaceLabel(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  return basename(trimmed) || trimmed
}

/** 把用户给的路径归一化成绝对路径（相对路径按进程 cwd 解析）。 */
export function normalizeDir(input: string): string {
  return resolve(input.trim())
}
