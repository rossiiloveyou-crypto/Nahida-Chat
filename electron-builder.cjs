const path = require('node:path')
const { verifyHost, verifyResources } = require('./scripts/release-resources.cjs')
module.exports = {
  appId: 'com.nahida.chat', productName: 'Nahida Chat',
  directories: { output: 'release' }, asar: true,
  files: ['out/main/**', 'out/preload/**', 'out/renderer/**', 'package.json'],
  extraResources: [
    { from: 'out/snowluma-host', to: 'snowluma-host', filter: ['**/*'] },
    { from: 'Prompt', to: 'prompt', filter: ['**/*.md'] },
    // 窗口/任务栏图标（exe 图标由 win.icon 决定，这里给运行期用）
    { from: 'build/icon.png', to: 'icon.png' }
  ],
  asarUnpack: ['**/*.node', '**/*.dll', '**/onnxruntime-node/**', '**/sharp/**', '**/@img/**'],
  npmRebuild: false,
  // 🔴 不能写 signAndEditExecutable: false —— 它会连 exe 图标与版本元数据一起跳过（构建日志会提示）。
  //    要的只是「不签名」：signExecutable: false 单独关掉签名，图标与元数据照写。
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'build/icon.ico', signExecutable: false },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico'
  },
  beforePack: async context => { verifyHost(path.join(context.packager.projectDir, 'out', 'snowluma-host')) },
  afterPack: async context => { verifyResources(path.join(context.appOutDir, 'resources')) }
}
