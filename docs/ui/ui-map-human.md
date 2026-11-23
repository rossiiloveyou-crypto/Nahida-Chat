# UI_MAP 人工段落（真源）

> `pnpm ui:map` 会读取本文件，把下面三段合并进自动生成的 `UI_MAP.md`。
> 改需求对照 / 变更记录 / 已知约束时改这里，不要手改生成结果。

## 需求 → 位置 → 代码

### 桥接上下文预算（SUP-05）

`settings-bridge-status` 的「桥接预算统计 / 桥接预算回落 / 桥接历史省略」定位到 `BridgeSection.tsx` 的运行状态区。只读展示本轮预算来源、总预算、含 ST 预留的已用量、ST 预留、省略历史条数；不增加设置写入入口。暂无预算轮次时显示占位而非假定容量。

### 对话导入与导出（SUP-04）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 设置中的导入与备份入口 | `settings-data`「设置页导入对话 / 设置页导出对话」 | `BackupPanel.tsx` |
| 文件预览、目标选择、角色匹配警告 | `settings-data-import`、`import-dialog`「导入预览 / 导入模式」 | `ImportDialog.tsx`、`ImportPreviewPanel.tsx` |
| 故事表单内预览与清除 | `story-import-dialog`「从对话导入 / 清空导入预览 / 开场文案」 | `NewStoryDialog.tsx` |
| 当前会话导出、格式与范围 | `export-dialog`「导出格式 / 导出范围」 | `ChatPage.tsx`、`ExportDialog.tsx` |

预览图用隔离夹具替代原生文件选择，仍走 Electron preload 与主进程真实解析。

### 故事召回面板与创建入口（2026-11-21，P4.9）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 独立故事召回参数与向量降级状态 | `settings-story-recall`「故事召回开关 / 轮数 / 预算 / 阈值 / 关键词权重 / 补查深度 / 保存故事召回设置」 | `StoryRecallPanel.tsx` → settings.save；story.recallStatus 只读临时 DB/WAL 副本 |
| 原有事实记忆展开可操作；摘要原样保留 | `settings-memory-facts`「检索参数 / 试召回输入 / 按人列表」；`settings-memory`「对话摘要参数」 | `MemorySection.tsx`，事实区默认折叠 |
| 主页面三模式，故事创建迁移，侧栏只列出/打开 | `chat-empty / chat-stories`「Chat / Agent / 故事 / 新建故事」 | `EmptyState.tsx / ChatPage.tsx / Sidebar.tsx` |
| 创建画像原文写入原有 profile.md | `new-story-dialog` 元素 17「故事画像输入」 | `NewStoryDialog.tsx` → `createStory / saveStoryProfile` |
| QQ 门槛即时保存，其他字段继续点保存 | `settings-qq-threshold` 元素 10「门槛组」 | `QqSection.tsx` → useQq.saveSettings，仅 commandThresholds |

定位图用隔离 `out-p49` 和临时 userData。运行 `env -u ELECTRON_RUN_AS_NODE pnpm ui:map --only=chat-empty,chat-stories,new-story-dialog,settings-memory,settings-story-recall,settings-memory-facts,settings-qq-threshold --build=out-p49 --verify-p49`，验证目标可见、视口边界、PNG 哈希和 DPI 尺寸。全局 verify-map.cjs 本机缺失，等价检查内置于生成器；保留的旧视图单独标记。

### 对话预发送（2026-11-21）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 每会话预发送开关，重启保留 | `chat-dialogue` 元素 **31「预发送开关」** | `features/chat/components/Composer.tsx` → `ChatPage.tsx` → `chatService.updateSession` |
| 独立请求回复；保留草稿，双击只生成一次 | 元素 **32「请求回复」**；同排位于开关右侧 | `features/chat/store.ts` → `chat.requestReply` → `chatService.begin` |
| Enter / 发送只追加，旁白沿用选择 | 元素 **33「对话旁白切换」/ 34「输入框」** | `Composer.tsx` → `queueMessage` / `narrate` |

只重拍此视图，使用隔离 `out-sup02` 与临时 userData。运行 `pnpm ui:map --only=chat-dialogue --build=out-sup02 --verify-presend` 验证 Enter 入队、请求、草稿、生成禁用、空队列与定位图 SHA/边界。QQ 会话隐藏该模式并在主进程拒绝新 API。

