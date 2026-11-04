# UI 定位图（UI_MAP）

> **以图为准。** 本文由 `ui-map-v0.json` 自动生成，只做索引；有冲突时以 PNG 为准。
> 重新生成：`pnpm ui:map` 后跑 `node ~/.dsh/agents-global/ui-map/write-ui-map-md.cjs docs/ui/ui-map-v0.json`
> 截图尺寸：**1280x860 内容区**，不含系统标题栏。

## 怎么读这张图

- **细线 = 8px**，**粗线 = 64px**；一格 = 可以说"第 7 行第 C 列"。
- 列标 **A/B/C...** 沿顶部，行标 **1/2/3...** 沿左侧，从内容区左上角起算。
- **紫色框 + 字母** = 区域；**绿色框 + 数字** = 元素，编号在元素左上角。
- 报位置任选：`B7`、`C7-F9`、`区域 B`、`元素 5`。

## 网格调试开关

| 操作 | 效果 |
| --- | --- |
| `Ctrl + Shift + G`（macOS `Cmd`） | 运行时显示 / 隐藏网格与编号 |
| URL 加 `?grid=1` | 以开启状态启动（截图脚本用这个） |
| `pnpm ui:map` | 重新生成全部截图与坐标 JSON |
| `node ~/.dsh/agents-global/ui-map/verify-map.cjs docs/ui/ui-map-v0-*.png` | 自检图里是否真有网格 |

网格覆盖层只在调试时使用，不参与业务；生产打包默认关闭。

---

## 主图

![UI 总览](./ui-map-v0.png)

---

## 对话首页（只保留 Chat/Agent 滑块）

