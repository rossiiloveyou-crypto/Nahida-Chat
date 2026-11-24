/**
 * P7：故事视口 / 检索 / meta / 画像 / 侧栏过滤 —— A-01…A-20（20 条）。
 *
 * 测真实边界：真落 story.json / profile.md / branches.json，真走 chatService，
 * searchStory 在真实消息上做大小写无关子串匹配。
 *
 * 跑法：node scripts/test/story-ui.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { bundleModule, createChecker, installElectronStub, loadEsbuild, p, projectRoot } from './qq-test-util.mjs'

const { check, done } = createChecker()
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-ui-'))
installElectronStub(userData)
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ defaultCharacterId: 'nahida', memory: { enabled: false, autoExtract: false } }),
  'utf8'
)

/* ── 桩掉 rag 依赖：chatService 会把 embedder / extract / retriever 拉进来 ── */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-story-ui-stubs-'))
const embedderStub = path.join(stubDir, 'embedder-stub.ts')
fs.writeFileSync(
  embedderStub,
  [
    'export const embedder = {',
    '  async embedOne() { return null },',
    '  async embed() { return null },',
    '  status() { return { ready: false, dimensions: 0, modelPath: "", lastError: null } },',
    '  modelInstalled() { return false }',
    '}'
  ].join('\n'),
  'utf8'
)
const extractStub = path.join(stubDir, 'extract-stub.ts')
fs.writeFileSync(extractStub, 'export async function extractMemories() { return [] }\n', 'utf8')
const ragStub = path.join(stubDir, 'rag-stub.ts')
fs.writeFileSync(
  ragStub,
  'export const memoryService = { async buildContextBlock() { return "" }, async extractInBackground() {}, activePersona() { return null }, upsertPersona() {}, appendHistory() {}, dispose() {} }\nexport class MemoryService { constructor() {} }\n',
  'utf8'
)
const plugin = {
  name: 'stub-rag-deps',
  setup(build) {
    const inRag = (importer) => importer.includes('features/rag') || importer.includes('features\\rag')
    build.onResolve({ filter: /^\.\/embedder$/ }, (args) => (inRag(args.importer) ? { path: embedderStub } : null))
    build.onResolve({ filter: /^\.\/extract$/ }, (args) => (inRag(args.importer) ? { path: extractStub } : null))
    build.onResolve({ filter: /^\.\.\/rag$/ }, (args) =>
      args.importer.endsWith('chatService.ts') ? { path: ragStub } : null
    )
  }
}

const mod = await bundleModule(
  'story-ui',
  [
    `export { createStory, deriveBranch, deleteBranch, listStoryBranches, listStories, switchBranch, getStory, getStorySession, searchStory, updateStoryMeta, readStoryProfile, saveStoryProfile } from '${p('src/main/features/story/service.ts')}'`,
    `export { StoryStore } from '${p('src/main/features/story/store.ts')}'`,
    `export { chatService } from '${p('src/main/features/chat/chatService.ts')}'`,
    `export { storyProfilePath, storiesRoot } from '${p('src/main/features/story/paths.ts')}'`,
    `export { visibleDesktopSessions } from '${p('src/renderer/src/features/story/sessionFilter.ts')}'`
  ].join('\n'),
  [plugin]
)
const {
  createStory,
  deriveBranch,
  listStoryBranches,
  listStories,
  switchBranch,
  getStory,
  getStorySession,
  searchStory,
  updateStoryMeta,
  readStoryProfile,
  saveStoryProfile,
  StoryStore,
  chatService,
  storyProfilePath,
  visibleDesktopSessions
} = mod

const store = new StoryStore()

/* ── 夹具：一个故事区，根分支 10 条（第 2 条含「钟楼」），再从第 4 条派生一条子分支 ── */
const story = createStory({
  title: 'P7 检索夹具',
  synopsis: '夹具概要',
  characterId: 'nahida',
  worldbookMode: 'override',
  worldbookDir: 'worldbooks/clock'
})
const storyId = story.meta.storyId
const root = chatService.listSessionsByStory(storyId)[0]

const rootMessages = []
for (let i = 0; i < 10; i += 1) {
  rootMessages.push({
    id: 'r' + i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: i === 2 ? '钟楼的指针停在了三点' : '第' + i + '句普通台词',
    createdAt: 1000 + i,
    status: 'done'
  })
}
chatService.appendMessages(root.id, rootMessages)