### ST 桥接进程与日志（2026-11-21，P6）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 设置 ST 目录、桥接角色、端口与可选 Node 路径 | `settings-bridge` 元素 **5 / 6 / 7 / 8**（桥接角色 `G9–R9`） | `features/settings/sections/BridgeSection.tsx` |
| 打开 ST / 停止 ST / 打开日志 | `settings-bridge` 元素 **10 / 11 / 12** | `BridgeSection.tsx` → preload → `main/features/bridge/host.ts` |
| 查看角色卡、PID、端口、日志大小、运行时、预算统计及最近错误 | `settings-bridge-status` 元素 **16「桥接预算统计」/ 17「桥接状态」/ 18「桥接失败步骤」/ 19「桥接故事召回状态」/ 20「刷新桥接状态」**（三张 bridge 视图同为 20 元素） | `host.health()`、`character.ts`、`spawn.ts`、`logpipe.ts`、`bridge/budget.ts` |
| 修改最高权重规则（空默认、清空停用） | `settings-bridge-lower` 元素 **13「最高权重规则正文」/ 14「保存最高权重规则」/ 15「最高权重规则状态」** | `BridgeSection.tsx` → `bridge.override.get/save` → `override.ts`；`driver.ts` 每轮 SYSTEM / IN_CHAT / depth 0 注入 |

2026-11-21：仅重拍 `settings-bridge / settings-bridge-lower / settings-bridge-status` 三张受影响视图；记忆组件未改，沿用既有图。健康状态页显示连续恢复失败次数、中文失败步骤和只读召回联动，新增入口沿用 `story.recallStatus`；轮询不重复复制召回库。熔断红色告警和孤儿扫描失败的隔离夹具定位图见任务 `baseline/p6-circuit-ui/`，不代表真实故障现场。最近一轮落盘计数尚无只读契约，本轮保留缺口。全局 AGENTS.md 本机不存在；仓库 AGENTS.md 和写图文档脚本仍引用旧全局校验器，二者不在 P6 白名单，U-07/U-08 保持部分未闭合。

### 世界书条目搜索（2026-11-08）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 世界书编辑器条目区按标题搜索 | `worldbook-editor` → 元素 **15「世界书条目搜索」**（`C5–J5`） | `features/worldbook/WorldbookEditorDialog.tsx` |
| 按触发词搜索（大小写无关） | 同上；输入后条目列表即时过滤 | `features/worldbook/filter.ts`（`filterWorldbookEntries`） |
| 无命中 / 清空搜索 | 同上；无命中显示空态，框右侧「×」清空 | `WorldbookEditorDialog.tsx` |

### 对话摘要参数（2026-11-12）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 长期记忆页顶部新增「对话摘要（窗口外的对话）」分区 | `settings-memory` → 元素 **4「对话摘要参数」**（`C8–R16`） | `features/settings/sections/MemorySection.tsx` |
| 总开关 / 触发条数 / 保留窗口 / 四段字符上限 | 同上；6 个数字框 + 1 个开关 | `MemorySection.tsx`、`shared/constants.ts`（`SUMMARY_*_RANGE`） |
| 摘要概况：已摘要会话 / 已压缩消息 / 最近更新 / 数据文件 / 最近错误 | 元素 **5「对话摘要状态」**（`C17–R21`） | `main/features/summary/service.ts`（`status()`）→ `summary:status` |
| 「刷新状态 / 忘掉当前会话的摘要 / 清空全部摘要」 | 元素 **6「对话摘要操作」**（`C21–R22`） | `summary:forget` / `summary:clear` |

