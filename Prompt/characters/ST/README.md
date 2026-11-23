# ST · 空角色卡（酒馆承载）

> 本角色是**空卡**：人格、设定与语料一律由 SillyTavern 角色卡承担，Nahida Chat 这边不写人设。
> 用途：故事区走 ST 桥接时，让 NC 侧不往 system 里塞人格，避免和 ST 角色卡抢戏。

## 文件分工

| 文件 | 负责什么 | 什么时候改它 |
| --- | --- | --- |
| `soul.md` | 声明「本卡不写人格」 | 一般不用改 |
| `modes/chat.md` | 纯聊天时的职责与边界（无工具） | 想改无设定时的应答规则 |
| `modes/agent.md` | 带工具干活时的权限边界 | 想改 Agent 纪律 |
| `modes/story.md` | 故事区叙事规则 | 想改故事推进方式 |
| `styles/chat.md` | 日常对话语感 | 想让她闲聊更平实 / 更像某个人 |
| `styles/agent.md` | 干活时的表达方式 | 想让她汇报得更利索 |
| `styles/story.md` | 故事区笔法 | 想改故事里的写法 |
| `canon/`、`worldbook/` | 空目录，保留是为了设置页文件清单完整 | 需要加语料 / 设定时才放东西 |

## 为什么是空卡

`promptStore.compose()` 的拼装顺序是：全局底线 → 统一语气 → 人格核心 → 原作台词 → 背景设定 → 模式规则 → 表达风格 → [Agent] 工具规范。
桥接故事会话走 `contextOnly`，**静态人格整段不注入**——本卡的 `soul.md` 因此在桥接轮次里不参与。
非桥接场景（普通 Chat / Agent / 未开桥接的故事）下，她按 `modes/` 与 `styles/` 出字，没有预设身世、口头禅或称呼偏好。

## 不在这个目录里的东西

- 全局底线规则：`Prompt/shared/base.md`
- 全局语气与句式：`Prompt/shared/tone.md`
- Agent 的工具纪律：`Prompt/shared/tool_usage.md`
- ST 角色卡本身：由 SillyTavern 侧管理，NC 不读也不改
