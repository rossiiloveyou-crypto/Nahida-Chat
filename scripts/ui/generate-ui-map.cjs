/**
 * 生成「可定位截图」：docs/ui/ui-map-v{版本}.png
 *
 * 做的事：
 * 1. 起一个真实的 Electron 窗口（独立 userData，不碰真实配置）
 * 2. 打开指定路由，开启网格覆盖层（?grid=1）
 * 3. 截全窗口内容区（不含系统标题栏），另存一张无网格的对照图
 * 4. 把网格覆盖层报告的 区域/元素 坐标写进 docs/ui/ui-map-v{版本}.json，
 *    供 UI_MAP.md 与后续定位使用
 *
 * 跑法：pnpm ui:map
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

/**
 * 命令行参数（都可省略，省略时按 Nahida Chat 默认值）：
 *   --project=<目录>   要截图的项目根（必须已 pnpm build，存在 out/main/index.js）
 *   --views=<json>     视图清单，形如 [{"hash":"/chat","name":"chat","primary":true}]
 *   --size=1280x860    内容区尺寸
 *   --out=<目录>       图片与 json 输出目录，默认 <project>/docs/ui
 *   --userdata=<目录>  隔离的 userData，默认临时目录
 *   --theme=light|dark 以哪个主题启动（默认 light）。dark 时写一份预置配置到隔离 userData，
 *                      主进程读到后会把窗口底色与 initialTheme 都切成深色（PHASE-1 §六 A6）
 */
function argValue(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : fallback
}

const projectRoot = path.resolve(argValue('project', path.resolve(__dirname, '../..')))
const outDir = path.resolve(argValue('out', path.join(projectRoot, 'docs', 'ui')))
const sizeRaw = argValue('size', '1280x860')
const [viewWidth, viewHeight] = sizeRaw.split('x').map((value) => Number(value))
const theme = argValue('theme', 'light') === 'dark' ? 'dark' : 'light'
const userData = path.resolve(
  argValue('userdata', path.join(require('node:os').tmpdir(), 'dsh-uimap-' + Date.now()))
)

// 每次从干净配置开始，截图才能稳定复现
fs.rmSync(userData, { recursive: true, force: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })

// 深色出图：必须在 rmSync **之后**写预置配置，否则会被上面那行删掉。
// 只往隔离目录写，绝不碰用户真实的 %APPDATA%/nahida-chat/settings.json。
if (theme === 'dark') {
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ appearance: { theme: 'dark' } }, null, 2),
    'utf8'
  )
}

app.setPath('userData', userData)
app.setAppPath(projectRoot)

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const version = pkg.version.split('.')[0] || '1'

/** 入口探测：不同 Electron 脚手架产物路径不同，这里按常见位置找。 */
function resolveMainEntry() {
  const candidates = [
    path.join(projectRoot, 'out', 'main', 'index.js'),
    path.join(projectRoot, 'dist', 'main', 'index.js'),
    path.join(projectRoot, 'out', 'main', 'index.cjs'),
    path.join(projectRoot, 'dist', 'main', 'index.cjs')
  ]
  const found = candidates.find((item) => fs.existsSync(item))
  if (!found) {
    throw new Error('找不到主进程产物，先构建项目：' + candidates.join(' / '))
  }
  return found
}

require(resolveMainEntry())

/**
 * 截图清单：默认是 Nahida Chat 的全部设置分区，可用 --views=<json> 覆盖。
 * 新增设置分区时记得往这里加一行，否则 pnpm ui:map 会安静地少出一张图
 * ——之前长期记忆就是这么被漏掉的。
 */