### 故事旁白（2026-11-08）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 故事区输入框旁增加「对话 / 旁白」切换 | `chat-story-drawer` → `D15–E18`，元素 **41「对话旁白切换」** | `features/chat/components/Composer.tsx` |
| 选旁白后输入不经过 LLM、不显示用户头像 | 选「旁白」再发送；气泡不出现，旁白以居中文字进入消息区 | `Composer.tsx` → `features/chat/store.ts`（`narrate`） |
| 旁白居中显示为「旁白：xxxxx」 | `chat-story-drawer` → `F11–L12`，元素 **26「旁白 10」** | `features/chat/components/MessageList.tsx`（`message--narration`）、`styles/global.css` |
| 旁白持久化，下一次对话作为系统消息下发 | 无独立控件；发送一次普通对话后生效 | `shared/types.ts`（`MessageRole`）、`main/features/chat/chatService.ts`（`narrate` / `sessionHistoryToLlm`）、`shared/ipc.ts` / `preload/index.ts` |

### 角色切换（2026-11-12）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 对话页输入区工具条最左新增「角色选择」 | `chat-conversation` → 元素 **18「角色选择」**（`C21–E21`，95×28）；首页态是 `chat-empty` 元素 **10** | `features/chat/components/ComposerBar.tsx` |
| 点开列出提示词库里的全部角色，每个带 id；缺 `soul.md` 的置灰不可选 | 同上；菜单底部注明「切换后，新建对话也跟随这个角色」 | `ComposerBar.tsx`、`main/features/prompt/promptStore.ts`（`library()`） |
| 菜单内容来自提示词库、当前角色打勾（可核对的证据） | 新视图 **`chat-character-menu`**（展开态截图，第 5 张） | 同上 |
| 切换**当前对话**的角色，历史消息一个字不动 | 同上；写 `Session.characterId`，下一步请求就换人格 | `main/features/chat/chatService.ts`（`updateSession` + `promptStore.hasCharacter` 校验） |
| 切换后新建对话跟随（不再靠「新建对话」换角色） | 无独立控件 | `ChatPage.tsx`（`handlePickCharacter` → `settings.save({ defaultCharacterId })`） |
| 故事会话的角色归所属故事区，此处只读（悬停有说明） | `chat-story-drawer` 元素 **43「角色选择」**（置灰）；要改去 设置 → 故事区 | `ChatPage.tsx`（`characterLocked`） |

### 故事分支列表（2026-11-13）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 分支抽屉改成**扁平列表**（不再按父子缩进、不再有子节点缩进线） | `chat-story-drawer` → 区域 **F 分支列表**，元素 **29「分支 时钟之谜」** / **30「分支 雨夜的另一种选择」**（各 237×65） | `features/story/StoryDrawer.tsx`、`styles/global.css`（`.story-tree__origin`） |
| 每行三行字：标题 / 消息数·时间·当前 / 出处 | 同上；根分支显示「故事的第一条分支」，其余显示「从《某分支》第 N 条之后分出」 | `shared/story.ts`（`StoryForkOrigin`）、`main/features/story/branches.ts`（`list()`） |
| 删分支按钮（悬停行内出现，**当前分支也能删**；只剩一条时禁用） | 同上，行右侧 22×22，无 `data-ui-target`（所以不占元素编号） | `StoryDrawer.tsx`（`canRemove`）、`main/features/story/derive.ts`（`deleteBranch`） |
| 时间轴「由此分支」派生后，列表末尾多一行并自动激活 | 元素 **31–40** 为时间轴按钮；派生即最新一行 | `features/story/store.ts`（`deriveFrom`） |

### 设置页数字输入框（2026-11-14）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 数字框可以连续输入（以前打一位就得再点一次） | 全部设置分区里的数字框；`settings-memory` 的「对话摘要参数」/「检索参数」两处最典型 | `components/NumberField.tsx`、`components/numberFieldMath.ts` |
| 打字过程中不被钳、不被抢焦点、不做一键一存 | 同上；输入框显示的是你刚敲的值，失焦后才按上下限落一次 | `NumberField.tsx`（onChange 只 setDraft，onBlur/Enter 提交） |
| 低于下限 / 清空后失焦的处理 | 同上；低于下限落到下限，清空回退到清空前的值（不会变成 0） | `numberFieldMath.ts`（`clampNumber`） |

