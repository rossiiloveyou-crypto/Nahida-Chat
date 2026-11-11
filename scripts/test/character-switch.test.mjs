/**
 * 角色切换（对话页唯一入口）—— 24 项。
 *
 * 这一轮把「换角色」从「新建一个对话」改成「在对话页切」。判据分两半：
 *  A. 主进程（真行为）：能改、改得进盘、拼错的角色被拒、模式那道锁不受影响、人格真的换了；
 *  B. 渲染层（静态契约）：切换器存在、建会话时带角色、**新建对话那条路不再带角色**。
 *  B 用小字符串断言而不是渲染快照：快照会跟着样式一起变，而这里要守的是
 *  「数据从哪来、写到哪去」——那类回归在截图上看不出来。
 *
 * 跑法：node scripts/test/character-switch.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleModule, createChecker, installElectronStub, p, projectRoot } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-character-'))
installElectronStub(userData)

const source = [
  `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
  `export { promptStore } from '${p('src/main/features/prompt/promptStore.ts')}'`,
  `export { settingsStore } from '${p('src/main/features/settings/settingsStore.ts')}'`
].join('\n')
const { chatService, promptStore, settingsStore } = await bundleModule('character-switch', source)

const readSource = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8')
const grabCall = (text, name) => {
  const start = text.indexOf(name + '(')
  if (start === -1) return ''
  let depth = 0
  for (let i = start + name.length; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}
const throwsWith = (fn, fragment) => {
  try {
    fn()
  } catch (error) {
    return String(error && error.message).includes(fragment)
  }
  return false
}

console.log('1-3 · 提示词库是判定真源')

const library = promptStore.library()
check('1 · 库里有至少两个角色目录（nahida + dania）', library.characters.length >= 2, library.characters.map((item) => item.id).join(','))
check(
  '2 · hasCharacter 认得真实角色、不认杜撰的 id',
  promptStore.hasCharacter('nahida') && promptStore.hasCharacter('dania') && !promptStore.hasCharacter('nobody-here')
)
check(
  '3 · hasCharacter 挡得住路径穿越（不拼路径，只对 readdir 出的 id 全等比较）',
  !promptStore.hasCharacter('../shared') && !promptStore.hasCharacter('..\\..\\evil')
)

console.log('4-6 · 有消息的会话也能切角色（本次改动的核心）')

const session = chatService.createSession()
check('4 · 新会话的角色 = 设置里的 defaultCharacterId', session.characterId === settingsStore.get().defaultCharacterId, session.characterId)
chatService.appendMessages(session.id, [
  { id: 'm-1', role: 'user', content: '你好', createdAt: Date.now(), status: 'done' },
  { id: 'm-2', role: 'assistant', content: '在的。', createdAt: Date.now(), status: 'done' }
])
const before = chatService.listSessions().find((item) => item.id === session.id)
const switched = chatService.updateSession(session.id, { characterId: 'dania' })
check('5 · 有消息的会话切成 dania 成功', switched.characterId === 'dania', switched.characterId)
check('6 · 切换不动历史消息条数', switched.messages.length === before.messages.length, switched.messages.length)

console.log('7-9 · 落盘与「只改一个字段」')

const disk = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8')).find((item) => item.id === session.id)
check('7 · sessions.json 里那一行也是 dania（不是只改内存）', disk.characterId === 'dania', disk.characterId)
const strip = (row) => {
  const copy = { ...row }
  delete copy.characterId
  delete copy.updatedAt
  return JSON.stringify(copy)
}
check('8 · 除 characterId/updatedAt 外，会话其余字段一字未动', strip(before) === strip(switched))
check('9 · 切回 nahida 也干净（可来回切，不留尾巴）', chatService.updateSession(session.id, { characterId: 'nahida' }).characterId === 'nahida')

console.log('10-13 · 非法输入被拒，且不半改')

check('10 · 切到不存在的角色 → 角色不存在', throwsWith(() => chatService.updateSession(session.id, { characterId: 'nobody-here' }), '角色不存在'))
check('11 · 传空串 → 角色不能为空', throwsWith(() => chatService.updateSession(session.id, { characterId: '   ' }), '角色不能为空'))
check(
  '12 · 被拒之后会话仍是原角色（没有先写后校验的半改）',
  chatService.listSessions().find((item) => item.id === session.id).characterId === 'nahida'
)
check(
  '13 · 模式那道锁没被顺手打开：有消息的会话仍然不能切 mode',
  throwsWith(() => chatService.updateSession(session.id, { mode: 'agent' }), '不能切换模式')
)

console.log('14-16 · 人格真的换了（不是只改了字段）')

const asDania = promptStore.compose('dania', 'chat')
const asNahida = promptStore.compose('nahida', 'chat')
check('14 · compose(dania) 里出现妲妮娅', asDania.includes('妲妮娅'), asDania.length + ' 字')
check('15 · compose(nahida) 里有纳西妲', asNahida.includes('纳西妲'), asNahida.length + ' 字')
check('16 · 两份 system 提示词不是同一份（角色层真的换了）', asDania !== asNahida)

console.log('17-18 · 新建对话跟随最后一次选择')

settingsStore.save({ defaultCharacterId: 'dania' })
const fresh = chatService.createSession()
check('17 · 默认角色改成 dania 后，新建会话就是 dania', fresh.characterId === 'dania', fresh.characterId)
settingsStore.save({ defaultCharacterId: 'nahida' })
check('18 · 改回 nahida 后新建会话跟着改回', chatService.createSession().characterId === 'nahida')

console.log('19-24 · 渲染层契约（静态）')

const composerBar = readSource('src/renderer/src/features/chat/components/ComposerBar.tsx')
const chatPage = readSource('src/renderer/src/features/chat/ChatPage.tsx')
const composer = readSource('src/renderer/src/features/chat/components/Composer.tsx')
const sidebar = readSource('src/renderer/src/components/Sidebar.tsx')

check('19 · 输入区有「角色选择」元素（出图后能被指认）', /data-ui-target="角色选择"/.test(composerBar))
check('20 · 菜单渲染的是提示词库的角色清单', /characters\.map\(/.test(composerBar))
check(
  '21 · 缺 soul.md 的角色列出来但点不动（不藏，藏了没法解释清单为什么少一个）',
  /disabled=\{!item\.complete\}/.test(composerBar)
)
check(
  '22 · 首页草稿角色一路带进新会话（建会话时带 characterId）',
  grabCall(chatPage, 'createSession').includes('characterId')
)
check(
  '23 · 切换时同时写「新对话默认角色」（否则下次新建又换人）',
  /saveSettings\(\{ defaultCharacterId: nextId \}\)/.test(chatPage)
)
{
  const sidebarCreate = grabCall(sidebar, 'createSession')
  check(
    '24 · 侧栏「新建对话」不再带 characterId —— 换角色只有对话页那一个入口',
    sidebarCreate.length > 0 && !sidebarCreate.includes('characterId'),
    sidebarCreate.slice(0, 60)
  )
}
check('25 · 输入框占位符不再写死角色名（原来写的是「给纳西妲发消息」）', !composer.includes('给纳西妲发消息') && /characterName/.test(composer))

done()