const DEFAULT_VIEWS = [
  { hash: '/chat', name: 'chat-empty', primary: true },
  // P6 起首页首帧是 Chat 模式，侧栏**有意**不渲染工作区段 —— 于是 A2 区域会整块从图上消失。
  // 补两个 Agent 态视图，把「工作区列表」和「零工作区门禁态」重新变成可定位的：
  //   click            = 开拍前先点这个元素（用来切到 Agent 模式）
  //   workspaces:'empty' = 开拍前把工作区清单清空（用来复现门禁态）
  { hash: '/chat', name: 'chat-agent', click: '[data-ui-target="Agent"]' },
  { hash: '/chat', name: 'chat-agent-gated', click: '[data-ui-target="Agent"]', workspaces: 'empty' },
  { hash: '/settings/models', name: 'settings-models' },
  { hash: '/settings/prompts', name: 'settings-prompts' },
  { hash: '/settings/memory', name: 'settings-memory' },
  { hash: '/settings/zones', name: 'settings-zones' },
  { hash: '/settings/zones', name: 'settings-zones-lower', scrollY: 900 },
  { hash: '/settings/qq', name: 'settings-qq' },
  { hash: '/settings/qq', name: 'settings-qq-lower', scrollY: 520 },
  { hash: '/settings/qq', name: 'settings-qq-events', scrollY: 1350 },
  { hash: '/settings/tools', name: 'settings-tools' },
  { hash: '/settings/appearance', name: 'settings-appearance' },
  { hash: '/settings/about', name: 'settings-about' }
]
const VIEWS = JSON.parse(argValue('views', JSON.stringify(DEFAULT_VIEWS)))

