#!/usr/bin/env node
/**
 * 判据机检脚本 · 硬编码色 / 令牌奇偶 / 未定义引用
 *
 * 对应文档：TASK-UI升级/PHASE-0-令牌化基线.md §4.3
 * 对应判据：总蓝图 D1 / D2 / D3；判据台账 J-01
 *
 * 用法（均输出单行 JSON，便于机器判定）：
 *   node scripts/theme/check-hardcoded-colors.mjs hardcoded
 *     -> {"count":N,"violations":[{line,selector,text}]}
 *   node scripts/theme/check-hardcoded-colors.mjs hardcoded --selftest
 *     -> {"selftest":{"expected":3,"actual":3,"ok":true,...}}   ← 防"正则写错却返回 0"
 *   node scripts/theme/check-hardcoded-colors.mjs parity
 *     -> {"status":"ok"|"not-implemented","light_count":48,"dark_count":0,...}
 *   node scripts/theme/check-hardcoded-colors.mjs unresolved
 *     -> {"missing":[{line,name,file}]}
 *
 * 三条口径（照 PHASE-0 §4.3，缺一不可）：
 *   1. 扫描面 = global.css，且 **跳过 .ui-grid* 选择器块**（J-01 豁免：量测工具不是 UI）；
 *   2. parity 在 dark 段不存在时返回 not-implemented，**绝不返回两个空数组冒充"两边相等"**（D33）；
 *   3. --selftest 喂一段已知含 3 处字面色的假 CSS，返回 0 就说明正则写错，不是"没有违规"（J-03）。
 *
 * 退出码：hardcoded 有违规 -> 1；--selftest 不达标 -> 1；unresolved 有缺 -> 1；
 *        parity 的 not-implemented 属 P0 的**正确状态** -> 0（P1 转真后才会出现 ok）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '../..');
const GLOBAL_CSS = resolve(PROJECT_ROOT, 'src/renderer/src/styles/global.css');
const TOKENS_CSS = resolve(PROJECT_ROOT, 'src/renderer/src/styles/tokens.css');

/** 字面色：3/4/6/8 位 hex，或 rgb(...)/rgba(...) */
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
/** 豁免前缀（J-01） */
const EXEMPT_PREFIX = '.ui-grid';

/**
 * J-09：与明暗无关的 9 个非颜色令牌。
 * 深色段**不复制**它们（复制相同值只会制造"两处都要改"的维护负担），
 * 所以 colors-only 口径的 parity 必须豁免。**写死，不靠命名规则猜**。
 */
const NON_COLOR = new Set([
  '--nc-radius-sm',
  '--nc-radius-md',
  '--nc-radius-lg',
  '--nc-radius-xl',
  '--nc-radius-pill',
  '--nc-font',
  '--nc-font-mono',
  '--nc-sidebar-width',
  '--nc-content-gutter',
]);
const isColor = (name) => !NON_COLOR.has(name);

/** 把注释替换成等长空白（保留换行，行号才不会漂） */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 逐字符走一遍 CSS，记录"每一行开始时所处的选择器栈"。
 * 这样每个字面色都能归到它真正所属的选择器块，且能识别 .ui-grid 豁免。
 * @returns {{selectors: string[], grids: boolean[]}} 下标为行号（1-based，0 位留空）
 */
