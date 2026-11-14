/**
 * 失败的一轮能不能自己收场（F-01…F-07）—— 真窗口验证。
 *
 * 报障：调用出错后气泡卡在「三个点」的打字动画上，没原因、没重试键，
 * 用户只能再发一条消息把它顶下去。
 *
 * 这条测试**不读代码猜**，全部在真窗口里点：
 *  ① 失败气泡里不许再出现打字动画；
 *  ② 原因写在气泡里；
 *  ③ 「重试这一轮 / 删除这条」两个键都在；
 *  ④ 点重试 → 真的重跑一轮，气泡里出现正文、按钮消失；
 *  ⑤ 重试不重复用户那句（user 气泡仍是 1 个）；
 *  ⑥ 再制造一次真失败（把会话指到一个连不上的地址）；
 *  ⑦ 点删除 → 那条气泡从 DOM 里消失，用户那句还留着。
 *
 * 跑法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/test/chat-failed-e2e.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '../..')
const userData = path.join(os.tmpdir(), 'nc-failed-e2e-' + Date.now())
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setAppPath(projectRoot)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ defaultCharacterId: 'nahida', memory: { enabled: false, autoExtract: false } }, null, 2),
  'utf8'
)
// 预先塞一条「失败」的回复：这就是用户截图里的那种状态（status=error + 空正文）
fs.writeFileSync(
  path.join(userData, 'sessions.json'),
  JSON.stringify([
    {
      id: 'SEED-FAILED',
      title: '失败样本',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      characterId: 'nahida',
      mode: 'chat',
      workspaceId: null,
      messages: [
        { id: 'u-1', role: 'user', content: '在吗', createdAt: Date.now(), status: 'done' },
        {
          id: 'a-1',
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          status: 'error',
          error: '连接被重置（测试注入）',
          toolCalls: []
        }
      ]
    }
  ], null, 2),
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
  await sleep(900)

  // ① ② ③ 失败态的界面
  const failedView = await win.webContents.executeJavaScript(
    '(() => {'
      + 'const bubbles = [...document.querySelectorAll(".message--assistant .bubble")];'
      + 'const bubble = bubbles[bubbles.length - 1];'
      + 'const actions = document.querySelector(".bubble-actions");'
      + 'return {'
      + '  typing: document.querySelectorAll(".typing").length,'
      + '  text: bubble ? bubble.innerText.trim() : "",'
      + '  hasActions: Boolean(actions),'
      + '  hasRetry: Boolean(document.querySelector(".bubble-actions__retry")),'
      + '  hasRemove: Boolean(document.querySelector(".bubble-actions__remove")),'
      + '  userBubbles: document.querySelectorAll(".message--user").length'
      + '}'
      + '})()'
  )
  check('F-01 失败气泡里没有打字动画（不再卡在三个点）', failedView.typing === 0, 'typing=' + failedView.typing)
  check('F-02 气泡里写着失败原因', failedView.text.includes('连接被重置'), failedView.text.slice(0, 40))
  check('F-03 两个键都在（重试这一轮 / 删除这条）', failedView.hasRetry && failedView.hasRemove,
    JSON.stringify({ actions: failedView.hasActions, retry: failedView.hasRetry, remove: failedView.hasRemove }))

  // ④ ⑤ 点重试，等真的跑完
  await win.webContents.executeJavaScript(
    'document.querySelector(".bubble-actions__retry").click(); true'
  )
  // 🔴 判「跑完了」必须问主进程要状态，不能只看 DOM：
  //    第一个增量一到，气泡就有字、按钮也消失了 —— 那时这一轮其实还在跑
  //    （真机上就是这么误判的：紧接着 updateSession 报「正在生成」）。
  const retried = await win.webContents.executeJavaScript(
    'new Promise(async (resolve) => {'
      + 'const deadline = Date.now() + 25000;'
      + 'const tick = async () => {'
      + '  const all = await window.nahida.chat.listSessions();'
      + '  const s = all.find((item) => item.id === "SEED-FAILED");'
      + '  const tail = s ? s.messages[s.messages.length - 1] : null;'
      + '  if (tail && tail.status === "done" && tail.content.length > 0) {'
      + '    const bubbles = [...document.querySelectorAll(".message--assistant .bubble")];'
      + '    const last = bubbles[bubbles.length - 1];'
      + '    return resolve({ ok: true, text: last ? last.innerText.trim() : "", messages: s.messages.length, userBubbles: document.querySelectorAll(".message--user").length, typing: document.querySelectorAll(".typing").length, actions: document.querySelectorAll(".bubble-actions").length });'
      + '  }'
      + '  if (Date.now() > deadline) return resolve({ ok: false, tail: tail && tail.status, typing: document.querySelectorAll(".typing").length });'
      + '  setTimeout(tick, 120);'
      + '};'
      + 'tick();'
      + '})'
  )
  check('F-04 点重试后气泡里出现了正文（真的重跑了一轮）', retried.ok === true && retried.text.length > 0,
    (retried.text || '').slice(0, 30) + ' / ' + retried.text.length + ' 字')
  check('F-05 重试没有重复用户那句（user 气泡仍是 1 个，消息总数 2 条）',
    retried.userBubbles === 1 && retried.messages === 2,
    JSON.stringify({ users: retried.userBubbles, messages: retried.messages }))

  // ⑥ 再制造一次**真**失败：把会话指到一个连不上的地址，再发一句
  const failed2 = await win.webContents.executeJavaScript(
    'new Promise(async (resolve) => {'
      + 'const catalog = await window.nahida.modelProfiles.save({ name: "死地址", provider: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-dead", models: ["dead"], defaultModel: "dead", temperature: 1, modelOptions: {} });'
      + 'const profile = catalog.profiles.find((p) => p.baseUrl === "http://127.0.0.1:9/v1");'
      + 'if (!profile) return resolve({ ok: false, error: "没找到刚存的死地址档案" });'
      + 'await window.nahida.chat.updateSession("SEED-FAILED", { modelProfileId: profile.id, modelId: "dead" });'
      + 'await window.nahida.chat.send({ sessionId: "SEED-FAILED", content: "再试一次" });'
      + 'const deadline = Date.now() + 25000;'
      + 'const tick = async () => {'
      + '  const all = await window.nahida.chat.listSessions();'
      + '  const s = all.find((item) => item.id === "SEED-FAILED");'
      + '  const tail = s ? s.messages[s.messages.length - 1] : null;'
      + '  const bubbles = [...document.querySelectorAll(".message--assistant .bubble")];'
      + '  const last = bubbles[bubbles.length - 1];'
      + '  const text = last ? last.innerText.trim() : "";'
      + '  if (tail && tail.status === "error") {'
      + '    return resolve({ ok: true, reason: tail.error || "", status: tail.status });'
      + '  }'
      + '  if (Date.now() > deadline) return resolve({ ok: false, reason: tail ? String(tail.status) + " / " + String(tail.error || "") : "no-tail" });'
      + '  setTimeout(tick, 120);'
      + '};'
      + 'tick();'
      + '})'
  )
  // 🔴 直接调 IPC 发的那一句不会进渲染层的 store（store 的 send() 才负责把消息塞进列表），
  //    所以必须整页重载让 store 从主进程读回落库结果 —— 和 ui:map 的播种同一条道理。
  //    这不是测试技巧：真实用户的失败气泡就是「重开应用后仍然在」的那个状态。
  await win.loadFile(indexHtml, { hash: '/chat', query: { v: String(Date.now() + 2) } })
  await sleep(900)
  const shown = await win.webContents.executeJavaScript(
    '(() => {'
      + 'const bubbles = [...document.querySelectorAll(".message--assistant .bubble")];'
      + 'const last = bubbles[bubbles.length - 1];'
      + 'return {'
      + '  text: last ? last.innerText.trim() : "",'
      + '  typing: document.querySelectorAll(".typing").length,'
      + '  actions: document.querySelectorAll(".bubble-actions").length,'
      + '  hasRetry: Boolean(document.querySelector(".bubble-actions__retry")),'
      + '  hasRemove: Boolean(document.querySelector(".bubble-actions__remove"))'
      + '}'
      + '})()'
  )
  check('F-06 真失败（连不上）也落到同一个失败态：原因写在气泡里、不转圈、两个键都在',
    failed2.ok === true && shown.text.includes('fetch failed') && shown.typing === 0 && shown.hasRetry && shown.hasRemove,
    JSON.stringify({ reason: failed2.reason, text: shown.text.slice(0, 40), typing: shown.typing, retry: shown.hasRetry }))

  // ⑦ 点删除：那条气泡消失，用户那句还在
  const removed = await win.webContents.executeJavaScript(
    'new Promise((resolve) => {'
      + 'const target = document.querySelector(".bubble-actions__remove");'
      + 'if (!target) return resolve({ ok: false, error: "没有可删的失败气泡" });'
      + 'const before = document.querySelectorAll(".message--assistant .bubble").length;'
      + 'const userBefore = document.querySelectorAll(".message--user").length;'
      + 'target.click();'
      + 'const deadline = Date.now() + 8000;'
      + 'const tick = () => {'
      + '  const after = document.querySelectorAll(".message--assistant .bubble").length;'
      + '  if (after === before - 1) return resolve({ ok: true, before, after, userBefore, userAfter: document.querySelectorAll(".message--user").length });'
      + '  if (Date.now() > deadline) return resolve({ ok: false, before, after });'
      + '  setTimeout(tick, 100);'
      + '};'
      + 'tick();'
      + '})'
  )
  check('F-07 点删除后那条气泡真的没了，用户那句还留着',
    removed.ok === true && removed.userAfter === removed.userBefore,
    JSON.stringify(removed))

  // ⑧ 收尾：测试留下的死地址档案要清掉（不然 next 次看设置页会多一行）
  const cleanup = await win.webContents.executeJavaScript(
    '(async () => {'
      + 'const catalog = await window.nahida.modelProfiles.list();'
      + 'const dead = catalog.profiles.find((item) => item.baseUrl === "http://127.0.0.1:9/v1");'
      + 'if (dead) await window.nahida.modelProfiles.remove(dead.id);'
      + 'const after = await window.nahida.modelProfiles.list();'
      + 'return { before: dead ? 1 : 0, after: after.profiles.filter((item) => item.baseUrl === "http://127.0.0.1:9/v1").length };'
      + '})()'
  )
  check('F-08 测试用的死地址档案已清理（不留污染）', cleanup.before === 1 && cleanup.after === 0, JSON.stringify(cleanup))

  const failed = checks.filter((item) => !item.ok)
  console.log('')
  console.log('共 ' + checks.length + ' 项，通过 ' + (checks.length - failed.length) + ' 项')
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
