# Prompt 目录约定

**提示词是文件资产，程序只负责按顺序拼装。** 改提示词 = 改文件，不用打开设置页。

## 目录结构

```
Prompt/
├─ shared/
│  ├─ base.md                 全局底线规则（所有角色、所有模式）
│  ├─ tone.md                 语气与句式规则（所有角色、所有模式）
│  └─ tool_usage.md           工具使用规范（仅 Agent 模式）
└─ characters/
   └─ <角色 id>/
      ├─ README.md            角色说明（不参与拼装）
      ├─ soul.md              人格核心
      ├─ canon/               原作台词样本
      │  ├─ _template.md      填写模板（_ 前缀，不参与拼装）
      │  └─ quotes.md         真正生效的台词（由模板复制而来，可不存在）
      ├─ worldbook/*.md       背景设定
      ├─ modes/
      │  ├─ chat.md           Chat 模式的职责与边界
      │  └─ agent.md          Agent 模式的职责与权限边界
      └─ styles/
         ├─ chat.md           闲聊时的表达风格
         └─ agent.md          干活时的表达风格
```

## 拼装顺序（每次请求现场读文件）

| # | 环节 | 文件 | 生效模式 |
| --- | --- | --- | --- |
| 1 | 全局底线 | `shared/base.md` | 两种 |
| 2 | 语气与句式 | `shared/tone.md` | 两种 |
| 3 | 人格核心 | `characters/<角色>/soul.md` | 两种 |
| 4 | 原作台词 | `characters/<角色>/canon/*.md` | 两种 |
| 5 | 背景设定 | `characters/<角色>/worldbook/*.md` | 两种 |
| 6 | 模式规则 | `characters/<角色>/modes/<mode>.md` | 按模式二选一 |
| 7 | 表达风格 | `characters/<角色>/styles/<mode>.md` | 按模式二选一 |
| 8 | 工具规范 | `shared/tool_usage.md` | 仅 Agent |

任何一环缺失都只是跳过，不会让对话失败。角色目录整个不在时，1、2、8 仍然照常注入。

> 顺序即权重：越靠后的段落离这次回答越近。工具纪律放最后，是为了让它不被语气规则盖掉。

## 四层分工

| 层 | 回答的问题 | 放在哪 |
| --- | --- | --- |
| 底线 | 什么不能做 | `shared/base.md` |
| 声音 | 怎么说才不像模板 | `shared/tone.md` |
| 身份 | 她是谁、记得什么 | `soul.md` + `worldbook/` |
| 语感 | 她说过的原句长什么样 | `canon/` |
| 模式 | 此刻在干什么、能干什么 | `modes/<mode>.md` + `styles/<mode>.md` |

## 改什么，改哪个文件

| 想改的东西 | 文件 |
| --- | --- |
| 她是个什么样的人 | `characters/<角色>/soul.md` |
| 她说话的原句样本（语感校准） | `characters/<角色>/canon/quotes.md` |
| 世界观、地名、人物、事件 | `characters/<角色>/worldbook/*.md` |
| Chat 模式下她该做什么、不该做什么 | `characters/<角色>/modes/chat.md` |
| Agent 模式下的职责与权限边界 | `characters/<角色>/modes/agent.md` |
| 闲聊时的语气与节奏 | `characters/<角色>/styles/chat.md` |
| 带工具干活时的表达方式 | `characters/<角色>/styles/agent.md` |
| 对所有角色都生效的底线规则 | `shared/base.md` |
| 所有模式共用的语气与句式 | `shared/tone.md` |
| Agent 怎么用工具 | `shared/tool_usage.md` |

## 四条硬规矩

1. **一个文件一个意图**：不要把「人格 + 世界观 + 工具规则」塞进同一个文件。
2. **首行必须是 `# 标题`**：设置页的角色名取自 `soul.md` 的一级标题。
3. **模式规则与表达风格分开**：`modes/` 管「该做什么」，`styles/` 管「怎么说话」。调语气不该动到职责边界。
4. **工具纪律只写一份**：Agent 的工具使用方式在 `shared/tool_usage.md`，角色的 `modes/agent.md` 只写这个角色自己的边界，不重复工具清单。
5. **台词只收原作原句**：`canon/` 是语感样本，不是规则；自己编的台词比不写更糟。`_` 前缀的文件不会被读取，模板可以一直放在那里。

## 新增角色

在 `characters/` 下新建文件夹（目录名就是角色 id），放好 `soul.md`、`modes/`、
`styles/`、`worldbook/`，需要台词就再放一个 `canon/`（从 `_template.md` 复制成 `quotes.md`）。
重启后设置页与对话首页会自动出现这个角色。不需要改代码。

> 提示词是产品资产，改动建议走 git 提交，方便回溯「哪次改动让回答变差了」。
