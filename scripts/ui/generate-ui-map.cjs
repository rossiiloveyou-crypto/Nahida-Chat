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
const { app, BrowserWindow, dialog } = require('electron')
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
// Isolated builds avoid cleaning occupied host artifacts under out/.
const buildRoot = path.resolve(argValue('build', path.join(projectRoot, 'out')))
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
seedObserveFiles()
const transferFixture = path.join(userData, 'transfer-fixture.jsonl')
fs.writeFileSync(transferFixture, [
  { user_name: '访客', character_name: '示例角色' },
  { name: '访客', is_user: true, mes: '你看见了什么？' },
  { name: '示例角色', is_user: false, mes: '窗外的雨停了。' }
].map((entry) => JSON.stringify(entry)).join('\n'), 'utf8')
const showOpenDialog = dialog.showOpenDialog
let useTransferFixture = false
dialog.showOpenDialog = (...args) => useTransferFixture
  ? Promise.resolve({ canceled: false, filePaths: [transferFixture] })
  : showOpenDialog.apply(dialog, args)

// M27：可选隔离夹具，让来源徽标同时出现；绝不触碰真实 userData。
const promptCheck = process.argv.includes('--verify-prompt-roots')
const promptOpened = []
if (promptCheck) {
  const custom = path.join(userData, 'prompt', 'characters', 'test-a')
  fs.mkdirSync(custom, { recursive: true })
  fs.writeFileSync(path.join(custom, 'soul.md'), '# 自定义示例\n\n仅用于提示词库定位图。\n')
  require('electron').shell.openPath = async (target) => { promptOpened.push(target); return '' }
}

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


/**
 * 旁听库样本（只写隔离 userData）。
 *
 * 为什么必须有：旁听面板现在是「一行概要 + 一个入口」，入口没数据就是禁用态，
 * 弹层截图只会是一句「还没有任何旁听记录」—— 那样拍出来的图和没做一样。
 * 这里按真源布局 userData/observe/qq/<uin>/<chatType>/<chatId>.jsonl 造几行，
 * 两个账号记同一个群，好让「⧉2 多账号」也在图上。
 */
function seedObserveFiles() {
  const root = path.join(userData, 'observe', 'qq')
  const line = (uin, chatType, chatId, chatLabel, at, text, name) =>
    JSON.stringify({
      v: 1,
      id: 'seed-' + uin + '-' + chatId + '-' + at,
      at,
      sessionId: 'qq:' + uin + ':' + chatType + ':' + chatId,
      key: 'qq:' + uin + ':' + chatType + ':' + chatId,
      channel: 'qq',
      uin,
      chatType,
      chatId,
      chatLabel,
      entryLabel: '',
      messageId: String(at),
      speakerId: '9000' + at,
      speakerName: name,
      speakerCard: '',
      isBot: false,
      mentioned: false,
      triggered: false,
      allowed: false,
      outcome: 'dropped-not-allowed',
      text,
      segmentTypes: ['text']
    })
  const write = (uin, chatType, chatId, lines) => {
    const dir = path.join(root, uin, chatType)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, chatId + '.jsonl'), lines.join('\n') + '\n', 'utf8')
  }
  const base = 1761000000000
  write('10001', 'group', '123456789', [
    line('10001', 'group', '123456789', '时钟研究小组', base, '钟楼到底为什么停？', '阿雨'),
    line('10001', 'group', '123456789', '时钟研究小组', base + 60000, '听说是没人上发条了。', '老周'),
    line('10001', 'group', '123456789', '时钟研究小组', base + 120000, '那上去看看不就知道了。', '阿雨')
  ])
  write('10002', 'group', '123456789', [
    line('10002', 'group', '123456789', '时钟研究小组', base + 30000, '同上，我也记一份。', '阿雨'),
    line('10002', 'group', '123456789', '时钟研究小组', base + 90000, '两个号互为备份。', '老周')
  ])
  write('10001', 'group', '987654321', [
    line('10001', 'group', '987654321', '雨夜读书会', base + 240000, '今晚读哪一本？', '小满'),
    line('10001', 'group', '987654321', '雨夜读书会', base + 300000, '还是那本没读完的。', '阿雨')
  ])
  write('10001', 'private', '20001', [
    line('10001', 'private', '20001', '', base + 420000, '在吗', '小满'),
    line('10001', 'private', '20001', '', base + 480000, '我在。', '阿雨')
  ])
  console.log('  已播种旁听样本（observe/qq 下 4 个会话）')
}

/** 入口探测：不同 Electron 脚手架产物路径不同，这里按常见位置找。 */
function resolveMainEntry() {
  const candidates = [
    path.join(buildRoot, 'main', 'index.js'),
    path.join(projectRoot, 'dist', 'main', 'index.js'),
    path.join(buildRoot, 'main', 'index.cjs'),
    path.join(projectRoot, 'dist', 'main', 'index.cjs')
  ]
  const found = candidates.find((item) => fs.existsSync(item))
  if (!found) {
    throw new Error('找不到主进程产物，先构建项目：' + candidates.join(' / '))
  }
  return found
}

// Q3: optional isolated preset fixture, resolved through the real bridge config and regex IPC.
const q3PresetFixture = process.argv.includes('--q3-preset-fixture')
const q35OptionsFixture = process.argv.includes('--q35-options-fixture')
const q35Opening = '雨点敲在钟楼的铜面上。\n<options>\n<option>😏 走到沙发旁坐下，端起水杯喝一口，顺便打量屋里的陈设</option>\n<option>🥺 站在茶几旁有点拘谨，轻声问她一个人住这么大的房子习不习惯</option>\n<option>😂 笑着指了指茶几上的打火机和指甲刀，调侃她平时还挺会享受生活</option>\n</options>\n<summary>雨夜的小镇里，钟楼停了。</summary>\n<comment>喵呼呼，一起去看看吧。</comment>'
if (q3PresetFixture) {
  const stRoot = path.join(userData, 'fixture-st')
  const stDir = path.join(stRoot, 'data-nc', 'default-user')
  fs.mkdirSync(path.join(stDir, 'OpenAI Settings'), { recursive: true })
  fs.mkdirSync(path.join(userData, 'nc-bridge'), { recursive: true })
  fs.writeFileSync(path.join(userData, 'nc-bridge', 'config.json'), JSON.stringify({ stRoot }))
  fs.writeFileSync(path.join(stDir, 'settings.json'), JSON.stringify({ oai_settings: { preset_settings_openai: 'q3-fixture' } }))
  const fixture = JSON.parse(fs.readFileSync(path.join(projectRoot, 'scripts', 'fixtures', 'st-settings.json'), 'utf8'))
  fs.writeFileSync(path.join(stDir, 'OpenAI Settings', 'q3-fixture.json'), JSON.stringify({ regex_scripts: fixture.oai_settings.extensions.regex_scripts }))
}
require(resolveMainEntry())

