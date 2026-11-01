#!/usr/bin/env node
/**
 * 判据机检脚本 · 双主题出图完整性（P3 的 A7）
 *
 * 对应文档：TASK-UI升级/PHASE-3-双主题出图与验收.md §4.2
 * 对应判据：总蓝图 D6；判据台账 J-12（主题回读）/ J-18（先归档再出图）
 *
 * 用法：node scripts/theme/check-ui-map.mjs
 *   -> 单行 JSON：
 *      {"fails":[],"counts":{"light":17,"dark":16},
 *       "grid":{"light":{"pass":8,"fail":0},"dark":{"pass":8,"fail":0}},
 *       "archive":{"latest":"20261031-174556","ok":true}}
 *
 * 三重口径（缺一不可）：
 *   1) 存在性：两套各 7 视图 ×（网格图 `ui-map-v0-<view>.png` + 无网格对照图
 *      `ui-clean-v0-<view>.png`）+ 主图 `ui-map-v0.png` + 坐标 `ui-map-v0.json`；
 *      深色另需 `UI_MAP.md`（G3：指回浅色表的短文件）。
 *   2) 像素级网格：调用全局 `verify-map.cjs`，凡出现 FAIL 行即计入 fails。
 *      **找不到该脚本也算 fail** —— 否则"没跑"会被静默当成"通过"（J-11）。
 *   3) 归档（J-18）：`docs/ui-archive/LATEST` 存在，且它指向的目录里
 *      light/dark 都至少有主图。出图是固定文件名原地覆盖，没有归档就没有可比对的历史。
 *
 * 退出码：fails 非空 -> 1。
 *
 * ⚠️ A48：视图名是**硬编码字符串**，新增视图必须同步这里的 VIEWS，
 *    否则新视图缺图不会被判失败。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

/** A48：与 scripts/ui/generate-ui-map.cjs 的视图清单保持同步 */
const VIEWS = [
  'chat-empty',
  'settings-models',
  'settings-prompts',
  'settings-memory',
  'settings-tools',
  'settings-appearance',
  'settings-about'
];

/** 全局出图自检脚本（像素级判网格）；可用环境变量覆盖 */
const VERIFY_MAP =
  process.env.UI_MAP_VERIFY || join(homedir(), '.dsh', 'agents-global', 'ui-map', 'verify-map.cjs');

const fails = [];
const counts = {};

function requireFile(dir, name) {
  const p = join(ROOT, dir, name);
  if (!existsSync(p)) fails.push(`${dir}/${name} 缺失`);
}

for (const dir of ['docs/ui', 'docs/ui-dark']) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) {
    fails.push(`${dir} 不存在`);
    continue;
  }
  const files = readdirSync(abs);
  counts[dir] = files.length;
  requireFile(dir, 'ui-map-v0.png');
  requireFile(dir, 'ui-map-v0.json');
  for (const v of VIEWS) {
    requireFile(dir, `ui-map-v0-${v}.png`);
    requireFile(dir, `ui-clean-v0-${v}.png`);
  }
  // G3：深色目录必须有对照表（指回 docs/ui/UI_MAP.md，避免两份表分叉，A55）
  if (dir === 'docs/ui-dark') requireFile(dir, 'UI_MAP.md');
}
requireFile('docs/ui', 'UI_MAP.md');

/** 像素级网格自检：解析 verify-map.cjs 的 PASS/FAIL 文本 */
const grid = {};
function runGrid(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(VERIFY_MAP)) {
    fails.push(`verify-map.cjs 未找到（${VERIFY_MAP}）：网格判据无法执行`);
    return null;
  }
  if (!existsSync(abs)) return null;
  const pngs = readdirSync(abs)
    .filter((f) => /^ui-map-v0(-.+)?\.png$/.test(f))
    .map((f) => join(abs, f));
  if (pngs.length === 0) return { pass: 0, fail: 0 };
  let out = '';
  try {
    out = execFileSync(process.execPath, [VERIFY_MAP, ...pngs], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const lines = out.split(/\r?\n/).filter(Boolean);
  const pass = lines.filter((l) => l.startsWith('PASS')).length;
  const bad = lines.filter((l) => l.startsWith('FAIL'));
  for (const l of bad) fails.push(`网格自检失败：${l}`);
  return { pass, fail: bad.length };
}
grid.light = runGrid('docs/ui');
grid.dark = runGrid('docs/ui-dark');

/** 归档判据（J-18） */
const archive = { latest: null, ok: false };
const latestFile = join(ROOT, 'docs/ui-archive/LATEST');
if (!existsSync(latestFile)) {
  fails.push('docs/ui-archive/LATEST 缺失：未先归档就出图（J-18）');
} else {
  archive.latest = readFileSync(latestFile, 'utf8').trim();
  const snap = join(ROOT, 'docs/ui-archive', archive.latest);
  const need = [
    join(snap, 'light/ui-map-v0.png'),
    join(snap, 'dark/ui-map-v0.png')
  ];
  const missing = need.filter((p) => !existsSync(p));
  if (archive.latest.length === 0 || missing.length > 0) {
    fails.push(`归档目录不完整：docs/ui-archive/${archive.latest}`);
  } else {
    archive.ok = true;
  }
}

console.log(JSON.stringify({ fails, counts, grid, archive }));
process.exit(fails.length === 0 ? 0 : 1);