### 故事时间轴（上下文窗口）（2026-11-14）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 时间轴改成定高窗口，**默认停在最新一条**，向上滚看历史 | `chat-story-drawer` → 区域 **G 消息时间轴**（`966,362 287×321`）；标题右侧一行小字「共 N 条 · 停在最新」（悬停有完整说明） | `features/story/StoryDrawer.tsx`（`listRef` + 贴底 effect） |
| 想从刚发生的那句分出去：末条就在首屏 | 元素 **31–40「从此处分支出新剧情 1–10」**（y 347–655；第 1 条被滚出视口，符合「停在最新」） | 同上 → `store.deriveFrom` |
| 窗口定高、超出自滚（22 条时首屏是第 12–22 条） | 同上；`max-height: 44vh` + 内部滚动 | `styles/global.css`（`.story-timeline__list`） |

### 旁听群号一览（弹层）（2026-11-14）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 群号不再平铺，面板只留一行概要 | `settings-channels-observe` → 元素 **20「旁听群号概要」**（`416,649 678×89`） | `sections/ObservePanel.tsx` |
| 入口按钮（没有记录时禁用） | 元素 **21「打开群号一览」**（`416,703 151×36`） | 同上 |
| 弹层：群号表 + 搜索（命中计数 / 清空 / Esc 关闭） | 新视图 **`settings-channels-observe-groups`** → 元素 **23「旁听群号搜索」**、**24「清空群号搜索」**、**25「旁听群号表」** | `sections/ObserveGroupsDialog.tsx`、`settings/observeFilter.ts` |

### 失败的一轮：原因 + 重试（2026-11-14）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 请求失败后气泡**不许**停在三个点的转圈上 | `chat-failed-turn` → 元素 **10「AI 气泡 2」**（`358,196 100×44`）；气泡里写的是主进程真正抛出来的 `fetch failed` | `features/chat/bubble.ts`（`bubbleViewOf`）→ `MessageList.tsx` |
| 给重试键（只给最后一轮） | 元素 **12「重试这一轮 2」**（`358,248 86×29`，在「失败操作 2」行内） | `MessageList.tsx` → `store.retry` → `chat:retry` |
| 给删除键 | 元素 **13「删除这条 2」**（`454,248 74×29`） | 同上 → `store.removeMessage` → `chat:delete-message` |
| 不是最后一条时说明为什么不能重试 | 同一行显示「后面已经有新消息了，只能重试最后一轮」，只留「删除这条」 | `MessageList.tsx` |
| 重试复用那条回复、不重复用户原话 | 点重试后 user 气泡仍是 1 个、消息总数仍是 2 条 | `main/features/chat/chatService.ts`（`restartTurn`） |
## 变更记录

### 修订 33（2026-11-22）· SUP-03 角色卡描述与文件折叠

- 角色根目录新增 `description.md`，仅供卡片展示；缺失时显示带角色 id 的占位提示，描述不进入任何模式的提示词。
- 文件清单默认收起，summary 保留「文件 7 个」及红色缺失计数；新增 `settings-prompts-files` 以真实点击展开第一张卡，原 7 项保留。
- 三张 prompts 图重拍；角色区按 1280×860 内容尺寸实测后设 `scrollY: 374`（收起态受页面最大滚动量钳制）。独立审计覆盖 PNG 哈希、绿色元素框/紫色区域标记、角色控件边界与编号。
- `settings-prompts-roles`：元素 **6 添加自定义角色**（414,306），**7 角色列表**（414,332，682×362）；来源 **8/11/14**，描述 **9/12/15**，文件 **10/13/16**；世界书入口 **17**，编辑器/选择目录/新建 **18/19/20**。坐标单位为 CSS px，PNG 随设备比例为 1666×1120。

### 修订 32（2026-11-20）· P4.5 桥接角色通用化

- 仅重拍 `settings-bridge`：新增元素 **6「桥接角色」**（416,517，678×36；`G9–R9`），新用户留空；运行期间与目录等配置一起置灰，停止后恢复编辑。
- 角色名随「打开 ST」传入并持久化；不再检查角色卡正文、世界书条目数或字节数。设置页移除单角色调试建议与过期阶段说明。
- 本视图端口 / Node / 单轮上限为元素 **7 / 8 / 9**，三个进程按钮为 **10 / 11 / 12**。其余三十张视图沿用历史截图及坐标，`settings-bridge-lower/status` 的旧编号仅对应各自旧图。
- 切卡会硬失败并提示切回目标角色；真实 ST 与真实模型的 H-23 仍由人工确认。