const derived = deriveBranch({ storyId, fromSessionId: root.id, fromMessageId: 'r4', title: '子分支' })
const childMessages = [
  { id: 'c0', role: 'user', content: '子分支里也提到了钟楼', createdAt: 2000, status: 'done' },
  { id: 'c1', role: 'assistant', content: '子分支独有的一句暗号：夜莺', createdAt: 2001, status: 'done' }
]
chatService.appendMessages(derived.sessionId, childMessages)

/* ═══════════════════ A-01…A-05：story:session ═══════════════════ */

// A-01：无 branchId → 活跃分支（派生即激活），且带 messages
const activeSession = getStorySession(storyId)
check(
  'A-01 无 branchId → 返回活跃分支会话，messages.length > 0',
  Boolean(activeSession) && activeSession.id === derived.sessionId && activeSession.messages.length > 0,
  JSON.stringify({ id: activeSession && activeSession.id, n: activeSession && activeSession.messages.length })
)

// A-02：显式 branchId → 该分支会话
const rootSession = getStorySession(storyId, root.id)
check(
  'A-02 story:session(branchId=根) → 返回该分支会话（id 相等、消息=根分支消息）',
  Boolean(rootSession) && rootSession.id === root.id && rootSession.messages.length === 10,
  JSON.stringify({ id: rootSession && rootSession.id, n: rootSession && rootSession.messages.length })
)

// A-03：只有子分支出现的词 → 命中含 branchId=子分支
const nightingale = searchStory(storyId, '夜莺')
check(
  'A-03 只在子分支出现的词 → 命中 branchId=子分支',
  nightingale.length > 0 && nightingale.every((hit) => hit.branchId === derived.sessionId),
  JSON.stringify(nightingale.map((hit) => hit.branchId))
)

// A-04：不存在词 0 条 + 对照（存在词 >0）
const missing = searchStory(storyId, '完全不存在的词xyz')
const existing = searchStory(storyId, '钟楼')
check('A-04 不存在词 → 0 条（对照：存在词 >0）', missing.length === 0 && existing.length > 0, JSON.stringify({ missing: missing.length, existing: existing.length }))

// A-05：空串 / 纯空格 → []
check('A-05 空串与纯空格 → []（不抛）', searchStory(storyId, '').length === 0 && searchStory(storyId, '   ').length === 0)

/* ═══════════════════ A-06…A-09：updateMeta / 画像 ═══════════════════ */

// A-06：改 title+synopsis+worldbookMode → 逐字段读回
const patched = updateStoryMeta(storyId, { title: '改过的标题', synopsis: '改过的概要', worldbookMode: 'default' })
const reread = getStory(storyId)
check(
  'A-06 updateMeta 改 title+synopsis+worldbookMode → getStory 逐字段一致',
  Boolean(patched) &&
    reread.title === '改过的标题' &&
    reread.synopsis === '改过的概要' &&
    reread.worldbookMode === undefined,
  JSON.stringify({ title: reread.title, synopsis: reread.synopsis, mode: reread.worldbookMode })
)

// A-07：非法 storyId → null，不抛
let invalidThrew = false
let invalidResult = 'n/a'
try {
  invalidResult = updateStoryMeta('../../evil', { title: 'x' })
} catch {
  invalidThrew = true
}
check('A-07 非法 storyId → null 且不抛', !invalidThrew && invalidResult === null, String(invalidResult))

// A-08：画像写读逐字一致，路径 = storyProfilePath
const profileText = '# 画像\n\n她今天开始叫我名字了。\n'
const savedOk = saveStoryProfile(storyId, profileText)
const profileFile = storyProfilePath(storyId)
check(
  'A-08 profileSave 写盘、profileGet 读回逐字一致，路径 = storyProfilePath()',
  savedOk && fs.existsSync(profileFile) && readStoryProfile(storyId) === profileText,
  profileFile
)

// A-09：空串保存 → 文件被删，读回空串
const cleared = saveStoryProfile(storyId, '  ')
check(
  'A-09 profileSave("") → 文件被删、profileGet 返回 ""',
  cleared && !fs.existsSync(profileFile) && readStoryProfile(storyId) === '',
  'exists=' + fs.existsSync(profileFile)
)

