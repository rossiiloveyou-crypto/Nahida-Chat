#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { startSt, artifact, stamp, stripAnsi, BASELINE } from './st-env.probe.mjs'

const id = stamp()
fs.mkdirSync(BASELINE, { recursive: true })
const rawPath = path.join(BASELINE, 'st-log.' + id + '.raw.txt')
const raw = fs.openSync(rawPath, 'wx')
const descriptors = Object.fromEntries(['out', 'err'].map((stream) => [stream, fs.openSync(path.join(BASELINE, 'st-log.' + id + '.' + stream + '.raw.txt'), 'wx')]))
const chunks = []
let state
let failure
try {
  state = await startSt({ onChunk: (item) => {
    fs.writeSync(raw, item.bytes)
    fs.writeSync(descriptors[item.stream], item.bytes)
    chunks.push(item)
  } })
  const goRaw = state.text.out.split(/\r?\n/).find((line) => stripAnsi(line).includes('Go to:'))
  console.log('LOG ' + JSON.stringify({ rawPath, timings: state.timings, goToRaw: goRaw, goToPlain: stripAnsi(goRaw || '') }))
  if (process.argv.includes('--serve')) await state.hold(Number(process.env.NC_ST_HOLD_MS || 600000))
} catch (error) { failure = error.message; console.error('FAIL ' + failure); process.exitCode = 1 }
finally {
  try { if (state) await state.close() } catch (error) { failure = error.message; console.error('FAIL ' + failure); process.exitCode = 1 }
  fs.closeSync(raw)
  Object.values(descriptors).forEach((fd) => fs.closeSync(fd))
  const escape = (text) => text.replace(/\x1b/g, '\\x1b').replace(/\r/g, '\\r')
  const decoded = Object.fromEntries(['out', 'err'].map((stream) => [stream, Buffer.concat(chunks.filter((item) => item.stream === stream).map((item) => item.bytes)).toString('utf8')]))
  artifact('st-log.' + id + '.esc.txt', Object.entries(decoded).map(([stream, text]) => text.split('\n').map((line) => '<' + stream + '>|' + escape(line)).join('\n')).join('\n'))
  artifact('st-log.' + id + '.plain.txt', Object.entries(decoded).map(([stream, text]) => text.split('\n').map((line) => '<' + stream + '>|' + stripAnsi(line)).join('\n')).join('\n'))
  const goRaw = decoded.out.split(/\r?\n/).find((line) => stripAnsi(line).includes('Go to:'))
  artifact('st-log.' + id + '.json', JSON.stringify({ failure, timings: state?.timings, data: state?.data, port: state?.port,
    goToRaw: goRaw, goToPlain: stripAnsi(goRaw || ''), ansiPresent: /\x1b\[/.test(decoded.out),
    byteCounts: Object.fromEntries(['out', 'err'].map((stream) => [stream, fs.statSync(path.join(BASELINE, 'st-log.' + id + '.' + stream + '.raw.txt')).size])),
    chunks: chunks.map((item) => ({ stream: item.stream, ms: item.ms, bytes: item.bytes.length })) }, null, 2) + '\n')
}
