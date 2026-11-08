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

### 故事旁白（2026-11-08）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 故事区输入框旁增加「对话 / 旁白」切换 | `chat-story-drawer` → `D15–E18`，元素 **41「对话旁白切换」** | `features/chat/components/Composer.tsx` |
| 选旁白后输入不经过 LLM、不显示用户头像 | 选「旁白」再发送；气泡不出现，旁白以居中文字进入消息区 | `Composer.tsx` → `features/chat/store.ts`（`narrate`） |
| 旁白居中显示为「旁白：xxxxx」 | `chat-story-drawer` → `F11–L12`，元素 **26「旁白 10」** | `features/chat/components/MessageList.tsx`（`message--narration`）、`styles/global.css` |
| 旁白持久化，下一次对话作为系统消息下发 | 无独立控件；发送一次普通对话后生效 | `shared/types.ts`（`MessageRole`）、`main/features/chat/chatService.ts`（`narrate` / `sessionHistoryToLlm`）、`shared/ipc.ts` / `preload/index.ts` |

## 变更记录

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
- 元素编号按 DOM 顺序生成，**新增控件会让后面的编号后移** —— 改完 UI 必须重跑截图并重新生成本文。
