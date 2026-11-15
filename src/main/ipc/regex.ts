import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { StRegexScript } from '@shared/regex'
import { readScripts, resolveStDataDir } from '../features/regex/scripts'

/** 显示层要脚本清单时带的可选目录（P4 会把它接到桥接设置上；这里缺省即部署默认值）。 */
export interface RegexScriptsRequest {
  stDir?: string
}

/**
 * 显示层正则（P3 §1 第 3 步）：**一条只读通道**。
 *
 * 三条硬规矩：
 *  1. 读盘失败（目录不在 / JSON 坏 / 权限）→ 返回空数组 + 一条 warn，**绝不抛**：
 *     显示层坏掉不能连累聊天，退化成「不做正则」是可接受的降级；
 *  2. 不做任何缓存逻辑：缓存真源在 features/regex/scripts.ts（按 mtime+size 失效）；
 *  3. 不做过滤（`markdownOnly` 也不筛）：通道语义归引擎，IPC 只搬数据，否则两处判据迟早分叉。
 */
export function registerRegexIpcHandlers(): void {
  ipcMain.handle(IPC.regexListScripts, (_event, request?: RegexScriptsRequest): StRegexScript[] => {
    const stDir = resolveStDataDir(request && typeof request === 'object' ? request.stDir : undefined)
    try {
      return readScripts(stDir)
    } catch (error) {
      console.warn('[regex] 读取 ST 正则脚本失败，显示层按「不做正则」运行：', error)
      return []
    }
  })
}
