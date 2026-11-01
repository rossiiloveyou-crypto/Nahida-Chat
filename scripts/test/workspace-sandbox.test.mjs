/**
 * 工作区路径闸的测试。
 *
 * 这条规则很容易写反：完全访问下限制要消失，只读/审批下限制必须在。
 * 写反的后果不是报错，而是"看起来配了工作区其实没用"或者"配了完全访问还是读不到"，
 * 两种都不会立刻报错，所以必须有测试盯着。
 *
 * 跑法：pnpm test:sandbox
 */
import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (error) {
    console.error('  FAIL ' + name)
    throw error
  }
}

let source = readFileSync(join(root, 'src/main/features/tools/sandbox.ts'), 'utf8')
// import 被剥掉了，node:path 的符号要重新注入，否则模块体里 resolve 是未定义
source = source.replace(/^import[^\n]*\n/gm, '')
let code = stripTypeScriptTypes(source)
code = code.replace(/^export (async function|function|const|class)/gm, '$1')
const names = [...code.matchAll(/^(?:async function|function|const|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
const path = await import('node:path')
const { resolveToolPath } = new Function(
  'isAbsolute',
  'resolve',
  'sep',
  code + '\nreturn {' + names.join(',') + '}'
)(path.isAbsolute, path.resolve, path.sep)

const WS = path.resolve('/tmp/ws-nahida')

console.log('只读 / 审批模式：工作区是硬边界')
test('相对路径落在工作区内', () => {
  const target = resolveToolPath('notes/a.txt', { mode: 'readonly', root: WS })
  assert.equal(target, path.join(WS, 'notes/a.txt'))
})
test('工作区内的绝对路径通过', () => {
  const inside = path.join(WS, 'notes/a.txt')
  assert.equal(resolveToolPath(inside, { mode: 'readonly', root: WS }), inside)
})
test('工作区外的绝对路径被拒绝', () => {
  assert.throws(
    () => resolveToolPath('C:/Windows/System32/config', { mode: 'readonly', root: WS }),
    /不在当前工作区/
  )
})
test('用 .. 逃出工作区被拒绝', () => {
  assert.throws(
    () => resolveToolPath('../../etc/passwd', { mode: 'approve', root: WS }),
    /不在当前工作区/
  )
})
test('审批模式同样受限（审批的是"做不做"，不是"在哪做"）', () => {
  assert.throws(
    () => resolveToolPath('C:/secret.txt', { mode: 'approve', root: WS }),
    /不在当前工作区/
  )
})

console.log('完全访问模式：边界消失')
test('工作区外的路径被放行', () => {
  const outside = path.resolve('/tmp/other/file.txt')
  assert.equal(resolveToolPath(outside, { mode: 'full', root: WS }), outside)
})
test('相对路径仍然以工作区为基准', () => {
  assert.equal(
    resolveToolPath('a.txt', { mode: 'full', root: WS }),
    path.join(WS, 'a.txt')
  )
})

console.log('边界细节')
test('工作区本身（不是子路径）也算在内', () => {
  assert.equal(resolveToolPath('.', { mode: 'readonly', root: WS }), WS)
})
test('同名前缀的兄弟目录不算工作区', () => {
  // /tmp/ws-nahida-evil 不能因为字符串前缀相同就通过
  assert.throws(
    () => resolveToolPath(WS + '-evil/x', { mode: 'readonly', root: WS }),
    /不在当前工作区/
  )
})

console.log('多工作区：同一次运行里两个根互不影响')
test('同一个应用里，两个工作区各管各的', () => {
  const wsA = path.resolve('/tmp/ws-alpha')
  const wsB = path.resolve('/tmp/ws-beta')
  assert.equal(resolveToolPath('a.txt', { mode: 'readonly', root: wsA }), path.join(wsA, 'a.txt'))
  assert.equal(resolveToolPath('b.txt', { mode: 'readonly', root: wsB }), path.join(wsB, 'b.txt'))
})
test('A 工作区的路径在 B 工作区里被拒绝', () => {
  const wsA = path.resolve('/tmp/ws-alpha')
  const wsB = path.resolve('/tmp/ws-beta')
  assert.throws(
    () => resolveToolPath(path.join(wsA, 'secret.txt'), { mode: 'readonly', root: wsB }),
    /不在当前工作区/
  )
})
test('没有绑工作区时只读模式明确报错，而不是默默放到 cwd', () => {
  // 空 root 绝不能回落成 '.'：那等于把整个进程工作目录当成可读区
  assert.throws(() => resolveToolPath('a.txt', { mode: 'readonly', root: '' }), /没有绑定工作区/)
})
test('完全访问模式下空 root 仍以当前目录为相对基准', () => {
  assert.equal(resolveToolPath('a.txt', { mode: 'full', root: '' }), path.resolve('a.txt'))
})

console.log('\n共 ' + passed + ' 项通过')