### 修订 31（2026-11-19）· M27 提示词资产分家

- 提示词库增加「添加自定义角色」与「内置 / 自定义」来源徽标，角色目录按钮打开用户层，避免空目录覆盖内置。
- `settings-prompts` 保留注入顺序与入口；新增 `settings-prompts-roles` 展示完整角色区。`--verify-prompt-roots` 仅在隔离 userData 播种 test-a，通过真实 renderer → preload → IPC 捕获打开目录，并核对两种来源徽标。
- 用户路径由主进程返回；shared 逐文件兜底，角色同 id 整体覆盖。内置世界书可读，保存由主进程只读守卫拦截。
- 当前定位（SUP-03 重拍后）：`settings-prompts-roles` 元素 **6 添加自定义角色**（414,306），来源 **8/11/14**，描述 **9/12/15**，文件 **10/13/16**（三卡均在视口）；世界书入口 **17**，编辑器/选择目录/新建 **18/19/20**。区域与编号由脚本生成，不手填生成表。


### 修订 30（2026-11-18）· P3 角色卡检测与最高权重规则

仅更新 settings-bridge、settings-bridge-lower、settings-bridge-status：手动导卡/导卡世界书与 ST 运行预算指引；多行规则输入、保存和启用状态；角色卡名称/avatar/完整性警告。控件顺延为 11–15；其余视图沿用既有地图。P3.5/P4 未施工。

### 修订 29（2026-11-14）· 失败的一轮：写明原因 + 可重试

- **报障**：某些调用出错之后，那条回复会卡在「头像 + 三个点」上——不美观，也没有重试键，
  用户只能再发一条消息把它顶下去。
- **根因有两处，缺一不可**：
  1. 界面：`MessageList` 原来只有 `message.content ? 正文 : 三个点` 这一条判据，
     `status === 'error'` 也走「三个点」那一支 —— 于是失败的样子和「正在生成」一模一样；
  2. 数据：失败原因只发一次 `chat:error` 广播，**不落盘**，关掉顶部错误条或重启就查不到为什么没回。
- **现在**：助手气泡的形态由纯函数 `bubbleViewOf` 决定（text / typing / failed）；
  失败气泡里写原因（`message.error`，跟着消息落盘），下面给「重试这一轮」「删除这条」。
  只有最后一轮能重试（中间那条重跑会截断后面的上下文），翻篇的那些只留删除。
- **重试的语义**是「重跑这一轮」而不是「再发一次话」：复用那条回复的 id，清空正文/思考/工具记录后重跑，
  **不新增用户消息**（否则历史里会有两句一样的原话，侧栏条数也虚增）。
- **另外两种看起来一样的状态也收进同一套**：点了停止（done + 空正文）、应用被关掉/崩掉
  （盘里留着 `streaming` 的半截回复）。后者在**读盘时**统一改成失败态并注明「上次生成没有跑完」，
  半截正文保留 —— 不改的话它会永远转圈，而且 `isReadableMessage` 会把它判成不可读，进不了摘要。
- **新增一张视图** `chat-failed-turn`（共 27 张），用**真失败**播种：把这条会话指到一个连不上的
  本地地址（`127.0.0.1:9`）发一句，主进程走真实的 catch 分支，图上的原因就是真跑出来的那句 `fetch failed`。
  播完会把那条死地址档案删掉，否则 `settings-models` 会多一行、元素编号整体后移。
- **元素编号**：本视图内失败气泡自带 4 个目标（AI 气泡 2 / 失败操作 2 / 重试这一轮 2 / 删除这条 2），
  输入区因此从 12 后移到 **14**。其它视图没有失败消息，编号不变。
- **验证**：`pnpm test:chat-failed`（60 条：纯规则 14、主进程真跑一轮 14、删除 5、读盘收敛 5、三端接线 15、reducer 7）
  与 `pnpm test:chat-failed:e2e`（8 条，真窗口点按钮：不转圈、原因可见、两个键在、点重试真的重跑、不重复用户原话、
  真失败也进同一态、点删除只删那一条、测试档案已清理）。
### 修订 28（2026-11-14）· 故事时间轴改上下文窗口 + 旁听群号收进弹层