/**
 * 截图清单：默认是 Nahida Chat 的全部设置分区，可用 --views=<json> 覆盖。
 * 新增设置分区时记得往这里加一行，否则 pnpm ui:map 会安静地少出一张图
 * ——之前长期记忆就是这么被漏掉的。
 */
const DEFAULT_VIEWS = [
  { hash: '/chat', name: 'chat-empty', primary: true },
  { hash: '/chat', name: 'chat-dialogue', seedPreSend: true, click: '[data-ui-target="故事卡片 预发送演示"]' },
  // P6 起首页首帧是 Chat 模式，侧栏**有意**不渲染工作区段 —— 于是 A2 区域会整块从图上消失。
  // 补两个 Agent 态视图，把「工作区列表」和「零工作区门禁态」重新变成可定位的：
  //   click            = 开拍前先点这个元素（用来切到 Agent 模式）
  //   workspaces:'empty' = 开拍前把工作区清单清空（用来复现门禁态）
  { hash: '/chat', name: 'chat-agent', click: '[data-ui-target="Agent"]' },
  { hash: '/chat', name: 'chat-agent-gated', click: '[data-ui-target="Agent"]', workspaces: 'empty' },
  // P9：对话样本 —— 把「AI 头像 / 用户头像 / 气泡」变成可定位的。
  // 空态图上根本没有消息，MessageList 里的头像与气泡一个都不存在，改头像样式时无从报坐标。
  // seedChat 用演示模式（本地回显、不联网）跑真实一轮，落库后整页重载再拍。
  {
    hash: '/chat',
    name: 'chat-conversation',
    seedChat: [
      '用三句话说明 RAG 和微调的区别',
      '那在本地优先的客户端里，你会先做哪一个'
    ]
  },
  // 角色切换（第 8 轮）：点开输入区最左的「角色选择」。
  // 不加这一张就只能证明"有那个按钮"，证明不了菜单里列的是**提示词库里的角色**、当前那个打了勾。
  {
    hash: '/chat',
    name: 'chat-character-menu',
    seedChat: ['用三句话说明 RAG 和微调的区别', '那在本地优先的客户端里，你会先做哪一个'],
    click: '[data-ui-target="角色选择"]'
  },
  // 失败的一轮（2026-11-14）：气泡里写原因 + 「重试这一轮 / 删除这条」。
  // 用**真失败**播种（把会话指到一个连不上的本地地址发一句），不是往页内塞假数据。
  { hash: '/chat', name: 'chat-failed-turn', seedFailure: true },
  { hash: '/settings/models', name: 'settings-models' },
  { hash: '/settings/prompts', name: 'settings-prompts' },
  { hash: '/settings/prompts', name: 'settings-prompts-roles', scrollY: 374 },
  { hash: '/settings/prompts', name: 'settings-prompts-files', scrollY: 374, click: '[data-ui-target="角色文件"]' },
  // P9：世界书编写器弹层（列表默认 8 条 + 展开按钮 + 新增表单）。
  // 点「打开世界书编辑器」后弹层自己会拉 knownDirs 并落到默认角色的 worldbook 目录。
  { hash: '/settings/prompts', name: 'worldbook-editor', click: '[data-ui-target="世界书编辑器入口"]' },
  // P7：故事区三视图（主界面双分区 / 抽屉展开 / 设置·故事区）
  ...(q35OptionsFixture ? ['chat-options', 'chat-options-filled'].map(name => ({ hash: '/chat', name, seedStory: true, click: ['[data-ui-target="新建对话"]', '[data-ui-target="故事"]', '[data-ui-target="故事卡片 时钟之谜"]'] })) : []),
  { hash: '/chat', name: 'chat-stories', seedStory: true, click: ['[data-ui-target="新建对话"]', '[data-ui-target="故事"]'] },
  ...(q3PresetFixture ? [{ hash: '/chat', name: 'chat-story-preset', seedStory: true, click: ['[data-ui-target="新建对话"]', '[data-ui-target="故事"]', '[data-ui-target="故事卡片 时钟之谜"]'], scrollSelector: '.message-list', scrollY: 0 }] : []),
  { hash: '/chat', name: 'chat-story-drawer', seedStory: true, click: ['[data-ui-target="新建对话"]', '[data-ui-target="故事"]', '[data-ui-target="故事卡片 时钟之谜"]', '[data-ui-target="打开分支抽屉"]'] },
  // Q1: explicit long-history views expose the new control and absolute message numbering.
  { hash: '/chat', name: 'chat-pagination', pagination: 10 },
  { hash: '/chat', name: 'chat-pagination-expanded', pagination: 20 },
  { hash: '/settings/stories', name: 'settings-stories', seedStory: true },
  // P8：新建故事区表单（含「背景与剧本设定」与「开场消息」两栏）
  { hash: '/chat', name: 'new-story-dialog', click: ['[data-ui-target="新建对话"]', '[data-ui-target="故事"]', '[data-ui-target="新建故事"]'] },
  { hash: '/settings/memory', name: 'settings-memory' },
  { hash: '/settings/memory', name: 'settings-story-recall', scrollY: 740 },
  { hash: '/settings/memory', name: 'settings-memory-facts', scrollY: 1580, click: '[data-ui-target="普通聊天事实记忆"] summary' },
  // P5：按人聚合面板在页面下半部分（对话摘要之后），补一张下滚视图让新表格可定位
  { hash: '/settings/memory', name: 'settings-memory-lower', scrollY: 1080 },
  // P7（H-25）：危险区在页面最末（top ≈ 2000+），上面两张都够不到。
  // 这一张专门证明「清空全部数据」与「按人删除」两个按钮在**列表态**就能看见（D-1 的回归证据）。
  // 滚到底（超出会自然夹到最大），并把弹框也拍一张（D-4 的占位文字是否还被截断）。
  { hash: '/settings/memory', name: 'settings-memory-danger', scrollY: 2400 },
  {
    hash: '/settings/memory',
    name: 'settings-memory-wipe-dialog',
    scrollY: 2400,
    click: '[data-ui-target="清空全部数据"] button'
  },
  // P7：渠道控制台（私聊 / 群聊两块 + 数据位置）。面板高约两屏，故补一张下滚视图。
  { hash: '/settings/channels', name: 'settings-channels' },
  { hash: '/settings/channels', name: 'settings-channels-lower', scrollY: 760 },
  // P8：D 区「旁听库」在 C 区之后（面板最下方），单独一张把它变成可定位的
  // 群号收进弹层之后，面板下半部分（概要 + 入口）才是要看的东西 → 滚到底（超出会自然夹到最大）
  { hash: '/settings/channels', name: 'settings-channels-observe', scrollY: 3200 },
  // 旁听群号一览（弹层）：群号收进弹层之后，这是唯一能证明「收起来了 + 能搜」的图
  {
    hash: '/settings/channels',
    name: 'settings-channels-observe-groups',
    scrollY: 3200,
    click: '[data-ui-target="打开群号一览"]'
  },
  { hash: '/settings/qq', name: 'settings-qq' },
  { hash: '/settings/qq', name: 'settings-qq-lower', scrollY: 520 },
  { hash: '/settings/qq', name: 'settings-qq-threshold', scrollY: 1400 },
  { hash: '/settings/qq', name: 'settings-qq-events', scrollY: 1350 },
  { hash: '/settings/tools', name: 'settings-tools' },
  { hash: '/settings/bridge', name: 'settings-bridge' },
  { hash: '/settings/bridge', name: 'settings-bridge-lower', scrollY: 650 },
  { hash: '/settings/bridge', name: 'settings-bridge-status', scrollY: 1200 },
  { hash: '/settings/appearance', name: 'settings-appearance' },
  { hash: '/settings/about', name: 'settings-about' },
  { hash: '/chat', name: 'import-dialog', transferPreview: true, click: ['[data-ui-target="导入对话"]', '[data-ui-target="选择导入文件"]'] },
  { hash: '/chat', name: 'story-import-dialog', transferPreview: true, click: ['[data-ui-target="新建对话"]', '[data-ui-target="故事"]', '[data-ui-target="新建故事"]', '[data-ui-target="从对话导入"]'] },
  { hash: '/chat', name: 'export-dialog', click: '[data-ui-target="对话更多"]' },
  { hash: '/settings/backup', name: 'settings-data' },
  { hash: '/settings/backup', name: 'settings-data-import', transferPreview: true, click: ['[data-ui-target="设置页导入对话"]', '[data-ui-target="选择导入文件"]'] }
]
const VIEWS = JSON.parse(argValue('views', JSON.stringify(DEFAULT_VIEWS)))

