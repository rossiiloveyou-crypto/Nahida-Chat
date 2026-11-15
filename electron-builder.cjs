const path = require('node:path')
const { verifyHost, verifyResources } = require('./scripts/release-resources.cjs')
module.exports = {
  appId: 'com.nahida.chat', productName: 'Nahida Chat',
  directories: { output: 'release' }, asar: true,
  files: ['out/main/**', 'out/preload/**', 'out/renderer/**', 'package.json'],
  extraResources: [
    { from: 'out/snowluma-host', to: 'snowluma-host', filter: ['**/*'] },
    { from: 'Prompt', to: 'prompt', filter: ['**/*.md'] }
  ],
  asarUnpack: ['**/*.node', '**/*.dll', '**/onnxruntime-node/**', '**/sharp/**', '**/@img/**'],
  npmRebuild: false,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  beforePack: async context => { verifyHost(path.join(context.packager.projectDir, 'out', 'snowluma-host')) },
  afterPack: async context => { verifyResources(path.join(context.appOutDir, 'resources')) }
}