/* ═══════════════════ A-10 / A-11 / A-20：命中字段 ═══════════════════ */

const towerHits = searchStory(storyId, '钟楼')
const hitCheck = towerHits.every((hit) => {
  const session = chatService.listSessionsByStory(storyId).find((item) => item.id === hit.branchId)
  return session && session.messages[hit.messageIndex] && session.messages[hit.messageIndex].id === hit.messageId
})
check('A-10 snippet 含查询词，且 messageIndex 指向 messages[idx].id === messageId', towerHits.length > 0 && towerHits.every((hit) => hit.snippet.includes('钟楼')) && hitCheck, String(towerHits.length))

const activeHit = towerHits.find((hit) => hit.branchId === derived.sessionId)
const inactiveHit = towerHits.find((hit) => hit.branchId === root.id)
check(
  'A-11 非活跃分支命中 isActiveBranch=false；活跃分支命中 true',
  Boolean(activeHit) && activeHit.isActiveBranch === true && Boolean(inactiveHit) && inactiveHit.isActiveBranch === false,
  JSON.stringify(towerHits.map((hit) => [hit.branchId === derived.sessionId, hit.isActiveBranch]))
)

// A-20：超长消息命中时 snippet 不超过 160
saveStoryProfile(storyId, 'placeholder')
const longSession = chatService.createSession({ mode: 'story', storyId, title: '超长' })
chatService.appendMessages(longSession.id, [
  { id: 'L0', role: 'user', content: 'x'.repeat(2500), createdAt: 3000, status: 'done' }
])
const longHit = searchStory(storyId, 'xxxx')
check('A-20 超长消息命中时 snippet.length <= 160', longHit.length > 0 && longHit.every((hit) => hit.snippet.length <= 160), JSON.stringify(longHit.map((hit) => hit.snippet.length)))

/* ═══════════════════ A-12 / A-13：侧栏过滤 ═══════════════════ */

const plain = { id: 'p1', title: '普通', mode: 'chat', messages: [], workspaceId: 'ws1' }
const plainNoWs = { id: 'p2', title: '无工作区', mode: 'chat', messages: [] }
const storySession = { id: 's1', title: '故事', mode: 'story', messages: [], storyId }
const filterList = [plain, plainNoWs, storySession]

const visibleAll = visibleDesktopSessions(filterList, null)
check(
  'A-12 visibleDesktopSessions(list, null)：story 不进、普通会话保留',
  visibleAll.length === 2 && !visibleAll.some((item) => item.storyId) && visibleAll.some((item) => item.id === 'p1'),
  visibleAll.map((item) => item.id).join(',')
)

const visibleWs = visibleDesktopSessions(filterList, 'ws1')
check(
  'A-13 visibleDesktopSessions(list, ws1)：按 workspaceId 过滤且 story 恒排除',
  visibleWs.length === 1 && visibleWs[0].id === 'p1',
  visibleWs.map((item) => item.id).join(',')
)

/* ═══════════════════ A-14 / A-16 / A-17 / A-18 / A-19：卡片与分支数据面 ═══════════════════ */

const summaries = listStories()
const mine = summaries.find((item) => item.storyId === storyId)
check(
  'A-14 listStories 每项含 title/synopsis/characterId/lastActiveAt/branchCount/memoryCount',
  Boolean(mine) &&
    typeof mine.title === 'string' &&
    typeof mine.synopsis === 'string' &&
    typeof mine.characterId === 'string' &&
    typeof mine.lastActiveAt === 'number' &&
    typeof mine.branchCount === 'number' &&
    typeof mine.memoryCount === 'number',
  JSON.stringify(mine && { branchCount: mine.branchCount, memoryCount: mine.memoryCount })
)

const overrideStory = createStory({
  title: '覆盖档位',
  characterId: 'nahida',
  worldbookMode: 'override',
  worldbookDir: 'worldbooks/override'
})
check(
  'A-16 createStory(worldbookMode=override) → getStory().worldbookMode === "override"',
  getStory(overrideStory.meta.storyId).worldbookMode === 'override',
  String(getStory(overrideStory.meta.storyId).worldbookMode)
)

