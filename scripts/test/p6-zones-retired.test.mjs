/**
 * P6「区块废弃」判据套件（ZN-01…ZN-16）。
 *
 * 为什么单独一个文件而不是塞进 channels-ui-contract：
 * 那是「渠道面板」的契约，删区块只是它的邻居；混进去会让以后查「谁守删除完整性」查不到。
 *
 * 三类断言：
 *   ① 删除完整性（ZN-01…ZN-06）—— 静态扫描，0 容忍
 *   ② 域解析不查表（ZN-07…ZN-10）—— 行为断言 + 唯一判定点
 *   ③ M4 守住（ZN-11…ZN-14）+ RK-1 文案（ZN-15）+ B2 裁决（ZN-16）
 *
 * 跑法：node scripts/test/p6-zones-retired.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p, projectRoot } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p6-zn-'))
installElectronStub(userData)

const read = (rel) => fs.readFileSync(p(rel), 'utf8')
const exists = (rel) => fs.existsSync(p(rel))

/** 递归收集 src / scripts 下的 .ts/.tsx/.mjs 文本（跳过 node_modules 与 out） */
function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === 'out') continue
      walk(full, out)
    } else if (/\.(ts|tsx|mjs|cjs)$/.test(item.name)) {
      out.push(full)
    }
  }
  return out
}

const srcFiles = walk(p('src'))
const rel = (full) => path.relative(projectRoot, full).split(path.sep).join('/')

/* ── 6.1 删除完整性 ─────────────────────────────────────────────────────── */

console.log('ZN-01…ZN-06 · 删除完整性')

{
  const hits = srcFiles.filter((file) => {
    const text = fs.readFileSync(file, 'utf8')
    return /from ['"][^'"]*zones(\/|['"])/.test(text) || /from ['"]@shared\/zones['"]/.test(text)
  })
  check('ZN-01 src 里没有任何 zones 的 import（别名或相对路径）', hits.length === 0, hits.map(rel).join(','))
}

{
  const gone = [
    'src/main/features/zones/scope.ts',
    'src/main/features/zones/store.ts',
    'src/main/ipc/zones.ts',
    'src/shared/zones.ts',
    'src/renderer/src/features/settings/sections/ZonesSection.tsx',
    'src/renderer/src/features/settings/useZones.ts',
    'scripts/test/zones-store.test.mjs',
    'scripts/test/zones-scope.test.mjs'
  ]
  const still = gone.filter(exists)
  check('ZN-02 8 个待删文件全部不存在', still.length === 0, still.join(','))
  check('ZN-02b zones 目录不存在', !exists('src/main/features/zones'))
}

check('ZN-03 shared/ipc.ts 里 "zone" 出现 0 次', (read('src/shared/ipc.ts').match(/zone/gi) || []).length === 0,
  (read('src/shared/ipc.ts').match(/zone/gi) || []).length)