![chat-empty](./ui-map-v0-chat-empty.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 会话侧栏 | x10 y10 236x840 |
| A | 对话头部 | x252 y16 1014x73 |
| B | 模式滑块 | x602 y493 314x72 |
| C | 输入区 | x252 y696 1014x148 |
| C1 | 输入区工具条 | x278 y773 962x28 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 新建对话 | x20 y80 216x38 |
| 2 | 会话列表 | x20 y180 216x479 |
| 3 | 设置入口 | x20 y794 216x48 |
| 4 | 模式与模型角标 | x1054 y39 186x26 |
| 5 | Chat | x607 y498 148x62 |
| 6 | Agent | x763 y498 148x62 |
| 7 | 输入框 | x278 y710 962x56 |
| 8 | 模型选择 | x278 y773 97x28 |
| 9 | 工作区选择 | x721 y773 112x28 |
| 10 | 权限模式 | x1179 y773 61x28 |

## 对话首页 · Agent 模式（侧栏含工作区列表）

![chat-agent](./ui-map-v0-chat-agent.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 会话侧栏 | x10 y10 236x840 |
| A2 | 工作区列表 | x20 y132 216x74 |
| A | 对话头部 | x252 y16 1014x73 |
| B | 模式滑块 | x602 y493 314x72 |
| C | 输入区 | x252 y696 1014x148 |
| C1 | 输入区工具条 | x278 y773 962x28 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 新建对话 | x20 y80 216x38 |
| 2 | 新建工作区 | x212 y139 20x20 |
| 3 | 工作区条目 | x20 y170 216x36 |
| 4 | 会话列表 | x20 y268 216x390 |
| 5 | 设置入口 | x20 y794 216x48 |
| 6 | 模式与模型角标 | x1046 y39 194x26 |
| 7 | Chat | x607 y498 148x62 |
| 8 | Agent | x763 y498 148x62 |
| 9 | 输入框 | x278 y710 962x56 |
| 10 | 模型选择 | x278 y773 97x28 |
| 11 | 工作区选择 | x721 y773 112x28 |
| 12 | 权限模式 | x1179 y773 61x28 |

## 对话首页 · Agent 模式 + 零工作区（输入区门禁态）

![chat-agent-gated](./ui-map-v0-chat-agent-gated.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 会话侧栏 | x10 y10 236x840 |
| A2 | 工作区列表 | x20 y132 216x69 |
| A | 对话头部 | x252 y16 1014x73 |
| B | 模式滑块 | x602 y493 314x72 |
| C | 输入区 | x252 y696 1014x148 |
| C1 | 输入区工具条 | x278 y773 962x28 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 新建对话 | x20 y80 216x38 |
| 2 | 新建工作区 | x212 y139 20x20 |
| 3 | 工作区条目 | x20 y170 216x31 |
| 4 | 会话列表 | x20 y263 216x395 |
| 5 | 设置入口 | x20 y794 216x48 |
| 6 | 模式与模型角标 | x1046 y39 194x26 |
| 7 | Chat | x607 y498 148x62 |
| 8 | Agent | x763 y498 148x62 |
| 9 | 输入框 | x278 y710 962x56 |
| 10 | 模型选择 | x278 y773 97x28 |
| 11 | 工作区选择 | x721 y773 112x28 |
| 12 | 权限模式 | x1179 y773 61x28 |

## 对话中（含 AI 头像与用户头像）

![chat-conversation](./ui-map-v0-chat-conversation.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 会话侧栏 | x10 y10 236x840 |
| A | 对话头部 | x252 y16 1014x73 |
| C | 输入区 | x252 y696 1014x148 |
| C1 | 输入区工具条 | x278 y773 962x28 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 新建对话 | x20 y80 216x38 |
| 2 | 会话列表 | x20 y180 216x479 |
| 3 | 设置入口 | x20 y794 216x48 |
| 4 | 模式与模型角标 | x1054 y39 186x26 |
| 5 | 用户头像 1 | x1166 y15 64x64 |
| 6 | 用户气泡 1 | x897 y15 254x51 |
| 7 | AI 头像 2 | x278 y97 64x64 |
| 8 | AI 气泡 2 | x358 y97 558x240 |
| 9 | 用户头像 3 | x1166 y355 64x64 |
| 10 | 用户气泡 3 | x832 y355 319x51 |
| 11 | AI 头像 4 | x278 y437 64x64 |
| 12 | AI 气泡 4 | x358 y437 558x240 |
| 13 | 输入框 | x278 y710 962x56 |
| 14 | 模型选择 | x278 y773 97x28 |
| 15 | 工作区选择 | x698 y773 159x28 |
| 16 | 权限模式 | x1179 y773 61x28 |

## 设置 · 模型配置

![settings-models](./ui-map-v0-settings-models.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| B | 模型配置 | x286 y46 936x909 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 标题与新建 | x286 y46 936x79 |
| 4 | 档案列表 | x286 y145 253x216 |
| 5 | 档案编辑区 | x555 y145 667x810 |
| 6 | 档案操作按钮 | x555 y883 667x36 |

## 设置 · 提示词库

![settings-prompts](./ui-map-v0-settings-prompts.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x399 y46 720x79 |
| 4 | 打开按钮组 | x957 y48 162x36 |
| 5 | 注入顺序 | x420 y229 678x258 |
| 6 | 角色列表 | x420 y643 678x140 |

## 设置 · 长期记忆

![settings-memory](./ui-map-v0-settings-memory.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y46 720x57 |
| 4 | 记忆状态 | x415 y208 678x105 |
| 5 | 检索参数 | x415 y570 678x172 |
| 6 | 试召回输入 | x415 y878 678x36 |
| 7 | 添加记忆 | x415 y1049 678x36 |

## 设置 · 区块

![settings-zones](./ui-map-v0-settings-zones.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| A | 区块列表 | x394 y172 720x283 |
| B | 区块成员 | x394 y481 720x203 |
| C | 白名单里的会话 | x394 y710 720x187 |
| D | 区块开关 | x394 y923 720x162 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y46 720x100 |
| 4 | 区块表格 | x415 y270 678x79 |
| 5 | 区块 主区块 | x415 y295 678x55 |
| 6 | 新建区块 | x415 y365 678x69 |
| 7 | 成员表格 | x415 y579 678x68 |
| 8 | 开关组 | x415 y1002 678x52 |

## 设置 · 区块（下半屏 / 行为开关）

![settings-zones-lower](./ui-map-v0-settings-zones-lower.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| A | 区块列表 | x394 y-109 720x283 |
| B | 区块成员 | x394 y200 720x203 |
| C | 白名单里的会话 | x394 y429 720x187 |
| D | 区块开关 | x394 y642 720x162 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y-235 720x100 |
| 4 | 区块表格 | x415 y-11 678x79 |
| 5 | 区块 主区块 | x415 y14 678x55 |
| 6 | 新建区块 | x415 y84 678x69 |
| 7 | 成员表格 | x415 y299 678x68 |
| 8 | 开关组 | x415 y721 678x52 |

## 设置 · 渠道控制台（QQ 号白名单 / 群白名单）

![settings-channels](./ui-map-v0-settings-channels.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| A0 | 机器人账号 | x394 y151 720x218 |
| A | QQ 号白名单 | x394 y395 720x319 |
| B | 群白名单 | x394 y740 720x319 |
| C | 鉴权开关 | x394 y1085 720x455 |
| E | 渠道工作区 | x394 y1566 720x241 |
| F | 渠道模型 | x394 y1834 720x244 |
| D | 数据位置 | x394 y2104 720x187 |
| D | 旁听库 | x394 y2317 720x431 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y46 720x79 |
| 4 | 机器人号（自动） | x415 y249 678x19 |
| 5 | 已记录的机器人号 | x415 y280 678x19 |
| 6 | 账号表 | x415 y493 678x68 |
| 7 | 新增账号权限 | x415 y657 678x36 |
| 8 | 群表 | x415 y838 678x68 |
| 9 | 群成员鉴权 | x415 y1129 678x21 |
| 10 | 工具调用拦截 | x415 y1215 678x21 |
| 11 | 群聊工具增强 | x415 y1320 678x21 |
| 12 | 全局权限模式说明 | x415 y1426 678x78 |
| 13 | 渠道工作区路径 | x415 y1645 678x19 |
| 14 | 渠道工作区操作 | x415 y1676 678x36 |
| 15 | 渠道当前模型 | x415 y1932 678x19 |
| 16 | 授权文件 | x415 y2202 678x19 |
| 17 | 旁听根目录 | x415 y2544 678x19 |
| 18 | 旁听合计 | x415 y2575 678x19 |
| 19 | 旁听会话表 | x415 y2607 678x68 |
| 20 | 旁听操作 | x415 y2691 678x36 |

## 设置 · 渠道控制台（下半屏 / 鉴权开关）

![settings-channels-lower](./ui-map-v0-settings-channels-lower.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| A0 | 机器人账号 | x394 y-609 720x218 |
| A | QQ 号白名单 | x394 y-365 720x319 |
| B | 群白名单 | x394 y-20 720x319 |
| C | 鉴权开关 | x394 y325 720x455 |
| E | 渠道工作区 | x394 y806 720x241 |
| F | 渠道模型 | x394 y1074 720x244 |
| D | 数据位置 | x394 y1344 720x187 |
| D | 旁听库 | x394 y1557 720x431 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y-714 720x79 |
| 4 | 机器人号（自动） | x415 y-511 678x19 |
| 5 | 已记录的机器人号 | x415 y-480 678x19 |
| 6 | 账号表 | x415 y-267 678x68 |
| 7 | 新增账号权限 | x415 y-103 678x36 |
| 8 | 群表 | x415 y78 678x68 |
| 9 | 群成员鉴权 | x415 y369 678x21 |
| 10 | 工具调用拦截 | x415 y455 678x21 |
| 11 | 群聊工具增强 | x415 y560 678x21 |
| 12 | 全局权限模式说明 | x415 y666 678x78 |
| 13 | 渠道工作区路径 | x415 y885 678x19 |
| 14 | 渠道工作区操作 | x415 y916 678x36 |
| 15 | 渠道当前模型 | x415 y1172 678x19 |
| 16 | 授权文件 | x415 y1442 678x19 |
| 17 | 旁听根目录 | x415 y1784 678x19 |
| 18 | 旁听合计 | x415 y1815 678x19 |
| 19 | 旁听会话表 | x415 y1847 678x68 |
| 20 | 旁听操作 | x415 y1931 678x36 |

## 设置 · 渠道控制台（旁听库）

![settings-channels-observe](./ui-map-v0-settings-channels-observe.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| A0 | 机器人账号 | x394 y-1409 720x218 |
| A | QQ 号白名单 | x394 y-1165 720x319 |
| B | 群白名单 | x394 y-820 720x319 |
| C | 鉴权开关 | x394 y-475 720x455 |
| E | 渠道工作区 | x394 y6 720x241 |
| F | 渠道模型 | x394 y274 720x244 |
| D | 数据位置 | x394 y544 720x187 |
| D | 旁听库 | x394 y757 720x431 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y-1514 720x79 |
| 4 | 机器人号（自动） | x415 y-1311 678x19 |
| 5 | 已记录的机器人号 | x415 y-1280 678x19 |
| 6 | 账号表 | x415 y-1067 678x68 |
| 7 | 新增账号权限 | x415 y-903 678x36 |
| 8 | 群表 | x415 y-722 678x68 |
| 9 | 群成员鉴权 | x415 y-431 678x21 |
| 10 | 工具调用拦截 | x415 y-345 678x21 |
| 11 | 群聊工具增强 | x415 y-240 678x21 |
| 12 | 全局权限模式说明 | x415 y-134 678x78 |
| 13 | 渠道工作区路径 | x415 y85 678x19 |
| 14 | 渠道工作区操作 | x415 y116 678x36 |
| 15 | 渠道当前模型 | x415 y372 678x19 |
| 16 | 授权文件 | x415 y642 678x19 |
| 17 | 旁听根目录 | x415 y984 678x19 |
| 18 | 旁听合计 | x415 y1015 678x19 |
| 19 | 旁听会话表 | x415 y1047 678x68 |
| 20 | 旁听操作 | x415 y1131 678x36 |

## 设置 · QQ 接入

![settings-qq](./ui-map-v0-settings-qq.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| A | 宿主状态 | x394 y289 720x419 |
| B | QQ 进程 | x394 y735 720x184 |
| C | 行为开关 | x394 y945 720x579 |
| D | 最近事件 | x394 y1550 720x143 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y46 720x79 |
| 4 | 权限说明 | x394 y163 720x19 |
| 5 | 渠道控制台链接 | x602 y164 60x15 |
| 6 | 宿主状态表 | x415 y368 678x228 |
| 7 | 宿主操作 | x415 y609 678x36 |
| 8 | 进程列表 | x415 y814 678x68 |
| 9 | 开关组 | x415 y1024 678x479 |
| 10 | 事件列表 | x415 y1629 678x43 |

## 设置 · QQ 接入（下半屏 / 行为开关）

![settings-qq-lower](./ui-map-v0-settings-qq-lower.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| A | 宿主状态 | x394 y-231 720x419 |
| B | QQ 进程 | x394 y215 720x184 |
| C | 行为开关 | x394 y425 720x579 |
| D | 最近事件 | x394 y1030 720x143 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y-474 720x79 |
| 4 | 权限说明 | x394 y-357 720x19 |
| 5 | 渠道控制台链接 | x602 y-356 60x15 |
| 6 | 宿主状态表 | x415 y-152 678x228 |
| 7 | 宿主操作 | x415 y89 678x36 |
| 8 | 进程列表 | x415 y294 678x68 |
| 9 | 开关组 | x415 y504 678x479 |
| 10 | 事件列表 | x415 y1109 678x43 |

## 设置 · QQ 接入（最近事件）

![settings-qq-events](./ui-map-v0-settings-qq-events.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| A | 宿主状态 | x394 y-599 720x419 |
| B | QQ 进程 | x394 y-154 720x184 |
| C | 行为开关 | x394 y56 720x579 |
| D | 最近事件 | x394 y661 720x143 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y-843 720x79 |
| 4 | 权限说明 | x394 y-726 720x19 |
| 5 | 渠道控制台链接 | x602 y-725 60x15 |
| 6 | 宿主状态表 | x415 y-521 678x228 |
| 7 | 宿主操作 | x415 y-280 678x36 |
| 8 | 进程列表 | x415 y-75 678x68 |
| 9 | 开关组 | x415 y135 678x479 |
| 10 | 事件列表 | x415 y740 678x43 |

## 设置 · 工具权限

![settings-tools](./ui-map-v0-settings-tools.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| B | Chat 工具增强 | x394 y419 720x184 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x394 y46 720x79 |
| 4 | 权限模式 | x415 y249 678x124 |
| 5 | 权限-只读 | x415 y249 219x124 |
| 6 | 权限-审批 | x644 y249 219x124 |
| 7 | 权限-完全访问 | x874 y249 219x124 |
| 8 | Chat 工具增强总开关 | x415 y518 678x21 |
| 9 | 已注册工具 | x415 y708 678x31 |
| 10 | 保存按钮组 | x394 y790 720x36 |

## 设置 · 外观

![settings-appearance](./ui-map-v0-settings-appearance.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |
| 主题选择 |  | x399 y129 720x181 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x399 y46 720x57 |
| 4 | 主题单选 | x420 y208 678x40 |
| 5 | 主题-浅色 | x420 y208 66x40 |
| 6 | 主题-深色 | x493 y208 66x40 |
| 7 | 主题-跟随系统 | x567 y208 94x40 |
| 8 | 当前主题 | x420 y255 678x19 |
| 9 | 配色展示 | x420 y416 678x28 |

## 设置 · 关于

![settings-about](./ui-map-v0-settings-about.png)

### 区域

| 编号 | 区域 | 坐标 |
| --- | --- | --- |
| A | 设置导航 | x10 y10 236x840 |
| B | 设置内容 | x252 y16 1014x828 |

### 元素

| 编号 | 元素 | 坐标 |
| --- | --- | --- |
| 1 | 返回对话 | x22 y68 212x34 |
| 2 | 导航条目 | x20 y116 216x685 |
| 3 | 页头 | x399 y46 720x57 |
| 4 | 运行信息 | x420 y208 678x190 |

---

## 需求 → 位置 → 代码

### 主题（P1）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 主题三段单选（浅色 / 深色 / 跟随系统） | 设置 · 外观 → 元素 **5 / 6 / 7** | `features/settings/sections/MiscSections.tsx`（`AppearanceSection`）、`features/settings/useTheme.ts` |
| 当前生效的主题回显 | 设置 · 外观 → 元素 **8**（「当前生效：…」） | 同上（`resolved`） |
| 色板跟随主题 | 设置 · 外观 → 元素 **9**（`.swatch--canvas`） | `styles/global.css`（读 `--nc-canvas`） |
| 全部日间/夜间色值 | 无控件（渲染层） | `styles/tokens.css`（`:root` 48 键 + `[data-theme='dark']` 39 键） |
| 主题持久化 | 无控件（选完即写 `settings.json` 的 `appearance.theme`） | `shared/types.ts`、`main/features/settings/settingsStore.ts`（`normalizeAppearance`） |
| 深色启动无白闪 | 无控件（窗口底色 + 首帧前 `data-theme`） | `main/window.ts`、`preload/index.ts`（`initialTheme`）、`renderer/src/main.tsx` |

### Chat 工具增强（P2 · 2026-11-03）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| Chat 工具增强总开关（默认关） | 设置 · 工具权限 → **区域 B**，元素 **8** | `features/settings/sections/ToolsSection.tsx`（`chatToolsEnabled`）、`shared/tools.ts`（`ChatToolsSettings.enabled?`） |
| 逐工具勾选（严格 opt-in） | 设置 · 工具权限 → 区域 B 内（总开关开启后才出现，元素 **9 已注册工具** 之前） | 同上（`patchChatTool`）；判定在 `main/features/tools/capability.ts` |
| 群聊工具增强开关（默认开，紧邻工具调用拦截） | 设置 · 渠道控制台 → **区域 C**，元素 **9** | `features/settings/sections/ChannelsSection.tsx`（`groupChatToolsEnabled` = `!== false`） |
| 保存时不丢字段（深合并） | 无控件（保存即写 `settings.json` 的 `chatTools`） | `main/features/settings/settingsStore.ts`（`save()` 的 chatTools 段） |
| 供给判定（唯一判定点） | 无控件（模型侧不可见） | `main/features/tools/capability.ts`（`resolveToolSupply`） |

### 品牌素材（P2）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 侧栏头像（日夜成对，34×34） | 对话首页 / 设置页 → 区域 **A** 左上（纯装饰，不参与编号） | `components/Sidebar.tsx`、`features/settings/SettingsSidebar.tsx`、`assets/nahida/index.ts` |
| 侧栏底部装饰（日夜成对，上缘 22% 淡出） | 对话首页 → 区域 **A** 底部、设置入口之上（高 108px） | `components/Sidebar.tsx`（`.sidebar__ornament`）、`styles/global.css` |
| 空态徽章（日夜成对，210×96） | 对话首页 → 滑块 **元素 7/8** 上方（绝对定位，不占流、不改滑块位置） | `features/chat/components/EmptyState.tsx`（`.empty-state__emblem`） |
| 发送按钮图标（日夜成对，viewBox 40 vs 44） | 区域 **C1** → 输入框右侧按钮内（20×20 锁死） | `features/chat/components/Composer.tsx`（`.composer__action-icon`） |
| 夜间满幅星空 + 压暗层 | 无控件（`body` 两层背景，仅夜间） | `styles/tokens.css`（`--nc-veil`）、`styles/global.css`（`[data-theme='dark'] body`） |
| 夜间半透明面板 | 无控件 | `styles/tokens.css`（`--nc-page-surface` / `--nc-panel-veil` / `--nc-composer-surface`） |
| 模式选择框与高亮（日夜各一对） | 对话首页 → 区域 **B**，元素 **7 / 8** | `styles/global.css`（`.mode-switch__item*` → `card-frame-*`） |
| 分割线（横 ×2 / 竖 ×1） | 侧栏「最近」上方、输入条顶部、侧栏与主区之间 | `styles/global.css`（`.sidebar__section-title::before` / `.composer` / `.app-main::before`） |
| 主页面点缀树叶 | 对话首页 → 空态四周（无编号，纯装饰） | `features/chat/components/EmptyState.tsx`（`.empty-state__leaf--1/2/3`） |
| 素材唯一出口 | 无控件 | `assets/nahida/index.ts`（`BRAND` / `brandFor`），白名单 **21** 个文件 |

### 工作区菜单（P5）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 点「…」菜单立刻完整可见，不需要滚动列表 | 对话首页 → 区域 **A2**，元素 **3 工作区条目** 的右端「…」（条件渲染，不进编号） | `features/workspace/WorkspaceSection.tsx`（`openMenu`）、`styles/global.css`（`.workspace-menu`） |
| 菜单不出视口（底部上翻 / 左右夹紧） | 同上 | 同上（`MENU_W=160` / `MENU_H=106` / `VIEWPORT_PAD=8`） |
| 滚列表 / 拖窗口时菜单自动关闭 | 同上 | 同上（`scroll` 用 capture、`resize`） |
| 点菜单项不被误判为「点外面」 | 同上 | 同上（`sectionRef` + `menuRef` 两处 contains） |

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 设置页左栏是设置条目 | 区域 A，元素 1/2 | `features/settings/SettingsSidebar.tsx` |
| 模型配置（档案 / 编辑 / 测试） | 区域 B，元素 3/4/5/6 | `features/settings/sections/ModelSection.tsx` |
| 提示词库（注入顺序 = 改哪个文件 / 打开目录 / 角色清单） | 元素 **3 / 4 / 5 / 6** | `sections/PromptsSection.tsx` |
| Chat/Agent 滑块 | 区域 B，元素 7/8 | `features/chat/components/EmptyState.tsx` |
| 输入框（**无字数上限**） | 区域 C，元素 9 | `features/chat/components/Composer.tsx` |
| **① 模型配置加「获取可用模型」** | 模型配置 → 档案编辑区，模型清单底部「+ 添加」右侧 | `sections/ModelSection.tsx`、`sections/ModelDiscovery.tsx`、`main/features/settings/modelDiscovery.ts` |
| **② token 预算去掉硬上限** | 长期记忆 → 检索参数里的 budget 输入框 | `sections/MemorySection.tsx`、`shared/constants.ts`、`main/features/rag/index.ts` |
| **④ 多工作区：侧栏工作区列表** | 对话首页 → 区域 **A2**，元素 **2**（新建）/ **3**（条目） | `features/workspace/WorkspaceSection.tsx`、`useWorkspaces.ts`、`main/features/settings/settingsStore.ts`、`main/features/workspace/index.ts` |
| **④ 多工作区：输入条里的工作区选择** | 对话首页 → 区域 C1，元素 **11** | `features/chat/components/ComposerBar.tsx`、`features/chat/ChatPage.tsx` |
| **④ 多工作区：每个会话的目录边界** | 无独立控件（由会话绑定） | `shared/types.ts`（`ToolScope`）、`main/features/tools/sandbox.ts`、`main/features/chat/chatService.ts`（`toolScopeOf`） |
| **④ 设置里的工作区已移除** | 工具权限页只剩权限模式 + 工具清单 | `sections/ToolsSection.tsx` |

### 工作区归属与空态门禁（P6）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| Chat 模式不显示工作区段 | 对话首页 · **Chat** → 侧栏「新建对话」与「最近」之间**没有** A2 区域（图 `ui-map-v0-chat-empty.png`） | `components/Sidebar.tsx`（`activeMode === 'agent' &&`）、`features/chat/store.ts`（`draftMode`） |
| Chat 模式不显示工作区范围标识 | 同上 → 「最近」右侧无工作区名（`.sidebar__section-scope`） | 同上 |
| Agent 模式下的工作区段 | 对话首页 · **Agent** → 区域 **A2**，元素 **2**（新建）/ **3**（条目）（图 `…-chat-agent.png`） | `features/workspace/WorkspaceSection.tsx` |
| **零工作区时输入区不可输入** | Agent + 零工作区 → 区域 **C**，元素 **9** 占位文案「先创建一个工作区，Agent 才能开始干活」（图 `…-chat-agent-gated.png`） | `features/chat/components/Composer.tsx`（`readOnly` + `.is-gated`）、`styles/global.css` |
| **点输入区直接弹建区流程** | 同上 → 整块任意位置可点 | `features/chat/ChatPage.tsx`（`handleCreateWorkspace` → `useWorkspaces().pickDirectory + save`） |
| 建完立刻可输入（无需重启） | 同上 → `.is-gated` 消失、侧栏出现 1 条目 | `features/workspace/useWorkspaces.ts`（`publish` 单例广播） |
| 侧栏空态「还没有工作区」可达且会保持 | Agent + 零工作区 → 区域 **A2**，元素 **3** | `main/features/settings/settingsStore.ts`（`normalizeWorkspaces` + `workspaceOptOut`）、`shared/types.ts` |
| 工作区选择器显示「未选工作区」 | 区域 **C1**，元素 **11** | `features/chat/components/ComposerBar.tsx` |
| 零工作区时工具被主进程拒绝 | 无独立控件（工具卡上出现失败原因） | `main/features/chat/chatService.ts`（`toolScopeOf` 抛错 + `runTool` 收敛） |

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| **P5 区块：记忆域列表**（root 置顶、灰底、不可删改） | 设置 → 区块 → 区域 **A**，元素 **4**（表格）/ **5**（主区块行）/ **6**（新建） | `features/settings/sections/ZonesSection.tsx`、`useZones.ts`、`main/features/zones/store.ts` |
| **P5 区块：选中区块的成员表** | 区域 **B**，元素 **7** | `ZonesSection.tsx`、`main/ipc/zones.ts` |
| **P5 区块：未归区的 QQ 会话候选** | 区域 **C**（没有白名单条目时只有空态文字，条件渲染） | `ZonesSection.tsx`、`main/ipc/zones.ts`（`zones:unzoned`：白名单 − 已归区，P6 换源） |
| **P5 区块：本区块行为开关** | 区域 **D**，元素 **8** | `shared/zones.ts`、`main/features/zones/scope.ts` |
| **P5 记忆按域召回 / 按域写入** | 无独立控件（聊天时自动生效） | `main/features/chat/{sessionPolicy,chatService}.ts`、`main/features/rag/{store,retriever,index}.ts` |
| **P5 广播归属守卫（X-01）** | 无控件（QQ 消息不再抢桌面的「正在生成」） | `renderer/src/features/chat/store.ts` |
| **P5 长代码块不劈开（X-03）** | 无控件（QQ 每条消息的围栏成对） | `main/features/qq/segment.ts` |

### 渠道白名单（P6 · SL 接入）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| **绑定表整体下线**：QQ 面板不再有「外部会话 ↔ 本机会话」那一区（原 C 区，含列表与表单） | 设置 · QQ 接入 → 只剩 **A 宿主状态 / B QQ 进程 / C 行为开关 / D 最近事件**（图 `ui-map-v0-settings-qq.png`） | `sections/QqSection.tsx`、`useQq.ts`、`main/features/qq/store.ts`（只留设置） |
| 权限去哪了（面板顶部静态说明） | 设置 · QQ 接入 → 元素 **4「权限说明」**（`%APPDATA%\Nahida Chat\channels\access.json`） | `sections/QqSection.tsx`（`data-ui-target="权限说明"`） |
| 侧栏导航描述改成「进程、白名单与回复」 | 设置 · 左栏 → 元素 **7**（QQ 接入条目副标题） | `features/settings/nav.ts` |
| 谁能回复 / 谁能用工具（数据层） | 无控件（P7 控制台才出界面；本版本手改 `access.json`） | `shared/channels.ts`、`main/features/channels/store.ts`、`main/ipc/channels.ts`、`main/features/qq/bridge.ts`（`unbound` / `no-permission` 两支） |
| 「加白即可入区」的候选来源 | 设置 · 区块 → 区域 **C**（候选来自白名单，不再是绑定表） | `main/ipc/zones.ts`（`zone:unzoned` + `zoneMemberAdd` 白名单守卫）、`useZones.ts` |
| 渠道会话不进侧栏 | 对话首页 · 侧栏「最近」**不出现** `qq:…` 会话（无单独控件） | `main/features/chat/chatService.ts`（`ensureChannelSession` / `listDesktopSessions`）、`main/ipc/index.ts`（`chat:list`） |
| 域判定改为解析会话 id | 无控件（聊天时自动生效） | `main/features/zones/scope.ts`（`isChannelSessionId` → `zone` / `solo`） |

### 渠道授权 v2 · 按「人」授权（P9-R3）

> 判定主体从**会话**改成**人（QQ 号）**。会话 = 机器人号 + 群号，整个群共用一条记录，
> 按会话判等于「群里一个人有权限 = 全群都能」。图见
> `ui-map-v0-settings-channels.png`（首屏）/ `-lower.png`（下滚 651px）/ `-observe.png`（下滚 1273px）。

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 机器人自己登录的号（**不参与授权**，只用来把群展开成会话键） | 首屏 → 区域 **A0**，元素 **1「机器人号（自动）」/「已记录的机器人号」** | `ChannelsSection.tsx`（`useBotUin`）、`main/features/channels/store.ts`（`addUin` / `uins[]`） |
| QQ 号白名单：**一个号一行**，私聊 / 群聊 / 工具三个位各自独立 | 首屏 → 区域 **A**，元素 **4「账号表」/ 5「新增账号权限」** | `ChannelsSection.tsx`（`AccountRow` / `PERMISSION_COLUMNS`）、`shared/channelAccess.ts`（`AccountPermissions`） |
| 群白名单：群号一行，管「这个群允不允许她说话」 | 首屏下半 → 区域 **B**，元素 **6「群表」** | `ChannelsSection.tsx`（`GroupRow`）、`store.ts`（`upsertGroup` / `removeGroup`） |
| 群成员鉴权开关（默认**关闭**）：打开后群里只有白名单里的人 @ 她才回 | 下滚 651px → 区域 **C**，元素 **7「群成员鉴权」** | `ChannelsSection.tsx`、`shared/channelAccess.ts`（`resolveMessageAccess`）、`main/features/qq/bridge.ts`（群聊 ③） |
| 工具调用拦截开关（默认**开启**）：模型照常看得到工具，**执行前**按发言人拦 | 下滚 651px → 区域 **C**，元素 **8「工具调用拦截」** | `main/features/channels/toolGate.ts`、`chatService.ts`（`runTool` 闸门）、`shared/channelAccess.ts`（`resolveToolAccess`） |
| 「允许工具」还要看全局权限模式（QQ 没有审批卡 = approve 等于全禁） | 下滚 651px → 区域 **C**，元素 **9「全局权限模式说明」** | `ChannelsSection.tsx`、`main/features/tools/permission.ts`（`PERMISSION_MODE_DESC`） |
| **渠道工作区根（P3 / M21）**：QQ 私聊与群聊里她读写文件唯一允许落地的目录，可改可恢复默认 | 下滚 1273px → 区域 **E**，元素 **13「渠道工作区路径」/ 14「渠道工作区操作」** | `ChannelsSection.tsx`（`channelWorkspaceDirLabel` / `pickChannelDir` / `resetChannelDir`）、`shared/types.ts`（`Settings.channelWorkspaceDir?`）、`settingsStore.ts`（`defaultChannelWorkspaceDir`）、`chatService.ts`（`toolScopeOf` 渠道分支） |
| **渠道模型（P3 复核补正 · 只读提示）**：渠道会话不单独记模型，每轮用**默认档案的默认模型**；面板只显示它落在哪个档案/模型上，**不提供选择器** | 下滚 1517px → 区域 **F**，元素 **15「渠道当前模型」** | `ChannelsSection.tsx`（`channelModelLabel` / `useModelProfiles`）、`settingsStore.ts`（`activeProfile` / `resolveProfile`）、`chatService.ts:637`（`effectiveSettings`）、`chatService.ts:115`（`ensureChannelSession` 不传 `modelProfileId`/`modelId`） |
| **渠道拒绝理由面向 QQ（P3 / M03）**：渠道里说「不支持交互式审批」，桌面上仍是「用户拒绝或审批超时」 | 无控件（工具卡上出现失败原因） | `chatService.ts`（`runTool` 的 `record.error = sink.canApprove() ? … : …`） |
| 授权文件位置与 v1 备份说明 | 下滚 1273px → 区域 **D**，元素 **16「授权文件」** | `ChannelsSection.tsx`、`store.ts`（`migrateToV2` → `access.v1.backup.json`） |
| 私聊准入按发言人判（陌生人私聊直接丢，不进模型） | 无控件（行为） | `bridge.ts`（私聊分支 ①）、`shared/channelAccess.ts` |
| 区块候选：白名单 → 会话键的投影（群 × 每个已知 uin） | 设置 · 区块 → 区域 **C**（候选列表） | `store.ts`（`sessions()`）、`main/ipc/zones.ts`（`zones:unzoned`） |

### 旁听库跨账号显示（P9-R2）

| 需求 | 图上位置 | 代码 |
| --- | --- | --- |
| 会话表新增「账号」列（哪个号记的） | 旁听库 → 元素 **19「旁听会话表」** 第 2 列 | `ObservePanel.tsx`、`shared/observe.ts`（`ObserveConversation.uin`） |
| 合计行拆成两句：第二句只在「同一个群被多个号记录」时出现 | 旁听库 → 元素 **18「旁听合计」** 及其下一行 | `ObservePanel.tsx`（`multiAccount`） |
| 跨号角标 ⧉N（同一 chatId 出现 ≥2 次时的淡色标记） | 元素 19 的「会话号」格 | `ObservePanel.tsx`（`.qq-tag-multi`）、`styles/global.css` |
| 面板**不**再定时轮询 `status()`（全量扫盘，2 GB 时约 3 秒） | 无控件（行为） | `useObserve.ts`（只在挂载时拉一次，刷新靠按钮） |

> 元素 **10 / 11 / 12** 位于 **区域 C1**（约 C12–H13）：10 按档案分组选模型，11 选工作区
> （写进当前会话），12 切权限模式。三个下拉菜单都向上弹出、条件渲染，静态截图里看不到。
>
> 工作区的三个入口分工：**侧栏 A2** 管清单（新建 / 改名 / 打开目录 / 移出），
> **元素 11** 管"这个会话用哪个"，**设置 → 工具权限** 只剩权限模式。
> 文件边界永远是「会话绑定的工作区」，不是全局设置 —— 两个会话可以同时开在两个目录。

## 变更记录

### 修订 19（2026-11-04）· P3 复核补正（渠道模型只读提示）

- **渠道控制台新增区域 F「渠道模型」**（在「E 渠道工作区」之后、「D 数据位置」之前）：
  元素 **15 渠道当前模型**（只读展示「档案名 · 默认模型」；没有可用档案时显示
  「（没有可用的模型档案 —— 渠道发不出消息）」）。
- **它是提示，不是开关**：没有任何写入路径 —— 不新增设置字段、不调 `updateSession`、
  不在渲染层重新实现 `resolveProfile`。守卫 `channels-ui-contract` 的 **5d / 5e / 5f** 三条盯着这条边界，
  其中 5f 已做突变验证（注入一个 `channelModelProfileId` 常量 → 立刻 FAIL，还原后回绿）。
- **元素编号再次后移**：E 区 11/12 → **13/14**，新增 15，原「授权文件」13 → **16**，
  旁听库 14/15/16/17 → **17/18/19/20**。旧截图编号全部作废，**以本次出图为准**。
- **区域字母顺序**：视觉顺序是 C → E → **F** → D → D（旁听库）。字母只是编号，不表示顺序。
- 出图命令与自检：`pnpm ui:map --only=settings-channels,settings-channels-lower,settings-channels-observe`，
  `verify-map` 三张全 **PASS**（1600×1075，竖线 334 / 横线 226–228）。

### 修订 18（2026-11-04）· P3（渠道端到端）

- **渠道控制台新增区域 E「渠道工作区」**（在「C 鉴权开关」之后、「D 数据位置」之前）：
  元素 **11 渠道工作区路径**（只读展示当前根；未配置时显示「（默认）应用数据目录/workspace」）
  + 元素 **12 渠道工作区操作**（「选择目录」；已配置时多一个「恢复默认」）。
  它是 **M21** 的「可配置」落点，也是**供给之外**的第二处渠道专属设置。
- **区域字母顺序与视觉顺序不同，是有意为之**：视觉顺序是 C → **E** → D → D（旁听库），
  因为 D 是「数据位置」，把它挪到通道设置之前会打断「授权 → 工作区 → 数据文件」的阅读顺序；
  区域字母只是编号，不表示顺序。**反馈位置请按图上的圆圈字母说，不要按出现顺序数。**
- **元素编号整体后移**：原「授权文件」**10 → 13**（E 区占了 11、12）；旁听库的 11/12/13 → **14/15/16**。
  旧截图上的编号对新版本无效，**以本次出图为准**。
- **渠道拒绝理由分岔**：`record.error` 由 `sink.canApprove()` 决定 ——
  渠道（`QqSink`，恒 false）说「当前环境不支持交互式审批…」，桌面（有卡）仍是逐字
  「用户拒绝或审批超时」。前者的措辞面向**模型可转述**，不含 `canApprove` / `permissionGate` 这类内部词。
- 出图命令：`pnpm ui:map --only=settings-channels,settings-channels-lower,settings-channels-observe`，
  `verify-map` 三张全部 **PASS**（1600×1075，竖线 334 / 横线 224–234）。

### 修订 17（2026-11-03）· P2（Chat 工具增强设置）

- **工具权限页新增区域 B「Chat 工具增强」**（在「权限模式」与「已注册工具」之间）：
  元素 **8 启用 Chat 工具**（总开关，**默认关**）。
  总开关开启后才出现逐工具勾选行；关闭时列表隐藏但**已勾选的工具保留**。
  区域 B 的 y 下移，后续「已注册工具」元素编号 **8 → 9**、保存按钮 **9 → 10**。
- **渠道控制台 C 区新增元素 9「群聊工具增强」**（紧邻「工具调用拦截」，**默认开**）。
  它是**供给**开关（有没有工具目录），与上面的「工具调用拦截」（**授权**开关）是两件事，
  两者都打开群里才有工具可用。元素 9 插入后，原来的「全局权限模式说明」**9 → 10**。
- **缺省方向相反，不要写反**：总开关 `enabled` 缺省 = 关（`=== true` 才算开）；
  群聊开关 `groupEnabled` 缺省 = **开**（`!== false` 才算开，M02）。
- **出图机制新增按需拍摄**（见下节「只拍需要的视图」）：新增 `--only=<name[,name]>` 与
  `--only=diff`，只拍指定视图时**其余视图坐标从上次 JSON 合并保留**，UI_MAP.md 仍是一张完整表。

### 修订 16（2026-11-02）· P9-R3（权限模型重做：按「人」授权）+ P9-R2（旁听跨账号显示）

- **渠道控制台整块重做**，从「按会话」改成「按人」：
  区域变为 **A0 机器人账号 / A QQ 号白名单 / B 群白名单 / C 鉴权开关 / D 数据位置**（旁听库仍在最后）。
  原来的「私聊白名单 / 群聊白名单」两块**不再存在** —— 它们的主体都是会话。
- **元素编号整体重排**（渠道视图）：1 返回对话 / 2 导航条目 / 3 页头 /
  **4 账号表 / 5 新增账号权限 / 6 群表 / 7 群成员鉴权 / 8 工具调用拦截 / 9 全局权限模式说明 /
  10 授权文件 / 11 旁听根目录 / 12 旁听合计 / 13 旁听会话表 / 14 旁听操作**。
  **旧编号不再适用**，请按本版新图报位置。
- **新增三张图的标题**（原来显示「待补中文标题」）：
  `settings-channels` → 设置 · 渠道控制台（QQ 号白名单 / 群白名单），
  `-lower` → 下半屏 / 鉴权开关，`-observe` → 旁听库。
- **列宽改了三条**（J-62）：`.qq-table--accounts`（5 列，权限位那格 232px）、
  `.qq-table--groups`（4 列）、`.qq-table--observe` **7 → 8 列**（加了「账号」列）。
  **不要**再复用 `.qq-table--channels` —— 它已随旧面板一起删除。
- **旁听表新增「账号」列 + ⧉N 角标 + 合计第二句**（P9-R2）：
  同一个群被多个号记录时，用户以前会以为「同一个群记了两遍 / 出 bug 了」（J-64）。
  修的是**显示口径**，存储层一个字节没动。
- **区块面板**：候选行的权限注记口径跟着改（私聊看 `private` 位 → 「可私聊 / 仅群聊」），
  顶部说明删掉了「只共享长期记忆，不共享短期上下文」这句（它是 M15 幻觉，已作废）。

### 修订 15（2026-11-01）· P8（旁听库 D 区）

- 渠道控制台新增 **D 区「旁听库（群语料）」**，位置在 C 数据位置之后：
  根目录 / 合计（会话数·文件数·体积·行数）/ 超 2 GB 提示 / 会话表 / 「看最近 50 条」抽屉 /
  刷新 + 打开目录 + 复制路径。
- **为什么加这张图**：D 区在面板最下方，两张旧图（`settings-channels` / `-lower`）都滚不到它，
  只能新开 `settings-channels-observe`（下滚 1560px）才可定位。
- **编号变化**：渠道视图元素 **11 → 12**，D 区新增
  **元素 9 旁听根目录 / 10 旁听合计 / 11 旁听会话表 / 12 旁听操作**。
  抽屉在空库时不渲染，所以不出编号；有记录时点「看最近」会再往后加编号。
  D 区在 `settings-channels` / `-lower` / `-observe` 三张图里都可见，编号一致。
- **D 区没有任何删除按钮** —— 旁听库「只增不清」是用户裁决（M21b），不是遗漏。
- 表格列宽单独一条 `.qq-table--observe`（7 列）。**不要**复用 `.qq-table--channels`（5 列），
  否则表头会折到第二行（J-62，本次实测踩到）。

### 修订 14（2026-11-01）· P7（渠道控制台）

- P6：移除 QQ 面板「绑定表」C 区，该视图元素编号整体前移。
- P7：新增设置分区「渠道控制台」（私聊 / 群聊两块 + 数据位置），设置页导航元素编号整体后移。
- P7：区块面板 C 区改为「白名单里的会话」，候选行新增权限位与最近活动两列。

**新增视图**：`settings-channels`（首屏）与 `settings-channels-lower`（下滚 760px），
面板结构 **A0 机器人账号 / A 私聊白名单 / B 群聊白名单 / C 数据位置**。

**为什么会有 A0**：白名单条目的第一段是**机器人自己的 QQ 号**（登录号），后面才是对方号。
群聊时两者完全不同，填错这条白名单永远匹配不上。面板优先从「已注入的 QQ 进程」自动取号
（`qq.processes()` 的 `account.uin`），取不到才让用户手填（存 `localStorage` 键 `nahida.channels.uin`）。

**编号变化**：设置页导航新增第 7 项「渠道控制台」，因此**所有 settings 视图**左导航的
后续元素**编号整体 +1**（原 7「QQ 接入」→ 现 8，原 8「工具权限」→ 现 9，依此类推）。
旧图编号不再适用，请按本版新图报位置。

### 修订 13（2026-11-01）· P7（UI 升级）· 选择框溢出与输入框垂直居中

只改 `styles/global.css`，无组件/CDOM 变化，但**坐标有位移**，所以图必须重出（已重出）。

- **输入框文字垂直居中**：`.composer__box` 的 `align-items` 由 `flex-end` 改 `center`
  —— 原来 34px 的发送按钮把盒子撑到 55.6px，22.4px 的 textarea 被压到底部，
  文字中心比盒中心**低 4.2px**。改后偏差 **0.0px**（区域 **C** 元素 **9**）。
- **选择框不再贴邻居**：`.session-list` / `.settings-nav` / `.workspace-list` 的 `gap` 由 2px 改 **6px**。
  选中态的装饰环是 `box-shadow: 0 0 0 1.6px`（**向外扩但不占布局**），两条相邻各扩 1.6px 共 3.2px，
  原来的 2px 装不下 → 环盖到邻居上。
- **边框不再被左边界裁掉**：同一批容器由 `padding-right: 2px` 改成 `padding: 0 2px`。
  它们是 `overflow-y: auto` 的滚动容器，**会裁掉子元素向外的绘制**，而左边 `padding` 是 0，
  导致选中环左边那一条**完全看不见**（用户反馈「边框卡在左边界里面」）。
  放大 8 倍的亮度剖面：环位置由 21,20（全黑）变成 **122,233**（完整）。
- **Chat/Agent 滑块不再被压扁**：`.mode-switch__item` 由 132×63.9（比 2.07）改成 **148×62（比 2.39）**，
  卡间距 4 → 8px。素材 `card-frame` 是 240×100（比 2.40）且 `preserveAspectRatio="none"`，
  容器比例不对就会**无条件拉伸**，缝针虚线与四角花叶跟着变形。

**本视图坐标变化（左导航累计下移约 28px）**：`settings-*` 各视图区域 **A** 内的导航条目、
以及对话页区域 **A / A2** 的条目间距均已重算，下表已是新值。元素**编号未变**。

### 修订 12（2026-11-01）· P6（SL 接入）· 渠道白名单替代绑定表

- **删掉一整块**：设置 → QQ 接入的 **C 区「绑定表」**（列表 + 表单，原 258–366 行）连容器一起删除，
  页面从 5 区变 4 区（A 宿主状态 / B QQ 进程 / C 行为开关 / D 最近事件）。元素编号整体前移：
  原「绑定列表 / 新建绑定」两个元素消失，**新增元素 4「权限说明」**，其后元素号整体前移（页头仍为 3）。
- **为什么删**：授权模型整体换掉（原蓝图 M18）。「外部会话 → 手工绑一条 NC 会话」的绑定表废弃，
  改为**白名单条目 + 会话 id 由外部键直接算出**（`qq:<uin>:<type>:<id>`）。`userData/qq/bindings.json` 原地保留、不再读取。
- **顶部静态说明**（元素 4）：告诉用户权限已经搬到「渠道控制台」（P7 提供），当前版本手改
  `%APPDATA%\Nahida Chat\channels\access.json` 即可。这是 H-29 要求的「不能让用户以为功能坏了」。
- **侧栏描述**同步从「进程、绑定与回复」改成「进程、白名单与回复」。
- **区块面板 C 区**换成 `zones:unzoned`（白名单 − 已归区）：加了白名单就出现在候选里，
  与「有没有说过话」解耦；候选行会标出「未授权自动回复」。
- **出图脚本修了一处真 bug**（`scripts/ui/generate-ui-map.cjs`）：`scrollY` 在设置页内容异步加载完成前就执行，
  `page.scrollHeight` 还是空页高度 ⇒ `scrollTop` 被钳在 138px，长页面**永远截不到下半屏**（QQ 的「最近事件」进不了图）。
  现在截图前按同一 `scrollY` 再滚一次。`settings-qq-lower` 的滚动量随之调到 **520**（900 会与 events 撞在同一钳制位置）。
- **坐标记法**：滚动过的视图（`-lower` / `-events`）用的是**滚动后的视口坐标**，所以区域 A/B 出现负 y（表示已滚出视口上方），这是正常现象。
- 验证：`pnpm typecheck` 0 error、`pnpm test` 22 套 / 513 项全绿、`pnpm build` 成功、
  浅色 14 张 `verify-map` 全 PASS（`settings-qq` 334/230、`settings-qq-lower` 337/230、`settings-qq-events` 337/224）。

### 修订 11（2026-11-01）· P6 工作区归属与空态门禁

- **Chat 模式不再显示工作区段**：工作区是 Agent 专属概念。`Sidebar.tsx` 改读
  `activeMode`（有活动会话看会话的 `mode`，否则看 `store.draftMode`），条件为 `agent` 才渲染
  `<WorkspaceSection />` 与「最近」右侧的工作区名。Chat 下这段**整块不渲染**，不留空白占位。
- **副作用（重要）**：首帧就是 Chat 模式，所以**主图 `ui-map-v0.png` 里没有 A2 工作区列表了**。
  为了让「工作区条目」仍然可被网格坐标指到，新增两个视图：
  **对话首页 · Agent 模式**（`chat-agent`）与 **对话首页 · Agent 模式 + 零工作区**（`chat-agent-gated`）。
  出图脚本为此新增 `click` / `workspaces` 两个视图级能力，并给每个视图加唯一 `v=<序号>` query
  （否则同 URL 的 `loadFile` 不会重载，播种会被旧状态盖掉）。
- **零工作区门禁态**：Agent 模式且清单为空时，输入区加 `.composer__box.is-gated`，
  `textarea` 用 `readOnly`（**不是** `disabled`，后者收不到点击）并换成引导占位文案；
  点整块任意位置走建区流程（`pickDirectory` + `save`），建完立即解禁。
- **删空即空**：`normalizeWorkspaces` 不再无条件补默认工作区，改由 `Settings.workspaceOptOut`
  区分「主动删空」与「从没建过」。因此侧栏空态「还没有工作区」是**可达且会保持**的状态。
- **实测坐标**：`chat-agent` 区域 A2 = x20 y128 216x70、工作区条目 = 元素 **3**（x20 y166 216x32）；
  `chat-agent-gated` 区域 A2 = x20 y128 216x65、输入框 = 元素 **9**。
- 验证：浅/深各 14 视图 `verify-map` 全 PASS，`check-ui-map` fails=[]，`verify-theme` 7/7。

### 修订 10（2026-10-31）· P5 工作区「…」菜单不被列表裁掉

- **现象**：点工作区条目的「…」，菜单被 `.workspace-list`（`max-height: 168px; overflow-y: auto`）裁掉，
  只有滚动列表才看得到一部分；只有 1 个工作区时**完全看不到**（菜单整体落在列表底边之外）。
- **根因**：`position: absolute` 的包含块是 `.workspace-item`，但**绘制裁剪**由最近的
  `overflow != visible` 祖先（`.workspace-list`）决定。`z-index: 30` 对裁剪无效——层叠与裁剪是两件事。
- **改法**：`.workspace-menu` 改 `position: fixed`（含 `z-index: 60`、`min-width: 148px → 160px`），
  坐标由 `WorkspaceSection.openMenu()` 在打开时读 `getBoundingClientRect()` 写 inline style；
  列表滚动（capture 监听）/ 窗口 resize 时关闭菜单，不留悬空浮层。
- **点外关闭补判**：`sectionRef.contains(target)` 之外再加 `menuRef.contains(target)`，
  否则点菜单项会被当成点外面而先关掉（菜单看得见却点不动）。
- **实测**：1 / 3 / 8 个工作区三种情形，8 条条目逐条点「…」，菜单 3 个选项全部完整可见
  （改前：1 个工作区时可见比例 **0**、8 个工作区时第 4 条起 **0.274 → 0**）。
- **无视觉影响**：菜单不是静态截图的一部分（条件渲染），出图坐标与编号不变。

### 修订 9（2026-10-31）· 提示词新增「原作台词」层

- **新增链路第 4 段**：人格核心 → **原作台词** → 背景设定。台词样本紧贴人格，因为它就是「她怎么说话」的证据；
  见 `main/features/prompt/promptStore.ts`（`compose()`，`CANON_DIR`）。
- **模板不污染提示词**：`Prompt/characters/nahida/canon/_template.md` 以 `_` 开头，
  `listMarkdown()` 跳过该前缀；注入前还会剥掉 `<!-- -->` 注释，
  所以模板里的填写说明、自检清单都不会跑到模型面前。启用方式是复制成 `quotes.md` 再填台词。
- **设置页**：注入顺序表从 7 行变 8 行（元素 **5** 高度 226 → 258），整页仍在 828 内容区内；
  最后一个元素底部 y783（折叠线 844），无需滚动截图。
- 验证：`pnpm test:prompt` 43/43（含「注释不进提示词」「`_` 模板不读取」两条新判据），
  浅/深各 12 视图 `verify-map` PASS，`verify-theme` 7/7。

### 修订 8（2026-10-31）· 区块（P5）

- **新增设置分区「区块」**（导航第 6 项，紧跟「长期记忆」）：区域 **A** 区块列表 / **B** 成员表 /
  **C** 未归区的 QQ 会话 / **D** 本区块行为开关。root 行置顶、灰底，改名与删除按钮呈禁用态。
- 因为左栏多了一项，**元素编号整体后移**；本文件已整体重出（12 视图）。
- 「已归区」的精确判定在 `userData/zones.json`；面板的未归区列表 = `qq.bindings()` − 已归区成员键，
  **没有新增专用接口**（多一个接口就多一处要同步）。
- 新视图：`settings-zones`（上半屏）与 `settings-zones-lower`（按页面容器滚动 900px，含区域 D），
  两张 `verify-map` 均 PASS。

### 修订 7（2026-10-31）· 提示词架构补齐（注入链路 + 模式规则层）

- **背景**：原先只有「全局 → 人格 → 设定 → 风格」四段，缺**模式职责层**与**Agent 工具规范层**，
  于是「Chat 没有工具」「Agent 的权限边界」只能靠风格文件兼职，改语气就会动到职责边界。
- **新增 7 段链路**：全局底线 → 语气句式 → 人格核心 → 背景设定 → **模式规则** → 表达风格 → **[仅 Agent] 工具规范**。
  见 `main/features/prompt/promptStore.ts`（`compose()`）：顺序即权重，工具纪律压轴。
- **新增文件**：`Prompt/shared/tone.md`（跨角色语气）、`Prompt/shared/tool_usage.md`（仅 Agent）、
  `Prompt/characters/nahida/modes/chat.md` 与 `modes/agent.md`（模式职责与边界）。
- **容错**：角色目录整个缺失时，全局段与 Agent 工具规范仍然注入——缺人格不等于失去执行纪律。
- **页面压回一屏**：合并「注入顺序」与「改哪个文件」为一张表（顺序即文件顺序），打开按钮并进页头（元素 **4**），
  角色文件改两列。改动前整页 2100px，元素 6–9 落在 860 折叠线以下，图上无法定位（J-11 同类）；
  改动后最后一个元素 6 底部 = y730，仍在 828 内容区内。
- **顺带修复**：`styles/global.css` 末尾 151 个换行被写成字面量（QQ 面板段落），postcss 报
  `Unknown word display` 导致整条构建挂掉；已还原为真实换行，内容未改。
- 出图：浅/深各 8 视图 `verify-map` PASS，`verify-theme` 7/7 通过。

### 修订 6（2026-10-31）· 双主题收口（P3）

- **先归档再出图**：`docs/ui-archive/20261031-174556/{light,dark}` 存下了 P2 末态的 15 张 PNG + 两份坐标 JSON
  （逐字节 md5 校验与源文件一致，`LATEST` 指向该时间戳）。为什么必须先归档：`docs/ui/*.png` 是固定文件名，
  `pnpm ui:map` 原地覆盖，P2 就已经因此把 P1 的图冲掉过一次（台账 J-18）。
- **深色目录补对照表**：新增 `docs/ui-dark/UI_MAP.md`，只记录「同一编号下的视觉差异」，坐标表指回本文件
  （两份表会分叉，经验库 A55）。
- **一键验收**：`scripts/theme/verify-theme.mjs` 把 7 条判据固化成一条命令
  （零字面色 / 脚本自检 / 令牌双向差集 / 未定义引用 / 浅色闸门 / 深色闸门 / 出图完整性）。
- **出图完整性判据**：`scripts/theme/check-ui-map.mjs` 除文件存在性外，还调用全局 `verify-map.cjs`
  做像素级网格判定，并校验 `docs/ui-archive/LATEST`；缺脚本、缺归档都计为失败，不静默跳过（J-11）。
- **像素级对比工具**：`scripts/theme/diff-ui-png.mjs`。P3 实测重出图 vs 归档图：浅色 11/15 完全相同、
  2 张只在 J-05 动态文本掩膜内变化、2 张（`settings-memory`）有 189–216 px 落在掩膜外
  —— 定位为记忆列表里的相对时间文本（散布在 bbox 524,373–1188,732 的零星文字像素，maxΔ=210）；
  深色 6/15 完全相同，另 3 张（`chat-empty` / `settings-prompts` / 主图）为 **maxΔ=1** 的星空底量化差（不可见）。
  P3 未改任何组件源码，因此这些差异不可能来自样式。
- **未改任何组件样式/结构**；两套图重出后仍是各 8/8 `verify-map` PASS、各 15 张 PNG。

### 修订 5（2026-10-31）· 品牌素材接入（P2）

- **侧栏头像**：`纳` 汉字方块 → 资产包 `avatar*_transparent.png`（101×101 / 102×102），34×34 `object-fit: contain`。
  `.brand-mark` 的 8 条文字版声明**整段替换**，否则会出现「图里还压着一个汉字」。
  设置页左栏（`SettingsSidebar`）同步换图 —— 它原本也用同一个类名放汉字，只改对话侧栏会让它变成「没有白底的裸字」。
- **发送按钮**：`↑` → `icon-send(-dark).svg`。两张 SVG 的 viewBox 不同（日 40×40 / 夜 44×44），
  容器锁死 20×20，否则夜间图标大 10%。**停止按钮仍保留 Unicode `■`**（资产包没有 stop 图标，硬套会误读）。
- **空态徽章**：新增 `.empty-state__emblem`（210×96），**绝对定位**在 `.empty-state` 内。
  为什么不用文档流：`.mode-dock` 的纵向位置由自己的 `margin-top: 47vh` 决定（AGENTS §二），进流会把滑块整体下推 108px。
  实测出图后滑块仍在 y493（与 P1 同一位置）。
- **日间版徽章压暗**：日间素材不透明像素均值 `rgb(231,237,210)`、76% 亮度 >230，贴白面板实测该区域 `sd_lum=0.06`（等于没画）。
  日间加 `filter: brightness(0.55) saturate(1.15)`，夜间原样。**这是渲染参数，不是色值**，没有引入字面色。
- **素材自带文字带已裁掉**：`center_emblem_*_transparent.png` 原图 420×215，最下 23px 是一整条烤死的文字（ASCII 降采样可见字形），
  入包前裁成 **420×192**，只保留纹样。判据沿用 M4/E3：素材里出现人类可读文字 = 效果图，不作素材。
- **侧栏底部装饰**：新增 `.sidebar__ornament`（236×108，`margin: 0 -10px` 出血）。
  上缘 `mask-image` 22% 淡出 —— 夜间图顶边与星空 Δ≈55，硬切是一条可见横线。
  实测相邻行亮度最大跳变：浅色 3.31 / 深色 6.96（没有台阶）。
- **夜间满幅星空**：`[data-theme='dark'] body` 两层背景 = `--nc-veil`（alpha 0.58 压暗）+ `background_dark.png`。
  **不用 `backdrop-filter`**（M8：设计稿是压暗层不是毛玻璃）。
- **夜间半透明面板**：`--nc-page-surface` 0.62 / `--nc-panel-veil`（侧栏）0.55 / `--nc-composer-surface` 0.82。
  实测最亮背景像素 rgb(54,60,67) 上：正文 8.33 / 次要 5.69 / 弱化 4.56，全过 AA。
- **令牌数变化**：`:root` 48 → **52**，`[data-theme='dark']` 39 → **43**（新增 4 个颜色令牌，parity 仍双向为空）。
- **踩坑（已修）**：`.brand-mark` 的注释里写了「font-星号/box-shadow」这种连写，其中的星号加斜杠提前闭合了注释，
  把整条规则变成非法选择器 → 头像实际按 101px 原始尺寸渲染。注释里不能出现裸的星号紧跟斜杠。

#### 修订 5 追加（同日，按用户「给了文件的都要接」的指令）

- **按钮选择框与高亮**：Chat / Agent 两态改用资产包 `card-frame-inactive.svg` / `card-frame-active.svg`（夜间各换 `-dark`）。
  用 **空白框**（`card-frame`）而不是 `card-selector`：后者内嵌「绝对话，不调用工具」（错字）等烤死文案（E6/M4）。
  压缩比：viewBox 240×100 → 实际 132×64，`preserveAspectRatio=none` 拉伸，比例 2.40 vs 2.06，肉眼无可见变形。
  代价：按钮内边距 8→12，滑块区域高度 **64→72**（`元素 7/8` 高度随之变化，编号不变）。
- **分割线 ×3**：
  - 侧栏「最近」上方：`divider-horizontal`（12px 高，两端渐隐 + 中央花纹）；
  - 输入条顶部：原 `border-top: 1px` 换成 `divider-horizontal`（12px）；
  - 侧栏与主区之间：`divider-vertical`（28×800 → 14px 宽绝对定位竖线，中央是须弥纹）。
  三条都随主题换图；`divider-sidebar.svg` **没用**（内嵌烤死的「最近」二字，E3）。
- **主页面点缀树叶 ×3**：`icon-leaf`（两片，左右各一）与 `icon-sparkle`（一处星芒），
  绝对定位在空态内（左 12%/上 18%、右 14%/上 34%、右 24%/下 26%），`aria-hidden` + `pointer-events:none`，不进编号。
  日间 `#6E9857` 系、夜间 `#C4DC9C` 系，各一张图。
- **素材白名单从 11 → 21 个文件**（+4 卡框、+2 竖分割、+2 叶、+2 星芒），体积仍 3.3 MB（SVG 都很小，且 <4KB 的被内联成 data URI）。

#### 仍未接入的素材与理由

| 文件 | 为什么没接 |
| --- | --- |
| `card-selector-*.svg` | 内嵌烤死文案，且「绝对话，不调用工具」是错字（M4/E6） |
| `divider-sidebar*.svg` | 内嵌烤死的「最近」；文字必须走 DOM，否则换语言/改文案就废 |
| `icon-gear*` `icon-plus*` `icon-agent-stars*` `icon-chat-bubble*` `icon-aranara-chat*` `icon-dendro-flower*` | 属**功能图标**，M3 定的是保留 `currentColor` 内联体系；混用会出现「一半跟随主题、一半不跟随」 |
| `icon-window-*` | 应用没有自绘标题栏 |
| `four-leaf-sigil*` | 与空态徽章（`center_emblem`）功能重复，同屏放两个徽记会抢焦点 |
| `sidebar-bottom-emblem-dark.svg` `sidebar_emblem_dark.png` | 侧栏底部已用整张 `sidebar_bottom_bg_dark.png`（内含中央徽记），再叠一个是重复 |
| `nahida_art.png` | 自带渐变背景（四角 rgb(249,250,244)～(205,209,191)），整块贴会露边；要用得先做径向遮罩 |
| `ui_reference_dark.png` | AI 渲染的设计稿，1.99MB，不作素材（M4） |
| `preview.html` / `settings.html` | 效果页，含 34 条零令牌规则（E11） |

### 修订 4（2026-10-31）· 日间/夜间双主题（P1）

- **日间换色（M1）**：`:root` 从项目自定 `#FDFDE3`（暖米黄）整体迁到资产包 `#F8F9F3` 系（黄绿白）。
  正文 `#2A4426`、次要 `#44613F`、弱化 `#5E7A56`、主色 `#4F7945`。
  → 对比度：正文 10.16 / 次要 6.55 / 弱化 **4.51**（原 2.85 不达标）/ 主色上白字 **5.06**（原 3.87 不达标）/ 危险 5.58（原 4.47）。
- **新增深色令牌段** `[data-theme='dark']`：只覆盖 **39 个含颜色**的令牌，9 个非颜色令牌（radius/font/sidebar/content-gutter）不复制。
  判据口径从「全令牌名双向差集」改为 **colors-only**（台账 J-09），豁免清单写死在脚本里。
- **新增外观设置页**：主题三段单选（元素 5/6/7）+ 当前生效回显（元素 8）。
  文案原来写的「主题切换排在 M4」已删除，那是 P1 之前的状态。
- **色板改为跟随主题**（元素 9）：原来是内联 `THEME.canvas` 常量，深色下会留一块刺眼的白方块。
- **持久化**：`Settings.appearance.theme`，走既有 `settings:get/save`，**没有新开 IPC**。
  `normalizeAppearance` 在 `get()` 合并与 `save()` 归一化**两处**都要过（漏一处会丢用户已存的主题）。
- **防白闪**：主进程 `backgroundColor` 按持久化主题求值，并经 `additionalArguments` 把 `--nahida-theme=` 传给 preload；
  渲染层在 `createRoot` 之前设 `data-theme`。实测窗口底色 `#101722`，40 帧采样 0 浅色帧。
- **出图脚本新增 `--theme=light|dark`**：在 `rmSync(userData)` **之后**写预置配置，并在结束时回读 `data-theme` 自检，
  主题没生效就直接 exit 2，不静默出一套错色的图。夜间图输出到 `docs/ui-dark/`。

### 修订 3（2026-10-31）· 多工作区

- **删掉** 设置 → 工具权限里的「工作区」段（原来只有一个全局 `workspaceDir` 输入框）。
  `PermissionSettings` 现在只剩 `mode`，目录不再属于权限配置。
- **新增** `Settings.workspaces: Workspace[]` + `activeWorkspaceId`，每个 `Workspace` 是
  `{ id, name, dir }`。新增 IPC 六个频道（`workspace:list|save|delete|set-active|pick-directory|open`），
  目录选择对话框只在主进程弹。
- **会话绑定**：`Session.workspaceId`。新建会话钉住当时的活动工作区；老会话（没有该字段）
  启动时自动绑到活动工作区。切换工作区写进会话，不动全局配置。
- **左栏新增区域 A2**：工作区列表（元素 2 新建、元素 3 条目）。「最近」列表按活动工作区过滤，
  并列显示当前作用域名，避免两个目录的会话串台。
- **输入条新增元素 11**：工作区选择器，和模型/权限同一排。选完直接写进当前会话。
- **沙箱契约**：`resolveToolPath(input, ToolScope)` 的第二个参数从 `PermissionSettings` 换成
  `ToolScope = { mode, root }`。`root` 空值时只读/审批模式**明确报错**，
  绝不回落成 `'.'`（那等于把进程 cwd 当成可读区）。
- **迁移**：老配置的 `permission.workspaceDir` 和更老的 `workspaceRoots[0]` 启动时变成清单第一条；
  清单为空时自动补一个 `userData/workspace` 的默认工作区。
- 因为左栏多了 A2，「最近」列表与新建对话按钮的相对位置整体下移，元素编号全部重排。

### 修订 2（2026-10-30）· 三项优化

- **① 设置 → 模型配置**：模型清单底部新增「获取可用模型」。点开先拉服务商清单，再勾选添加；
  手动填模型 ID 的输入框原样保留在左边。
- **② 长期记忆**：token 预算去掉 2000 硬上限（输入框无 `max`）。
- **③ 工具权限**：删除「按风险分级」与「工作区白名单」，改成「工作区目录 + 权限模式」。
  旧配置的 `toolPolicy` / `workspaceRoots` 启动时自动迁移。（其中的工作区部分已在修订 3 被多工作区取代。）
- 顺带修了 `scripts/ui/write-ui-map-md.cjs` 保留段落的正则 bug（`m` 标志下 `$` 匹配行尾，
  捕获组永远是空串，每次重跑都会清空人写的三段）。

## 已知约束

- 坐标只对 **1280x860** 有效；窗口更窄时响应式布局会变化，须重新出图。
- **P3 起渠道控制台多一个 E 区（渠道工作区）**，视觉顺序是 C → **E** → D 数据位置 → D 旁听库，
  字母顺序**不等于**阅读顺序（原因见「修订 18」）。报表位置时请用圆圈字母 + 元素编号。
- **E 区高度随「恢复默认」按钮出现与否变化**：未配置（默认）时只有「选择目录」一个按钮，
  配置过之后多一个「恢复默认」，区域高度与下方 D 区的 y 会各差约一行。这不是量错。
- **P9-R3 起，渠道控制台的三张图覆盖的是「空名单」状态**：账号表 / 群表都只有一行空态文字。
  一旦加了账号或群，表格行数变化会推低后面的区域（B / C / D 的 y 会整体下移），
  编号**不变**（表头与行是同一个元素），但坐标必须重新出图。
- **渠道视图里没有「私聊白名单 / 群聊白名单」两块了**。按人授权之后，
  「谁能私聊」「谁在群里能触发」「谁能用工具」是同一张账号表的三列；
  「群允不允许她说话」是另一张群表。看到旧图里的两块请按本版新图报位置。
- **「群聊」那一列在「群成员鉴权」关闭时看不到效果**（判定恒放行）。这是有意的：
  列头有 `title` 写着「群成员鉴权关闭时不生效」，不要为了「让它有反应」去改判定（J-33/M34）。
- **P2 起装饰元素不进编号**：头像、侧栏底部装饰、空态徽章、发送图标都是纯装饰（`aria-hidden`），
  没有 `data-ui-target`，所以元素 1–12 的编号含义与 P1 一致，没有整体后移。
- **P2 起出图默认不再全量**：`pnpm ui:map --only=<视图名>` 只拍需要的那几张。
  🔴 只拍一张时，**同一页面**的其它视图要一起重拍 —— 新增 `data-ui-target` 会让该页 DOM 顺序里
  后面的元素编号整体后移，只重拍一张会让同页其它图的编号与坐标对不上。
- **`--only` 不会清空坐标表**：没拍的视图从上次 `ui-map-v0.json` 合并回来。
  但那份 JSON 一旦被整份覆盖（全量出图）就会以全量为准。
- **空态徽章是绝对定位**（`top: 25vh`，以 `.empty-state` 为参照），窗口高度变化时它与滑块的相对距离会变；
  它不占流，所以 `元素 7/8` 的位置不受它影响。
- 夜间截图在 `docs/ui-dark/`（`generate-ui-map.cjs --theme=dark --out=docs/ui-dark`），
  两套图各自 8/8 `verify-map` PASS；P3 起 `docs/ui-dark/UI_MAP.md` 是**指回本表**的对照文件，坐标表仍以本文件为准。
- 元素编号按 DOM 顺序生成，**新增控件会让后面的编号后移** —— 改完 UI 必须重跑截图并重新生成本文。
- 高于视口的分区（工具权限的保存按钮在 y580、长期记忆的添加框更靠下）在截图里能截到，
  但那部分内容实际需要滚动才可见，坐标仍然有效。
- 「获取可用模型」候选面板、模型/工作区/权限三个下拉菜单、工作区的「…」菜单都是条件渲染，
  静态截图里不存在，因此没有编号。它们相对触发器的位置：候选面板向上弹出（`bottom: calc(100% + 6px)`）；
  **工作区的「…」菜单自 P5 起是 `position: fixed` + 打开时写入实时坐标**（不再是
  `top: calc(100% + 4px)` 的绝对定位）—— 因为它原先被 `.workspace-list` 的 `overflow-y: auto` 裁掉，
  永远弹不出列表边界。默认贴条目左下弹出，底部放不下上翻，上翻也放不下就贴视口底；
  列表一滚动或窗口一缩放就关闭（fixed 不跟随滚动）。
- 工作区列表最高 168px（约 5 条），超出滚动 —— 侧栏高度有限，无限增长会把「最近」挤没。
- 「区块」面板的**成员表与候选列表都是条件渲染**：没有成员/没有未归区绑定时图里只有一行空态文字，
  元素 **7**（成员表格）与 **8**（开关组）的位置会随之上下移动；反馈位置时以当次出图为准。
- `pnpm ui:map` 的默认视图清单在 `scripts/ui/generate-ui-map.cjs` 里，
  **新增设置分区必须往里面加一行**，否则会安静地少出一张图（长期记忆之前就是这样被漏掉的）。
  `scripts/theme/check-ui-map.mjs` 里的视图名单同样要同步（A48）。
- **坐标单位是 CSS px，PNG 是物理 px**：本表与 `ui-map-v0.json` 用 1280×860 内容区（CSS px），
  而 PNG 实际是 **1600×1075**（Windows 显示缩放 125%），换算比 **1.25**。
  台账 J-05 的像素掩膜用的是 PNG 物理坐标，不能与本表坐标直接混用。
- **`settings-memory` 列表里有相对时间文本**（「x 分钟前」之类），每次出图都会变，且不在 J-05 的三个掩膜内；
  对比时按「散布小像素块」识别（P3 实测 789–816 px、bbox 覆盖整列列表、maxΔ=210）。
- 归档目录每轮约 **21 MB**（深色星空图单张 ≈1.5 MB，浅色整套 2.7 MB），不是蓝图预估的 3 MB；

- **QQ 面板自 P6（SL 接入）起没有绑定表**：`settings-qq` 只剩 4 区（宿主状态 / QQ 进程 / 行为开关 / 最近事件），
  原来按旧图找「C 区绑定表」的位置现在是 **C 行为开关**。授权改到「渠道控制台」（P7）；本版本手改
  `%APPDATA%\Nahida Chat\channels\access.json`。
- **滚动视图的坐标是「滚动后的视口坐标」**：`settings-qq-lower` / `settings-qq-events` / `settings-zones-lower` 里出现
  负的 `y`（如 `A 宿主状态 x394 y-488`）表示该区域已滚到视口上方，不是量错了。
- **出图脚本的 `scrollY` 必须晚于内容异步加载**（P6 修）：设置页的宿主状态/设置项要等 IPC 返回，
  过早滚动会被 `scrollHeight` 钳住（实测只剩 138px），长页面下半屏进不了图。
  长期只需保留最近 5 次。