- **时间轴默认贴底**：本来是 1~N 从上往下铺满抽屉，而用户要分的通常是最后一条，每次都得先把抽屉滚到底。
  现在时间轴是定高窗口（`max-height: 44vh`，内部滚动），打开 / 切分支 / 新消息后自动贴到最新一条，向上滚看历史。
  抽屉里分支列表也封顶（168px）自滚，免得分支一多就把时间轴顶出屏幕。
- **旁听群号收起**：原来在渠道控制台里一张表平铺所有「账号 × 会话」，旁听过几十个群之后整页都是数字。
  现在面板只留「X 个群 · Y 个私聊 · 合计 N 条会话记录 · 约 M 行语料」+ 一个「群号一览（可搜索）」按钮；
  明细进弹层：按群号 / 群名 / 账号搜索（空格多词 AND，`群聊`/`私聊` 也能当关键词），命中行可直接「看最近」。
  Esc / 点遮罩关闭；只读，仍然没有任何删除入口（旁听库只增不清）。
- **抽屉不再整页滚**：`.story-drawer` 改成 `overflow: hidden`，分支列表封顶 132px 自滚、时间轴 `flex:1` 吃剩余高度自滚。
  不改这一步的话，时间轴贴底只能贴到「抽屉底部之外」，最后几条照样被输入区挡住（本轮实测撞到过）。
  抽屉去掉滚动条后内容宽 277→**287**，区域 F 高 155、区域 G `966,362 287×321`。
- **元素编号变化**：`settings-channels-observe` 去掉「旁听会话表」、加上「旁听群号概要」「打开群号一览」
  → 后续元素后移（旁听操作 18→**22**；同视图另有并行改动新增了「机器人号（自动）」「已记录的机器人号」两个元素，
  所以 4–18 整体 +2）；`chat-story-drawer` 编号不变（时间轴头部那行小字不带 `data-ui-target`）。
- **新增一张视图** `settings-channels-observe-groups`（弹层，共 26 张）。出图脚本顺带补了旁听样本播种：
  按真源 `observe/qq/<uin>/<chatType>/<chatId>.jsonl` 造几行，否则弹层入口是禁用的，图上只能是一句「还没有任何旁听记录」。
- **顺带修掉一个出图假成功**：`view.click` 原来只要元素存在就点，而按钮在数据没拉回来时是 `disabled`，
  点了是静默无效 —— 图会拍成「弹层没打开」，脚本却以为成功（本轮实测撞到过）。现在会等到可用再点。
- **验证**：`pnpm test:story-timeline:e2e`（真窗口、22 条消息：窗口能滚、打开即在底部、首屏第 12 条起、末条可见、可滚回第 1 条）
  与 `pnpm test:observe-groups`（14 条：匹配口径 + 面板不再平铺 + 只读无删除入口）。

### 修订 27（2026-11-14）· 设置页数字框改成「失焦提交」

- **两个报障一起修**：①点进去只能打一个字符，得再点一次才能打下一位；②输入小于下限被立刻改写，想打两位数打不进去。
- **根因**：数字框是受控的，而且**每敲一键就 onCommit** → 主进程归一化 → 回写设置 → value 被换成钳过的值；
  同时存盘期间 `disabled={saving}` 会把焦点直接踢掉（这就是「得再点一次」的真身）。
- **改法**：新建 `components/NumberField.tsx` 统一接管 17 个数字框（9 摘要/记忆 + 5 QQ + 1 模型 + 2 世界书）：
  打字只改本地草稿，**失焦或回车**才提交一次并按 min/max 钳；Esc 放弃；存盘期间不禁用；
  外部值只在「没在编辑」时同步进来。纯函数拆到 `numberFieldMath.ts`，能被 node 直接测。
- **图上零变化**：4 张相关视图（`settings-memory` / `settings-qq` / `settings-models` / `worldbook-editor`）
  重拍后**区域与元素坐标逐字段相同**，编号没有位移；JSON 里只有 `pngSha256` 变了（重拍必然换字节）。
  这几张就是按「只截改动部分」的规则挑的，没有全量重拍。
