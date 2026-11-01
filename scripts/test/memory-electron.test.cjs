/**
 * 在真实 Electron 主进程环境里验证记忆链路。
 * 为什么必须用 Electron 跑：node:sqlite 在 Electron 里的可用性、
 * transformers 的 ESM 动态 import、原生 .node 加载，三者只有真环境能证。
 *
 * 用法：electron scripts/test/memory-electron.test.cjs
 */
const { app } = require('electron')
const { join } = require('node:path')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log('  ok  ' + name + (detail ? '  (' + detail + ')' : ''))
  } else {
    failed += 1
    console.error('  FAIL ' + name + (detail ? '  (' + detail + ')' : ''))
  }
}

app.whenReady().then(async () => {
  try {
    console.log('运行环境')
    check('Electron 版本', Boolean(process.versions.electron), process.versions.electron)
    check('Node 版本', Boolean(process.versions.node), process.versions.node)

    // ── node:sqlite 在 Electron 里可用性 ──
    console.log('\nnode:sqlite')
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(':memory:')
    const version = db.prepare('SELECT sqlite_version() AS v').get().v
    check('SQLite 可用', Boolean(version), 'version ' + version)
    let fts5 = true
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x)")
    } catch {
      fts5 = false
    }
    check('FTS5 可用（关键词检索依赖）', fts5)
    db.close()

    // ── 模型文件 ──
    // 注意：不直接 require('onnxruntime-node')。
    // pnpm 的严格隔离不会把它提升到顶层，而且它是 @huggingface/transformers
    // 的内部依赖——直接依赖它是错误的耦合。原生绑定是否可用，
    // 由下面 pipeline 真跑一次推理来证明（那才是唯一有意义的验证）。
    console.log('\n模型与推理')
    // 测试脚本跑在 scripts/test/ 下，app.getAppPath() 会指向脚本目录；
    // 真实应用里 app.getAppPath() 就是项目根，这里手动上溯两级对齐。
    const modelDir = join(__dirname, '..', '..', 'models')
    const fs = require('node:fs')
    check('模型目录存在', fs.existsSync(modelDir), modelDir)
    const onnxPath = join(modelDir, 'Xenova', 'bge-m3', 'onnx', 'model_quantized.onnx')
    check('模型文件存在', fs.existsSync(onnxPath))

    // ── ESM 动态 import + 真实推理 ──
    const importEsm = new Function('m', 'return import(m)')
    const mod = await importEsm('@huggingface/transformers')
    const { pipeline, env } = mod
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = modelDir
    env.useBrowserCache = false

    const t0 = Date.now()
    const extractor = await pipeline('feature-extraction', 'Xenova/bge-m3', { dtype: 'q8' })
    const loadMs = Date.now() - t0
    check('CJS 里动态 import ESM 成功', true, 'load ' + loadMs + 'ms')

    const t1 = Date.now()
    const out = await extractor(['记忆检索自检'], { pooling: 'cls', normalize: true })
    const inferMs = Date.now() - t1
    check('1024 维向量', out.dims[out.dims.length - 1] === 1024, 'dims ' + JSON.stringify(out.dims))
    check('推理耗时', inferMs < 3000, inferMs + 'ms')

    console.log('\n通过 ' + passed + '，失败 ' + failed)
  } catch (error) {
    console.error('异常:', error && error.message)
    console.error(error && error.stack)
    failed += 1
  } finally {
    app.exit(failed > 0 ? 1 : 0)
  }
})