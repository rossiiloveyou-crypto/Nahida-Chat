const MAX_NAME_LENGTH = 120
const INVALID = /[\\/:*?"<>|＼／：＊？＂＜＞｜\p{Cc}\p{Cs}]/gu
const TRAILING = /[. ]+$/u
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu

function truncate(name: string, maxLength: number): string {
  // 路径组件同时受 UTF-16 和 UTF-8 上限约束，且保持完整码点。
  let result = ''
  let bytes = 0
  for (const char of name) {
    bytes += Buffer.byteLength(char)
    if (result.length + char.length > maxLength || bytes > maxLength) break
    result += char
  }
  return result.replace(TRAILING, '')
}

/** 返回单个文件名组件，跨 Windows/macOS/Linux 可用。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name.normalize('NFC').replace(INVALID, '_').replace(TRAILING, '')
  const portable = DEVICE_NAME.test(cleaned) ? '_' + cleaned : cleaned
  return truncate(portable, MAX_NAME_LENGTH) || 'conversation'
}

/** 仅分配候选名；实际写盘时调用方应使用排他创建防止并发覆盖。 */
export function uniqueFileName(stem: string, extension: string, existingNames: Iterable<string>): string {
  const ext = extension && !extension.startsWith('.') ? '.' + extension : extension
  if (ext && !/^(?:\.[A-Za-z0-9]{1,16}){1,2}$/.test(ext)) {
    throw new Error('导出扩展名无效')
  }
  const key = (name: string): string => name.normalize('NFC').replace(TRAILING, '').toLowerCase()
  const taken = new Set(Array.from(existingNames, key))
  const safeStem = sanitizeFileName(stem)
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : '-' + n
    const name = (truncate(safeStem, MAX_NAME_LENGTH - ext.length - suffix.length) || '_') + suffix + ext
    if (!taken.has(key(name))) return name
  }
}
