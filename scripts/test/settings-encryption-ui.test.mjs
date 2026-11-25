/** Real ModelSection + useModelProfiles DOM regression. Synthetic IPC only; no user configuration. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { MessagePort } from 'node:worker_threads'
import { JSDOM } from 'jsdom'
import { loadEsbuild, p, projectRoot } from './qq-test-util.mjs'

const require = createRequire(import.meta.url)
const esbuild = loadEsbuild()
// Only close ports born during this isolated test, never pre-existing host handles.
const originalHandles = new Set(process._getActiveHandles())
const originalFetch = globalThis.fetch
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://settings-fixture.invalid'
})
const previous = new Map()
for (const [name, value] of Object.entries({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}
// No resource loader is enabled in jsdom. Fail explicitly if the component attempts network I/O.
dom.window.fetch = globalThis.fetch = () => { throw new Error('Unexpected network access') }
let root, ui, passed = 0
const NORMAL = '系统密钥库可用，密钥保存时加密。'
const WARNING = '系统密钥库不可用，新密钥将以明文保存；已有密文保持不变。'
const REENTER = '原密钥无法解密，请重新填写。保存其它设置时会保留原密文。'
const secrets = ['sk-synthetic-settings-dom-only-001', 'sk-synthetic-replacement-dom-only-002']
const scenarios = [
  { name: 'unavailable storage warns', available: false, unavailable: false },
  { name: 'available storage gives normal hint', available: true, unavailable: false },
  { name: 'unreadable profile requests reentry', available: true, unavailable: true },
  { name: 'unavailable storage and unreadable profile show both warnings', available: false, unavailable: true }
]
function checkMasked(expected) {
  const inputs = [...document.querySelectorAll('input')]
  const passwords = inputs.filter(input => input.type === 'password')
  assert.equal(passwords.length, 1, 'exactly one password field is rendered')
  const input = passwords[0]
  assert.equal(input.getAttribute('type'), 'password')
  assert.equal(input.autocomplete, 'new-password')
  assert.ok(input.value === expected, 'password field contains the expected synthetic value')
  for (const secret of secrets) {
    assert.ok(!document.body.textContent.includes(secret), 'no synthetic key in body text')
    assert.ok(inputs.filter(item => item !== input).every(item => !item.value.includes(secret)), 'no synthetic key in other fields')
    assert.ok([...document.querySelectorAll('*')].every(element =>
      [...element.attributes].every(attr =>
        (element === input && attr.name === 'value') || !attr.value.includes(secret)
      )
    ), 'no synthetic key in titles, accessibility labels, or other attributes')
  }
  return input
}
async function test(name, run) {
  await run()
  console.log('ok settings-encryption-ui ' + (++passed) + ' - ' + name)
}
try {
  // Bundle production renderer and its hook, not a replacement component or copied render logic.
  // Compile in memory so the sole persistent artifact is this test file.
  const result = await esbuild.build({
    stdin: {
      contents: [
        'export { createElement, act } from ' + JSON.stringify(p('node_modules/react/index.js')),
        'export { createRoot } from ' + JSON.stringify(p('node_modules/react-dom/client.js')),
        'export { ModelSection } from ' + JSON.stringify(p('src/renderer/src/features/settings/sections/ModelSection.tsx'))
      ].join(String.fromCharCode(10)),
      resolveDir: projectRoot, sourcefile: 'settings-encryption-ui-entry.ts'
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    alias: { '@shared': p('src/shared') }, logLevel: 'silent'
  })
  const filename = path.join(projectRoot, 'scripts/test/settings-encryption-ui.memory.cjs')
  const compiled = new (require('node:module'))(filename)
  compiled.filename = filename
  compiled.paths = require('node:module')._nodeModulePaths(path.dirname(filename))
  compiled._compile(result.outputFiles[0].text, filename)
  ui = compiled.exports
  for (const scenario of scenarios) {
    const calls = { settings: 0, profiles: 0 }
    const profile = {
      id: 'synthetic-profile', name: 'Synthetic profile', provider: 'openai',
      baseUrl: 'https://model-fixture.invalid/v1',
      apiKey: scenario.unavailable ? '' : secrets[0], apiKeyUnavailable: scenario.unavailable,
      models: ['synthetic-model'], defaultModel: 'synthetic-model', temperature: 0.7,
      modelOptions: { 'synthetic-model': { contextWindowTokens: 8192, multimodal: false } }
    }
    const catalog = { profiles: [profile], defaultProfileId: profile.id }
    const unexpected = () => { throw new Error('Unexpected IPC operation') }
    window.nahida = {
      settings: { get: async () => { calls.settings++; return { keyStorage: { available: scenario.available } } }, save: unexpected },
      modelProfiles: {
        list: async () => { calls.profiles++; return structuredClone(catalog) },
        save: unexpected, remove: unexpected, setDefault: unexpected, test: unexpected, discover: unexpected
      }
    }
    root = ui.createRoot(document.getElementById('root'))
    await test(scenario.name, async () => {
      await ui.act(async () => { root.render(ui.createElement(ui.ModelSection)) })
      assert.equal(calls.profiles, 1, 'production hook read synthetic catalog')
      assert.ok(calls.settings >= 1, 'production component read synthetic storage status')
      const statuses = [...document.querySelectorAll('[role="status"]')]
      const expected = [!scenario.available && WARNING, scenario.unavailable && REENTER,
        scenario.available && !scenario.unavailable && NORMAL].filter(Boolean)
      for (const text of [NORMAL, WARNING, REENTER]) {
        assert.equal(statuses.some(node => node.textContent === text), expected.includes(text), 'status branch: ' + text)
      }
      for (const warning of statuses.filter(node => [WARNING, REENTER].includes(node.textContent))) {
        assert.ok(warning.getAttribute('style').includes('var(--nc-warning)'), 'warning uses warning token')
      }
      checkMasked(profile.apiKey)
    })
    await test(scenario.name + ': editing stays masked and does not leak key', async () => {
      const input = checkMasked(profile.apiKey)
      await ui.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, secrets[1])
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      checkMasked(secrets[1])
      assert.ok(document.body.textContent.includes('未保存'), 'production change handler updates dirty state')
      assert.ok(profile.apiKey !== secrets[1], 'editing draft leaves fixture profile untouched')
    })
    await ui.act(async () => root.unmount())
    root = null
  }
  console.log('PASS settings-encryption-ui ' + passed + '/' + (scenarios.length * 2))
} catch (error) {
  console.error('FAIL settings-encryption-ui', error)
  process.exitCode = 1
} finally {
  if (root && ui) await ui.act(async () => root.unmount())
  dom.window.close()
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  esbuild.stop()
  globalThis.fetch = originalFetch
  // React/jsdom scheduling leaves referenced Node MessagePorts after root.unmount().
  // Close the actual new ports; retain stdio and all handles that predate this test.
  const ports = process._getActiveHandles().filter(handle =>
    handle instanceof MessagePort && !originalHandles.has(handle))
  await Promise.all(ports.map(port => new Promise(resolve => {
    port.once('close', resolve)
    port.close()
  })))
  console.log('CLEANUP settings-encryption-ui: closed ' + ports.length + ' test-owned MessagePorts')
}
