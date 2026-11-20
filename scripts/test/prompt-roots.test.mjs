/** M27：真实生产 store/editor + 隔离双层资产；不读写真实用户数据。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { bundleModule, createChecker, installElectronStub, p } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p35-user-'))
const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-p35-app-'))
installElectronStub(userData)
const require = createRequire(import.meta.url)
const electron = require('electron')
electron.app.getAppPath = () => appPath
const opened = []
electron.shell.openPath = async (target) => { opened.push(target); return '' }
const { promptStore: store, ...editor } = await bundleModule('prompt-roots', [
  'export { promptStore } from ' + JSON.stringify(p('src/main/features/prompt/promptStore.ts')),
  'export { addEntry, updateEntry, removeEntry, createWorldbook, knownDirs } from ' + JSON.stringify(p('src/main/features/worldbook/editor.ts'))
].join('\n'))
const builtin = path.join(appPath, 'Prompt')
const user = path.join(userData, 'prompt')
const write = (root, rel, body) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
  return file
}
const snapshot = (root) => {
  const files = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else files.push([path.relative(root, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
    }
  }
  walk(root)
  return JSON.stringify(files.sort())
}
const rejects = (fn) => { try { fn(); return false } catch { return true } }
const draft = { title: '测试条目', keywords: ['test'], always: false, priority: 5, value: 50, chained: [], body: 'USER_WORLDBOOK' }
const sep = '\n\n---\n\n'
try {
  check('模块导入不创建用户 prompt 根', !fs.existsSync(user))
  for (const [file, body] of Object.entries({ 'base.md': 'BASE', 'tone.md': 'TONE', 'tool_usage.md': 'TOOLS' })) write(builtin, 'shared/' + file, body)
  for (const id of ['nahida', 'dania']) {
    write(builtin, 'characters/' + id + '/soul.md', 'SOUL_' + id)
    write(builtin, 'characters/' + id + '/canon/quotes.md', 'CANON')
    write(builtin, 'characters/' + id + '/worldbook/world.md', 'WORLD')
    for (const mode of ['chat', 'agent', 'story']) {
      write(builtin, 'characters/' + id + '/modes/' + mode + '.md', 'MODE_' + mode)
      write(builtin, 'characters/' + id + '/styles/' + mode + '.md', 'STYLE_' + mode)
    }
  }
  const before = snapshot(builtin)
  for (const name of ['base.md', 'tone.md', 'tool_usage.md']) {
    write(user, 'shared/' + name, 'OVERRIDE_' + name)
    check('shared ' + name + ' 独立覆盖', store.compose('dania', 'agent').includes('OVERRIDE_' + name))
    fs.unlinkSync(path.join(user, 'shared', name))
  }
  fs.rmSync(user, { recursive: true, force: true })
  check('root 保持内置根语义', store.root() === builtin)
  check('roots 区分 user/builtin', store.roots().user === user && store.roots().builtin === builtin)
  store.ensureUserRoot()
  check('A-01 ready 后可创建 characters/shared', fs.statSync(path.join(user, 'characters')).isDirectory() && fs.statSync(path.join(user, 'shared')).isDirectory())
  let lib = store.library()
  check('兼容 root 指向用户层', lib.root === user && lib.userRoot === user && lib.builtinRoot === builtin)
  check('A-02 两个内置角色仍可见且标为 builtin', lib.characters.length === 2 && lib.characters.every((c) => c.origin === 'builtin'))
  check('主进程返回生效角色绝对路径', lib.characters.every((c) => c.dir === path.join(builtin, 'characters', c.id) && c.worldbookDir === path.join(c.dir, 'worldbook')))
  for (const mode of ['chat', 'agent', 'story']) {
    const expected = ['BASE', 'TONE', 'SOUL_dania', 'CANON', 'WORLD', 'MODE_' + mode, 'STYLE_' + mode, ...(mode === 'agent' ? ['TOOLS'] : [])]
    check('A-08 ' + mode + ' 原段顺序逐字不变', store.compose('dania', mode) === expected.join(sep))
  }
  write(user, 'shared/tone.md', 'USER_TONE')
  check('A-04 tone 覆盖，base/tool 逐文件兜底', store.compose('dania', 'agent') === ['BASE', 'USER_TONE', 'SOUL_dania', 'CANON', 'WORLD', 'MODE_agent', 'STYLE_agent', 'TOOLS'].join(sep))
  write(user, 'shared/tone.md', '')
  check('空用户文件也是显式覆盖', !store.compose('dania', 'chat').includes('TONE'))
  fs.unlinkSync(path.join(user, 'shared/tone.md'))
  check('删除 shared 覆盖后恢复 builtin', store.compose('dania', 'chat').includes('TONE'))
  write(user, 'characters/DANIA/soul.md', 'UPPERCASE_USER')
  if (process.platform === 'win32') {
    check('Windows 大小写碰撞合并且保留原会话 id', store.library().characters.filter((c) => c.id.toLowerCase() === 'dania').length === 1 && store.library().characters.some((c) => c.id === 'dania' && c.origin === 'user'))
    check('大小写碰撞 library 与 compose 一致', store.compose('dania', 'chat').includes('UPPERCASE_USER') && store.hasCharacter('DANIA'))
  }
  fs.rmSync(path.join(user, 'characters/DANIA'), { recursive: true, force: true })
  write(user, 'characters/test-a/soul.md', '# 自定义测试\nUSER_TEST')
  write(user, 'characters/dania/soul.md', '# 用户妲妮娅\nUSER_DANIA')
  lib = store.library()
  check('A-03 新角色出现在合并库中', lib.characters.some((c) => c.id === 'test-a' && c.origin === 'user'))
  check('同 id 仅保留一个且用户来源优先', lib.characters.filter((c) => c.id === 'dania').length === 1 && lib.characters.find((c) => c.id === 'dania').origin === 'user')
  for (const mode of ['chat', 'agent', 'story']) {
    const expected = ['BASE', 'TONE', '# 用户妲妮娅\nUSER_DANIA', ...(mode === 'agent' ? ['TOOLS'] : [])]
    check('A-03 ' + mode + ' 整体遮蔽不混入内置文件', store.compose('dania', mode) === expected.join(sep))
  }
  check('缺失字段不借用内置存在标记', lib.characters.find((c) => c.id === 'dania').files.find((f) => f.id === 'worldbook').exists === false)
  fs.unlinkSync(path.join(user, 'characters/dania/soul.md'))
  check('空用户角色目录继续整体遮蔽', store.compose('dania', 'chat') === ['BASE', 'TONE'].join(sep) && !store.library().characters.find((c) => c.id === 'dania').complete)
  fs.rmdirSync(path.join(user, 'characters/dania'))
  check('移除用户目录后恢复内置角色', store.library().characters.find((c) => c.id === 'dania').origin === 'builtin' && store.compose('dania', 'chat').includes('SOUL_dania'))
  await store.openUserRoot()
  check('A-06 添加入口打开用户 characters', opened.at(-1) === path.join(user, 'characters'))
  await store.openLibrary()
  check('打开库目录仅打开用户根', opened.at(-1) === user)
  await store.openCharacter('test-a')
  check('用户角色打开自身用户目录', opened.at(-1) === path.join(user, 'characters/test-a'))
  await store.openCharacter('nahida')
  check('内置角色打开用户容器且不创建空覆盖', opened.at(-1) === path.join(user, 'characters') && !fs.existsSync(path.join(user, 'characters/nahida')))
  check('非法角色路径在读取前被挡住', rejects(() => store.compose('../shared', 'chat')))
  let invalidOpen = false
  try { await store.openCharacter('../evil') } catch { invalidOpen = true }
  check('非法角色路径在打开前被挡住', invalidOpen)
  const dir = path.join(user, 'characters/test-a/worldbook')
  editor.createWorldbook(dir)
  const listing = editor.addEntry(dir, 'custom.md', draft)
  const entry = listing.files.flatMap((f) => f.entries).find((e) => e.title === draft.title)
  check('A-05 新条目写入用户 worldbook', fs.readFileSync(path.join(dir, 'custom.md'), 'utf8').includes('USER_WORLDBOOK'))
  editor.updateEntry(dir, 'custom.md', entry.id, { ...draft, body: 'UPDATED' })
  check('用户条目可修改且生成用户备份', fs.readFileSync(path.join(dir, 'custom.md'), 'utf8').includes('UPDATED') && fs.existsSync(path.join(dir, 'custom.md.bak')))
  editor.removeEntry(dir, 'custom.md', entry.id)
  check('用户条目可删除', !fs.readFileSync(path.join(dir, 'custom.md'), 'utf8').includes('UPDATED'))
  check('knownDirs 角色入口仅列用户目录', editor.knownDirs().filter((d) => d.kind === 'character').every((d) => d.dir.startsWith(user + path.sep)))
  const builtinDir = path.join(builtin, 'characters/nahida/worldbook')
  for (const [name, fn] of [
    ['create', () => editor.createWorldbook(path.join(builtinDir, 'new'))],
    ['add', () => editor.addEntry(builtinDir, 'new.md', draft)],
    ['update', () => editor.updateEntry(builtinDir, 'world.md', 'missing', draft)],
    ['remove', () => editor.removeEntry(builtinDir, 'world.md', 'missing')]
  ]) check('内置 ' + name + ' 写入口保护', rejects(fn))
  const alias = path.join(userData, 'builtin-alias')
  fs.symlinkSync(builtinDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  check('目录联接别名也保护内置', rejects(() => editor.createWorldbook(path.join(alias, 'new'))))
  check('联接下尚不存在的文件也保护', rejects(() => editor.addEntry(alias, 'new.md', draft)))
  for (const ext of ['.tmp', '.bak']) {
    const marker = path.join(dir, 'blocked.md' + ext)
    fs.symlinkSync(process.platform === 'win32' ? builtinDir : path.join(builtinDir, 'world.md'), marker, process.platform === 'win32' ? 'junction' : 'file')
    check('临时或备份链接 ' + ext + ' 保护', rejects(() => editor.addEntry(dir, 'blocked.md', draft)) && !fs.existsSync(path.join(dir, 'blocked.md')))
    if (process.platform === 'win32') fs.rmdirSync(marker)
    else fs.unlinkSync(marker)
  }
  const fileAlias = path.join(dir, 'alias.md')
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(builtinDir, 'world.md'), fileAlias, 'file')
    check('文件符号链接保护内置', rejects(() => editor.addEntry(dir, 'alias.md', draft)))
    fs.unlinkSync(fileAlias)
  } else console.log('  INFO Windows 文件符号链接权限缺失：以目录联接覆盖 realpath 守卫，文件链接实测未覆盖')
  check('chat 工具开启仍保持压轴', store.compose('dania', 'chat', { toolsEnabled: true }).endsWith(sep + 'TOOLS'))
  const dangling = path.join(userData, 'dangling-builtin')
  fs.symlinkSync(path.join(builtin, 'not-created'), dangling, process.platform === 'win32' ? 'junction' : 'dir')
  check('悬空目录链接目标也解析到内置', rejects(() => store.assertWritablePath(path.join(dangling, 'child'))))
  check('悬空链接 createWorldbook 前零写入', rejects(() => editor.createWorldbook(dangling)) && !fs.existsSync(path.join(builtin, 'not-created')))
  if (process.platform !== 'win32') {
    for (const ext of ['.tmp', '.bak']) {
      const marker = path.join(dir, 'dangling.md' + ext)
      fs.symlinkSync(path.join(builtinDir, 'not-created.md'), marker, 'file')
      check('悬空 sidecar ' + ext + ' 保护', rejects(() => editor.addEntry(dir, 'dangling.md', draft)) && !fs.existsSync(path.join(builtinDir, 'not-created.md')))
      fs.unlinkSync(marker)
    }
  }
  const outside = path.join(userData, 'external-story')
  editor.createWorldbook(outside)
  editor.addEntry(outside, 'world.md', draft)
  check('外部剧本世界书继续可写', fs.readFileSync(path.join(outside, 'world.md'), 'utf8').includes('USER_WORLDBOOK'))
  check('A-07 内置快照逐文件哈希完全不变', snapshot(builtin) === before)
  fs.renameSync(builtin, builtin + '-away')
  check('缺失内置层仍返回用户角色', store.library().characters.some((c) => c.id === 'test-a') && store.compose('test-a', 'chat').includes('USER_TEST'))
  fs.renameSync(builtin + '-away', builtin)
  electron.app.isPackaged = true
  const previousResources = process.resourcesPath
  process.resourcesPath = appPath
  write(path.join(appPath, 'prompt'), 'shared/base.md', 'PACKAGED_BASE')
  check('打包根解析仍使用 resources/prompt', store.root() === path.join(appPath, 'prompt'))
  check('打包态用户根保持不变', store.userRoot() === user)
  check('打包态同样保护内置写入', rejects(() => editor.createWorldbook(path.join(appPath, 'prompt/new'))))
  process.resourcesPath = previousResources
  electron.app.isPackaged = false
} finally {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(appPath, { recursive: true, force: true })
}
done()