switchBranch(storyId, root.id)
const afterSwitch = getStorySession(storyId)
check(
  'A-17 switchBranch 后 story:session 返回的分支 id = 切换目标',
  Boolean(afterSwitch) && afterSwitch.id === root.id,
  afterSwitch && afterSwitch.id
)

// A-18：派生守恒 —— 新分支消息数 = idx+1，且原分支 id 序列不变
const beforeRootIds = chatService
  .listSessionsByStory(storyId)
  .find((item) => item.id === root.id)
  .messages.map((message) => message.id)
  .join(',')
const derived2 = deriveBranch({ storyId, fromSessionId: root.id, fromMessageId: 'r3', title: '守恒' })
const derived2Session = getStorySession(storyId, derived2.sessionId)
const afterRootIds = chatService
  .listSessionsByStory(storyId)
  .find((item) => item.id === root.id)
  .messages.map((message) => message.id)
  .join(',')
check(
  'A-18 deriveBranch 后新会话消息数 = idx+1 = 4，且原分支 id 序列不变',
  Boolean(derived2Session) && derived2Session.messages.length === 4 && beforeRootIds === afterRootIds,
  JSON.stringify({ n: derived2Session && derived2Session.messages.length, same: beforeRootIds === afterRootIds })
)

// A-19：删**当前**分支 → 列表少一行、会话少一条、活跃指针自动换人
// 🔴 P6 修订后不再需要「先把活跃分支切走」：分支之间没有父子依赖，删当前分支也被允许，
//    主进程会把活跃指针交给剩下的里面最近活动的那条。
const beforeList = listStoryBranches(storyId)
const beforeSessions = chatService.listSessionsByStory(storyId).length
const { deleteBranch } = mod
deleteBranch(storyId, derived2.sessionId)
const afterList = listStoryBranches(storyId)
const afterSessions = chatService.listSessionsByStory(storyId).length
const activeAfter = afterList.filter((item) => item.isActive)
check(
  'A-19 deleteBranch（删的是当前分支）→ 行数 -1、会话 -1、活跃指针恰好一个且不是被删的',
  afterList.length === beforeList.length - 1 &&
    afterSessions === beforeSessions - 1 &&
    activeAfter.length === 1 &&
    activeAfter[0].branchId !== derived2.sessionId,
  JSON.stringify({ before: beforeList.length, after: afterList.length, active: activeAfter.map((i) => i.branchId) })
)

/* ═══════════════════ A-15：契约存在性（静态文本断言，防 J-01） ═══════════════════ */

const readText = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
const ipcText = readText('src/shared/ipc.ts')
const preloadText = readText('src/preload/index.ts')
const apiText = readText('src/shared/api.ts')
const ipcKeys = ['storySession', 'storySearch', 'storyUpdateMeta', 'storyProfileGet', 'storyProfileSave', 'storyPickWorldbookDir']
const bridgeKeys = ['session:', 'search:', 'updateMeta:', 'profileGet:', 'profileSave:', 'pickWorldbookDir']
check(
  'A-15 IPC 6 个新频道 + preload/api 6 个键都在',
  ipcKeys.every((key) => ipcText.includes(key)) &&
    bridgeKeys.every((key) => preloadText.includes(key)) &&
    bridgeKeys.every((key) => apiText.includes(key)),
  ipcKeys.filter((key) => !ipcText.includes(key)).join(',') || 'all-present'
)

done()


