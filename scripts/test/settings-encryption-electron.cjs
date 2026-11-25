// Isolated OS-key-store integration probe. Never opens the user's configuration.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-key-native-'))
app.setPath('userData', root)
app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS key store unavailable: native probe not verified')
  const { loadEsbuild, projectRoot } = await import('./qq-test-util.mjs')
  const output = path.join(root, 'store.cjs')
  await loadEsbuild().build({ entryPoints:[path.join(projectRoot,'src/main/features/settings/settingsStore.ts')], outfile:output,
    bundle:true, platform:'node',format:'cjs',external:['electron'],alias:{'@shared':path.join(projectRoot,'src/shared')},logLevel:'silent' })
  const { SettingsStore } = require(output)
  const key=randomBytes(32).toString('hex')
  const store=new SettingsStore()
  const value=store.get()
  value.modelProfiles[0].apiKey=key
  store.save(value)
  const file=path.join(root,'settings.json')
  const raw=fs.readFileSync(file,'utf8')
  if(raw.includes(key)||Object.hasOwn(JSON.parse(raw),'apiKey')) throw new Error('Native encryption assertion failed')
  if(new SettingsStore().get().apiKey!==key) throw new Error('Native reload assertion failed')
  const { rollbackFile }=require('./settings-key-rollback.cjs')
  rollbackFile(file,safeStorage)
  if(JSON.parse(fs.readFileSync(file,'utf8')).apiKey!==key) throw new Error('Native rollback assertion failed')
  console.log('PASS native safeStorage: encrypted disk, reload, same-user rollback (3/3)')
}).catch(() => {console.error('FAIL native safeStorage isolated probe');process.exitCode=1})
.finally(()=>{
  // Electron still owns userData handles until quit; remove our synthetic secret artifacts first.
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('settings.json') || name === 'store.cjs') fs.rmSync(path.join(root,name), {force:true})
  }
  app.quit()
})
