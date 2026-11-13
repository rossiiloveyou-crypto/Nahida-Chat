# 项目施工规范 · Nahida Chat

本文件是本仓库的编码指令入口。**全局约规（`~/.dsh/AGENTS.md`）同样适用**，下面是本项目的补充与细化。

---

## 一、这个项目是什么

Electron + Vite + React + TypeScript 的本地优先桌面聊天客户端。

分层铁律（详见 `docs/01-架构与目录约定.md`）：

```
renderer (React) ── window.nahida ──▶ preload ──▶ main (Node)
   只展示              唯一出口          只转发        唯一能力持有者
```

- 渲染进程**不能**碰 Node / fs / net / ipcRenderer。
- 新增能力 = `main/features/<x>/` + `renderer/src/features/<x>/`，纵向切，不要建横跨一切的大文件。
- 跨进程的数据结构**先写 `shared/types.ts`**，禁止两端各写一份"差不多的接口"。
- 色值只出现在 `styles/tokens.css`，组件里用 `var(--nc-*)`。

---

## 二、UI 改动 = 必须交付可定位图

全局约规第一节的全部条款在这里**强制执行**，并且本项目已经有现成实现，**直接复用，不要重写**：

| 现有资产 | 位置 | 说明 |
| --- | --- | --- |
| 网格覆盖层 | `src/renderer/src/components/GridOverlay.tsx` | 默认关闭，`Ctrl/Cmd+Shift+G` 或 `?grid=1` 打开 |
| 截图脚本 | `scripts/ui/generate-ui-map.cjs` | `pnpm ui:map` |
| 定位文档 | `docs/ui/UI_MAP.md` | 区域/元素坐标表 + 需求→代码对照 |
| 图片 | `docs/ui/ui-map-v0*.png` | 当前尺寸 1280×860 |

### 改 UI 的固定流程

```bash
pnpm typecheck && pnpm build                        # 1. 必须构建，截图读的是 out/
pnpm ui:map --only=<这次改到的视图>[,<视图>]        # 2. 只拍改动部分
node ~/.dsh/agents-global/ui-map/verify-map.cjs docs/ui/ui-map-v0-<视图>.png   # 3. 自检
```

第 3 步必须看到 `PASS`。

**截图只截改动部分（操作者规则，2026-11-13）**：网格图是「这次改动」的证据，不是产品目录。

- 一次改动涉及哪几张就列哪几张，例如 `pnpm ui:map --only=chat-story-drawer`；
- `--only` 会把新坐标**合并**进上一份 `ui-map-v0.json`，没拍的视图沿用旧坐标，`UI_MAP.md` 仍然是完整的一张表；
- 只有**公共样式 / 侧栏 / 主题**这类会影响全部视图的改动，才用 `pnpm ui:map --all`；
- 裸跑 `pnpm ui:map` 会**直接拒绝**（退出码 6）并列出全部视图名，不会静默拍 24 张。

`pnpm ui:map` 已经串好了两步：`electron scripts/ui/generate-ui-map.cjs` 出图 + `node scripts/ui/write-ui-map-md.cjs docs/ui/ui-map-v0.json` 重写文档。
**不要手写 UI_MAP.md 的区域表/元素表**——新增视图、编号后移都会自动同步；只有「需求对照」「变更记录」「已知约束」三段是人写的（真源是 `docs/ui/ui-map-human.md`）。

### 给元素加标注

新增可交互控件时，顺手加上属性，覆盖层会自动编号：

```tsx
<div data-ui-region="B 区域名">              {/* 区域框（紫色 + 字母） */}
  <div data-ui-target="元素名">…</div>        {/* 元素框（绿色 + 序号） */}
</div>
```

**注意**：序号按 DOM 顺序自动生成，加了新元素会让后面的编号整体后移 —— 所以改完 UI **必须重新出图并更新 UI_MAP.md**，否则用户按旧编号反馈就会指错地方。

### 当前首页的约定

新对话首页**只保留功能键**（Chat/Agent 滑块），标题、角色说明、示例问题都已被要求移除，等整体视觉重构后再补。
滑块位置由 `.mode-dock` 的 `margin-top` 控制，与 `EmptyState.tsx` 的结构解耦，便于以后挪位置。

---

## 三、提示词库（不要写死角色）

```
Prompt/
├─ shared/base.md                 全局规则（所有角色）
└─ characters/<角色 id>/
   ├─ soul.md                     人格核心
   ├─ worldbook/*.md              背景设定
   └─ styles/{chat,agent}.md      两种会话模式各自的风格
```

- 拼装顺序固定：**全局 → 人格 → 设定 → 该模式的风格**，缺哪个文件就跳过哪个，不报错。
- **不要在代码里写死任何角色名或人格文本** —— 后续要做多角色。
- **设置页不显示提示词正文**，只提供「改哪个文件」对照表和「打开目录」按钮；正文一律用编辑器改。
- 新增角色 = 建一个文件夹，不改代码。

---

## 四、模型配置

- 档案（ModelProfile）是唯一真源，`Settings` 上的扁平字段（provider/baseUrl/apiKey/model）**只是镜像**，由 `normalizeProfiles` 统一同步。
- 对话永远用「默认档案」的默认模型；`chatService` 里会重新取一次档案，避免镜像过期。
- 新增服务商 = 往 `shared/constants.ts` 的 `VENDOR_PRESETS` 加一条，不改界面代码。
- 旧配置（M0 只有扁平字段）必须能无损升级，已有测试覆盖。

---

## 五、验证命令

```bash
pnpm typecheck      # 主进程 + 渲染进程，必须 0 error
pnpm test           # 行为测试（档案落盘 / 提示词库 / 记忆 / 权限 / 发现 / 沙箱）
pnpm build          # electron-vite 构建
pnpm ui:map --only=<改到的视图>   # 出可定位图（改 UI 时必跑；只拍改动那几张）
```

**测试要测真实边界**：重启后能否读回、删光后是否回落到安全默认、非法输入是否被拒、路径穿越是否被挡。
不要写"重复实现一遍 normalize"这种只验证自己的测试。

---

## 六、并行施工注意

这个工作区同时有多个 agent 在改同一个项目（RAG/记忆模块就是另一个窗口加的）。

- 动手前先看 `git status` 和文件 mtime，**不要假定文件还是你上次看到的样子**。
- `typecheck` 报出你没写过的字段时，先查是谁加的，**不要直接删别人的代码**。
- 发现半成品（类型加了、实现没跟上）→ **先在回复里报告**，再决定补不补。
- 提交标题：`type(scope): 中文描述`，`type` 限 `feat|fix|refactor|perf|style|docs|test|chore|ci|build|revert`，`scope` 用中文模块名，描述以动词开头，不加句号。

---

## 七、沟通

默认简体中文。先结论，再改动，再验证结果，最后限制。
报位置用图上的记法（`A7`、`C7–F9`、`元素 5`），不要用"左边一点""上面那块"。
