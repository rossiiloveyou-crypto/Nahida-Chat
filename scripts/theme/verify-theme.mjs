#!/usr/bin/env node
/**
 * 双主题一键验收（P3 的 G2）
 *
 * 对应文档：TASK-UI升级/PHASE-3-双主题出图与验收.md §4.2 / §六 A1
 * 对应判据：总蓝图 D1 / D2 / D3 / D6 / D7；判据台账 J-09（colors-only）/ J-11（每次重核）/ J-18（先归档）
 *
 * 用法：
 *   node scripts/theme/verify-theme.mjs            # 跑 7 项，任一失败 exit 1
 *   node scripts/theme/verify-theme.mjs --json     # 只输出单行 JSON（给 CI / 上层脚本用）
 *
 * 为什么要把判据固化成一条命令：验收原本靠人记 6–7 条命令，
 * P0/P1/P2 各出现过一次"差点漏跑"，而漏跑一条就是假绿。
 *
 * 7 项判据：
 *   A1 零字面色      check-hardcoded-colors.mjs hardcoded      -> count === 0
 *   A2 脚本自检      ... hardcoded --selftest                  -> selftest.ok === true
 *   A3 令牌双向差集  ... parity                                -> status ok 且两向空（colors-only，J-09）
 *   A4 无未定义引用  ... unresolved                            -> missing.length === 0
 *   A5 浅色对比度闸门 check-contrast.mjs --gate                 -> summary.fail === 0
 *   A6 深色对比度闸门 check-contrast.mjs --theme dark --gate    -> summary.fail === 0
 *   A7 出图完整性    check-ui-map.mjs                           -> fails.length === 0（含像素网格 + 归档）
 *
 * 退出码：失败 0 项 -> 0；否则 1。
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const JSON_ONLY = process.argv.includes('--json');

const NODE = process.execPath;

/** 每项：name / args / expect(parsed) / why（失败时打印的人话） */
const checks = [
  {
    name: 'A1 零字面色',
    args: ['scripts/theme/check-hardcoded-colors.mjs', 'hardcoded'],
    expect: (o) => o.count === 0,
    why: 'global.css 非 .ui-grid 选择器块里出现了字面色值'
  },
  {
    name: 'A2 脚本自检',
    args: ['scripts/theme/check-hardcoded-colors.mjs', 'hardcoded', '--selftest'],
    expect: (o) => o.selftest?.ok === true,
    why: '喂入已知含 3 处字面色的假 CSS 未检出 → 正则失效，A1 的 0 不可信（J-03）'
  },
  {
    name: 'A3 令牌双向差集',
    args: ['scripts/theme/check-hardcoded-colors.mjs', 'parity'],
    expect: (o) => o.status === 'ok' && o.missing_dark.length === 0 && o.missing_light.length === 0,
    why: '日间/夜间颜色令牌集合不相等（colors-only 口径，J-09）'
  },
  {
    name: 'A4 无未定义引用',
    args: ['scripts/theme/check-hardcoded-colors.mjs', 'unresolved'],
    expect: (o) => o.missing.length === 0,
    why: '有 var(--nc-*) 引用了不存在的令牌 → 该处样式静默失效'
  },
  {
    name: 'A5 浅色对比度闸门',
    args: ['scripts/theme/check-contrast.mjs', '--gate'],
    expect: (o) => o.summary?.fail === 0,
    why: '浅色下有配伍低于阈值（正文/次要 4.5，11px 小字 3.5，J-10）'
  },
  {
    name: 'A6 深色对比度闸门',
    args: ['scripts/theme/check-contrast.mjs', '--theme', 'dark', '--gate'],
    expect: (o) => o.summary?.fail === 0,
    why: '深色下有配伍低于阈值'
  },
  {
    name: 'A7 出图完整性',
    args: ['scripts/theme/check-ui-map.mjs'],
    expect: (o) => o.fails.length === 0,
    why: '两套出图缺文件 / 网格没画进 PNG / 未归档（J-18）'
  }
];

const results = [];
for (const c of checks) {
  const t0 = Date.now();
  let ok = false;
  let detail = '';
  try {
    const out = execFileSync(NODE, c.args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    });
    const parsed = JSON.parse(String(out).trim().split(/\r?\n/).pop());
    ok = c.expect(parsed) === true;
    if (!ok) detail = c.why;
  } catch (e) {
    detail = `执行失败（exit ${e.status ?? '?'}）：${String(e.stdout ?? e.message).trim().slice(0, 300)}`;
  }
  results.push({ name: c.name, ok, ms: Date.now() - t0, detail });
  if (!JSON_ONLY) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (${results[results.length - 1].ms}ms)`);
    if (detail) console.log(`      ↳ ${detail}`);
  }
}

const failed = results.filter((r) => !r.ok);
if (JSON_ONLY) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }));
} else {
  console.log(
    failed.length === 0
      ? `\n全部通过（${results.length} 项，${results.reduce((s, r) => s + r.ms, 0)}ms）`
      : `\n失败 ${failed.length} 项：${failed.map((r) => r.name).join(', ')}`
  );
}
process.exit(failed.length === 0 ? 0 : 1);
