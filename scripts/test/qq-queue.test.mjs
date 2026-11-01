/**
 * A2 keyed queue 三条不变量（P4 G2）。
 * 跑法：node scripts/test/qq-queue.test.mjs
 */
import { bundleModule, createChecker, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const mod = await bundleModule('queue', `export { createKeyedQueue } from '${p('src/main/features/qq/queue.ts')}'`)
const { createKeyedQueue } = mod
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('① 同键串行（不是并发）')
const queue = createKeyedQueue()
const order = []
const task = (name, delay) => async () => {
  order.push('start:' + name)
  await sleep(delay)
  order.push('end:' + name)
  return name
}
const results = await Promise.all([
  queue.run('k', task('a', 40)),
  queue.run('k', task('b', 5)),
  queue.run('k', task('c', 0))
])
check(
  '执行顺序 = 提交顺序（后提交的即使更快也不能插队）',
  order.join(',') === 'start:a,end:a,start:b,end:b,start:c,end:c',
  order.join(',')
)
check('返回值分别是自己的任务结果', results.join(',') === 'a,b,c', results.join(','))

console.log('② 尾链吞错：前一个失败不阻断后一个')
const q2 = createKeyedQueue()
const ran = []
const first = q2.run('k', async () => {
  ran.push(1)
  throw new Error('故意失败')
})
const second = q2.run('k', async () => {
  ran.push(2)
  return 'ok'
})
let firstError = null
try {
  await first
} catch (error) {
  firstError = error
}
const secondResult = await second
check('第一个任务的 rejection 照样抛给调用方', firstError instanceof Error && /故意失败/.test(firstError.message))
check('第二个任务仍然执行了', ran.join(',') === '1,2', ran.join(','))
check('第二个任务拿到自己的结果', secondResult === 'ok', secondResult)
check('键空即删（防内存泄漏）', q2.pendingKeys() === 0, q2.pendingKeys())

console.log('③ 超限拒绝（reject，不是排队）')
const q3 = createKeyedQueue({ maxPendingPerKey: 2 })
const slow = () => sleep(50)
const t1 = q3.run('k', slow)
const t2 = q3.run('k', slow)
let rejected = null
try {
  await q3.run('k', slow)
} catch (error) {
  rejected = error
}
check('第三个任务被 reject', rejected instanceof Error, String(rejected))
check('message 含 queue_full', rejected instanceof Error && rejected.message.includes('queue_full'), rejected && rejected.message)
await Promise.all([t1, t2])

// 不同键互不影响
const q4 = createKeyedQueue({ maxPendingPerKey: 1 })
const a = q4.run('a', slow)
const b = q4.run('b', slow)
check('不同键可以并发挂起', q4.pendingKeys() === 2, q4.pendingKeys())
await Promise.all([a, b])
check('全部结束后键清空', q4.pendingKeys() === 0, q4.pendingKeys())

done()
