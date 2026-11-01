#!/usr/bin/env node
/**
 * 出图逐像素对比（P3 的 G4「像素级抽查」判据）
 *
 * 用途：把「两个时间点的同一套图」或「浅色/深色同名图」做逐像素对比，
 * 输出差异像素数、占比、包围盒，并判断差异是否**全部落在已知动态区域内**。
 *
 * 为什么需要它：`docs/ui/*.png` 是固定文件名、每次原地覆盖（J-18），
 * 跨版本比对只能靠 `docs/ui-archive/<时间戳>/`；而差异里混着
 * 「真的改了样式」和「页面上的运行时长/时间戳自己在跳」（J-05）两类，肉眼分不开。
 *
 * 用法：
 *   node scripts/theme/diff-ui-png.mjs --a docs/ui --b docs/ui-archive/20261031-174556/light
 *   node scripts/theme/diff-ui-png.mjs --a docs/ui --b docs/ui-archive/20261031-174556/light --strict
 *   node scripts/theme/diff-ui-png.mjs --a docs/ui/ui-map-v0.png --b docs/ui-dark/ui-map-v0.png --pair
 *
 * 判据：
 *   - `--strict`：存在「掩膜外」差异像素 → exit 1（说明出现了布局/颜色变更，不是动态文字）
 *   - 不带 `--strict`：只报告，exit 0（用于记录/归档对比）
 *
 * 已知动态区域（J-05，1600×1075 内容区坐标）：秒级刷新的运行时长/状态文本框。
 * 深色另有品牌装饰动画（飘叶/星芒），本脚本把整块装饰带也列为可选掩膜 `--mask-anim`。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 极简 PNG 解码：只支持 8bit RGB/RGBA 非隔行（Electron 截图就是这种）。 */
function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit 位深，实际 ' + bitDepth)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null
  if (!channels) throw new Error('只支持 RGB/RGBA，colorType=' + colorType)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const dst = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? dst[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = src[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      dst[x] = v & 0xff
    }
  }
  return { width, height, channels, pixels }
}

/** J-05：三处秒级刷新的运行时长/状态文本框（x0,y0,x1,y1，像素） */
const MASKS_STATIC = [
  [1120, 438, 1210, 460], // settings-about 运行时长
  [1115, 367, 1205, 389], // settings-memory 时间戳
  [995, 303, 1095, 329] // settings-tools 状态
]

/** 品牌装饰动画带（飘叶在聊天区、星芒在空态区），只在对比 dark 时启用 */
const MASKS_ANIM = [
  [0, 0, 1600, 1075]
]

function parseArg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  if (hit) return hit.slice(name.length + 3)
  const idx = process.argv.indexOf('--' + name)
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1]
  return fallback
}

const A = parseArg('a')
const B = parseArg('b')
const PAIR = process.argv.includes('--pair')
const STRICT = process.argv.includes('--strict')
const USE_ANIM = process.argv.includes('--mask-anim')
const THRESHOLD = Number(parseArg('threshold', '0'))

if (!A || !B) {
  console.error('用法：node scripts/theme/diff-ui-png.mjs --a <图或目录> --b <图或目录> [--strict] [--pair] [--mask-anim]')
  process.exit(2)
}

const masks = USE_ANIM ? MASKS_STATIC.concat(MASKS_ANIM) : MASKS_STATIC
const inMask = (x, y) =>
  masks.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)

function listPairs() {
  if (PAIR) return [[A, B]]
  const files = fs
    .readdirSync(A)
    .filter((f) => f.endsWith('.png'))
    .sort()
  return files.map((f) => [path.join(A, f), path.join(B, f)])
}

function diffPair(pa, pb) {
  if (!fs.existsSync(pb)) return { file: path.basename(pa), status: 'missing_on_right' }
  const ia = decodePng(fs.readFileSync(pa))
  const ib = decodePng(fs.readFileSync(pb))
  if (ia.width !== ib.width || ia.height !== ib.height)
    return {
      file: path.basename(pa),
      status: 'size_mismatch',
      a: `${ia.width}x${ia.height}`,
      b: `${ib.width}x${ib.height}`
    }

  let diff = 0
  let outside = 0
  let maxChannel = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < ia.height; y += 1) {
    for (let x = 0; x < ia.width; x += 1) {
      const oa = (y * ia.width + x) * ia.channels
      const ob = (y * ib.width + x) * ib.channels
      let d = 0
      for (let ch = 0; ch < Math.min(ia.channels, ib.channels); ch += 1) {
        const dv = Math.abs(ia.pixels[oa + ch] - ib.pixels[ob + ch])
        if (dv > d) d = dv
      }
      if (d > THRESHOLD) {
        diff += 1
        if (d > maxChannel) maxChannel = d
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
        if (!inMask(x, y)) outside += 1
      }
    }
  }
  const total = ia.width * ia.height
  return {
    file: path.basename(pa),
    status: 'ok',
    size: `${ia.width}x${ia.height}`,
    diff,
    ratio: Number(((diff / total) * 100).toFixed(4)),
    outside_mask: outside,
    max_channel_delta: maxChannel,
    bbox: diff > 0 ? [x0, y0, x1, y1] : null
  }
}

const results = listPairs().map(([pa, pb]) => diffPair(pa, pb))
const violations = results.filter((r) => r.status !== 'ok' || r.outside_mask > 0)

console.log(
  JSON.stringify(
    {
      a: A,
      b: B,
      threshold: THRESHOLD,
      masks: USE_ANIM ? 'static+anim' : 'static',
      files: results,
      summary: {
        compared: results.length,
        identical: results.filter((r) => r.status === 'ok' && r.diff === 0).length,
        differ_only_in_mask: results.filter((r) => r.status === 'ok' && r.diff > 0 && r.outside_mask === 0).length,
        violations: violations.map((r) => ({ file: r.file, status: r.status, outside_mask: r.outside_mask ?? null }))
      }
    },
    null,
    2
  )
)
process.exit(STRICT && violations.length > 0 ? 1 : 0)
