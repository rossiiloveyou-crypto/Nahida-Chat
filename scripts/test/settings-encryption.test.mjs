/** Real SettingsStore boundary tests; only randomized temporary settings are used.
 * Run: node scripts/test/settings-encryption.test.mjs
 * No forced process exit: leaked handles remain observable to the caller.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { bundleModule, installElectronStub, p } from './qq-test-util.mjs'

const require = createRequire(import.meta.url)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-key-tests-'))
const Module = require('node:module')
const originalResolve = Module._resolveFilename
let passed = 0
let failed = 0
const check = (condition, label) => { if (!condition) { const error = new Error(label); error.testLabel = label; throw error } }
const key = () => 'synthetic-' + randomBytes(24).toString('hex')
const profile = (id, apiKey) => ({ id, name: id, provider: 'openai-compatible', baseUrl: 'https://example.invalid/' + id,
  apiKey, models: ['test-model'], defaultModel: 'test-model', temperature: 0.7, createdAt: 1, updatedAt: 1 })
const fixture = (keys) => ({ provider: 'openai-compatible', baseUrl: 'https://example.invalid/p0', apiKey: keys[0],
  model: 'test-model', temperature: 0.7, modelProfiles: keys.map((k, i) => profile('p' + i, k)), defaultProfileId: 'p0' })

try {
  installElectronStub(root, { encryptionAvailable: true })
  const electron = require('electron')
  check(electron.safeStorage, 'safeStorage stub exists')
  const safeStorage = electron.safeStorage
  const originalSafe = { ...safeStorage }
  const { SettingsStore } = await bundleModule('settings-encryption',
    'export { SettingsStore } from ' + JSON.stringify(p('src/main/features/settings/settingsStore.ts')))
  const { decryptSettings, rollbackFile } = require('./settings-key-rollback.cjs')
  let dir
  const reset = (id, available = true) => {
    dir = path.join(root, id)
    fs.mkdirSync(dir)
    electron.app.getPath = (name) => name === 'userData' ? dir : path.join(dir, name)
    Object.assign(safeStorage, originalSafe)
    safeStorage.isEncryptionAvailable = () => available
  }
  const file = () => path.join(dir, 'settings.json')
  const write = (value) => fs.writeFileSync(file(), JSON.stringify(value))
  const bytes = () => fs.readFileSync(file(), 'utf8')
  const disk = () => JSON.parse(bytes())
  const noPlain = (text, keys) => {
    check(keys.every(k => !k || !text.includes(k)), 'plaintext excluded')
    const data = JSON.parse(text)
    check(!Object.hasOwn(data, 'apiKey'), 'top key absent')
    check(data.modelProfiles.every(p => !Object.hasOwn(p, 'apiKey')), 'profile keys absent')
  }
  const run = async (id, fn) => {
    try { reset(id); await fn(); passed++; console.log('PASS ' + id) }
    catch (error) { failed++; console.error('FAIL ' + id + ': ' + (error instanceof Error && error.testLabel ? error.testLabel : 'assertion or operation failed')) }
  }

  await run('E01 new save and reread', () => {
    const k = key(), store = new SettingsStore()
    store.save(fixture([k]))
    noPlain(bytes(), [k])
    check(typeof disk().apiKeyEnc === 'string', 'top ciphertext exists')
    const fresh = new SettingsStore().get()
    check(fresh.apiKey === k && fresh.modelProfiles[0].apiKey === k, 'key roundtrip')
    check(fresh.keyStorage.available && !fresh.keyStorage.decryptFailed, 'storage status')
  })
  await run('E02 legacy plaintext migration', () => {
    const k = key(); write(fixture([k]))
    check(new SettingsStore().get().apiKey === k, 'legacy key read')
    noPlain(bytes(), [k])
    const backup = file() + '.pre-key-migration.enc.bak'
    check(fs.existsSync(backup), 'migration backup exists')
    noPlain(fs.readFileSync(backup, 'utf8'), [k])
  })
  await run('E03 M0 flat migration', () => {
    const k = key(); const data = fixture([k]); delete data.modelProfiles; delete data.defaultProfileId; write(data)
    const loaded = new SettingsStore().get()
    check(loaded.apiKey === k && loaded.modelProfiles.length === 1 && loaded.modelProfiles[0].apiKey === k, 'flat profile migration')
    noPlain(bytes(), [k])
  })
  await run('E04 migration idempotence', () => {
    write(fixture([key()])); new SettingsStore().get()
    const before = bytes(); const backup = fs.readFileSync(file() + '.pre-key-migration.enc.bak', 'utf8')
    new SettingsStore().get(); new SettingsStore().get()
    check(bytes() === before, 'reread does not rewrite')
    check(fs.readFileSync(file() + '.pre-key-migration.enc.bak', 'utf8') === backup, 'backup immutable')
  })
  await run('E05 empty keys', () => {
    let calls = 0; safeStorage.encryptString = (...args) => { calls++; return originalSafe.encryptString(...args) }
    new SettingsStore().save(fixture(['']))
    check(calls === 0, 'empty key not encrypted')
    check(!disk().apiKeyEnc && !disk().modelProfiles[0].apiKeyEnc, 'empty ciphertext absent')
    check(new SettingsStore().get().apiKey === '', 'empty key roundtrip')
  })
  await run('E06 all profiles encrypted', () => {
    const keys = [key(), key(), key()]; new SettingsStore().save(fixture(keys))
    noPlain(bytes(), keys)
    check(disk().modelProfiles.every(p => typeof p.apiKeyEnc === 'string'), 'every profile encrypted')
    const fresh = new SettingsStore().get()
    check(fresh.modelProfiles.every((p, i) => p.apiKey === keys[i]), 'all profiles roundtrip')
  })
  await run('E07 unavailable preserves ciphertext', () => {
    const k = key(); new SettingsStore().save(fixture([k])); const prior = disk()
    safeStorage.isEncryptionAvailable = () => false
    const store = new SettingsStore(); const loaded = store.get()
    check(!loaded.keyStorage.available && loaded.apiKey === '', 'unavailable status')
    check(loaded.modelProfiles[0].apiKeyUnavailable === true, 'profile unavailable flag')
    store.save({ temperature: 0.42 })
    check(disk().apiKeyEnc === prior.apiKeyEnc && disk().modelProfiles[0].apiKeyEnc === prior.modelProfiles[0].apiKeyEnc, 'ciphertext retained')
    const before = bytes(); let threw = false
    try { store.saveProfile({ ...loaded.modelProfiles[0], apiKey: key() }) } catch { threw = true }
    check(threw && bytes() === before, 'unavailable replacement preserves file')
  })
  await run('E08 corrupt ciphertext preserves settings', () => {
    const data = fixture(['']); delete data.apiKey; delete data.modelProfiles[0].apiKey
    data.apiKeyEnc = Buffer.from('broken-envelope').toString('base64'); data.modelProfiles[0].apiKeyEnc = data.apiKeyEnc
    data.temperature = 0.43; data.modelProfiles[0].temperature = 0.43; write(data)
    const store = new SettingsStore(), loaded = store.get()
    check(loaded.apiKey === '' && loaded.modelProfiles[0].apiKey === '', 'broken keys empty')
    check(loaded.keyStorage.decryptFailed && loaded.modelProfiles[0].apiKeyUnavailable, 'decryption failure flags')
    check(loaded.temperature === 0.43 && loaded.modelProfiles[0].name === 'p0', 'other settings retained')
    store.save({ temperature: 0.44 })
    check(disk().apiKeyEnc === data.apiKeyEnc && disk().modelProfiles[0].apiKeyEnc === data.apiKeyEnc, 'broken ciphertext retained on save')
  })
  await run('E08b corrupt M0 ciphertext retained', () => {
    const data = fixture(['']); delete data.modelProfiles; delete data.defaultProfileId; delete data.apiKey
    data.apiKeyEnc = Buffer.from('broken-m0-envelope').toString('base64'); write(data)
    const store = new SettingsStore(), loaded = store.get()
    check(loaded.apiKey === '' && loaded.keyStorage.decryptFailed, 'M0 decryption failure flags')
    check(loaded.modelProfiles[0].apiKeyUnavailable, 'M0 unavailable profile')
    store.save({ appearance: { ...loaded.appearance } })
    check(disk().apiKeyEnc === data.apiKeyEnc && disk().modelProfiles[0].apiKeyEnc === data.apiKeyEnc, 'M0 broken ciphertext retained')
  })
  await run('E08c missing and duplicate IDs preserve ciphertext', () => {
    const data = fixture(['', '', '', ''])
    delete data.apiKey
    const envelopes = data.modelProfiles.map((p, i) => {
      delete p.apiKey
      p.apiKeyEnc = Buffer.from('broken-id-' + i).toString('base64')
      return p.apiKeyEnc
    })
    delete data.modelProfiles[0].id
    data.modelProfiles[1].id = 'duplicate'
    data.modelProfiles[2].id = 'duplicate'
    data.modelProfiles[3].id = '@top'
    data.defaultProfileId = 'duplicate'
    data.apiKeyEnc = envelopes[1]
    write(data)
    const store = new SettingsStore(), loaded = store.get()
    check(loaded.modelProfiles.length === 4, 'all malformed identity profiles retained')
    check(new Set(loaded.modelProfiles.map(p => p.id)).size === 4, 'repaired identities unique')
    check(loaded.modelProfiles.every(p => p.apiKeyUnavailable && p.apiKey === ''), 'all malformed identity keys marked')
    store.save({ appearance: { ...loaded.appearance } })
    check(disk().modelProfiles.every((p, i) => p.apiKeyEnc === envelopes[i]), 'ciphertext stays with repaired identity')
    const fresh = new SettingsStore().get()
    check(fresh.modelProfiles.every((p, i) => p.id === loaded.modelProfiles[i].id), 'repaired identities survive reload')
  })
  await run('E08d deleting corrupt keys does not revive them', () => {
    const data = fixture(['']); delete data.apiKey; delete data.modelProfiles[0].apiKey
    const envelope = Buffer.from('broken-delete-envelope').toString('base64')
    data.apiKeyEnc = envelope; data.modelProfiles[0].apiKeyEnc = envelope; write(data)
    const store = new SettingsStore(); store.deleteProfile(store.get().modelProfiles[0].id)
    check(!bytes().includes(envelope), 'deleted ciphertext absent on disk')
    const fresh = new SettingsStore().get()
    check(fresh.apiKey === '' && fresh.modelProfiles.every(p => !p.apiKey && !p.apiKeyUnavailable), 'deleted bad key does not revive')
    check(!fresh.keyStorage.decryptFailed, 'deletion clears failed status')
    store.save({ appearance: { ...store.get().appearance } })
    check(!bytes().includes(envelope), 'later save does not revive ciphertext')
  })
  await run('E08e same identity missing IDs retains distinct keys', () => {
    const keys = [key(), key(), key()], data = fixture(keys)
    data.modelProfiles = keys.map(k => { const p = profile('same', k); delete p.id; return p })
    delete data.defaultProfileId; write(data)
    const loaded = new SettingsStore().get()
    check(loaded.modelProfiles.length === 3, 'same identity profiles retained')
    check(loaded.modelProfiles.every((p, i) => p.apiKey === keys[i]), 'same identity distinct keys preserved')
    noPlain(bytes(), keys)
    check(new SettingsStore().get().modelProfiles.every((p, i) => p.apiKey === keys[i]), 'same identity keys survive reload')
  })
  await run('E08f duplicate IDs invalid models retains ciphertext', () => {
    const data = fixture(['', '']), envelopes = []
    delete data.apiKey; delete data.defaultProfileId
    for (const [i, p] of data.modelProfiles.entries()) {
      p.id = 'duplicate'; p.models = []; p.defaultModel = ''; delete p.apiKey
      p.apiKeyEnc = Buffer.from('broken-empty-model-' + i).toString('base64'); envelopes.push(p.apiKeyEnc)
    }
    write(data)
    const store = new SettingsStore(), loaded = store.get()
    check(loaded.modelProfiles.length === 2, 'invalid models profiles retained')
    store.save({ appearance: { ...loaded.appearance } })
    check(disk().modelProfiles.every((p, i) => p.apiKeyEnc === envelopes[i]), 'invalid model ciphertext kept per profile')
    check(new SettingsStore().get().modelProfiles.length === 2, 'invalid model profiles survive reload')
  })
  await run('E08g null profile top ciphertext fallback and deletion', () => {
    const envelope = Buffer.from('broken-null-profile').toString('base64')
    const data = fixture(['']); delete data.apiKey; data.apiKeyEnc = envelope; data.modelProfiles = [null]; write(data)
    const store = new SettingsStore(), loaded = store.get()
    check(loaded.modelProfiles.length === 1 && loaded.keyStorage.decryptFailed, 'null profile falls back with failed key')
    store.save({ appearance: { ...loaded.appearance } })
    check(disk().apiKeyEnc === envelope && disk().modelProfiles[0].apiKeyEnc === envelope, 'fallback keeps top ciphertext')
    store.deleteProfile(store.get().modelProfiles[0].id)
    check(!bytes().includes(envelope), 'fallback deletion clears ciphertext')
    const fresh = new SettingsStore().get()
    check(!fresh.keyStorage.decryptFailed && fresh.modelProfiles.every(p => !p.apiKeyUnavailable), 'fallback deletion survives restart')
  })
  await run('E08h malformed envelope blocks writes', () => {
    const data = fixture(['']); delete data.apiKey; delete data.modelProfiles[0].apiKey
    data.apiKeyEnc = { malformed: true }; data.modelProfiles[0].apiKeyEnc = { malformed: true }; write(data)
    const before = bytes(), store = new SettingsStore(), loaded = store.get()
    check(loaded.keyStorage.writeFailed === true, 'malformed envelope write failure flag')
    let threw = false
    try { store.save({ appearance: { ...loaded.appearance } }) } catch { threw = true }
    check(threw && bytes() === before, 'malformed envelope preserves original bytes')
  })
  await run('E09 replace key', () => {
    const old = key(), replacement = key(), store = new SettingsStore(); store.save(fixture([old]))
    const before = disk().modelProfiles[0].apiKeyEnc
    store.saveProfile({ ...store.get().modelProfiles[0], apiKey: replacement })
    noPlain(bytes(), [old, replacement])
    check(disk().modelProfiles[0].apiKeyEnc !== before, 'replacement ciphertext changed')
    check(new SettingsStore().get().apiKey === replacement, 'replacement roundtrip')
  })
  await run('E10 encryption failure atomic and redacted', () => {
    const store = new SettingsStore(); store.save(fixture([key()])); const before = bytes(); const replacement = key()
    const logs = [], saved = {}; for (const name of ['log', 'warn', 'error']) { saved[name] = console[name]; console[name] = (...args) => logs.push(args.join(' ')) }
    let caught
    try {
      safeStorage.encryptString = () => { throw new Error('synthetic encryption error ' + replacement) }
      try { store.saveProfile({ ...store.get().modelProfiles[0], apiKey: replacement }) } catch (error) { caught = error }
    } finally { for (const name of Object.keys(saved)) console[name] = saved[name] }
    check(Boolean(caught), 'save reports encryption error')
    check(bytes() === before, 'file unchanged on encryption error')
    check(!fs.existsSync(file() + '.tmp'), 'no temporary plaintext file')
    check(!logs.join(' ').includes(replacement) && !String(caught).includes(replacement), 'failure redacted')
  })
  await run('S2 non-string defaultModel preserves plaintext migration', () => {
    const values = [7, null, {}]; const keys = values.map(() => key()); const data = fixture(keys)
    data.modelProfiles.forEach((p,i) => { p.models = []; p.defaultModel = values[i] })
    write(data); const store = new SettingsStore(); const loaded = store.get()
    check(loaded.modelProfiles.length === 3 && loaded.modelProfiles.every((p,i)=>p.apiKey === keys[i]), 'malformed model metadata retains keys')
    store.save({}); noPlain(bytes(), keys)
  })
  await run('E04b repeated saves reuse ciphertext', () => {
    const k=key(); const store=new SettingsStore(); store.save(fixture([k])); const before=disk().apiKeyEnc
    store.save({}); store.save({}); check(disk().apiKeyEnc===before, 'ciphertext reused without re-encryption')
    check(new SettingsStore().get().apiKey===k, 'repeat-save key roundtrip')
  })
  await run('E06b plaintext fallback emits one warning', () => {
    safeStorage.isEncryptionAvailable = () => false
    const logs = [], warn = console.warn, k = key()
    console.warn = (...args) => logs.push(args.join(' '))
    try {
      const store = new SettingsStore(); store.save(fixture([k])); store.get(); store.save({})
      check(disk().apiKey === k && disk().modelProfiles[0].apiKey === k, 'explicit fallback plaintext retained')
      check(!store.get().keyStorage.available, 'fallback status available to renderer')
      check(logs.length === 1 && !logs.join('').includes(k), 'single redacted warning')
    } finally { console.warn = warn }
  })
  await run('E02 E09 model consumer success and failure', async () => {
    const k=key(); new SettingsStore().save(fixture([k])); const settings=new SettingsStore().get()
    const { testModelConnection } = await bundleModule('key-consumer', 'export { testModelConnection } from ' + JSON.stringify(p('src/main/features/settings/modelTest.ts')))
    const fetch = globalThis.fetch, captured = [], logs = [], originals = {}
    for (const name of ['log','warn','error']) { originals[name]=console[name]; console[name]=(...args)=>logs.push(args.join(' ')) }
    try {
      globalThis.fetch = async (_url, init) => { captured.push(init.headers.Authorization === 'Bearer ' + k); return new Response(JSON.stringify({ choices:[{message:{content:'ok'}}] }), {status:200}) }
      const success=await testModelConnection(settings)
      globalThis.fetch = async (_url, init) => { captured.push(init.headers.Authorization === 'Bearer ' + k); return new Response('fixture denied', {status:401}) }
      const failure=await testModelConnection(settings)
      check(success.ok && !failure.ok && captured.every(Boolean) && captured.length === 2, 'decrypted key reaches model requests')
      check(!JSON.stringify([success,failure,logs]).includes(k), 'consumer success and failure output redacted')
    } finally {globalThis.fetch=fetch; for(const name of Object.keys(originals)) console[name]=originals[name]}
  })
  await run('R01 rollback all keys with encrypted backup', () => {
    const keys = [key(), key()]; new SettingsStore().save(fixture(keys)); const before = bytes(), data = disk()
    const restored = decryptSettings(data, safeStorage)
    check(restored.apiKey === keys[0] && restored.modelProfiles.every((p, i) => p.apiKey === keys[i]), 'pure rollback all keys')
    check(JSON.stringify(data) === JSON.stringify(disk()), 'pure rollback input immutable')
    const { backupPath } = rollbackFile(file(), safeStorage)
    check(fs.readFileSync(backupPath, 'utf8') === before, 'original backup exact')
    check(disk().apiKey === keys[0] && !disk().apiKeyEnc, 'rollback file restored')
  })
  await run('R02 rollback failure all or nothing', () => {
    new SettingsStore().save(fixture([key(), key()])); const data = disk()
    data.modelProfiles[1].apiKeyEnc = Buffer.from('broken-envelope').toString('base64'); write(data)
    const before = bytes(); let threw = false
    try { rollbackFile(file(), safeStorage) } catch { threw = true }
    check(threw && bytes() === before, 'failed rollback retains original')
    const backups = fs.readdirSync(dir).filter(n => n.includes('.encrypted-backup-'))
    check(backups.length === 1 && fs.readFileSync(path.join(dir, backups[0]), 'utf8') === before, 'failed rollback retains backup')
    check(!fs.readdirSync(dir).some(n => n.endsWith('.tmp')), 'failed rollback leaves no plaintext temp')
    let missing = false; try { rollbackFile('', safeStorage) } catch { missing = true }
    check(missing, 'explicit path required')
  })
} catch {
  failed++; console.error('FAIL test setup or module loading')
} finally {
  Module._resolveFilename = originalResolve
  fs.rmSync(root, { recursive: true, force: true })
}
console.log('Settings encryption: ' + passed + ' passed, ' + failed + ' failed')
if (failed) process.exitCode = 1
