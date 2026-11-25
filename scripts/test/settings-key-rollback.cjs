/** Run with Electron: electron scripts/test/settings-key-rollback.cjs <explicit-settings.json>
 * The output intentionally restores plaintext for an older application. Keep the backup protected.
 * Requiring this module neither loads Electron nor locates any user configuration.
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

/** Pure transformation: no mutation, filesystem access, Electron startup or logging. */
function decryptSettings(value, safeStorage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings document')
  const result = JSON.parse(JSON.stringify(value))
  const holders = [result, ...(Array.isArray(result.modelProfiles) ? result.modelProfiles : [])]
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object' || !Object.hasOwn(holder, 'apiKeyEnc')) continue
    const encoded = holder.apiKeyEnc
    if (typeof encoded !== 'string' || !encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('Invalid encrypted key')
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Key storage unavailable')
    try {
      const decoded = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      if (typeof decoded !== 'string') throw new Error('Invalid decrypted key')
      holder.apiKey = decoded
    } catch {
      throw new Error('Key decryption failed; original settings retained')
    }
    delete holder.apiKeyEnc
    delete holder.apiKeyUnavailable
  }
  delete result.keyStorage
  return result
}

/** Explicit path only. Backup precedes decryption; original is replaced only after all keys succeed. */
function rollbackFile(settingsPath, safeStorage) {
  if (typeof settingsPath !== 'string' || !settingsPath.trim()) throw new Error('Explicit settings.json path required')
  const target = path.resolve(settingsPath)
  if (path.basename(target).toLowerCase() !== 'settings.json') throw new Error('Expected settings.json path')
  if (!fs.lstatSync(target).isFile()) throw new Error('Expected regular settings file')
  const original = fs.readFileSync(target)
  const parsed = JSON.parse(original.toString('utf8'))
  const backupPath = target + '.encrypted-backup-' + randomUUID() + '.bak'
  fs.writeFileSync(backupPath, original, { flag: 'wx', mode: 0o600 })
  const restored = decryptSettings(parsed, safeStorage)
  const temp = target + '.rollback-' + randomUUID() + '.tmp'
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(restored, null, 2) + '\n', 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, target)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
  return { backupPath }
}

module.exports = { decryptSettings, rollbackFile }

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !args[0].trim()) {
    console.error('Usage: electron scripts/test/settings-key-rollback.cjs <explicit-settings.json>')
    process.exitCode = 1
    const electron = require('electron')
    if (electron.app) electron.app.quit()
  } else {
    const { app, safeStorage } = require('electron')
    if (!app || !safeStorage) {
      console.error('Run this script with Electron, not Node')
      process.exitCode = 1
    } else {
      app.whenReady().then(() => {
        rollbackFile(args[0], safeStorage)
        console.log('Rollback complete; encrypted original backup retained beside settings.json')
      }).catch(() => {
        console.error('Rollback failed; original settings retained. Check path, permissions and OS key storage.')
        process.exitCode = 1
      }).finally(() => app.quit())
    }
  }
}
