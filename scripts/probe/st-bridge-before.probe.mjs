#!/usr/bin/env node
/** Environment adapter only. The production driver and original assertions remain untouched. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ownedData, stamp, BASELINE, PROJECT, stopTree, artifact } from './st-env.probe.mjs'
import { createHash } from 'node:crypto'

let exitCode = 1
try {
  if (!process.env.NC_ST_PORT || (!process.env.NC_ST_DATA && !process.env.NC_PROBE_FIXTURE_DIR)) throw new Error('NC_ST_PORT and owned NC_ST_DATA or NC_PROBE_FIXTURE_DIR are required')
  const fixtureDir = process.env.NC_PROBE_FIXTURE_DIR ? path.resolve(process.env.NC_PROBE_FIXTURE_DIR) : null
  const data = ownedData(process.env.NC_ST_DATA || (fixtureDir ? path.dirname(fixtureDir) : undefined))
  if (fixtureDir && fixtureDir !== path.join(data, 'default-user')) throw new Error('Fixture directory must be owned data/default-user')
  const port = Number(process.env.NC_ST_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
  const env = { ...process.env, NC_PROBE_ST_URL: 'http://127.0.0.1:' + port,
    NC_PROBE_ST_DATA: path.join(data, 'default-user'), NC_PROBE_ROUNDS: '3', NC_PROBE_BASELINE_DIR: BASELINE }
  delete env.ELECTRON_RUN_AS_NODE
  fs.mkdirSync(BASELINE, { recursive: true })
  const file = path.join(BASELINE, 'bridge-rounds.' + stamp() + '.before.txt')
  const fd = fs.openSync(file, 'wx')
  const stdout = []
  const fixtureArtifact = process.env.NC_PROBE_FIXTURE_ARTIFACT || null
  const fixture = fixtureArtifact ? JSON.parse(fs.readFileSync(fixtureArtifact, 'utf8')) : null
  if (fixture && path.resolve(fixture.data) !== data) throw new Error('Fixture evidence belongs to different data root')
  const child = spawn(process.execPath, [path.join(PROJECT, 'scripts/probe/bridge-rounds.probe.mjs')], {
    cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let timer
  let timedOut = false
  let timerFailure
  let spawnError
  const signal = () => { stopTree(child).catch((error) => { console.error(error.message); process.exitCode = 1 }) }
  process.once('SIGINT', signal)
  process.once('SIGTERM', signal)
  try {
    child.stdout.on('data', (bytes) => { stdout.push(Buffer.from(bytes)); fs.writeSync(fd, bytes); process.stdout.write(bytes) })
    child.stderr.on('data', (bytes) => { fs.writeSync(fd, bytes); process.stderr.write(bytes) })
    timer = setTimeout(() => { timedOut = true; stopTree(child).catch((error) => { timerFailure = error.message }) }, Number(process.env.NC_ST_BEFORE_TIMEOUT_MS || 660000))
    const result = await new Promise((resolve) => {
      child.once('error', (error) => { spawnError = error.message })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    exitCode = timedOut ? 124 : result.code ?? 1
    let report = null
    try { report = JSON.parse(Buffer.concat(stdout).toString('utf8')) } catch {}
    const digest = target => createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    const manifest = { file, sha256: digest(file), bytes: fs.statSync(file).size, ...result, timedOut, timerFailure, spawnError,
      fixtureArtifact, fixtureSha256: fixtureArtifact ? digest(fixtureArtifact) : null,
      fixtureClosedArtifact: fixture ? path.join(BASELINE, 'st-fixture.' + fixture.id + '.closed.json') : null,
      stLogArtifact: fixture ? path.join(BASELINE, 'st-log.' + fixture.id + '.fixture.json') : process.env.NC_PROBE_ST_LOG_ARTIFACT || null,
      stData: env.NC_PROBE_ST_DATA, rounds: report?.rounds?.length ?? null,
      assertions: report?.assertions ?? null, health: report?.health ?? null }
    const manifestFile = artifact(path.basename(file).replace('.before.txt', '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    console.error('BEFORE ' + JSON.stringify({ file, manifestFile, ...result, timedOut, timerFailure, spawnError, bytes: fs.statSync(file).size }))
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', signal)
    process.removeListener('SIGTERM', signal)
    fs.closeSync(fd)
  }
} catch (error) { console.error('FAIL ' + error.message) }
process.exitCode = exitCode
