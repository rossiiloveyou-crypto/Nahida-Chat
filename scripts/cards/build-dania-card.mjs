#!/usr/bin/env node
/** P3 lossless mechanical mapping; importing this module performs no I/O.
 * buildDaniaCard({ sourceCard, soul, quotes, storyMode, storyStyle, tone,
 *   worldbooks: { 'world.md': string, 'characters.md': string, ... } }) -> V2 card.
 * Worldbook content retains source headings, metadata, preambles and separators.
 * Concatenating entries for each ncFile reproduces its source byte-for-byte.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORLDBOOK_FILES = Object.freeze(['world.md', 'characters.md', 'story.md', 'dania.md']);
export const MINIMUM_UTF8_BYTES = Object.freeze({ description: 10000, mes_example: 8000, worldbook: 75800 });
const COUNTS = [29, 21, 12, 12];
const need = (ok, message) => { if (!ok) throw new Error(message); };
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** characters = Unicode code points; JS length is reported separately. */
export function measureText(text) {
  need(typeof text === 'string', 'Expected source text');
  return { utf8Bytes: Buffer.byteLength(text, 'utf8'), characters: [...text].length, utf16CodeUnits: text.length };
}

export function parseWorldbook(text, file) {
  const headings = [...text.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  need(headings.length, file + ': no level-two entries');
  return headings.map((h, index) => {
    const end = headings[index + 1]?.index ?? text.length;
    const section = text.slice(h.index, end);
    const block = section.match(/^## [^\n]+\n((?:- (?:id|触发词|常驻|优先级|内在价值|连带触发词):[^\n]*(?:\n|$))+)/);
    need(block, file + ': missing metadata: ' + h[1]);
    const meta = {};
    for (const line of block[1].split(/\r?\n/)) {
      const m = line.match(/^- ([^:]+):\s*(.*?)\s*$/);
      if (m) meta[m[1]] = m[2];
    }
    for (const key of ['id', '触发词', '常驻', '优先级', '内在价值', '连带触发词']) need(meta[key] !== undefined, file + ': missing ' + key);
    const words = s => s === '无' ? [] : s.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
    const body = section.slice(block[0].length).replace(/^\r?\n/, '').replace(/(?:\r?\n)+---\s*$/, '').trim();
    need(body.length && Number.isFinite(Number(meta['优先级'])) && Number.isFinite(Number(meta['内在价值'])), file + ': invalid entry');
    return { title: h[1], file, ncId: meta.id, body,
      keys: [...new Set([h[1], ...words(meta['触发词']), ...words(meta['连带触发词'])])],
      constant: meta['常驻'] === '是', priority: Number(meta['优先级']), value: Number(meta['内在价值']),
      content: text.slice(index === 0 ? 0 : h.index, end) };
  });
}

/** Keep every source line, including comments and framing prose. Wrap only quote
 * lines. The user label is the existing subsection, never invented dialogue. */
export function convertQuotes(text) {
  let heading = '', count = 0;
  const result = text.replace(/[^\n]*(?:\n|$)/g, line => {
    const m = line.match(/^### ([^\r\n]+)/);
    if (m) heading = m[1];
    if (!/^- 「[^\r\n]*」\r?(?:\n)?$/.test(line)) return line;
    need(heading, 'Quote lacks authored subsection'); count++;
    return '<START>\n{{user}}: ' + heading + '\n{{char}}: ' + line;
  });
  need(count, 'No quote examples'); return result;
}
export function restoreQuotes(text) {
  return text.replace(/<START>\n\{\{user\}\}: [^\n]*\n\{\{char\}\}: (- 「[^\r\n]*」\r?(?:\n|$))/g, '$1');
}
export function extractPersonality(soul) {
  const headings = [...soul.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  return headings.flatMap((h, i) => /性格|气质/.test(h[1]) ? [soul.slice(h.index, headings[i + 1]?.index ?? soul.length)] : []).join('');
}

/** M25 literal deletions and necessary cross-reference repairs, all recorded. */
export function buildStoryRules(storyMode, storyStyle, tone, identity) {
  const removals = [], adjustments = [];
  const remove = (text, source, literal) => {
    need(text.includes(literal), source + ': expected length clause missing');
    removals.push({ source, removed: literal }); return text.replace(literal, '');
  };
  let style = remove(storyStyle, 'styles/story.md', '篇幅按下文「最高优先级 · 边界」执行。');
  style = remove(style, 'styles/story.md', '正文 200～400 字，超过 450 字就删到 450 以内。');
  style = remove(style, 'styles/story.md', '或「把篇幅写到 800～1000 字」');
  for (const [from, to] of [['忽略那两条', '忽略该条'], ['上面四条', '上面三条']]) {
    need(style.includes(from), 'Missing cross-reference');
    style = style.replace(from, to); adjustments.push({ source: 'styles/story.md', from, to });
  }
  const cleanTone = remove(tone, 'shared/tone.md', '（8～25 字）');
  const at = style.indexOf('## 最高优先级 · 边界');
  need(at >= 0, 'Missing boundary section');
  const boundary = style.slice(at);
  const singleAction = boundary.match(/^- \*\*篇幅\*\*：[^\r\n]*(?:\r?\n|$)/m)?.[0];
  need(singleAction, 'Missing single-action rule');
  const systemPrompt = [identity, storyMode, boundary.replace(singleAction, '')].join('\n\n');
  const postHistory = [style.slice(0, at), singleAction, cleanTone].join('\n\n');
  const boundaryEvidence = ['只演妲妮娅', '不代演用户', '不推进剧情'].map(marker => {
    const original = storyStyle.split(/\r?\n/).find(line => line.includes('**' + marker + '**'));
    need(original && systemPrompt.includes(original), 'Authored boundary changed: ' + marker);
    return { marker, original };
  });
  return { systemPrompt, postHistory, removals, adjustments, boundaryEvidence };
}

export function buildDaniaCard(assets) {
  const { sourceCard, soul, quotes, storyMode, storyStyle, tone, worldbooks } = assets;
  need(sourceCard?.spec === 'chara_card_v2' && sourceCard.data, 'Expected original V2 card');
  const originals = sourceCard.data.character_book.entries;
  const notes = originals.filter(e => e.extensions?.ncId === 'st-conversion-note');
  need(notes.length === 1, 'Expected one original author note');
  const sections = WORLDBOOK_FILES.flatMap((file, i) => {
    const parsed = parseWorldbook(worldbooks[file], file);
    need(parsed.length === COUNTS[i], file + ': unexpected entry count'); return parsed;
  });
  need(new Set(sections.map(s => s.ncId)).size === 74, 'Duplicate source IDs');
  const entries = sections.map((s, i) => {
    const matches = originals.filter(e => e.extensions?.ncId === s.ncId);
    need(matches.length === 1, 'Original entry missing/ambiguous: ' + s.ncId);
    const e = clone(matches[0]);
    Object.assign(e, { id: i, name: s.title, comment: s.title, content: s.content, keys: s.keys,
      constant: s.constant, priority: s.priority, insertion_order: s.priority * 10 });
    e.extensions = { ...e.extensions, ncId: s.ncId, ncFile: s.file, ncPriority: s.priority, ncValue: s.value };
    return e;
  });
  entries.push(clone(notes[0]));
  const identity = sourceCard.data.system_prompt.split(/\r?\n/)[0];
  need(identity.includes('你此刻就是妲妮娅本人'), 'Original identity declaration missing');
  const rules = buildStoryRules(storyMode, storyStyle, tone, identity);
  const card = clone(sourceCard), d = card.data;
  Object.assign(d, { name: '妲妮娅', description: soul, personality: extractPersonality(soul),
    mes_example: convertQuotes(quotes), system_prompt: rules.systemPrompt, post_history_instructions: rules.postHistory });
  Object.assign(d.character_book, { entries, scan_depth: 4, token_budget: 8192 });
  d.character_book.extensions.entryCount = 75;
  d.creator_notes = [
    'P3 story 机械重建；由 scripts/cards/build-dania-card.mjs 生成。',
    'soul.md 全文；canon/quotes.md 全文可逆 START 映射；modes/story.md、styles/story.md、shared/tone.md 按 M25 去除篇幅数字规则。',
    '世界书74源条目保留标题、元数据、正文、前言、分隔符，逐文件连接还原源文；第75作者备注沿用原卡。',
    'scenario / first_mes / alternate_greetings 保留原卡；篇幅由 ST 预设决定。',
  ].join('\n');
  const texts = { 'soul.md': soul, 'canon/quotes.md': quotes, 'modes/story.md': storyMode,
    'styles/story.md': storyStyle, 'shared/tone.md': tone,
    ...Object.fromEntries(WORLDBOOK_FILES.map(file => ['worldbook/' + file, worldbooks[file]])) };
  d.extensions.dania_story_build = { version: 1, contentMapping: 'lossless-source-sections',
    measurements: 'utf8Bytes=Buffer.byteLength(utf8); characters=Unicode code points; utf16CodeUnits=JS length',
    sourceFiles: Object.fromEntries(Object.entries(texts).map(([file, text]) => [file, measureText(text)])),
    removedLengthClauses: rules.removals, crossReferenceAdjustments: rules.adjustments, boundaryEvidence: rules.boundaryEvidence };
  for (const key of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) card[key] = d[key];
  card.creatorcomment = d.creator_notes;
  return card;
}
export function serializeCard(card) { return JSON.stringify(card, null, 2) + '\n'; }

/** Pure checks: exact source equality AND independently named byte thresholds. */
export function checkDaniaCard(card, assets) {
  const errors = [], assert = (ok, message) => { if (!ok) errors.push(message); };
  const d = card?.data;
  if (!d || !Array.isArray(d.character_book?.entries)) return { ok: false, errors: ['Malformed card'], stats: {} };
  const entries = d.character_book.entries;
  const sourceWorldbooks = WORLDBOOK_FILES.map(file => ({ file, ...measureText(assets.worldbooks[file]) }));
  const sourceBodyOnly = WORLDBOOK_FILES.map(file => {
    const parsed = parseWorldbook(assets.worldbooks[file], file);
    return { file, entries: parsed.length, ...measureText(parsed.map(s => s.body).join('')) };
  });
  for (const file of WORLDBOOK_FILES) assert(entries.filter(e => e.extensions?.ncFile === file).map(e => e.content).join('') === assets.worldbooks[file], file + ': exact source reconstruction failed');
  assert(entries.length === 75, 'Expected 75 book entries');
  assert(d.description === assets.soul, 'soul.md changed');
  assert(restoreQuotes(d.mes_example) === assets.quotes, 'quotes.md round-trip failed');
  assert(d.system_prompt.includes(assets.storyMode), 'story mode not preserved');
  for (const word of ['只演', '不代演', '不推进']) assert(d.system_prompt.includes(word), 'Missing boundary: ' + word);
  assert(!/[0-9０-９]+\s*(?:[～~–—-]\s*[0-9０-９]+)?\s*字/.test(d.system_prompt + '\n' + d.post_history_instructions), 'Numeric length rule remains');
  for (const key of ['scenario', 'first_mes', 'alternate_greetings']) assert(same(d[key], assets.sourceCard.data[key]), 'Greeting changed: ' + key);
  const description = measureText(d.description), examples = measureText(d.mes_example);
  const worldbook = measureText(entries.map(e => e.content).join(''));
  const sourceBytes = sourceWorldbooks.reduce((n, s) => n + s.utf8Bytes, 0);
  assert(description.utf8Bytes >= MINIMUM_UTF8_BYTES.description, 'description below 10000 UTF-8 bytes');
  assert(examples.utf8Bytes >= MINIMUM_UTF8_BYTES.mes_example, 'mes_example below 8000 UTF-8 bytes');
  assert(worldbook.utf8Bytes >= MINIMUM_UTF8_BYTES.worldbook, 'worldbook below 75800 UTF-8 bytes');
  assert(worldbook.utf8Bytes >= sourceBytes * 0.85, 'worldbook below 85% of actual source UTF-8 bytes');
  assert(d.character_book.scan_depth === 4 && d.character_book.token_budget === 8192, 'Book scan/budget mismatch');
  assert(serializeCard(card) === serializeCard(buildDaniaCard(assets)), 'Artifact differs from deterministic build');
  return { ok: !errors.length, errors, stats: { bookEntries: entries.length, sourceWorldbooks, sourceBodyOnly,
    sourceWorldbookUtf8Bytes: sourceBytes, description, mes_example: examples, personality: measureText(d.personality),
    quoteExamples: (d.mes_example.match(/^<START>$/gm) || []).length, worldbook,
    originalWorldbook: measureText(assets.sourceCard.data.character_book.entries.map(e => e.content).join('')),
    worldbookByteFloor: 75800, actualSource85PercentBytes: sourceBytes * 0.85, artifact: measureText(serializeCard(card)) } };
}

async function loadAssets(project, workspace) {
  const read = file => readFile(file, 'utf8');
  const root = resolve(project, 'Prompt/characters/dania');
  const [sourceCard, soul, quotes, storyMode, storyStyle, tone, books] = await Promise.all([
    read(resolve(workspace, 'ST导出/妲妮娅.json')).then(JSON.parse), read(resolve(root, 'soul.md')),
    read(resolve(root, 'canon/quotes.md')), read(resolve(root, 'modes/story.md')), read(resolve(root, 'styles/story.md')),
    read(resolve(project, 'Prompt/shared/tone.md')),
    Promise.all(WORLDBOOK_FILES.map(async file => [file, await read(resolve(root, 'worldbook', file))])),
  ]);
  return { sourceCard, soul, quotes, storyMode, storyStyle, tone, worldbooks: Object.fromEntries(books) };
}
async function main(args) {
  need(args.length <= 1 && args.every(x => x === '--check'), 'Usage: node scripts/cards/build-dania-card.mjs [--check]');
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), workspace = resolve(project, '..');
  const output = resolve(workspace, 'ST导出/妲妮娅.story.json');
  const assets = await loadAssets(project, workspace);
  const card = args.includes('--check') ? JSON.parse(await readFile(output, 'utf8')) : buildDaniaCard(assets);
  const report = checkDaniaCard(card, assets);
  need(report.ok, report.errors.join('\n'));
  if (args.includes('--check')) need(await readFile(output, 'utf8') === serializeCard(card), 'Artifact JSON bytes/format drift');
  else await writeFile(output, serializeCard(card), 'utf8');
  console.log(JSON.stringify({ action: args.includes('--check') ? 'check' : 'build', ...report }, null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