function buildLineContext(src) {
  const lineTotal = src.split('\n').length;
  const selectors = new Array(lineTotal + 2).fill('(top-level)');
  const grids = new Array(lineTotal + 2).fill(false);
  const stack = [];
  let prelude = '';
  let line = 1;

  const isGrid = () => stack.some((s) => s.startsWith(EXEMPT_PREFIX));
  selectors[1] = '(top-level)';
  grids[1] = false;

  for (const ch of src) {
    if (ch === '\n') {
      line += 1;
      selectors[line] = stack.length ? stack[stack.length - 1] : '(top-level)';
      grids[line] = isGrid();
      continue; // 选择器可以跨行（A,\nB {），所以 prelude 不清空
    }
    if (ch === '{') {
      const head = prelude.trim();
      const first = head.split(',')[0].trim();
      // @media / @keyframes 之类不是选择器，但它们也不该被当成 .ui-grid 豁免
      stack.push(head.startsWith('@') ? '@' : first || '(anonymous)');
      prelude = '';
    } else if (ch === '}') {
      stack.pop();
      prelude = '';
    } else if (ch === ';') {
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return { selectors, grids };
}

/**
 * 扫描一段 CSS 的字面色。
 * @param {string} css
 * @param {{exemptSelectorPrefix?: string}} [opts]
 */
function scanHardcoded(css, opts = {}) {
  const exempt = opts.exemptSelectorPrefix ?? EXEMPT_PREFIX;
  const src = stripComments(css);
  const { selectors, grids } = buildLineContext(src);
  const lines = src.split('\n');
  const violations = [];

  lines.forEach((text, idx) => {
    const line = idx + 1;
    if (exempt && grids[line]) return; // J-01：量测工具层豁免
    const matches = text.match(COLOR_RE);
    if (!matches) return;
    for (const _ of matches) {
      violations.push({ line, selector: selectors[line] ?? '(unknown)', text: text.trim() });
    }
  });
  return violations;
}

/** 抽出某个选择器块（第一个匹配）里的令牌名 */
function tokensInBlock(css, selectorRe) {
  const src = stripComments(css);
  const m = src.match(selectorRe);
  if (!m) return null;
  // 取块内文本：从 '{' 到配对的 '}'
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

function tokenNames(block) {
  if (!block) return [];
  const out = new Set();
  for (const m of block.matchAll(/(--nc-[a-z0-9-]+)\s*:/g)) out.add(m[1]);
  return [...out].sort();
}

/** 所有 --nc-* 定义（含行号） */
function collectDefinitions(files) {
  const defs = new Map();
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    src.split('\n').forEach((text, idx) => {
      for (const m of text.matchAll(/(--nc-[a-z0-9-]+)\s*:/g)) {
        if (!defs.has(m[1])) defs.set(m[1], { name: m[1], file, line: idx + 1 });
      }
    });
  }
  return defs;
}

/** 所有 var(--nc-*) 引用（含行号） */
function collectReferences(files) {
  const refs = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    src.split('\n').forEach((text, idx) => {
      for (const m of text.matchAll(/var\(\s*(--nc-[a-z0-9-]+)/g)) {
        refs.push({ name: m[1], file, line: idx + 1 });
      }
    });
  }
  return refs;
}

function env(cssFile) {
  return { global: readFileSync(cssFile, 'utf8') };
}

// ---------------------------------------------------------------- 子命令

function cmdHardcoded() {
  const violations = scanHardcoded(env(GLOBAL_CSS).global);
  return {
    file: 'src/renderer/src/styles/global.css',
    scope: `非 ${EXEMPT_PREFIX}* 选择器块（J-01 豁免）`,
    count: violations.length,
    violations,
  };
}

/**
 * 防假绿自检（J-03）：喂一段**已知含 3 处字面色**的假 CSS。
 * 返回 0 = 正则写错了，不是"没有违规"。
 * 额外那条 .ui-grid 块是反向对照：它必须**不被计入**，否则豁免逻辑也错了。
 */
function cmdSelftest() {
  const fake = [
    '.a {',
    '  color: #fff;',
    '  background: rgba(1, 2, 3, 0.5);',
    '}',
    '.b {',
    '  border: 1px solid #ABCDEF;',
    '}',
    '.ui-grid__hint {',
    '  color: #123456;',
    '}',
  ].join('\n');
  const expected = 3;
  const actual = scanHardcoded(fake).length;
  const exemptOnly = scanHardcoded('.ui-grid__x {\n  color: #abcdef;\n}').length;
  const ok = actual === expected && exemptOnly === 0;
  return {
    selftest: {
      expected,
      actual,
      ok,
      exempt_block_counted: exemptOnly,
      note: 'expected=3 是"非 .ui-grid 块"的真违规数；exempt_block_counted 必须为 0',
    },
  };
}

function cmdParity() {
  const css = readFileSync(TOKENS_CSS, 'utf8');
  const light = tokenNames(tokensInBlock(css, /:root\s*\{/));
  const darkBlock = tokensInBlock(css, /\[data-theme\s*=\s*["']dark["']\]\s*\{/);
  if (darkBlock === null || darkBlock === undefined || darkBlock.length === 0) {
    // D33：输入为空时否定型判据毫无意义 —— 必须显式声明"没实现"，不能报两个空数组
    return {
      status: 'not-implemented',
      reason: 'tokens.css 中不存在 [data-theme="dark"] 段（P0 非目标：dark 段属 P1）',
      light_count: light.length,
      dark_count: 0,
      missing_dark: [],
      missing_light: [],
    };
  }
  // J-09：9 个非颜色令牌与明暗无关，深色段不复制，parity 必须豁免。
  // 豁免清单写死，不靠命名规则猜——renaming 一个令牌不该让它变成"非颜色"。
  const lightColors = light.filter(isColor);
  const darkColors = tokenNames(darkBlock).filter(isColor);
  const darkSet = new Set(darkColors);
  const lightSet = new Set(lightColors);
  return {
    status: 'ok',
    scope: 'colors-only（非颜色令牌已豁免，J-09）',
    light_count: light.length,
    dark_count: darkColors.length,
    light_colors: lightColors.length,
    dark_colors: darkColors.length,
    non_color_exempt: NON_COLOR.size,
    missing_dark: lightColors.filter((n) => !darkSet.has(n)),
    missing_light: darkColors.filter((n) => !lightSet.has(n)),
  };
}

function cmdUnresolved() {
  const files = [TOKENS_CSS, GLOBAL_CSS];
  const defs = collectDefinitions(files);
  const refs = collectReferences(files);
  const missing = [];
  const seen = new Set();
  for (const ref of refs) {
    if (defs.has(ref.name) || seen.has(ref.name)) continue;
    seen.add(ref.name);
    missing.push({
      line: ref.line,
      name: ref.name,
      file: ref.file.replace(PROJECT_ROOT, '').replace(/^[\\/]/, '').replace(/\\/g, '/'),
    });
  }
  return { missing };
}

// ---------------------------------------------------------------- CLI

const [cmd, ...rest] = process.argv.slice(2);
const emit = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(code);
};

switch (cmd) {
  case 'hardcoded': {
    if (rest.includes('--selftest')) {
      const out = cmdSelftest();
      emit(out, out.selftest.ok ? 0 : 1);
      break;
    }
    const out = cmdHardcoded();
    emit(out, out.count === 0 ? 0 : 1);
    break;
  }
  case 'parity':
    emit(cmdParity());
    break;
  case 'unresolved': {
    const out = cmdUnresolved();
    emit(out, out.missing.length === 0 ? 0 : 1);
    break;
  }
  default:
    emit({ error: 'unknown command', usage: ['hardcoded [--selftest]', 'parity', 'unresolved'] }, 2);
}
