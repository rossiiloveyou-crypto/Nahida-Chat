/**
 * 实测同步写耗时（PHASE-8 §九 K2 的判据：> 2 ms/条 才需要改成队列）。
 * 只在临时目录里跑，不碰真实 userData。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, installElectronStub, p } from './test/qq-test-util.mjs'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-observe-probe-'))
installElectronStub(userData)

const mod = await bundleModule('observe-probe', `export { ObserveStore, makeRecord } from '${p('src/main/features/observe/store.ts')}'`)
const { ObserveStore, makeRecord } = mod

function measure(label, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-observe-probe-lib-'))
  const store = new ObserveStore({ root, ...options })
  const N = 500
  const text = '这是一条用来测落盘耗时的普通群聊消息，长度接近真实发言。'
  const started = process.hrtime.bigint()
  for (let i = 0; i < N; i += 1) {
    store.append(makeRecord({ uin: '10001', chatType: 'group', chatId: '888888', text: text + String(i), at: Date.now() }))
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const per = elapsedMs / N
  console.log(
    label +
      '：' + N + ' 条共 ' + elapsedMs.toFixed(1) + ' ms ⇒ 平均 ' + per.toFixed(3) + ' ms/条' +
      '（' + (per > 2 ? '超过 2 ms，需改队列' : '未超 2 ms，保持同步写') + '）'
  )
  return per
}

// 单分片（默认 32 MiB）
measure('单分片（默认 32 MiB）', {})
// 小分片（200 字节）：每次都要 readdir/stat 挑分片，是最坏情况
measure('小分片（200 B，最坏情况）', { segmentBytes: 200 })
