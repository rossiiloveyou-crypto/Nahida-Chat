import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

// pnpm 10 会跳过依赖的 postinstall，electron 二进制可能没落地。
// 这里做一次兜底：缺二进制就补装，避免 pnpm install 后直接跑不起来。

const require = createRequire(import.meta.url)

let electronDir
try {
  electronDir = dirname(require.resolve('electron/package.json'))
} catch {
  console.warn('[ensure-electron] 未找到 electron 包，跳过')
  process.exit(0)
}

const marker = join(electronDir, 'path.txt')
if (existsSync(marker)) {
  console.log('[ensure-electron] electron 二进制已就绪')
  process.exit(0)
}

console.log('[ensure-electron] 缺少 electron 二进制，开始补装…')
const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/' }
})
process.exit(result.status ?? 1)