/**
 * 只拍需要的那几张（避免每次全量出图，一轮要几分钟）。
 *
 *   --only=settings-tools,settings-channels   只拍这两张
 *   --only=diff                              只拍「与上次的逐字节差异不为零」的视图
 *
 * 两种模式都会**合并**进已有的 ui-map-v{版本}.json：
 * 没拍的视图保留上一次的坐标，UI_MAP.md 仍然是完整的一张表。
 * 不合并的话「只拍一张」会把整份坐标表清空，之后按旧编号报位置就会指错地方。
 *
 * 注意：新增 data-ui-target 会让 DOM 顺序里后面的元素编号后移，
 * 所以**改了那块 UI** 时，除了本视图，还要把同一页面的其它视图一起重拍（用 --only 列出来即可）。
 */
const onlyArg = argValue('only', '')
const ONLY = onlyArg ? onlyArg.split(',').map((item) => item.trim()).filter(Boolean) : null
const ALL = process.argv.includes('--all')

/**
 * 🔴 默认**不许全量**（操作者规则 2026-11-13）。
 *
 * 网格图是「这次改动」的证据，不是产品目录。裸跑一轮要几分钟、出 24 张图和一份整表，
 * 其中只有一两张与改动有关 —— 那是纯浪费，还把审阅成本推给人。
 * 所以必须二选一：
 *   --only=<视图名>[,...]  只拍改到的那几张（坐标表与上一份合并，UI_MAP.md 仍然完整）
 *   --all                  明确认账「这次真的全局都变了」（公共样式 / 侧栏 / 主题）
 * 什么都不给 → 直接拒绝，一张都不拍。
 */
