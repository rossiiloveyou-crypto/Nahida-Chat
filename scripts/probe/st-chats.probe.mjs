#!/usr/bin/env node
/** Uses only a running probe-owned ST. No secrets or user source data are copied. */
import fs from 'node:fs'
import path from 'node:path'
import { ownedData, artifact, stamp, delay } from './st-env.probe.mjs'

const id = stamp()
const report = { probe: 'st-chats', at: new Date().toISOString(), requests: [], samples: [], failure: null }
let chatDir
let backupDir
let backupsBefore
let createdNames = []
let data
const listing = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
try {
  if (!process.env.NC_ST_PORT || !process.env.NC_ST_DATA) throw new Error('NC_ST_PORT and NC_ST_DATA are required')
  data = ownedData()
  const port = Number(process.env.NC_ST_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
  const base = 'http://127.0.0.1:' + port
  const cookies = new Map()
  let token = ''
  async function request(endpoint, method = 'GET', body) {
    const response = await fetch(base + endpoint, { method, headers: {
      Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { 'X-CSRF-Token': token } : {})
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0]
      const index = pair.indexOf('=')
      cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    const text = await response.text()
    // Store status/body shape, never cookie or token values.
    report.requests.push({ endpoint, method, status: response.status, ...(endpoint.startsWith('/api/') ? { response: text.slice(0, 500) } : {}) })
    return { status: response.status, text }
  }
  const home = await request('/')
  if (home.status !== 200) throw new Error('GET / returned ' + home.status)
  const csrf = await request('/csrf-token')
  if (csrf.status === 200) { try { token = JSON.parse(csrf.text).token } catch {} }
  if (!token && csrf.status === 404) token = home.text.match(/name=["']csrf-token["'][^>]*content=["']([^"']+)/i)?.[1]
  if (!token) throw new Error('CSRF token missing')
  report.csrf = { obtained: true, cookies: cookies.size }
  const getCharacters = await request('/api/characters/all')
  let charactersResponse = getCharacters
  if (getCharacters.status === 404) charactersResponse = await request('/api/characters/all', 'POST', {})
  if (charactersResponse.status !== 200) throw new Error('Character list HTTP ' + charactersResponse.status)
  const characters = JSON.parse(charactersResponse.text)
  const character = Array.isArray(characters) ? characters.find((item) => typeof item.avatar === 'string') : null
  if (!character) throw new Error('No existing character cards; no cards fabricated')
  const avatar = character.avatar
  if (path.basename(avatar) !== avatar) throw new Error('Unexpected avatar path')
  report.avatar = avatar
  report.characterCount = characters.length
  chatDir = path.join(data, 'default-user', 'chats', avatar.replace('.png', ''))
  backupDir = path.join(data, 'default-user', 'backups')
  report.directories = { chatDir, backupDir }
  const chatsBefore = listing(chatDir)
  backupsBefore = listing(backupDir)
  // Let ST create its own character chat directory through the native read endpoint.
  await request('/api/chats/get', 'POST', { avatar_url: avatar })
  async function save(label, chat, suffix = '') {
    const name = 'nc-probe-' + id + '-' + label + suffix
    const before = listing(chatDir)
    const result = await request('/api/chats/save', 'POST', { chat, file_name: name, avatar_url: avatar, force: true })
    console.log('save=http=' + result.status + ' label=' + label)
    const files = listing(chatDir).filter((file) => !before.includes(file))
    if (result.status !== 200 || files.length !== 1) throw new Error('Save did not produce exactly one new file: ' + JSON.stringify(files))
    const file = files[0]
    createdNames.push(file)
    const bytes = fs.readFileSync(path.join(chatDir, file))
    const lines = bytes.length ? bytes.toString('utf8').split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line)) : []
    const sample = { label, requested: name, file, bytes: bytes.length, messageInputs: chat.filter((item) => typeof item.is_user === 'boolean').length,
      lines: lines.length, meta_first: !!lines[0] && Object.hasOwn(lines[0], 'chat_metadata'),
      last_is_user: lines.at(-1)?.is_user ?? null, lastKeys: Object.keys(lines.at(-1) || {}), jsonl: lines }
    report.samples.push(sample)
    artifact('st-chats.' + id + '.' + label + '.jsonl', bytes)
    console.log('file=' + file + ' ' + JSON.stringify(sample))
    const deleted = await request('/api/chats/delete', 'POST', { chatfile: file, avatar_url: avatar })
    const after = listing(chatDir)
    const observation = { status: deleted.status, fileAbsent: !fs.existsSync(path.join(chatDir, file)), after }
    sample.deletion = observation
    console.log('delete=http=' + deleted.status + ' ' + JSON.stringify(observation))
    if (deleted.status !== 200 || !observation.fileAbsent) throw new Error('Delete failed')
    return sample
  }
  await save('empty', [])
  const messages = [{ name: 'Probe User', is_user: true, is_system: false, send_date: new Date().toISOString(), mes: 'nc-probe-user-' + id },
    { name: 'Probe Assistant', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'nc-probe-assistant-' + id }]
  // First measure the literal two-message payload; do not assume ST adds a header.
  const raw = await save('messages-only', messages)
  const header = { user_name: 'Probe User', character_name: character.name, create_date: new Date().toISOString(), chat_metadata: {} }
  const normal = await save('with-metadata', [header, ...messages], ':sanitize?')
  if (raw.lines !== messages.length || raw.meta_first || normal.lines !== messages.length + 1 || !normal.meta_first || normal.last_is_user !== false) {
    throw new Error('Observed jsonl differs from raw serialization contract')
  }
  report.metadataConclusion = 'The API serializes the supplied array verbatim; the caller supplies the metadata record.'
  // Native backups throttle per character (not per chat file). Observe trailing writes after delete.
  await delay(11000)
  report.backups = listing(backupDir).filter((file) => !backupsBefore.includes(file)).map((file) => ({ file,
    bytes: fs.statSync(path.join(backupDir, file)).size, relative: path.relative(path.join(data, 'default-user'), path.join(backupDir, file)) }))
  for (const item of report.backups) artifact('st-chats.' + id + '.backup.' + item.file, fs.readFileSync(path.join(backupDir, item.file)))
  report.backupsAfterDelete = report.backups.length
  report.before = { chats: chatsBefore, backups: backupsBefore }
  console.log('BACKUPS ' + JSON.stringify(report.backups))
} catch (error) { report.failure = error.message; process.exitCode = 1; console.error('FAIL ' + error.message) }
finally {
  try {
    if (chatDir && backupDir && backupsBefore) {
      // Only exact observed new paths inside this disposable, owned data root.
      for (const file of createdNames) if (file.startsWith('nc-probe-') && path.basename(file) === file) fs.rmSync(path.join(chatDir, file), { force: true })
      const newBackups = listing(backupDir).filter((file) => !backupsBefore.includes(file))
      for (const file of newBackups) if (file.startsWith('chat_') && file.endsWith('.jsonl')) fs.unlinkSync(path.join(backupDir, file))
      report.cleanup = { chats: listing(chatDir), backups: listing(backupDir), createdChatsAbsent: createdNames.every((file) => !fs.existsSync(path.join(chatDir, file))) }
      console.log('CLEANUP ' + JSON.stringify(report.cleanup))
    }
  } catch (error) { report.cleanupFailure = error.message; process.exitCode = 1 }
  const output = JSON.stringify(report, null, 2) + '\n'
  console.log('REPORT ' + artifact('st-chats.' + id + '.txt', output))
}
