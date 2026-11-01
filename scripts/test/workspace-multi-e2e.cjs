/**
 * 多工作区的端到端验证（真 Electron，真落盘，真工具调用）。
 *
 * 为什么必须起 Electron 而不是纯 Node：这条链路的每一环都在主进程里
 * —— 工作区清单落盘 -> 会话绑定 -> chatService.toolScopeOf -> 沙箱路径闸
 * -> fs.list_dir 真的读到了哪个目录。任何一环接错，单元测试依然全绿，
 * 但用户会看到"两个工作区里的会话读到同一批文件"。
 *
 * 断言的是**互斥性**：会话 A 只看到 alpha 的文件、会话 B 只看到 beta 的，
 * 而不是分别断言"结果里包含某个文件名"——后者在两边都返回全部文件时也会通过。
 *
 * 跑法：pnpm test:workspace
 */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '..', '..')
const userData = path.join(os.tmpdir(), 'nahida-ws-e2e-' + Date.now())
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setAppPath(projectRoot)
require(path.join(projectRoot, 'out', 'main', 'index.js'))

const out = []
const log = (...a) => { out.push(a.join(' ')); console.log(...a) }

app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 2200))
  const win = BrowserWindow.getAllWindows()[0]
  const call = (fn, ...args) => win.webContents.executeJavaScript(
    'window.nahida.' + fn + '(' + args.map(a => JSON.stringify(a)).join(',') + ')'
  )

  try {
    // 完全访问关掉审批，让工具直接跑（这里测的是目录边界，不是审批流）
    const s = await call('settings.get')
    await call('settings.save', { permission: { mode: 'readonly' } })

    const dirA = path.join(userData, 'alpha'); fs.mkdirSync(dirA, { recursive: true })
    const dirB = path.join(userData, 'beta'); fs.mkdirSync(dirB, { recursive: true })
    fs.writeFileSync(path.join(dirA, 'ONLY-IN-ALPHA.txt'), 'a')
    fs.writeFileSync(path.join(dirB, 'ONLY-IN-BETA.txt'), 'b')

    let cat = await call('workspaces.list')
    const idA = cat.workspaces[0].id
    await call('workspaces.save', { name: 'alpha', dir: dirA })
    cat = await call('workspaces.list')
    const widA = cat.workspaces.find(w => w.dir === dirA).id
    await call('workspaces.save', { name: 'beta', dir: dirB })
    cat = await call('workspaces.list')
    const widB = cat.workspaces.find(w => w.dir === dirB).id

    // 两个会话，分别绑 alpha / beta
    const sA = await call('chat.createSession', { mode: 'agent', workspaceId: widA })
    const sB = await call('chat.createSession', { mode: 'agent', workspaceId: widB })
    log('会话A 绑 alpha', sA.workspaceId === widA ? 'OK' : 'BAD')
    log('会话B 绑 beta', sB.workspaceId === widB ? 'OK' : 'BAD')

    // 触发真实工具调用（mock provider 见到「工作区」就调 fs.list_dir）
    const sendAndWait = async (sessionId) => {
      const before = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
        .find(x => x.id === sessionId).messages.length
      await call('chat.send', { sessionId, content: '看看工作区里有什么文件' })
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 250))
        const all = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
        const sess = all.find(x => x.id === sessionId)
        const last = sess.messages[sess.messages.length - 1]
        if (last && last.status === 'done' && last.toolCalls && last.toolCalls.length > 0
            && last.toolCalls.every(c => c.status === 'ok' || c.status === 'error' || c.status === 'denied')) {
          return last
        }
      }
      return null
    }

    const rA = await sendAndWait(sA.id)
    const rB = await sendAndWait(sB.id)

    const textA = rA && rA.toolCalls && rA.toolCalls[0] ? (rA.toolCalls[0].result || rA.toolCalls[0].error || '') : '(无)'
    const textB = rB && rB.toolCalls && rB.toolCalls[0] ? (rB.toolCalls[0].result || rB.toolCalls[0].error || '') : '(无)'

    log('--- 会话A（alpha）工具结果 ---')
    log(textA.split('\n').slice(0, 8).join('\n'))
    log('--- 会话B（beta）工具结果 ---')
    log(textB.split('\n').slice(0, 8).join('\n'))
    log('---')
    const passA = textA.includes('ONLY-IN-ALPHA') && !textA.includes('ONLY-IN-BETA')
    const passB = textB.includes('ONLY-IN-BETA') && !textB.includes('ONLY-IN-ALPHA')
    log('A 只看到 alpha 的文件', passA ? 'OK' : 'BAD')
    log('B 只看到 beta 的文件', passB ? 'OK' : 'BAD')
    if (!passA || !passB) process.exitCode = 1

    // ---- 删掉会话 B 所在的工作区：会话不能带着失效 id 失联 ----
    // 侧栏按 workspaceId 过滤，id 失效 = 对话在「最近」里彻底消失（用户视角是"凭空没了"）
    const beforeIds = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
    log('删除前会话B 绑着 beta', beforeIds.find(x => x.id === sB.id).workspaceId === widB ? 'OK' : 'BAD')

    const cat2 = await call('workspaces.remove', widB)
    const after = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
    const sB2 = after.find(x => x.id === sB.id)

    log('删除工作区后会话B 仍在', sB2 ? 'OK' : 'BAD')
    log('会话B 已改绑到活动工作区', sB2.workspaceId === cat2.activeWorkspaceId ? 'OK' : 'BAD(' + sB2.workspaceId + ')')
    log('改绑目标是真实存在的工作区', cat2.workspaces.some(w => w.id === sB2.workspaceId) ? 'OK' : 'BAD')
    log('会话A 不受影响', after.find(x => x.id === sA.id).workspaceId === widA ? 'OK' : 'BAD')

    const reassignOk = Boolean(sB2) && sB2.workspaceId === cat2.activeWorkspaceId
      && cat2.workspaces.some(w => w.id === sB2.workspaceId)
    if (!reassignOk) process.exitCode = 1

    // ---- 渲染层镜像：删掉工作区后侧栏不能把会话藏起来 ----
    // 上面那些会话是直接走 IPC 建的，渲染层的 zustand 单例并不知道它们存在
    // （真实用户不会绕过 store）。所以这一段全部用 DOM 点击驱动，走用户真正走的路：
    //   点「新建对话」建两个会话 -> 点工作区「…」->「移出列表」-> 数侧栏还剩几条会话
    const evalJs = (code) => win.webContents.executeJavaScript(code)
    const countSel = (sel) => evalJs('document.querySelectorAll(' + JSON.stringify(sel) + ').length')
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))

    // 侧栏「新建对话」×2：这一步会经过 store.createSession，store 才会真正持有这两个会话
    for (let i = 0; i < 2; i++) {
      await evalJs('document.querySelector(".sidebar__new").click()')
      await sleep(500)
    }
    const sessBefore = await countSel('.session-item')
    log('点两次新建对话后有两条会话', sessBefore === 2 ? 'OK' : 'BAD(' + sessBefore + ')')

    const wsBefore = await countSel('.workspace-item')
    log('侧栏工作区条目数', wsBefore >= 1 ? 'OK(' + wsBefore + ')' : 'BAD(' + wsBefore + ')')

    // 记住这两个会话在 store 里绑的是哪个工作区（= 侧栏当前活动工作区）
    const beforeDisk = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
    const uiSessionIds = beforeDisk.slice(0, 2).map(s => s.id)

    // 点第一个工作区的「…」->「移出列表」
    const clicked = await evalJs(`
      (function () {
        var more = document.querySelectorAll('.workspace-item__more')
        if (!more.length) return 'no-more-button'
        more[0].click()
        return 'menu-opened'
      })()
    `)
    log('打开工作区菜单', clicked === 'menu-opened' ? 'OK' : 'BAD(' + clicked + ')')
    await sleep(200)

    const removed = await evalJs(`
      (function () {
        var btns = Array.prototype.slice.call(document.querySelectorAll('.workspace-menu button'))
        var hit = btns.filter(function (b) { return b.textContent.indexOf('移出列表') >= 0 })[0]
        if (!hit) return 'no-remove-button'
        hit.click()
        return 'removed'
      })()
    `)
    log('点击移出列表', removed === 'removed' ? 'OK' : 'BAD(' + removed + ')')
    await sleep(1000)

    // 关键断言：卸掉一个工作区之后，界面上一条会话都不能少。
    // 渲染层不同步的话，这里会掉到 0 —— 用户看到的就是"对话凭空消失"。
    // 注意不能断言"恰好 2 条"：resync 拉的是整个盘，前面用 IPC 建的会话也会一起回来，
    // 所以正确的判据是"不少于删之前"，并且 UI 建的那两条确实还在列表里。
    const sessAfter = await countSel('.session-item')
    log('移出工作区后会话没有变少', sessAfter >= sessBefore ? 'OK(' + sessBefore + '->' + sessAfter + ')' : 'BAD(' + sessBefore + '->' + sessAfter + ')')
    if (sessAfter < sessBefore) process.exitCode = 1

    const visibleIds = await evalJs(
      'Array.prototype.slice.call(document.querySelectorAll(".session-item__title")).map(function(n){return n.textContent})'
    )
    log('侧栏仍有会话可点', Array.isArray(visibleIds) && visibleIds.length === sessAfter ? 'OK' : 'BAD')

    // 落盘也不能留孤儿：没有会话指向已删除的工作区
    const disk = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
    const catFinal = await call('workspaces.list')
    const orphan = disk.filter(s => !catFinal.workspaces.some(w => w.id === s.workspaceId))
    log('没有会话指向已删除的工作区', orphan.length === 0 ? 'OK' : 'BAD(' + orphan.length + ' 个孤儿)')
    if (orphan.length > 0) process.exitCode = 1

    // UI 建的会话必须还在盘里（没被误删）
    const survived = uiSessionIds.filter(id => disk.some(s => s.id === id))
    log('UI 建的会话仍在盘里', survived.length === 2 ? 'OK' : 'BAD(' + survived.length + ')')
    if (survived.length !== 2) process.exitCode = 1
  } catch (e) {
    log('FAIL', e && e.message ? e.message : String(e))
    process.exitCode = 1
  }
  // 清理是尽力而为：Electron 自己还开着 userData 里的文件（锁文件 / 缓存），
  // Windows 上 rmSync 会报 EPERM。清理失败绝不能把测试搞成"卡死无结果"。
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {
    log('（临时目录未清理，可手动删除：' + userData + '）')
  }
  app.exit(process.exitCode || 0)
})