app.whenReady().then(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('没有找到主窗口')
    app.exit(1)
    return
  }

  // 统一尺寸，保证网格坐标可复现
  win.setContentSize(viewWidth, viewHeight)
  // 窗口必须真的可见：隐藏窗口下 capturePage 会一直返回同一帧旧画面
  win.showInactive()
  await new Promise((resolve) => setTimeout(resolve, 600))

  /**
   * 把鼠标 hover 从画面里摘掉（P4 新增）。
   *
   * 窗口出现时如果正好压在光标下面，Chromium 会给那个元素置上 :hover——
   * 于是「同一个构建、同一份代码」两次出图会差出一个胶囊的边框（实测 3967px，
   * 落在 .composer-pick 上），逐像素比对就会误报成样式回归。
   * 合成一条 mouseMove 到左上角，hover 状态立刻清掉，且不移动用户的真实光标。
   * 每次截图前都要重发一次：换路由后指针仍停在原位置，hover 会重新命中。
   */
  const clearHover = () => win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
  clearHover()

  const indexHtml = [
    path.join(projectRoot, 'out', 'renderer', 'index.html'),
    path.join(projectRoot, 'dist', 'renderer', 'index.html'),
    path.join(projectRoot, 'dist', 'index.html')
  ].find((item) => fs.existsSync(item))
  if (!indexHtml) {
    console.error('找不到渲染页产物（out/renderer/index.html 或 dist/index.html）')
    app.exit(1)
    return
  }
  const report = { version, projectRoot, theme, contentSize: { width: viewWidth, height: viewHeight }, views: {} }

  // 播种用的目录：必须真实存在，否则 workspaces.save 会以「目录不存在」拒绝
  const seedDir = path.join(userData, 'ui-map-workspace')
  fs.mkdirSync(seedDir, { recursive: true })

  for (const [viewIndex, view] of VIEWS.entries()) {
    // 开拍前把工作区清单调到视图要求的状态（P6）。
    // 必须在 loadFile **之前**做：useWorkspaces 是模块级单例，只有整页重载才会重新拉取；
    // 直接调 IPC 改完再截，渲染层手里还是旧清单。
    const want = view.workspaces === 'empty' ? 0 : Math.max(1, view.workspaces === undefined ? 1 : Number(view.workspaces) || 1)
    await win.webContents.executeJavaScript(`
      (async () => {
        const want = ${want}
        let cat = await window.nahida.workspaces.list()
        while (cat.workspaces.length > want) {
          cat = await window.nahida.workspaces.remove(cat.workspaces[cat.workspaces.length - 1].id)
        }
        while (cat.workspaces.length < want) {
          cat = await window.nahida.workspaces.save({ name: '', dir: ${JSON.stringify(seedDir)} })
        }
        return cat.workspaces.length
      })()
    `)

    // ?grid=1 走 query，HashRouter 下 hash 里再放路由。
    // v=<序号> 是**必需的**：两个视图只要 hash 和 query 完全相同（例如 chat-agent 与
    // chat-agent-gated 都在 /chat），loadFile 就不会真的导航 —— React 树不重建、
    // useWorkspaces 的模块级单例还留着上一视图的清单，于是播种结果被旧状态盖掉，
    // 拍出来的图和视图声明不符（P6 实测：门禁态那张带着工作区、输入框也没门禁）。
    // 加一个视图唯一的 query 让每个视图真正从白页开始加载。
    await win.loadFile(indexHtml, { hash: view.hash, query: { grid: '1', v: String(viewIndex) } })
    // 兜底：上一轮的隐藏 class 不会跨页面保留，但热重载等场景可能残留
    await win.webContents.executeJavaScript(
      "document.querySelector('.ui-grid')?.classList.remove('ui-grid--hidden')"
    ).catch(() => {})

    // 视图级点击（P6）：用来切到 Agent 模式这类「首帧拿不到、必须交互才出现」的状态。
    // 元素可能还没渲染（loadFile 回来时 React 只挂了一部分），所以在页内重试等它出现。
    if (typeof view.click === 'string' && view.click) {
      const clicked = await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const sel = ${JSON.stringify(view.click)}
          const deadline = Date.now() + 8000
          const tick = () => {
            const node = document.querySelector(sel)
            if (node) { node.click(); return resolve(true) }
            if (Date.now() > deadline) return resolve(false)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      `)
      if (!clicked) {
        // 点不到就停下：静默截一张「没点成功」的图比少一张图更糟（会拿错图当证据）
        console.error('点击目标不存在：' + view.click + '（视图 ' + view.name + '）')
        app.exit(3)
        return
      }
      // 覆盖层只在 mount / 路由变化 / resize / scroll 时重测；点击会挂载新 DOM，
      // 派发一次 scroll 强制它重测，否则 JSON 坐标是新的、画在图上的框还是旧的（或干脆没有）。
      await win.webContents.executeJavaScript("window.dispatchEvent(new Event('scroll'))")
      await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const start = Number(document.documentElement.dataset.uiTargets || 0)
          const deadline = Date.now() + 5000
          const tick = () => {
            const now = Number(document.documentElement.dataset.uiTargets || 0)
            if (now !== start) return resolve(now)
            if (Date.now() > deadline) return resolve(now)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      `)
    }

    // 等到「当前路由的量测结果」就绪再截图：
    // 覆盖层挂在 Routes 外面，DOM 不随页面重建，只判断元素存在会拿到上一页的坐标。
    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const expected = ${JSON.stringify(view.hash)}
        const deadline = Date.now() + 10000
        const tick = () => {
          const ready = document.documentElement.dataset.uiReady
          const targets = Number(document.documentElement.dataset.uiTargets || 0)
          const labels = document.querySelectorAll('.ui-grid__col-label').length
          if (ready === expected && targets > 0 && labels > 0) {
            return resolve({ ready, targets })
          }
          if (Date.now() > deadline) return reject(new Error('网格未就绪: ' + ready + ' target=' + expected))
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    `)
    // 长页面（如设置页的 QQ 面板）允许按视图指定纵向滚动位置：
    // 覆盖层已监听 scroll（capture=true），滚动后会重新量测，坐标仍按视口记。
    if (typeof view.scrollY === 'number' && view.scrollY > 0) {
      // 设置页真正的滚动容器是 .settings-page（overflow-y:auto），不是 window；
      // 两个都滚一遍，避免不同页面容器实现差异。
      await win.webContents.executeJavaScript(
        '(function(){' +
          'var y = ' + String(Math.round(view.scrollY)) + ';' +
          'var page = document.querySelector(".settings-page");' +
          'if (page && page.scrollHeight > page.clientHeight) page.scrollTo(0, y);' +
          'window.scrollTo(0, y);' +
          'return true;' +
        '})()'
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
    // P6 修复：设置页的内容是**异步加载**的（宿主状态 / 设置项过了几百毫秒才渲染）。
    // 上面那次滚动发生得太早，page.scrollHeight 还是"空页"的高度，scrollTop 被钳在很小的值上；
    // 等内容长出来之后 scrollTop 不会自动变大 ⇒ 长页面永远只能截到前 138px（QQ 的「最近事件」根本进不了图）。
    // 这里在截图前重放一次（此时内容已就位），并等覆盖层按新 scrollTop 重新量测。
    if (typeof view.scrollY === 'number' && view.scrollY > 0) {
      await win.webContents.executeJavaScript(
        '(function(){' +
          'var y = ' + String(Math.round(view.scrollY)) + ';' +
          'var page = document.querySelector(".settings-page");' +
          'if (page) page.scrollTo(0, y);' +
          'window.scrollTo(0, y);' +
          'window.dispatchEvent(new Event("scroll"));' +
          'return true;' +
        '})()'
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // 截图前再清一次 hover：上一张图之后可能有人动过鼠标，或路由重排让指针落到别的元素上
    clearHover()
    await new Promise((resolve) => setTimeout(resolve, 120))
    let png = (await win.webContents.capturePage()).toPNG()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = (await win.webContents.capturePage()).toPNG()
      if (!next.equals(png)) {
        png = next
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 350))
      png = next
    }

    // 覆盖层在首帧后异步测量，等它画完
    const geometry = await win.webContents.executeJavaScript(`
      (() => {
        const els = [...document.querySelectorAll('[data-ui-target]')]
        const regions = [...document.querySelectorAll('[data-ui-region]')]
        const rect = (node) => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) } }
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          regions: regions.map((node) => ({ label: node.dataset.uiRegion, ...rect(node) })),
          targets: els.map((node, index) => ({ index: index + 1, label: node.dataset.uiTarget, tag: node.tagName.toLowerCase(), ...rect(node) })),
        }
      })()
    `)

    // 网格图；主视图额外存一份不带后缀的 ui-map-v{版本}.png，方便直接引用
    fs.writeFileSync(path.join(outDir, `ui-map-v${version}-${view.name}.png`), png)
    if (view.primary) {
      fs.writeFileSync(path.join(outDir, `ui-map-v${version}.png`), png)
    }

    // 无网格对照图：用 class 隐藏，别写内联 style——内联样式会留到下一个视图
    await win.webContents.executeJavaScript(
      "document.querySelector('.ui-grid')?.classList.add('ui-grid--hidden')"
    )
    // 等覆盖层真的 display:none，否则下面抓到的仍是隐藏前的旧帧
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const overlay = document.querySelector('.ui-grid')
        const hidden = () => !overlay || getComputedStyle(overlay).display === 'none'
        if (hidden()) return resolve(true)
        const deadline = Date.now() + 3000
        const tick = () => {
          if (hidden()) return resolve(true)
          if (Date.now() > deadline) return resolve(false)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    `)
    // 关键：连续两次取帧一致才落盘。
    // 只等固定时长就抓一帧，会抓到隐藏网格前的旧帧 —— ui-clean-*.png 会混进网格图，
    // 之后"零视觉变更"的逐像素比对就会拿网格图当基线，比出几十万像素的假差异。
    clearHover()
    let clean = (await win.webContents.capturePage()).toPNG()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const next = (await win.webContents.capturePage()).toPNG()
      if (next.equals(clean)) break
      clean = next
    }
    fs.writeFileSync(path.join(outDir, `ui-clean-v${version}-${view.name}.png`), clean)

    report.views[view.name] = geometry
    console.log('已生成', view.name, '区域', geometry.regions.length, '元素', geometry.targets.length)
  }

  // 出图后自检：深色出图必须真的落在深色上，不能因为配置没生效而静默出一套浅色图
  const probe = await win.webContents.executeJavaScript(
    "({ theme: document.documentElement.dataset.theme || 'light', canvas: getComputedStyle(document.documentElement).getPropertyValue('--nc-canvas').trim() })"
  )
  report.observedTheme = probe
  console.log('观测主题', JSON.stringify(probe), '期望', theme)
  if (probe.theme !== theme) {
    console.error('主题未生效：期望', theme, '实得', probe.theme, '—— 出图结果不可信')
    app.exit(2)
    return
  }

  fs.writeFileSync(path.join(outDir, `ui-map-v${version}.json`), JSON.stringify(report, null, 2), 'utf8')
  console.log('完成：docs/ui/ui-map-v' + version + '.json')
  app.exit(0)
})
