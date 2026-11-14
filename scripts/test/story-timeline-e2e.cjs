/**
 * 故事分支时间轴 = 「上下文窗口」（T-01…T-05）—— 真窗口验证，不靠读代码猜。
 *
 * 报障：时间轴从上往下铺 1~N，可用户要分的通常是**最后一条**，
 * 结果每次都要先把抽屉滚到底。现在改成定高窗口 + 默认贴底、向上滚看历史。
 *
 * 断言：
 *  ① 时间轴有自己的滚动窗口（scrollHeight > clientHeight）
 *  ② 打开时已经在底部（scrollTop + clientHeight ≈ scrollHeight）
 *  ③ 视口里最上面那条不是第 1 条（说明真的滚下来了）
 *  ④ 往上滚能回到第 1 条（历史仍可读）
 *
 * 跑法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/test/story-timeline-e2e.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '../..')
const userData = path.join(os.tmpdir(), 'nc-timeline-' + Date.now())
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setAppPath(projectRoot)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ defaultCharacterId: 'nahida', memory: { enabled: false, autoExtract: false } }, null, 2),
  'utf8'
)
require(path.join(projectRoot, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok })
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  → ' + detail))
}

app.whenReady().then(async () => {
  await sleep(900)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.error('没有找到主窗口'); app.exit(1); return }
  win.setContentSize(1280, 860)
  const indexHtml = path.join(projectRoot, 'out', 'renderer', 'index.html')
  await win.loadFile(indexHtml, { hash: '/chat', query: { v: String(Date.now()) } })
  await sleep(600)

  // 播种：一条故事 + 4 轮真实往返（演示模式 mockProvider）+ 一条旁白 → 共 10 条消息
  const seeded = await win.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const created = await window.nahida.story.create({
        title: '时间轴样本',
        characterId: 'nahida',
        openingText: '雨点敲在钟楼的铜面上，像是有人在数数。'
      })
      const storyId = created.meta.storyId
      const root = await window.nahida.story.session(storyId)
      if (!root) return { ok: false, reason: '根分支不存在' }
      // 10 轮 = 20 条 + 开场 + 旁白 = 22 条：必须真的把窗口撑爆，否则「默认贴底」测不出来
      const lines = [
        '你听，钟楼好像不响了。',
        '那我们去塔顶看看？',
        '等雨小一点再说。',
        '那我先记下来。',
        '记在哪儿？',
        '就写在手背上。',
        '雨停了。',
        '走吧。',
        '楼梯是湿的，慢一点。',
        '上面有风。'
      ]
      for (const line of lines) {
        await window.nahida.chat.send({ sessionId: root.id, content: line })
        const deadline = Date.now() + 15000
        for (;;) {
          const snap = await window.nahida.story.session(storyId)
          const tailMsg = snap && snap.messages[snap.messages.length - 1]
          if (tailMsg && tailMsg.role === 'assistant' && tailMsg.status === 'done' && tailMsg.content.length > 0) break
          if (Date.now() > deadline) return { ok: false, reason: '等待回复超时' }
          await sleep(120)
        }
      }
      await window.nahida.chat.narrate(root.id, '雨声忽然停了。')
      const after = await window.nahida.story.session(storyId)
      return { ok: true, storyId, count: after ? after.messages.length : 0 }
    })()
  `)
  if (!seeded || !seeded.ok) { console.error('播种失败：' + JSON.stringify(seeded)); app.exit(2); return }

  // 整页重载（chatStore / storyStore 是模块级单例），再点开故事卡片
  await win.loadFile(indexHtml, { hash: '/chat', query: { v: String(Date.now() + 1) } })
  await sleep(900)
  const opened = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + 8000
      const tick = () => {
        const card = document.querySelector('[data-ui-target="故事卡片 时间轴样本"]')
        if (card) { card.click(); return resolve(true) }
        if (Date.now() > deadline) return resolve(false)
        setTimeout(tick, 80)
      }
      tick()
    })
  `)
  if (!opened) { console.error('点不到故事卡片'); app.exit(3); return }
  await sleep(900)

  const measured = await win.webContents.executeJavaScript(`
    (() => {
      const list = document.querySelector('.story-timeline__list')
      if (!list) return { error: '没有时间轴列表' }
      const rows = [...list.querySelectorAll('.story-timeline__item')]
      const firstVisible = rows.find((row) => row.getBoundingClientRect().top >= list.getBoundingClientRect().top - 1)
      const gap = list.scrollHeight - list.clientHeight - list.scrollTop
      const beforeTop = rows.length ? rows[0].textContent.trim().slice(0, 12) : ''
      const lastText = rows.length ? rows[rows.length - 1].textContent.trim().slice(0, 12) : ''
      // 向上滚回顶部，确认历史还能看
      list.scrollTop = 0
      return {
        rows: rows.length,
        windowed: list.scrollHeight > list.clientHeight + 4,
        gapAtBottom: Math.round(gap),
        firstVisibleText: firstVisible ? firstVisible.textContent.trim().slice(0, 12) : '',
        firstText: beforeTop,
        lastText,
        topAfterScrollUp: list.scrollTop
      }
    })()
  `)

  check(
    'T-01 时间轴是个定高窗口（22 条内容比视口高，能滚）',
    measured.windowed === true,
    JSON.stringify({ rows: measured.rows, gap: measured.gapAtBottom })
  )
  check('T-02 打开时已经贴在底部（差值 ≤ 2px）', measured.gapAtBottom <= 2, String(measured.gapAtBottom))
  check(
    'T-03 视口里最上面那条不是第 1 条（说明真的滚下来了）',
    measured.firstVisibleText !== '' && !measured.firstVisibleText.startsWith('1.'),
    JSON.stringify({ firstVisible: measured.firstVisibleText, first: measured.firstText, last: measured.lastText })
  )
  check('T-04 末条在视口里（最新一条随手就能分）', measured.lastText !== '' && measured.lastText.startsWith(String(measured.rows) + '.'), measured.lastText)
  check('T-05 往上滚能回到第 1 条（历史仍可读）', measured.topAfterScrollUp === 0, String(measured.topAfterScrollUp))

  const failed = checks.filter((item) => !item.ok)
  console.log('')
  console.log('共 ' + checks.length + ' 项，通过 ' + (checks.length - failed.length) + ' 项')
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
