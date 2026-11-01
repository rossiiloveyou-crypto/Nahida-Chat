import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const sharedDir = resolve(__dirname, 'src/shared')
const rendererDir = resolve(__dirname, 'src/renderer/src')

export default defineConfig({
  main: {
    // externalizeDepsPlugin 会把 dependencies 里的包全部外部化，
    // @huggingface/transformers（含 onnxruntime-node 原生二进制）必须走
    // node_modules 而不是被 rollup 打进 bundle，否则运行时加载不到 .node。
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': sharedDir }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': sharedDir }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': sharedDir,
        '@renderer': rendererDir
      }
    },
    plugins: [react()]
  }
})