{
  const preload = read('src/preload/index.ts')
  const api = read('src/shared/api.ts')
  const zonesBlock = /^\s*zones:\s*\{/m
  check('ZN-04 preload / api.ts 里没有 zones: { 块', !zonesBlock.test(preload) && !zonesBlock.test(api))
}

check('ZN-05 设置页 nav 里没有 "zones"', (read('src/renderer/src/features/settings/nav.ts').match(/zones/gi) || []).length === 0,
  (read('src/renderer/src/features/settings/nav.ts').match(/zones/gi) || []).length)

{
  const main = read('src/main/index.ts')
  check('ZN-06 main/index.ts 既没有 zoneStore 也没有 zones.json（含注释）',
    !/zoneStore/.test(main) && !/zones\.json/.test(main),
    'zoneStore=' + /zoneStore/.test(main) + ' zones.json=' + /zones\.json/.test(main))
}

/* ── 6.2 域解析不再查表 ─────────────────────────────────────────────────── */

console.log('ZN-07…ZN-10 · 域解析不查表')

const mod = await bundleModule(
  'p6-zn',
  [
    `export { ROOT_SCOPE, scopeOf, sessionPolicy } from '${p('src/main/features/chat/sessionPolicy.ts')}'`,
    `export { memoryRouteOf } from '${p('src/main/features/story/route.ts')}'`
  ].join('\n')
)

const QQ = 'qq:10001:private:20002'
const DESKTOP = '3f2a9c1e-0000-4000-8000-000000000000'

check('ZN-07 渠道会话与桌面会话返回同值', mod.scopeOf(QQ) === mod.scopeOf(DESKTOP),
  mod.scopeOf(QQ) + ' vs ' + mod.scopeOf(DESKTOP))
check('ZN-08 返回值非空（fail-closed 闸门保活）', String(mod.scopeOf('x')).length > 0, JSON.stringify(mod.scopeOf('x')))
check('ZN-08b 空串输入也返回非空（「空与坏不同形」）', String(mod.scopeOf('')).length > 0, JSON.stringify(mod.scopeOf('')))
check('ZN-09 ROOT_SCOPE === "zone:root"', mod.ROOT_SCOPE === 'zone:root', mod.ROOT_SCOPE)

{
  const pkg = read('src/main/features/chat/sessionPolicy.ts')
  const assignPoints = (pkg.match(/ROOT_SCOPE\s*=/g) || []).length
  const srcHits = srcFiles.filter((file) => rel(file) !== 'src/main/features/chat/sessionPolicy.ts' && /ROOT_SCOPE\s*=/.test(fs.readFileSync(file, 'utf8')))
  check('ZN-10 ROOT_SCOPE 的赋值点只有 sessionPolicy.ts 一处', assignPoints === 1 && srcHits.length === 0,
    'self=' + assignPoints + ' others=' + srcHits.map(rel).join(','))
  const primaryDefs = srcFiles.filter((file) => /function\s+scopeOf\s*\(/.test(fs.readFileSync(file, 'utf8'))).map(rel)
  check('ZN-10b scopeOf 的定义点只有一个', primaryDefs.length === 1 && primaryDefs[0].endsWith('chat/sessionPolicy.ts'), primaryDefs.join(','))
}

/* ── 6.3 M4 守住 ────────────────────────────────────────────────────────── */

console.log('ZN-11…ZN-14 · M4 守住（记忆/人设/指令照旧）')

{
  const store = read('src/main/features/rag/store.ts')
  check('ZN-11 resetLegacySchema 的 scope_id 旧库检测还在', /scope_id/.test(store) && /resetLegacySchema/.test(store))
  const cols = ['id', 'content', 'user_id', 'persona_id', 'embedding'].filter((name) => new RegExp('\\b' + name + '\\b').test(store))
  check('ZN-12 memories 表关键列齐全（schema 未被顺手改）', cols.length === 5, cols.join(','))
}

{
  const chat = read('src/main/features/chat/chatService.ts')
  check('ZN-14 route.scope 仍是非空闸门', /if \(!route\.scope/.test(chat))
  const plain = mod.memoryRouteOf({ id: DESKTOP })
  const qq = mod.memoryRouteOf({ id: QQ })
  check('ZN-14b 非故事会话的 route.scope 永不为空', Boolean(plain.scope) && Boolean(qq.scope),
    JSON.stringify({ plain, qq }))
  // story_<base36>_<6 hex>，见 main/features/story/paths.ts 的 STORY_ID_PATTERN
  const story = mod.memoryRouteOf({ id: 'story-session', storyId: 'story_abc123_00ff01' })
  check('ZN-14c 故事区仍走物理库 + story: 前缀（未被牵动）',
    story.storyId === 'story_abc123_00ff01' && story.scope === 'story:story_abc123_00ff01',
    JSON.stringify(story))
}

/* ── 6.4 RK-1 文案 ──────────────────────────────────────────────────────── */

console.log('ZN-15 · RK-1「跨场景共享」')

{
  const section = read('src/renderer/src/features/settings/sections/MemorySection.tsx')
  const para = (section.match(/<p className="setting-group__desc" data-ui-target="跨场景共享提示">[\s\S]*?<\/p>/) || [''])[0]
  check('ZN-15 三个词（私聊 / 群聊 / 桌面）都在同一段 desc 里',
    para.includes('私聊') && para.includes('群聊') && para.includes('桌面'),
    para.replace(/\s+/g, ' ').slice(0, 120))
  check('ZN-15b 文案写的是「换场景不换人设」的意思', para.includes('人设') && para.includes('共享'))
}

/* ── 6.5 B2 裁决 ────────────────────────────────────────────────────────── */

console.log('ZN-16 · observeGroupMessages 随区块一起删')

{
  const hits = srcFiles.filter((file) => /observeGroupMessages/.test(fs.readFileSync(file, 'utf8'))).map(rel)
  check('ZN-16 src 里 observeGroupMessages 出现 0 次', hits.length === 0, hits.join(','))
  const scriptsHits = walk(p('scripts/test'))
    .filter((file) => !file.endsWith('p6-zones-retired.test.mjs'))
    .filter((file) => /observeGroupMessages/.test(fs.readFileSync(file, 'utf8')))
    .map(rel)
  check('ZN-16b 其余测试也不引用这个字段', scriptsHits.length === 0, scriptsHits.join(','))
}

done()
