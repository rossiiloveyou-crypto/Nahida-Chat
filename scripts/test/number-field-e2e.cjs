/**
 * 数字输入框的真机验证（N-E1…N-E6）—— 用真窗口 + 真 IPC 打字，不看源码猜。
 *
 * 报障原话：点进去打一个数字就再也打不了第二个，得再点一次；
 * 而且输入小于下限会被立刻改写。
 *
 * 这里复现的是**完全相同**的操作序列：focus → 依次打 '1'、'10'、'100'（每步都派发 input 事件），
 * 断言三件事：
 *  ① 每一步输入框显示的就是刚打的那个值（没被钳成下限、光标没丢）
 *  ② 打字期间设置**没有**被保存（证明不再一键一存）
 *  ③ 失焦之后才落库，且落的是 100
 * 再补两条边界：低于下限失焦 → 变下限；清空失焦 → 回退原值（不是 0）。
 *
 * 跑法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/test/number-field-e2e.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '../..')
const userData = path.join(os.tmpdir(), 'nc-numfield-' + Date.now())
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setAppPath(projectRoot)

// 摘要默认是开的；显式再写一遍，免得默认值将来变了把这条测试变成假失败
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ defaultCharacterId: 'nahida', summary: { enabled: true, triggerCount: 40 } }, null, 2),
  'utf8'
)

require(path.join(projectRoot, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  → ' + detail))
}

app.whenReady().then(async () => {
  await sleep(900)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('没有找到主窗口')
    app.exit(1)
    return
  }
  win.setContentSize(1280, 860)
  await win.loadFile(path.join(projectRoot, 'out', 'renderer', 'index.html'), {
    hash: '/settings/memory',
    query: { v: String(Date.now()) }
  })

  // 等设置页真的把「对话摘要参数」渲染出来（设置是异步拉的）
  const ready = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + 8000
      const tick = () => {
        const block = document.querySelector('[data-ui-target="对话摘要参数"]')
        if (block && block.querySelectorAll('input[type="number"]').length >= 6) return resolve(true)
        if (Date.now() > deadline) return resolve(false)
        setTimeout(tick, 100)
      }
      tick()
    })
  `)
  if (!ready) {
    console.error('设置页没渲染出来（等待超时）')
    app.exit(2)
    return
  }

  const typed = await win.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const setNative = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const block = document.querySelector('[data-ui-target="对话摘要参数"]')
      const el = [...block.querySelectorAll('input[type="number"]')][0]
      const min = Number(el.min)
      el.focus()
      const steps = []
      for (const v of ['1', '10', '100']) {
        setNative(el, v)
        await sleep(80)
        steps.push({ typed: v, shown: el.value, focused: document.activeElement === el })
      }
      const beforeBlur = (await window.nahida.settings.get()).summary.triggerCount
      el.blur()
      await sleep(500)
      const afterBlur = (await window.nahida.settings.get()).summary.triggerCount
      const shownAfterBlur = el.value

      // N-E4：低于下限失焦 → 钳到下限
      el.focus()
      setNative(el, '1')
      await sleep(80)
      const belowWhileTyping = el.value
      el.blur()
      await sleep(500)
      const belowStored = (await window.nahida.settings.get()).summary.triggerCount
      const belowShown = el.value

      // N-E5：清空失焦 → 回退原值（绝不是 0）
      const beforeClear = (await window.nahida.settings.get()).summary.triggerCount
      el.focus()
      setNative(el, '')
      await sleep(80)
      el.blur()
      await sleep(500)
      const emptyStored = (await window.nahida.settings.get()).summary.triggerCount
      const emptyShown = el.value

      return { min, steps, beforeBlur, afterBlur, shownAfterBlur, belowWhileTyping, belowStored, belowShown, beforeClear, emptyStored, emptyShown }
    })()
  `)

  check(
    'N-E1 连着打 1 → 10 → 100：每一步显示的都是刚打的值（不再被钳成下限）',
    typed.steps.map((s) => s.shown).join(',') === '1,10,100',
    typed.steps.map((s) => s.typed + '→' + s.shown).join(' ')
  )
  check(
    'N-E2 打字过程中焦点一直在框里（不用再点一次）',
    typed.steps.every((s) => s.focused),
    typed.steps.map((s) => (s.focused ? 'focused' : 'LOST')).join(',')
  )
  check('N-E3 打字期间没有一键一存（存盘还是 40）', typed.beforeBlur === 40, String(typed.beforeBlur))
  check(
    'N-E3b 失焦才落库，落的是 100，框里也显示 100',
    typed.afterBlur === 100 && typed.shownAfterBlur === '100',
    JSON.stringify({ stored: typed.afterBlur, shown: typed.shownAfterBlur })
  )
  check(
    'N-E4 低于下限：打字时保留原样，失焦才钳到下限',
    typed.belowWhileTyping === '1' && typed.belowStored === typed.min && typed.belowShown === String(typed.min),
    JSON.stringify({ typing: typed.belowWhileTyping, stored: typed.belowStored, min: typed.min })
  )
  check(
    'N-E5 清空后失焦：回退到清空前那个值（不是 0，也不是下限）',
    typed.beforeClear !== 0 &&
      typed.emptyStored === typed.beforeClear &&
      typed.emptyShown === String(typed.beforeClear),
    JSON.stringify({ beforeClear: typed.beforeClear, stored: typed.emptyStored, shown: typed.emptyShown })
  )

  const failed = checks.filter((item) => !item.ok)
  console.log('')
  console.log('共 ' + checks.length + ' 项，通过 ' + (checks.length - failed.length) + ' 项')
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
