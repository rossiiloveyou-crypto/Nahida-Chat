# UI_MAP 人工段落（真源）

> `pnpm ui:map` 会读取本文件，把下面三段合并进自动生成的 `UI_MAP.md`。
> 改需求对照 / 变更记录 / 已知约束时改这里，不要手改生成结果。

## 需求 → 位置 → 代码

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

## 变更记录

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