- **验证**：`pnpm test:number-field`（20 条：纯函数 + 「不许再有裸 type=number」「数字框不许在存盘期间禁用」等结构守卫）
  与 `pnpm test:number-field:e2e`（真窗口 focus → 打 1/10/100 → 失焦，6 条全过）。

### 修订 26（2026-11-13）· 故事分支改独立 + 出图只截改动部分

- **分支不再依赖上级**：`branches.json` 从树改成**扁平列表**（version 2）。节点上不再有
  `parentBranchId / parentMessageId / parentMessageIndex`，只留两张快照：
  `forkedFrom`（给人看的一行出处）与 `memoryBounds`（记忆可见范围）。
  老文件读到自动迁移，迁移前后召回结果逐字一致（`test:story-branch` 的 A-03b / A-03c 盯着）。
- **删分支只剩两条拒绝**：分支不存在、以及「最后一条不能删」。删当前分支被允许，活跃指针交给最近活动的那条；
  「先处理子分支」那道拒绝已删除 —— 分支之间本来就没有父子关系。
- **图上变化（只影响 `chat-story-drawer`）**：区域 F 由「分支树」改名 **F 分支列表**；
  每行 48→**65** 高（多一行出处小字），元素 29 / 30 宽度 237 不变；**元素编号没有位移**
  （删按钮不带 `data-ui-target`、且悬停才出现，覆盖层数不到它）。
- **顺带修掉出图脚本的一个漂移源**：`seedChat` 原来每个视图都往同一条会话追加两条，
  于是第 2 个 seedChat 视图起对话变 8 条、第 3 个 12 条，所有对话截图的内容与编号跟着漂。
  现在会话非空即跳过播种（幂等），对话视图稳定在 4 条。
- **新规则：截图只截改动部分**。裸跑 `pnpm ui:map` 会被拒绝（退出码 6）并列出视图名；
  必须 `--only=<视图>`（坐标表与上一份合并，UI_MAP.md 仍完整）或 `--all`（公共样式/侧栏/主题这类全局改动）。

### 修订 25（2026-11-12）· 对话页角色切换

- **输入区工具条从 3 个选择器变 4 个**：最左新增「角色选择」（名字首字头像 + 角色名 + 箭头）。
  打开的是提示词库清单，不是设置页；缺 `soul.md` 的角色列出来但置灰，避免「清单里莫名少一个」。
- **元素编号变化（只影响带输入区的视图）**：
  `chat-conversation` 模型选择 16→**19**、工作区 17→**20**、权限 18→**21**，角色选择占用 **18**；
  `chat-stories` 19–22、`new-story-dialog` 25–28、`chat-story-drawer` 43–46 同构后移；
  `chat-empty` 10–13、`chat-agent` / `chat-agent-gated` 12–15。`settings-*` 不受影响。
- **行为**：切换同时写「会话」和「新对话默认」两处 —— 否则新建对话又换回默认角色，
  等于把「靠新建对话换角色」换个方式留着。故事会话例外（角色属故事区，见上表）。
- **静默降级被堵住**：主进程 `updateSession` 现在校验提示词库里真有这个目录，
  拼错/角色被删会直接报错，而不是让 `compose()` 悄悄跳过人格那几段。
- **新增一张视图** `chat-character-menu`（对话中 + 菜单展开，24 张图）：否则只能证明"有那个按钮"，
  证明不了菜单里列的是**提示词库里的角色**、当前那个打了勾。
- **测试**：`scripts/test/character-switch.test.mjs`（25 项）已接入 `pnpm test` 链尾。

### 修订 24（2026-11-12）· 思考过程折叠块

- **AI 气泡上方新增「思考」折叠块**（`chat-conversation` 元素 **10「思考 2」**、**15「思考 4」**，145×20px）：
  折叠态显示「思考 + 已思考 · N 字 + ▸」，点开在气泡前展示全文（左侧强调线 + 浅底，最高 260px 滚动）。
- **元素编号变化**：`chat-conversation` 元素 10 之后整体 +1（原「AI 气泡 2」10→**11**、「用户头像 3」11→**12**……）。
  同样被带动的是 `chat-stories`（思考 **11 / 16**）与 `new-story-dialog`（思考 **17 / 22**）——
  这两个视图背后渲染的是同一条会话，所以跟着一起变。`chat-empty` / `settings-*` 无思考块，未受影响。
