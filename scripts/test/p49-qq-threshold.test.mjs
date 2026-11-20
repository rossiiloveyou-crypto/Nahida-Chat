/** P4.9 D: real QqSection + useQq + QqStore, with only the preload transport stubbed. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p49-qq-threshold-'))
installElectronStub(dir)
const { QqStore } = await bundleModule('p49-qq-store',
  'export { QqStore } from ' + JSON.stringify(p('src/main/features/qq/store.ts')))
const storeDir = path.join(dir, 'qq')
const store = new QqStore(storeDir)
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const requests = []
let pending = null
window.nahida = { qq: {
  status: async () => null,
  processes: async () => [],
  getSettings: async () => new QqStore(storeDir).settings(),
  onEvent: () => () => {},
  logs: async () => [],
  saveSettings: patch => {
    requests.push(structuredClone(patch))
    return new Promise((resolve, reject) => { pending = { patch, resolve, reject } })
  }
} }
const ui = await bundleModule('p49-qq-threshold-dom', [
  'export { createElement, act } from ' + JSON.stringify(p('node_modules/react/index.js')),
  'export { createRoot } from ' + JSON.stringify(p('node_modules/react-dom/client.js')),
  'export { MemoryRouter } from ' + JSON.stringify(p('node_modules/react-router-dom/dist/index.mjs')),
  'export { QqSection } from ' + JSON.stringify(p('src/renderer/src/features/settings/sections/QqSection.tsx'))
].join(String.fromCharCode(10)))
const { createElement: h, act } = ui
const root = ui.createRoot(document.getElementById('root'))
const mount = async () => act(async () => root.render(h(ui.MemoryRouter, null, h(ui.QqSection))))
const leaveTab = async () => act(async () => root.render(h('p', null, '其它设置 Tab')))
const threshold = name => document.querySelector('[data-ui-target="门槛 ' + name + '"] select')
const row = name => document.querySelector('[data-ui-target="门槛 ' + name + '"]')
const field = label => [...document.querySelectorAll('label.field')].find(n => n.querySelector('.field__label')?.textContent === label)?.querySelector('input,select')
const button = text => [...document.querySelectorAll('button')].find(n => n.textContent === text)
const change = async (node, value) => act(async () => {
  const proto = node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value)
  node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
})
const complete = async error => act(async () => {
  assert.ok(pending, 'a real save is pending')
  const task = pending
  pending = null
  if (error) task.reject(new Error(error))
  else task.resolve(store.saveSettings(task.patch))
})
let checks = 0
async function test(label, run) { await run(); console.log('PASS ' + (++checks) + ' - ' + label) }
const otherLevel = (name, settings = store.settings()) => settings.commandThresholds[name] === 'high' ? 'low' : 'high'

try {
  await mount()
  const first = store.settings()
  const nextList = otherLevel('list')
  await test('D-04 other fields remain local until the existing save button is clicked', async () => {
    await change(field('typing 文本'), '未保存的 typing 草稿')
    await change(field('出错时回给对端的一句话（留空 = 不回）'), '未保存的错误回复')
    assert.equal(requests.length, 0)
    assert.equal(store.settings().typingText, first.typingText)
  })
  await test('D-01 selecting a threshold immediately sends only commandThresholds', async () => {
    await change(threshold('list'), nextList)
    assert.equal(requests.length, 1)
    assert.deepEqual(Object.keys(requests[0]), ['commandThresholds'])
    assert.deepEqual(requests[0].commandThresholds, { ...first.commandThresholds, list: nextList })
    assert.equal(threshold('list').value, first.commandThresholds.list, 'pending value is not represented as persisted')
  })
  await test('D-03 pending selects are disabled and repeated events cannot race', async () => {
    assert.ok([...document.querySelectorAll('.qq-command-select')].every(n => n.disabled))
    assert.match(row('list').textContent, /保存中/)
    await change(threshold('switch'), otherLevel('switch'))
    assert.equal(requests.length, 1)
    await change(field('出错时回给对端的一句话（留空 = 不回）'), '保存期间继续编辑')
  })
  await test('D-04 threshold receipt preserves unsaved drafts including edits during save', async () => {
    await complete()
    assert.equal(threshold('list').value, nextList)
    assert.equal(threshold('list').disabled, false)
    assert.equal(field('typing 文本').value, '未保存的 typing 草稿')
    assert.equal(field('出错时回给对端的一句话（留空 = 不回）').value, '保存期间继续编辑')
    assert.equal(store.settings().typingText, first.typingText)
    assert.equal(store.settings().errorReplyText, first.errorReplyText)
    assert.equal(new QqStore(storeDir).settings().commandThresholds.list, nextList)
  })
  await test('D-04 original save button submits remaining draft fields and latest threshold', async () => {
    await act(async () => button('保存设置').click())
    assert.equal(requests.length, 2)
    assert.equal(requests[1].typingText, '未保存的 typing 草稿')
    assert.equal(requests[1].errorReplyText, '保存期间继续编辑')
    assert.equal(requests[1].commandThresholds.list, nextList)
    await complete()
    assert.equal(store.settings().typingText, '未保存的 typing 草稿')
    assert.equal(field('出错时回给对端的一句话（留空 = 不回）').value, '保存期间继续编辑')
  })
  await test('D-01/D-02 tab remount and a new store instance both read the saved threshold', async () => {
    await leaveTab()
    await mount()
    assert.equal(threshold('list').value, nextList)
    assert.equal(new QqStore(storeDir).settings().commandThresholds.list, nextList)
  })
  const beforeFailure = store.settings()
  const failedSwitch = otherLevel('switch')
  await test('D-03 failed save remains visible inline and retains the persisted value and draft', async () => {
    await change(field('typing 文本'), '失败时也要保留')
    await change(threshold('switch'), failedSwitch)
    await complete('fixture write failed')
    assert.match(row('switch').querySelector('[role="alert"]').textContent, /保存失败：fixture write failed/)
    assert.equal(threshold('switch').value, beforeFailure.commandThresholds.switch)
    assert.equal(threshold('switch').disabled, false)
    assert.deepEqual(store.settings(), beforeFailure)
    assert.equal(field('typing 文本').value, '失败时也要保留')
  })
  await test('D-03 retry clears the inline error and saves without losing earlier thresholds', async () => {
    await change(threshold('switch'), failedSwitch)
    assert.equal(row('switch').querySelector('[role="alert"]'), null)
    await complete()
    assert.equal(threshold('switch').value, failedSwitch)
    assert.equal(threshold('list').value, nextList)
    assert.equal(field('typing 文本').value, '失败时也要保留')
  })
  await test('D-04 existing restore button restores draft only and retains saved thresholds', async () => {
    const count = requests.length
    await act(async () => button('还原').click())
    assert.equal(requests.length, count)
    assert.equal(field('typing 文本').value, store.settings().typingText)
    assert.equal(threshold('switch').value, failedSwitch)
  })
  await test('D-01 leaving the tab while save is pending still persists for the next mount', async () => {
    const nextAdd = otherLevel('add')
    await change(threshold('add'), nextAdd)
    await leaveTab()
    await complete()
    await mount()
    assert.equal(threshold('add').value, nextAdd)
    assert.equal(new QqStore(storeDir).settings().commandThresholds.add, nextAdd)
    assert.equal(threshold('list').value, nextList)
  })
  console.log('P4.9 QQ threshold: ' + checks + ' passed, 0 failed, 0 skipped')
  console.log('共 ' + checks + ' 项，通过 ' + checks + ' 项')
} finally {
  await act(async () => root.unmount())
  dom.window.close()
  // 与 message-edit.test.mjs 相同：卸载后释放 jsdom/React scheduler 的事件循环引用。
  for (const handle of process._getActiveHandles()) {
    if (handle.constructor.name === 'MessagePort') handle.unref()
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
