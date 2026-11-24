import { ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { DisplayScriptsState } from '@shared/types'
import { readScripts, resolveStDataDir, mergeDisplayScripts, invalidateScriptsCache } from '../features/regex/scripts'
import { readPresetRegexScripts, readCurrentPresetName, isPresetName, invalidatePresetCache } from '../features/bridge/presetRegex'
import { bridgeHost } from '../features/bridge/host'

export interface RegexScriptsRequest { stDir?: string; refresh?: boolean }

/** 只读 host 的派生配置；不创建第二份目录设置。 */
export function readDisplayScriptsState(request?: RegexScriptsRequest): DisplayScriptsState {
  let hostDir = ''
  try { hostDir = bridgeHost.health().config.stDataDir } catch { /* 下方读取保留明确诊断 */ }
  const stDir = resolveStDataDir(request?.stDir?.trim() || hostDir)
  const result: DisplayScriptsState = { scripts: [], stDir, preset: '', warning: null }
  try {
    if (request?.refresh) { invalidatePresetCache(); invalidateScriptsCache(stDir) }
    JSON.parse(readFileSync(join(stDir, 'settings.json'), 'utf8'))
    result.preset = readCurrentPresetName(stDir)
    const global = readScripts(stDir)
    if (result.preset) {
      if (!isPresetName(result.preset)) throw new Error('preset name')
      JSON.parse(readFileSync(join(stDir, 'OpenAI Settings', result.preset + '.json'), 'utf8'))
    }
    result.scripts = mergeDisplayScripts(global, readPresetRegexScripts(stDir))
    if (!result.preset) result.warning = 'ST 尚未选择 OpenAI 预设；当前仅使用全局显示脚本。'
  } catch {
    result.warning = 'ST 显示脚本读取失败，请检查 ST 数据目录、当前预设文件及 JSON 格式。'
    console.warn('[regex]', result.warning, stDir)
  }
  return result
}

export function registerRegexIpcHandlers(): void {
  ipcMain.handle(IPC.regexListScripts, (_event, request?: RegexScriptsRequest) => readDisplayScriptsState(request).scripts)
  ipcMain.handle(IPC.regexScriptsState, (_event, request?: RegexScriptsRequest) => readDisplayScriptsState(request))
}