- **行为**：思考中自动展开（末尾闪烁光标）；正文一开始出现就自动收起；用户手动点过之后不再自动收。
- **判据集变更（T1）**：`chat-sink.test.mjs` 的「通道名只有 chatDelta/chatDone」扩成三通道，
  ChatDone 增加可选 `reasoning` 字段，并新增三条断言（思考走独立通道 / 不混进正文 / done 带全文）。

### 修订 23（2026-11-12）· 长期记忆页新增「对话摘要」分区

- **长期记忆页顶部新增「对话摘要（窗口外的对话）」**（`settings-memory` 元素 **4/5/6**）：总开关、触发条数、保留窗口、四段字符上限，加摘要概况与三个动作按钮。
- **元素编号整体后移 3 位**：原「记忆状态」4→**7**、「检索参数」8→**8**（追加在状态之后，实际为 8）、「试召回输入」9→**9**、「添加记忆」10→**10**；报位置请按新图。
- **页头文案改写**：明确本页有两层记忆（对话摘要 / 事实记忆），避免把两者当成同一件事。
- **行为**：配置改完**立即生效**（每次调用现读 settings），不需要重启；演示模式（mock）下不压缩。
- **测试**：`scripts/test/summary-store.test.mjs`（42 项）已接入 `pnpm test` 链尾。

### 修订 22（2026-11-08）· 世界书搜索 + 故事旁白

- **世界书编辑器新增条目搜索**（`worldbook-editor` 元素 **15**）：同时匹配条目标题与全部触发词，大小写无关；无命中时显示明确空态。新增元素使原列表/展开编号后移一位（列表 15→**16**、展开 16→**17**）。
- **故事区输入框左侧新增「对话 / 旁白」徽章**（`chat-story-drawer` 元素 **41**）：仅故事会话出现；选「旁白」后发送不触发 LLM，不创建 assistant 占位。
- **旁白以居中文字显示**（元素 **26「旁白 10」**）：无用户头像、无气泡，格式为「旁白：xxxxx」。
- **旁白持久化并进入下一轮模型上下文**：共享 `MessageRole` 新增 `narration`；主进程 `narrate` 只写 `sessions.json`，拼接历史时转为带「系统旁白：」前缀的 system 消息。
- **测试**：`scripts/test/story-narration.test.mjs`（12 项）+ `worldbook-editor.test.mjs` 新增搜索 6 项（共 83 项）；均通过。

## 已知约束

- 坐标只对 **1280x860** 有效；窗口更窄时响应式布局会变化，须重新出图。PNG 实际像素可能是 CSS 尺寸的 1.3 倍左右（Electron 的设备像素比），**报位置与 JSON 仍按 1280×860 的网格坐标**。
- **世界书搜索框在条目区顶部**：搜索是即时过滤，不会再请求磁盘；切换世界书 / 刷新列表后查询词会保留到当前弹层关闭，清空按钮在框右侧。
- **故事旁白的「对话 / 旁白」徽章只出现在故事会话**：普通 Chat / Agent 页面不显示；旁白发送后不会立即产生 AI 回复，必须在下一句「对话」发送时才进入模型上下文。
- **角色切换只在对话页**：`ComposerBar` 是唯一的切换入口；侧栏「新建对话」刻意不带角色参数，
  新建出来的对话跟随「新对话默认角色」。故事会话里那个选择器是置灰的 —— 它的角色属故事区（`story.json` 的 meta）。
- **切角色不会换记忆库**：长期记忆按「用户人设」分域，不按 AI 角色分域，切换角色后仍会召回同一批事实记忆。
- 元素编号按 DOM 顺序生成，**新增控件会让后面的编号后移** —— 改完 UI 必须重跑截图并重新生成本文。

2026-11-22（P6 补做）：删除桥接状态页面向用户的内部台账提示；仅重拍 settings-bridge-status 与隔离熔断夹具，状态元素仍为16/17/18/19、最高权重三件仍为13/14/15；仓库规范和文档模板改用内置校验。旧阶段“全局校验器本机缺失”和“白名单外残留”的记录仅为历史现场，不再作为当前操作步骤；桥接控件边界仍以任务baseline独立审计为准。
