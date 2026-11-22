import { lstatSync, unlinkSync } from 'node:fs'
import type { Session } from '@shared/types'
import { branchStore, rootBranchOf, toBranchSessionInfo } from './branches'
import { storyBranchesPath } from './paths'

function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 仅登记已落盘的新分支；读取旧分支失败时保留原件。 */
export function registerImportedBranch(session: Session, previous: Session[], makeActive: boolean): void {
  const storyId = session.storyId
  if (!storyId) throw new Error('缺少故事区 id')
  const path = storyBranchesPath(storyId)
  const hadFile = entryExists(path)
  const existing = branchStore.read(storyId)
  if (hadFile && !existing) throw new Error('已有分支清单读取失败，请先修复')
  if (existing?.branches.some((branch) => branch.branchId === session.id)) {
    throw new Error('导入分支 id 重复')
  }
  // branches.ts 使用固定临时文件名，保留现有文件且避免跟随悬空符号链接。
  const tmp = path + '.tmp'
  if (entryExists(tmp)) throw new Error('分支清单存在未清理的临时文件')
  try {
    branchStore.ensure(storyId, previous.map(toBranchSessionInfo))
    branchStore.append(storyId, rootBranchOf(toBranchSessionInfo(session)), makeActive)
  } catch (error) {
    for (const file of hadFile ? [tmp] : [tmp, path]) {
      if (entryExists(file)) unlinkSync(file)
    }
    throw error
  }
}
