#!/usr/bin/env node
/**
 * 判据机检脚本 · WCAG 对比度
 *
 * 对应文档：TASK-UI升级/PHASE-0-令牌化基线.md §4.4
 * 对应判据：总蓝图 D7（P1 起成为闸门，见判据台账 J-02）
 *
 * 口径：
 *   - 输入 = tokens.css 解析出的令牌表（日间 :root；P1 之后附加 [data-theme="dark"]）；
 *   - 配对表**写死在脚本里**（前景 -> 背景），不做推断；
 *   - P0 阶段**只记录不判定**：现有 --nc-text-tertiary 仅 2.85、--nc-danger 4.36，
 *     本来就不达标（见 PHASE-0 §二 E6），此时判红没有意义，会逼人去改色 —— 那是 P1 的事。
 *     加 --gate 才按阈值退出非 0（P1 起在 CI 里用）。
 *
 * 用法：
 *   node scripts/theme/check-contrast.mjs                 # 记录模式，永远 exit 0
 *   node scripts/theme/check-contrast.mjs --gate          # 闸门模式，有 fail 则 exit 1
 *   node scripts/theme/check-contrast.mjs --theme dark     # 指定段（P1 之后可用）
 *
 * 输出：单行 JSON。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '../..');
const TOKENS_CSS = resolve(PROJECT_ROOT, 'src/renderer/src/styles/tokens.css');

/** AA 正文阈值 */
const AA_NORMAL = 4.5;
/** J-02：11px 小字与 placeholder 单列，允许 ≥3.5 但必须登记为残留 */
const AA_SMALL_REGISTERED = 3.5;

/**
 * 配对表（前景 -> 背景）。**写死，不做推断。**
 * 对应 PHASE-0 §4.4 的 8 组。
 * thresholdOverride：J-02 登记过的例外（仍是"未达标"，只是不当作 P0 的失败）。
 */
const PAIRS = [
  { fg: '--nc-text', bg: '--nc-canvas' },
  { fg: '--nc-text-secondary', bg: '--nc-canvas' },
  { fg: '--nc-text-tertiary', bg: '--nc-canvas', j02: true },
  { fg: '--nc-text', bg: '--nc-surface' },
  { fg: '--nc-text-secondary', bg: '--nc-surface' },
  { fg: '--nc-danger', bg: '--nc-canvas' },
  { fg: '--nc-on-accent', bg: '--nc-accent' },
  { fg: '--nc-warning', bg: '--nc-canvas' },
];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** 取某个选择器块的**第一层**内容 */
function blockOf(css, selectorRe) {
  const src = stripComments(css);
  const m = src.match(selectorRe);
  if (!m) return null;
  let depth = 0;
  let start = -1;
  for (let i = m.index; i < src.length; i += 1) {
    if (src[i] === '{') {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return src.slice(start);
}

/** 解析成 { '--nc-x': 'raw value' } */
function parseTokens(block) {
  const out = new Map();
  if (!block) return out;
  for (const m of block.matchAll(/(--nc-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/** #rgb / #rrggbb / #rrggbbaa -> {r,g,b,a} */
function parseColor(raw, label) {
  const v = String(raw).trim();
  const hex = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
        a: 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  const fn = v.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  throw new Error(`无法解析颜色 ${label}=${v}`);
}

/** alpha 合成：把 fg 叠在 bg 上 */
function composite(fg, bg) {
  if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b };
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

/** WCAG 2.x 相对亮度 */
function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const gate = argv.includes('--gate');
const themeArgIdx = argv.indexOf('--theme');
const theme = themeArgIdx >= 0 ? argv[themeArgIdx + 1] : 'light';

const css = readFileSync(TOKENS_CSS, 'utf8');
const rootBlock = blockOf(css, /:root\s*\{/);
const darkBlock = blockOf(css, /\[data-theme\s*=\s*["']dark["']\]\s*\{/);

const base = parseTokens(rootBlock);
const override = theme === 'dark' ? parseTokens(darkBlock) : new Map();

if (theme === 'dark' && !darkBlock) {
  process.stdout.write(
    `${JSON.stringify({ status: 'not-implemented', reason: 'tokens.css 中没有 [data-theme="dark"] 段（P0 非目标）' })}\n`,
  );
  process.exit(0);
}

const rows = [];
for (const pair of PAIRS) {
  const fgRaw = override.get(pair.fg) ?? base.get(pair.fg);
  const bgRaw = override.get(pair.bg) ?? base.get(pair.bg);
  if (fgRaw === undefined || bgRaw === undefined) {
    rows.push({ fg: pair.fg, bg: pair.bg, error: 'token 未定义' });
    continue;
  }
  const bg = composite(parseColor(bgRaw, pair.bg), { r: 255, g: 255, b: 255 });
  const fg = composite(parseColor(fgRaw, pair.fg), bg);
  const ratio = Number(contrast(fg, bg).toFixed(2));
  const threshold = pair.j02 ? AA_SMALL_REGISTERED : AA_NORMAL;
  rows.push({
    fg: pair.fg,
    bg: pair.bg,
    fg_value: fgRaw,
    bg_value: bgRaw,
    ratio,
    threshold,
    pass: ratio >= threshold,
    aa_pass: ratio >= AA_NORMAL,
    ...(pair.j02 ? { registered_residual: ratio < AA_NORMAL } : {}),
  });
}

const failed = rows.filter((r) => r.pass === false).length;
const out = {
  theme,
  mode: gate ? 'gate' : 'record-only',
  pairs: rows,
  summary: { total: rows.length, pass: rows.length - failed, fail: failed, aa_normal: AA_NORMAL },
  note: gate
    ? '闸门模式：fail > 0 时退出码 1（P1 起启用）'
    : 'P0 只记录不判定：--nc-text-tertiary 2.85 / --nc-danger 4.47 / --nc-on-accent-on-accent 3.87 本来就不达标，改进属 P1',
};

process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(gate && failed > 0 ? 1 : 0);
