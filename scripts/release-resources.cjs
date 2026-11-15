const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const REQUIRED_HOST_FILES = [
  'node.exe', 'index.mjs', 'package.json', 'check-node-version.cjs', 'LICENSE', 'EULA.md', 'PRIVACY.md',
  'native/snowluma-win32-x64.node', 'native/snowluma-win32-x64.dll',
  'native/websocket-win32-x64.node', 'native/ffmpeg/ffmpegAddon.win32.x64.node',
  'native/sqlite/manifest.json', 'native/sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node'
]
const MANIFEST = 'release-manifest.json'
function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function inventory(root, dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) throw Error('发布资源不得依赖符号链接：' + file)
    if (entry.isDirectory()) return inventory(root, file)
    const rel = path.relative(root, file).split(path.sep).join('/')
    if (rel === MANIFEST) return []
    return [{ path: rel, size: fs.statSync(file).size, sha256: digest(file) }]
  })
}
function assertHostFiles(root) {
  for (const rel of REQUIRED_HOST_FILES) {
    const file = path.join(root, rel)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw Error('宿主发布资源缺失：' + file)
  }
  if (fs.statSync(path.join(root, 'node.exe')).size < 50 * 1024 * 1024) throw Error('宿主 node.exe 大小异常')
  if (fs.statSync(path.join(root, 'index.mjs')).size < 5 * 1024 * 1024) throw Error('宿主 index.mjs 大小异常')
}
function writeManifest(root) {
  assertHostFiles(root)
  const manifest = { version: 1, files: inventory(root) }
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
function verifyHost(root) {
  assertHostFiles(root)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw Error('宿主 manifest 格式错误')
  const actual = inventory(root)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw Error('宿主资源校验失败：文件缺失、内容改变或意外文件')
  return { files: actual.length, bytes: actual.reduce((n, f) => n + f.size, 0) }
}
function verifyResources(resources) {
  const result = verifyHost(path.join(resources, 'snowluma-host'))
  if (!fs.existsSync(path.join(resources, 'prompt', 'shared', 'base.md'))) throw Error('发布包缺少提示词库')
  return result
}
module.exports = { REQUIRED_HOST_FILES, writeManifest, verifyHost, verifyResources }
if (require.main === module) {
  const dir = path.resolve(process.argv[2] || 'out/snowluma-host')
  console.log(JSON.stringify({ directory: dir, ...verifyHost(dir) }))
}