/* Q2: production ChatPage / StoryDrawer / stores, synthetic IPC only. */
async function q2Browser() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-q2-browser-'))
  function setup() {
    const make=id=>({id,storyId:'q2',mode:'story',title:'Q2',createdAt:1,updatedAt:1,characterId:null,modelProfileId:'profile',modelId:'model',messages:Array.from({length:122},(_,i)=>({id:id+'-'+(i+1),role:i%2?'assistant':'user',content:'第'+(i+1)+'条。'+'钟楼下的旅人继续前行。'.repeat(8),createdAt:i+1,status:'done',toolCalls:[]}))})
    const sessions={a:make('a'),b:make('b')},calls=[],delays=[];let active='a',missing=null,failRead=false,delay=0
    const branches=()=>Object.values(sessions).map(s=>({branchId:s.id,title:s.id,isActive:s.id===active,messageCount:s.messages.length,lastActiveAt:1}))
    const settings={provider:'mock',model:'model',theme:'light',fontSize:15,bridge:{enabled:false},agent:{},memory:{enabled:false},toolSupply:{},permissionMode:'ask',permission:{mode:'approve'}},off=()=>()=>{}
    window.nahida={initialTheme:'light',settings:{get:async()=>settings,save:async()=>settings},modelProfiles:{list:async()=>({profiles:[{id:'profile',name:'Profile',provider:'mock',models:['model'],defaultModel:'model'}],defaultProfileId:'profile'})},prompts:{library:async()=>({characters:[]})},workspaces:{list:async()=>({workspaces:[],activeWorkspaceId:null})},regex:{listScripts:async()=>[]},chat:{listSessions:async()=>[],onDelta:off,onReasoning:off,onTool:off,onApproval:off,onDone:off,onError:off},story:{list:async()=>[],session:async(_id,branch)=>{calls.push('read:'+(branch??active));const ms=delays.length?delays.shift():delay;if(ms)await new Promise(r=>setTimeout(r,ms));if(failRead)throw Error('fixture read failed');const s=sessions[branch??active];return s?{...s,messages:s.messages.filter(m=>m.id!==missing)}:null},branches:async()=>branches(),switchBranch:async(_id,id)=>{calls.push('switch:'+id);active=id;return branches()},derive:async()=>{sessions.derived=make('derived');active='derived';return{branch:{branchId:active}}},removeBranch:async(_id,id)=>{delete sessions[id];if(active===id)active='a';return{activeBranchId:active}},search:async()=>[]}}
    window.__q2Errors=[];window.addEventListener('error',e=>window.__q2Errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__q2Errors.push(String(e.reason)))
    window.q2={chat,story,sessions,calls,async mount(){await chat.getState().init();const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(React.createElement(ChatPage)));await story.getState().openStory('q2')},missing(id){missing=id},fail(v){failRead=v},delay(v){delay=v},delays(...values){delays.push(...values)},viewport(id){chat.getState().adoptStorySession(sessions[id])}}
  }
  async function suite() {
    const h=window.q2,checks=[]
    const check=(name,ok,detail=null)=>checks.push({name,ok:Boolean(ok),detail})
    const wait=ms=>new Promise(r=>setTimeout(r,ms))
    const until=async(fn,label,timeout=4000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await wait(25)}throw Error('timeout: '+label)}
    const rows=()=>[...document.querySelectorAll('.message-list [data-message-id]')],row=id=>rows().find(n=>n.dataset.messageId===id)
    const jump=n=>document.querySelector('[data-ui-target="跳到消息 '+n+'"]'),list=()=>document.querySelector('.message-list')
    const settleScroll=async()=>{const end=Date.now()+6000;let last=null,stable=0;while(Date.now()<end){const now=list()?list().scrollTop:0;if(now===last)stable++;else{stable=0;last=now}if(stable>=3)return;await wait(60)}}
    const centered=id=>{const r=row(id).getBoundingClientRect(),b=list().getBoundingClientRect();return{delta:Math.abs((r.top+r.bottom-b.top-b.bottom)/2),height:b.height,visible:r.top<b.bottom&&r.bottom>b.top}}
    try{
      await h.mount();await until(()=>rows().length===10,'initial rows');await wait(150)
      check('B-01 closed with handle only',!h.story.getState().drawerOpen&&!document.querySelector('.story-drawer')&&Boolean(document.querySelector('[data-ui-target="打开分支抽屉"]')))
      await h.story.getState().switchTo('b');check('B-02 switch stays closed',h.story.getState().drawerOpen===false)
      await h.story.getState().deriveFrom('b-3');check('B-02 derive stays closed',h.story.getState().drawerOpen===false)
      await h.story.getState().removeBranch('derived');check('B-02 remove stays closed',h.story.getState().drawerOpen===false)
      document.querySelector('[data-ui-target="打开分支抽屉"]').click();await until(()=>document.querySelector('.story-drawer'),'drawer')
      await h.story.getState().switchTo('b');check('B-03 manual open retained on switch',h.story.getState().drawerOpen)
      await h.story.getState().deriveFrom('b-3');check('B-03 manual open retained on derive',h.story.getState().drawerOpen)
      await h.story.getState().removeBranch('derived');check('B-03 manual open retained on remove',h.story.getState().drawerOpen)
      h.story.getState().closeStory();await h.story.getState().openStory('q2');await until(()=>document.querySelector('[data-ui-target="打开分支抽屉"]'),'reentry')
      check('B-03 close then reenter closed',!h.story.getState().drawerOpen)
      document.querySelector('[data-ui-target="打开分支抽屉"]').click();await until(()=>jump(122),'timeline')
      check('B-09 absolute number 122',jump(122).textContent.trim().startsWith('122.')&&document.querySelectorAll('.story-timeline__jump').length===122)
      jump(118).click();await until(()=>row('a-118')?.classList.contains('is-focus'),'focus118');await settleScroll()
      let geometry=centered('a-118');check('B-04 centered <=20%',geometry.visible&&geometry.delta<=geometry.height*.2,geometry)
      await until(()=>h.story.getState().focusMessageId===null,'expiry60',2600)
      await h.story.getState().switchTo('b');await h.story.getState().switchTo('a');await until(()=>rows().length===10,'page reset')
      jump(3).click();await until(()=>row('a-3')?.classList.contains('is-focus'),'hidden focus');await settleScroll()
      geometry=centered('a-3');check('B-05 hidden target expands to120 and visible',rows().length===120&&geometry.visible,{rows:rows().length,...geometry})
      check('B-08 focus visibly appears',row('a-3').classList.contains('is-focus')&&getComputedStyle(row('a-3').querySelector('.bubble')).boxShadow!=='none')
      await until(()=>!row('a-3').classList.contains('is-focus'),'focus clears',2600)
      check('B-08 production timer clears highlight',h.story.getState().focusMessageId===null&&getComputedStyle(row('a-3').querySelector('.bubble')).boxShadow==='none')
      h.delay(120);const switches=h.calls.length;jump(118).click();h.viewport('b');await until(()=>h.calls.slice(switches).includes('switch:a'),'cross branch');await until(()=>row('a-118')?.classList.contains('is-focus'),'cross focus');await settleScroll();h.delay(0)
      geometry=centered('a-118');check('B-06 A timeline B viewport switches then focuses',h.chat.getState().activeId==='a'&&geometry.visible&&geometry.delta<=geometry.height*.2,{calls:h.calls.slice(-6),...geometry})
      await until(()=>h.story.getState().focusMessageId===null,'cross expiry',2600)
      const before={active:h.chat.getState().activeId,rows:rows().length,scroll:list().scrollTop,switches:h.calls.filter(s=>s.startsWith('switch:')).length}
      h.missing('a-60');jump(60).click();await until(()=>document.querySelector('.story-timeline__hint'),'missing hint')
      check('B-07 missing id warns without navigation',h.chat.getState().activeId===before.active&&rows().length===before.rows&&Math.abs(list().scrollTop-before.scroll)<2&&h.story.getState().focusMessageId===null&&h.calls.filter(s=>s.startsWith('switch:')).length===before.switches,{before,hint:document.querySelector('.story-timeline__hint').textContent})
      h.missing(null);h.fail(true);jump(61).click();await until(()=>document.querySelector('.story-timeline__hint')?.textContent.includes('fixture read failed'),'error hint');h.fail(false)
      check('B-07 IPC errors surfaced',h.story.getState().focusMessageId===null&&window.__q2Errors.length===0)
      jump(61).click();await until(()=>row('a-61')?.classList.contains('is-focus'),'recovery')
      check('B-07 success clears hint',!document.querySelector('.story-timeline__hint'))
      h.story.getState().setFocus(null);h.delays(200,20);jump(117).click();jump(119).click()
      await until(()=>h.story.getState().focusMessageId==='a-119','latest request focus');await wait(300)
      check('Q2 latest jump wins reversed IPC completion',h.story.getState().focusMessageId==='a-119')
      h.story.getState().setFocus(null);h.delays(200);jump(117).click();document.querySelector('[data-ui-target="分支 b"] .story-tree__main').click()
      await until(()=>h.chat.getState().activeId==='b','explicit branch navigation');await wait(300)
      check('Q2 explicit branch choice cancels pending jump',h.chat.getState().activeId==='b'&&h.story.getState().focusMessageId===null)
      check('Q2 renderer no errors',window.__q2Errors.length===0,window.__q2Errors)
    }catch(error){check('Q2 suite completed',false,{message:error.message,stack:error.stack,body:document.body.innerText.slice(-1500),errors:window.__q2Errors})}
    return{checks,passed:checks.length>=20&&checks.every(x=>x.ok),environment:{userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight]}}
  }
  try{
    const imports=[['React','node_modules/react/index.js'],['{createRoot}','node_modules/react-dom/client.js'],['{flushSync}','node_modules/react-dom/index.js'],['{ChatPage}','src/renderer/src/features/chat/ChatPage.tsx'],['{useChatStore as chat}','src/renderer/src/features/chat/store.ts'],['{useStoryStore as story}','src/renderer/src/features/story/store.ts']].map(([names,file])=>'import '+names+' from '+JSON.stringify(p(file))+';')
    await loadEsbuild().build({stdin:{contents:imports.join('\n')+'\n('+setup.toString()+')()',resolveDir:projectRoot,loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'},alias:{'@shared':p('src/shared')},outfile:path.join(work,'browser.js'),plugins:[{name:'q2-assets',setup(build){build.onLoad({filter:/[/\\]settings[/\\]useTheme\.ts$/},()=>({contents:'export const useTheme=()=>({resolved:"light"})',loader:'js'}));build.onLoad({filter:/\.(png|svg)$/},()=>({contents:'export default "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="',loader:'js'}))}}]})
    fs.writeFileSync(path.join(work,'style.css'),['tokens.css','global.css'].map(name=>readText('src/renderer/src/styles/'+name)).join('\n'))
    fs.writeFileSync(path.join(work,'index.html'),'<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root" style="height:100%;width:100%;display:flex"></div><script src="browser.js"></script></body></html>')
    const resultFile=path.join(work,'result.json')
    const runner=["const {app,BrowserWindow}=require('electron'),fs=require('node:fs');",'app.setPath("userData",'+JSON.stringify(path.join(work,'user-data'))+');',"app.commandLine.appendSwitch('disable-renderer-backgrounding');app.commandLine.appendSwitch('disable-background-timer-throttling');",'app.whenReady().then(async()=>{try{const win=new BrowserWindow({width:1280,height:860,useContentSize:true,show:true,skipTaskbar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile('+JSON.stringify(path.join(work,'index.html'))+');const result=await win.webContents.executeJavaScript('+JSON.stringify('('+suite.toString()+')()')+',true);fs.writeFileSync('+JSON.stringify(resultFile)+',JSON.stringify(result,null,2));app.exit(result.passed?0:1)}catch(e){console.error(e);app.exit(2)}});'].join('\n')
    fs.writeFileSync(path.join(work,'runner.cjs'),runner)
    const electron=path.join(p('node_modules/electron/dist'),readText('node_modules/electron/path.txt').trim()),env={...process.env};delete env.ELECTRON_RUN_AS_NODE
    const code=await new Promise((resolve,reject)=>{const child=spawn(electron,[path.join(work,'runner.cjs')],{cwd:projectRoot,env,stdio:['ignore','inherit','inherit']});const timer=setTimeout(()=>child.kill(),60000);child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',c=>{clearTimeout(timer);resolve(c)})})
    const result=fs.existsSync(resultFile)?JSON.parse(fs.readFileSync(resultFile,'utf8')):{passed:false,checks:[],error:'Electron exited without result'}
    fs.writeFileSync(p('../DOC/agent--ST桥接重构/task-桥接重构1/baseline/q2-chromium-evidence.json'),JSON.stringify({...result,exitCode:code,generatedAt:new Date().toISOString()},null,2))
    for(const item of result.checks)console.log((item.ok?'PASS ':'FAIL ')+item.name+(item.ok?'':' '+JSON.stringify(item.detail)))
    console.log('Q2_CHROMIUM_CHECKS '+result.checks.filter(x=>x.ok).length+'/'+result.checks.length)
    if(code!==0||!result.passed)process.exitCode=1
  }finally{fs.rmSync(work,{recursive:true,force:true})}
}
await q2Browser()