if (!ONLY && !ALL) {
  const chatLike = VIEWS.filter((view) => !view.hash.startsWith('/settings'))
  const settings = VIEWS.filter((view) => view.hash.startsWith('/settings'))
  console.error('拒绝全量截图：只拍你改动的那几张。')
  console.error('')
  console.error('  pnpm ui:map --only=<视图名>[,<视图名>]')
  console.error('')
  console.error('  对话 / 故事页：' + chatLike.map((view) => view.name).join(', '))
  console.error('  设置页：      ' + settings.map((view) => view.name).join(', '))
  console.error('')
  console.error('真的全局都变了（公共样式 / 侧栏 / 主题）才用：pnpm ui:map --all')
  process.exit(6)
}

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
    path.join(buildRoot, 'renderer', 'index.html'),
    path.join(projectRoot, 'dist', 'renderer', 'index.html'),
    path.join(projectRoot, 'dist', 'index.html')
  ].find((item) => fs.existsSync(item))
  if (!indexHtml) {
    console.error('找不到渲染页产物（out/renderer/index.html 或 dist/index.html）')
    app.exit(1)
    return
  }
  const report = { version, projectRoot, theme, contentSize: { width: viewWidth, height: viewHeight }, views: {} }

  // ── --only 的筛选（P2 新增）──────────────────────────────────────────
  // diff 模式：读上一次的 JSON 与磁盘上的 PNG，把「还没拍过」或「上次拍的哈希对不上」的视图挑出来。
  // 用 PNG 的 sha256 而不是像素比对：这里只需要知道「要不要重拍」，不需要知道差多少。
  const crypto = require('node:crypto')
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  let targets = DEFAULT_VIEWS
  if (ONLY && !(ONLY.length === 1 && ONLY[0] === 'diff')) {
    const wanted = new Set(ONLY)
    const unknown = ONLY.filter((name) => !VIEWS.some((view) => view.name === name))
    if (unknown.length > 0) {
      console.error('--only 里有不存在的视图：' + unknown.join(', '))
      console.error('可选：' + VIEWS.map((view) => view.name).join(', '))
      app.exit(5)
      return
    }
    targets = VIEWS.filter((view) => wanted.has(view.name))
  } else if (ONLY && ONLY[0] === 'diff') {
    const prevPath = path.join(outDir, 'ui-map-v' + version + '.json')
    const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : { views: {} }
    targets = VIEWS.filter((view) => {
      const file = path.join(outDir, 'ui-map-v' + version + '-' + view.name + '.png')
      if (!fs.existsSync(file)) return true
      const record = prev.views[view.name]
      // 老 JSON 里没有哈希（P2 之前生成的）→ 一律重拍，宁可多拍一张也不要拿旧坐标
      if (!record || !record.pngSha256) return true
      return sha(file) !== record.pngSha256
    })
    console.log('diff 模式：需要重拍 ' + targets.length + ' / ' + VIEWS.length + ' 张' + (targets.length ? '：' + targets.map((v) => v.name).join(', ') : ''))
  }

  if (targets.length === 0) {
    // 没有要拍的：直接退出，不白起一轮窗口、也不重写坐标 JSON（它一个字都没变）
    console.log('没有需要重拍的视图（--only=diff）')
    app.exit(0)
    return
  }

  // 播种用的目录：必须真实存在，否则 workspaces.save 会以「目录不存在」拒绝
  const seedDir = path.join(userData, 'ui-map-workspace')
  fs.mkdirSync(seedDir, { recursive: true })

  for (const [viewIndex, view] of targets.entries()) {
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

    if (promptCheck && view.name === 'settings-prompts') {
      const observed = await win.webContents.executeJavaScript(`
        (async () => {
          const deadline = Date.now() + 10000
          while (!document.querySelector('[data-ui-target="添加自定义角色"]')) {
            if (Date.now() > deadline) throw new Error('M27 添加入口未出现')
            await new Promise((r) => requestAnimationFrame(r))
          }
          const library = await window.nahida.prompts.library()
          document.querySelector('[data-ui-target="添加自定义角色"]').click()
          await new Promise((r) => setTimeout(r, 100))
          return { library, badges: [...document.querySelectorAll('[data-ui-target="角色来源"]')].map((e) => e.textContent) }
        })()
      `)
      const assert = require('node:assert/strict')
      const target = path.join(userData, 'prompt', 'characters')
      assert.equal(promptOpened.at(-1), target)
      assert.ok(fs.statSync(target).isDirectory())
      assert.ok(observed.library.characters.some((c) => c.id === 'test-a' && c.origin === 'user'))
      for (const id of ['nahida', 'dania']) assert.ok(observed.library.characters.some((c) => c.id === id && c.origin === 'builtin'))
      assert.ok(observed.badges.includes('内置') && observed.badges.includes('自定义'))
      console.log('PASS M27 live renderer→preload→IPC→shell.openPath ' + JSON.stringify({ target, badges: observed.badges }))
    }

    // 视图级点击已移到播种之后（P7）：seedStory / seedChat 会整页重载，
    // 必须在其之后再点，否则点击打开的抽屉会被 loadFile 冲掉（出图实测）。

    /**
     * 对话样本（P9）：把视图从「空态」变成「有消息的会话」。
     *
     * 为什么必须走 IPC 而不是往渲染层塞假数据：
     * 消息列表的来源是 chatStore.sessions，它是模块级单例，只有整页重载才重新拉取；
     * 直接在页内改 zustand 会被下一次 init 覆盖，而且测不到真实链路。
     * 这里用主进程真正的 send()（演示模式 mockProvider，不联网、不需要 key），
     * 跑完一轮后**整页重载**让 store 从主进程读回落库结果——截到的就是真实持久化之后的画面。
     *
     * 消息文本不要含「工作区/目录/文件/列表/ls/工具」：mockProvider 见到这些词会改走
     * 工具调用分支（弹审批卡），对话样本就拍不成两栏气泡了。
     */
    /**
     * P7：故事区样本。走真实 IPC：建故事区 → 造根分支消息 → 从第 1 条派生一条子分支，
     * 这样侧栏卡片、抽屉分支树、检索命中和时间轴都有可定位对象。
     * 播种完必须整页重载（chatStore / storyStore 都是模块级单例）。
     */
    if (view.seedStory) {
      const seeded = await win.webContents.executeJavaScript(`
        (async () => {
          const existing = (await window.nahida.story.list()).find((story) => story.title === '时钟之谜')
          if (!existing) {
            const created = await window.nahida.story.create({
              title: '时钟之谜',
              characterId: 'nahida',
              synopsis: '雨夜的小镇里，钟楼停了。她和我一起去找停摆的原因。',
              openingText: ${JSON.stringify(q35OptionsFixture ? q35Opening : q3PresetFixture ? '<think_nya>这是隔离预设的折叠内容。</think_nya>雨点敲在钟楼的铜面上。' : '雨点敲在钟楼的铜面上，像是有人在数数。')}
            })
            const storyId = created.meta.storyId
            const root = await window.nahida.story.session(storyId)
            if (!root) return { ok: false, reason: '根分支会话不存在' }
            const lines = [
              '你听，钟楼好像不响了。',
              '不是不响，是它把声音藏起来了。',
              '那我们去塔顶看看？',
              '等雨小一点，我先把斗篷系紧。'
            ]
            for (const line of ${q35OptionsFixture ? "[]" : "lines"}) {
              await window.nahida.chat.send({ sessionId: root.id, content: line })
              const deadline = Date.now() + 15000
              for (;;) {
                // 🔴 必须用 story.session 轮询：chat.listSessions() 有意排除 story 会话（G1），
                //    用它查故事会话永远为空 → 必然超时（P7 出图实测）。
                const snap = await window.nahida.story.session(storyId)
                const tail = snap && snap.messages[snap.messages.length - 1]
                if (tail && tail.role === 'assistant' && tail.status === 'done' && tail.content.length > 0) break
                if (Date.now() > deadline) return { ok: false, reason: '等待故事回复超时' }
                await new Promise((r) => setTimeout(r, 120))
              }
            }
            if (${q35OptionsFixture}) return { ok: true, storyId, messages: root.messages.length }
            // 旁白视图：写一条真实 narration（不调模型），再从它派生，保证活跃分支里能看到居中旁白。
            await window.nahida.chat.narrate(root.id, '雨声忽然停了，钟楼里传来一声很轻的叹息。')
            const after = await window.nahida.story.session(storyId)
            const target = after && after.messages[after.messages.length - 1]
            if (target) {
              await window.nahida.story.derive({
                storyId,
                fromSessionId: after.id,
                fromMessageId: target.id,
                title: '雨夜的另一种选择'
              })
            }
            return { ok: true, storyId, messages: after ? after.messages.length : 0 }
          }
          return { ok: true, storyId: existing.storyId }
        })()
      `)
      if (!seeded || !seeded.ok) {
        console.error('故事播种失败：' + JSON.stringify(seeded) + '（视图 ' + view.name + '）')
        app.exit(4)
        return
      }
      await win.loadFile(indexHtml, {
        hash: view.hash,
        query: { grid: '1', v: String(viewIndex), seed: String(Date.now()) }
      })
      await win.webContents.executeJavaScript(
        "document.querySelector('.ui-grid')?.classList.remove('ui-grid--hidden')"
      ).catch(() => {})
      await win.webContents.executeJavaScript("window.dispatchEvent(new Event('scroll'))")
      console.log('  已播种故事区 ' + seeded.storyId)
    }

    // SUP-02：只走真实 preload/IPC 写入队列，截图保留未请求回复状态。
    if (view.seedPreSend) {
      const seeded = await win.webContents.executeJavaScript(`
        (async () => {
          const created = await window.nahida.story.create({
            title: '预发送演示', characterId: 'nahida',
            synopsis: '两段对话和一段旁白，等待一次明确的请求回复。'
          })
          const session = await window.nahida.story.session(created.meta.storyId)
          if (!session) throw new Error('预发送样本会话不存在')
          await window.nahida.chat.updateSession(session.id, { preSend: true })
          await window.nahida.chat.queueMessage({ sessionId: session.id, content: '先别回答，我想分两段说。' })
          await window.nahida.chat.queueMessage({ sessionId: session.id, content: '等我按请求回复，再一起接着说。' })
          await window.nahida.chat.narrate(session.id, '窗外的雨停了，房间安静下来。')
          const saved = await window.nahida.story.session(created.meta.storyId)
          if (!saved.preSend || saved.messages.length !== 3 || saved.messages.some(m => m.role === 'assistant')) {
            throw new Error('预发送样本不是三条无助手的待回复消息')
          }
          return { id: session.id, preSend: saved.preSend, roles: saved.messages.map(m => m.role) }
        })()
      `)
      console.log('PASS SUP-02 real IPC queued snapshot ' + JSON.stringify(seeded))
      await win.loadFile(indexHtml, { hash: view.hash, query: { grid: '1', v: String(viewIndex), seed: String(Date.now()) } })
    }

    if (Array.isArray(view.seedChat) && view.seedChat.length > 0) {
      const seeded = await win.webContents.executeJavaScript(`
        (async () => {
          const lines = ${JSON.stringify(view.seedChat)}
          let sessions = await window.nahida.chat.listSessions()
          // 干净 userData 下不会有会话；复用第一条避免多个视图堆积互相影响
          let session = sessions[0]
          if (!session) session = await window.nahida.chat.createSession({ mode: 'chat' })
          // 🔴 幂等：这条会话已经有消息就不再播种。多个 seedChat 视图共用同一条会话，
          //    不这么写会**逐视图累加**（第 2 个视图起变成 8 条、第 3 个 12 条），
          //    于是所有对话截图的内容与元素编号都会跟着漂，图和视图声明对不上。
          const empty = session.messages.length === 0
          for (const line of lines) {
            if (!empty) break
            await window.nahida.chat.send({ sessionId: session.id, content: line })
            // send() 同步返回「立即结果」，生成在后台继续；等它从 streaming 变 done
            const deadline = Date.now() + 15000
            for (;;) {
              const list = await window.nahida.chat.listSessions()
              const now = list.find((s) => s.id === session.id)
              const tail = now && now.messages[now.messages.length - 1]
              if (tail && tail.role === 'assistant' && tail.status === 'done' && tail.content.length > 0) break
              if (Date.now() > deadline) return { ok: false, reason: '等待生成超时' }
              await new Promise((r) => setTimeout(r, 120))
            }
          }
          const final = await window.nahida.chat.listSessions()
          const done = final.find((s) => s.id === session.id)
          return { ok: true, sessionId: session.id, messages: done ? done.messages.length : 0 }
        })()
      `)
      if (!seeded || !seeded.ok) {
        console.error('对话播种失败：' + JSON.stringify(seeded) + '（视图 ' + view.name + '）')
        app.exit(4)
        return
      }
      // 整页重载：让 chatStore 的模块级单例从主进程重新拉取刚落库的消息。
      // 不加这个的话页内还是空态——store 只在 init() 时读一次。
      await win.loadFile(indexHtml, {
        hash: view.hash,
        query: { grid: '1', v: String(viewIndex), seed: String(Date.now()) }
      })
      await win.webContents.executeJavaScript(
        "document.querySelector('.ui-grid')?.classList.remove('ui-grid--hidden')"
      ).catch(() => {})
      await win.webContents.executeJavaScript("window.dispatchEvent(new Event('scroll'))")
      console.log('  已播种对话 ' + seeded.messages + ' 条消息')
    }

    /**
     * 失败的一轮（2026-11-14）：气泡上要写明原因，并给「重试这一轮 / 删除这条」。
     *
     * 为什么不往页内塞一条 status:'error' 的假消息：那样拍到的只是我们自己造的假象，
     * 真实失败路径（主进程 catch → message.error 落盘 → 广播 → reducer → 气泡）一段都没走到。
     * 这里把会话指到一个**连不上**的本地地址（127.0.0.1:9）再发一句，失败是真的。
     * 🔴 播完必须把死地址档案删掉：留着会让 settings-models 视图多一行、元素编号整体后移。
     */
    if (view.seedFailure) {
      const seededFailure = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
          // 幂等：已经有一条「尾巴是失败」的会话就复用它（同一轮里重复跑视图不会堆）
          const list = await window.nahida.chat.listSessions()
          const existing = list.find((s) => {
            const tail = s.messages[s.messages.length - 1]
            return Boolean(tail && tail.status === 'error')
          })
          if (existing) return { ok: true, sessionId: existing.id, messages: existing.messages.length }
          const session = await window.nahida.chat.createSession({ mode: 'chat' })
          const catalog = await window.nahida.modelProfiles.save({
            name: '连不上',
            provider: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:9/v1',
            apiKey: 'sk-dead',
            models: ['dead'],
            defaultModel: 'dead',
            temperature: 1,
            modelOptions: {}
          })
          const profile = catalog.profiles.find((item) => item.baseUrl === 'http://127.0.0.1:9/v1')
          if (!profile) return { ok: false, reason: '死地址档案没落盘' }
          await window.nahida.chat.updateSession(session.id, { modelProfileId: profile.id, modelId: 'dead' })
          await window.nahida.chat.send({ sessionId: session.id, content: '在吗' })
          const deadline = Date.now() + 20000
          for (;;) {
            const now = (await window.nahida.chat.listSessions()).find((item) => item.id === session.id)
            const tail = now && now.messages[now.messages.length - 1]
            if (tail && tail.status === 'error') break
            if (Date.now() > deadline) return { ok: false, reason: '等待失败超时' }
            await sleep(120)
          }
          // 收尾：会话放回默认档案，死地址档案删掉（不留污染）
          await window.nahida.chat.updateSession(session.id, { modelProfileId: null, modelId: null })
          await window.nahida.modelProfiles.remove(profile.id)
          const final = (await window.nahida.chat.listSessions()).find((item) => item.id === session.id)
          return { ok: true, sessionId: session.id, messages: final ? final.messages.length : 0 }
        })()
      `)
      if (!seededFailure || !seededFailure.ok) {
        console.error('失败样本播种失败：' + JSON.stringify(seededFailure) + '（视图 ' + view.name + '）')
        app.exit(4)
        return
      }
      // 整页重载：chatStore 是模块级单例，只在 init() 时读一次主进程的会话
      await win.loadFile(indexHtml, {
        hash: view.hash,
        query: { grid: '1', v: String(viewIndex), seed: String(Date.now()) }
      })
      await win.webContents.executeJavaScript(
        "document.querySelector('.ui-grid')?.classList.remove('ui-grid--hidden')"
      ).catch(() => {})
      await win.webContents.executeJavaScript("window.dispatchEvent(new Event('scroll'))")
      console.log('  已播种失败样本 ' + seededFailure.sessionId)
    }
    // 视图级点击（P6/P7）：放在**所有播种之后**再点——seedStory / seedChat 会整页 loadFile 重载，
    // 早于播种点击会被重载冲掉（chat-story-drawer 曾因此拍成与 chat-stories 一模一样）。
    // 元素可能还没渲染，页内重试等它出现。
    // 视图级点击（P6）：用来切到 Agent 模式这类「首帧拿不到、必须交互才出现」的状态。
    // 元素可能还没渲染（loadFile 回来时 React 只挂了一部分），所以在页内重试等它出现。
    // P7：click 支持**数组**（多步：先开弹框，再点弹框里的按钮）。单字符串照旧，不做破坏性改动。
    const clickSteps =
      typeof view.click === 'string' && view.click
        ? [view.click]
        : Array.isArray(view.click)
          ? view.click.filter((item) => typeof item === 'string' && item)
          : []
    useTransferFixture = Boolean(view.transferPreview)
    for (const clickSelector of clickSteps) {
      const clicked = await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const sel = ${JSON.stringify(clickSelector)}
          const deadline = Date.now() + 12000
          const tick = () => {
            const node = document.querySelector(sel)
            // 🔴 存在 ≠ 可点：按钮常在数据还没拉回来时是 disabled 的，
            //    这时候 click() 是**静默无效**，图会拍成「弹层没打开」而脚本还以为成功了。
            //    （旁听群号一览就是靠这条：列表为空时入口是禁用的。）
            if (node && !node.disabled) { node.click(); return resolve(true) }
            if (Date.now() > deadline) return resolve(false)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      `)
      if (!clicked) {
        // 点不到就停下：静默截一张「没点成功」的图比少一张图更糟（会拿错图当证据）
        console.error('点击目标不存在：' + clickSelector + '（视图 ' + view.name + '）')
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

    if (view.pagination) {
      await win.webContents.executeJavaScript(`(async () => {
        let session = (await window.nahida.chat.listSessions()).find(item => item.title === '分页定位样本')
        if (!session) {
          session = await window.nahida.chat.createSession({ mode: 'chat' })
          await window.nahida.chat.updateSession(session.id, { title: '分页定位样本', preSend: true })
          for (let index = 1; index <= 122; index++) {
            await window.nahida.chat.queueMessage({ sessionId: session.id, content: '第 ' + index + ' 条历史消息：分页后仍使用完整会话的绝对序号。' })
          }
          // The first queued message auto-titles a session, so restore the fixture title last.
          await window.nahida.chat.updateSession(session.id, { title: '分页定位样本' })
        }
        const snapshot = (await window.nahida.chat.listSessions()).find(item => item.id === session.id)
        if (snapshot?.messages.length !== 122) throw new Error('Q1 fixture must contain exactly 122 messages')
      })()`)
      await win.loadFile(indexHtml, { hash: view.hash, query: { grid: '1', v: String(viewIndex), pagination: String(Date.now()) } })
      const checked = await win.webContents.executeJavaScript(`(async () => {
        const wait = async predicate => {
          const deadline = Date.now() + 10000
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error('Q1 pagination view did not settle')
            await new Promise(requestAnimationFrame)
          }
        }
        await wait(() => document.querySelectorAll('.message-list [data-message-id]').length === 10)
        const list = document.querySelector('.message-list')
        list.scrollTop = 0
        if (${JSON.stringify(view.pagination)} === 20) {
          document.querySelector('[data-ui-target="加载更多消息"]').click()
          await wait(() => document.querySelectorAll('.message-list [data-message-id]').length === 20)
          list.scrollTop = 0
        }
        await new Promise(requestAnimationFrame)
        const button = document.querySelector('[data-ui-target="加载更多消息"]')
        const box = button.getBoundingClientRect()
        const bounds = list.getBoundingClientRect()
        if (box.top < bounds.top || box.bottom > bounds.bottom) throw new Error('Q1 load-more control outside visible list')
        window.dispatchEvent(new Event('scroll'))
        return { count: document.querySelectorAll('.message-list [data-message-id]').length, label: button.textContent, top: box.top, bottom: box.bottom }
      })()`)
      console.log('PASS Q1 visible pagination ' + view.name + ' ' + JSON.stringify(checked))
    }

    if (view.transferPreview) {
      const checked = await win.webContents.executeJavaScript(`(async () => {
        const find = (label) => document.querySelector('[data-ui-target="' + label + '"]')
        const wait = async (test) => {
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            if (test()) return true
            await new Promise(requestAnimationFrame)
          }
          return false
        }
        if (!(await wait(() => find('导入预览')))) return false
        if (!${JSON.stringify(view.name === 'story-import-dialog')}) return true
        if (!find('开场消息输入')?.disabled) return false
        find('清空导入预览')?.click()
        if (!(await wait(() => !find('导入预览') && find('开场消息输入')?.disabled === false))) return false
        find('从对话导入')?.click()
        return wait(() => find('导入预览') && find('开场消息输入')?.disabled)
      })()`)
      if (!checked) throw new Error('导入预览控件验证失败：' + view.name)
      if (view.name === 'story-import-dialog') console.log('PASS X17 开场消息随导入预览禁用/恢复')
      await win.webContents.executeJavaScript("window.dispatchEvent(new Event('scroll'))")
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
    if (q35OptionsFixture && view.name.startsWith('chat-options')) {
      const evidence = await win.webContents.executeJavaScript(`(async () => {
        const cards = [...document.querySelectorAll('.option-card__item')]
        if (cards.length !== 3 || cards.some(b => b.disabled)) throw Error('Missing enabled option buttons')
        const initial = await window.nahida.story.list()
        const before = await window.nahida.story.session(initial.find(s => s.title === '时钟之谜').storyId)
        const originalSend = window.nahida.chat.send
        window.__q35Sends = 0
        window.nahida.chat.send = (...args) => { window.__q35Sends++; return originalSend(...args) }
        const folded = [...document.querySelectorAll('details.bubble-card')].map(d => ({ title:d.querySelector('summary').textContent, open:d.open }))
        if (folded.length !== 2 || folded.some(d => d.open)) throw Error('Builtin folding mismatch')
        if (${JSON.stringify(view.name)} === 'chat-options-filled') {
          // Native button keyboard activation; Chromium owns click dispatch.
          cards[1].focus()
        }
        return { before, sends: window.__q35Sends, folded, labels: cards.map(b => b.dataset.uiTarget) }
      })()`)
      if (view.name === 'chat-options-filled') {
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'})
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'})
        await new Promise(resolve => setTimeout(resolve, 200))
        const after = await win.webContents.executeJavaScript(`(async () => {
          const input=document.querySelector('.composer__input')
          const list=await window.nahida.story.list()
          return { sends:window.__q35Sends, value:input.value, focused:document.activeElement===input, start:input.selectionStart,end:input.selectionEnd,
            session:await window.nahida.story.session(list.find(s=>s.title==='时钟之谜').storyId) }
        })()`)
        if (after.sends !== 0 || !after.focused || after.value !== '🥺 站在茶几旁有点拘谨，轻声问她一个人住这么大的房子习不习惯' || after.start !== after.value.length || after.end !== after.value.length || JSON.stringify(evidence.before)!==JSON.stringify(after.session)) throw Error('Native option activation failed: '+JSON.stringify(after))
        evidence.after = after
      }
      fs.writeFileSync(path.join(outDir, view.name+'-evidence.json'), JSON.stringify(evidence, null, 2))
      console.log('PASS Q35 Chromium ' + view.name)
    }
    if (view.name === 'chat-story-preset') {
      await win.webContents.executeJavaScript("document.querySelector('details.bubble-card')?.scrollIntoView({block:'center'}); window.dispatchEvent(new Event('scroll'))")
      await new Promise(resolve => setTimeout(resolve, 500))
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
    const gridFile = path.join(outDir, `ui-map-v${version}-${view.name}.png`)
    fs.writeFileSync(gridFile, png)
    geometry.pngSha256 = sha(gridFile)
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

    if (process.argv.includes('--verify-p49')) {
      const assert = require('node:assert/strict')
      const required = {
        'chat-empty': ['Chat', 'Agent', '故事'],
        'chat-stories': ['故事', '新建故事'],
        'chat-story-drawer': ['跳到消息 10', '从此处分支出新剧情 10'],
        'new-story-dialog': ['故事画像输入'],
        'settings-memory': ['对话摘要参数'],
        'settings-story-recall': ['故事召回开关', '故事召回轮数', '故事召回预算', '故事召回阈值', '故事关键词权重', '故事补查深度', '保存故事召回设置', '补算故事向量'],
        'settings-memory-facts': ['检索参数', '试召回输入', '按人列表'],
        'settings-qq-threshold': ['门槛组']
      }[view.name] || []
      if (view.name === 'chat-story-drawer') {
        const jumps = geometry.targets.filter(item => /^跳到消息 \d+$/.test(item.label))
        const derives = geometry.targets.filter(item => /^从此处分支出新剧情 \d+$/.test(item.label))
        assert.equal(jumps.length, 10, '故事样本应有10个时间轴跳转按钮')
        assert.equal(jumps.length, derives.length, '每行时间轴增加一个跳转按钮')
      }
      for (const label of required) {
        const target = geometry.targets.find(item => item.label === label)
        assert.ok(target && target.width > 0 && target.height > 0, label + ' 不可见')
        assert.ok(target.left >= 0 && target.top >= 0 && target.left + target.width <= geometry.viewport.width + 1 && target.top + target.height <= geometry.viewport.height + 1, label + ' 超出视口')
      }
      assert.equal(geometry.pngSha256, sha(gridFile))
      const image = require('electron').nativeImage.createFromPath(gridFile)
      const scale = await win.webContents.executeJavaScript('window.devicePixelRatio')
      const pixels = image.getSize()
      assert.ok(Math.abs(pixels.width - geometry.viewport.width * scale) <= 2 && Math.abs(pixels.height - geometry.viewport.height * scale) <= 2, 'PNG 物理像素尺寸与视口/DPI不一致')
      console.log('PASS P4.9 grid hash/controls/bounds ' + view.name)
    }

    if (view.seedPreSend && process.argv.includes('--verify-presend')) {
      const assert = require('node:assert/strict')
      const targets = ['预发送开关', '请求回复', '输入框']
      for (const label of targets) {
        const target = geometry.targets.find(item => item.label === label)
        assert.ok(target && target.width > 0 && target.height > 0, label + ' 不可见')
        assert.ok(target.left >= 0 && target.top >= 0 && target.left + target.width <= geometry.viewport.width + 1 && target.top + target.height <= geometry.viewport.height + 1, label + ' 超出视口')
      }
      assert.equal(geometry.pngSha256, sha(gridFile))
      console.log('PASS SUP-02 targeted grid hash/controls/bounds')
      const snapshot = () => win.webContents.executeJavaScript(`(async () => {
        const stories = await window.nahida.story.list()
        return window.nahida.story.session(stories.find(s => s.title === '预发送演示').storyId)
      })()`)
      const waitUntil = async (label, read) => {
        const deadline = Date.now() + 15000
        for (;;) {
          const result = await read()
          if (result) return result
          if (Date.now() > deadline) throw new Error(label + ' 超时')
          await new Promise(resolve => setTimeout(resolve, 30))
        }
      }
      const enterText = async (text, enter = true) => {
        await win.webContents.executeJavaScript("document.querySelector('.composer__input').focus()")
        await win.webContents.insertText(text)
        if (enter) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
        }
      }
      assert.deepEqual((await snapshot()).messages.map(m => m.role), ['user', 'user', 'narration'])
      await enterText('再补一句：请把前面三段一起接住。')
      await waitUntil('Enter 入队', async () => (await snapshot()).messages.length === 4)
      assert.equal((await snapshot()).messages.filter(m => m.role === 'assistant').length, 0)
      await enterText('这段仍是草稿，不随请求回复发送。', false)
      await win.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('[data-ui-target="请求回复"]')
        button.click(); button.click()
      })()`)
      await waitUntil('流式禁用', () => win.webContents.executeJavaScript(`(() => {
        const request = document.querySelector('[data-ui-target="请求回复"]')
        const toggle = document.querySelector('[data-ui-target="预发送开关"]')
        return request?.disabled && toggle?.disabled && Boolean(document.querySelector('.composer__action--stop'))
      })()`))
      await waitUntil('请求完成', async () => {
        const session = await snapshot()
        return session.messages.length === 5 && session.messages.at(-1).status === 'done'
      })
      assert.equal((await snapshot()).messages.filter(m => m.role === 'assistant').length, 1)
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('.composer__input').value"), '这段仍是草稿，不随请求回复发送。')
      await win.webContents.executeJavaScript("document.querySelector('[data-ui-target=\"请求回复\"]').click()")
      await waitUntil('空队列提示', () => win.webContents.executeJavaScript("document.body.textContent.includes('还没有待回复的内容')"))
      assert.equal((await snapshot()).messages.length, 5)
      console.log('PASS SUP-02 live Enter queues / double click replies once / streaming locks / draft retained / empty queue rejected')
    }
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

  // ── 只拍一部分时，把没拍的视图从旧 JSON 里合并回来 ──
  // 不合并的话「只拍一张」会把整份坐标表清空，UI_MAP.md 变成一张只有单页的表，
  // 之后按旧编号（元素 5、C7）报位置就会指到别的地方。
  const reportPath = path.join(outDir, 'ui-map-v' + version + '.json')
  if (ONLY && fs.existsSync(reportPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      const merged = {}
      for (const view of VIEWS) {
        merged[view.name] = report.views[view.name] || prev.views?.[view.name]
        if (!merged[view.name]) delete merged[view.name]
      }
      report.views = merged
      console.log('已合并上次坐标：本次重拍 ' + targets.length + ' 张，保留 ' + (Object.keys(merged).length - targets.length) + ' 张')
    } catch (error) {
      console.error('合并上次坐标失败（将只写本次拍的）：' + (error && error.message ? error.message : error))
    }
  }

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log('完成：docs/ui/ui-map-v' + version + '.json')
  app.exit(0)
})