# SnowLuma 上游记录（UPSTREAM）

> **本目录是上游源码的只读副本。任何文件都不得修改。**
> 需要改变行为 → 在 Nahida Chat 侧包一层，不要改这里（否则上游同步永远做不了）。

## 来源

| 项 | 值 |
| --- | --- |
| 上游项目 | SnowLuma（QQ NT 协议运行时，Node + 原生 addon） |
| 版本 | **2.2.1** |
| 本地来源目录 | `D:\NAHIDA\例子\SnowLuma-2.2.1\`（发行包，**不是 git 仓库**，无 `git clone` 可替代） |
| 落位日期 | 2026-10-31 |
| 许可 | 源码可见**非商业**许可，见 `LICENSE`（§3d / §4b：公开发布衍生版须书面授权） |
| 同步方式 | 上游发新版本时，整包替换 `vendor/snowluma/`，然后重跑 `node scripts/build-snowluma-host.mjs` |

## 落位范围（10 个包）

`vendor/snowluma/packages/` 只保留构建 `snowluma-host` 所需的最小闭包：

| 包 | 用途 |
| --- | --- |
| `bridge` | 进程发现 / 注入 / 账号识别 |
| `common` | 日志 / 配置 / runtime 路径解析 |
| `core` | 应用入口 + `src/bridge`（20 个 QQ 动作的真实实现） |
| `onebot` | 事件归一化 + action 派发 |
| `proto-defs` | 协议定义 |
| `protocol` | QQ 封包编解码 |
| `proton` | protobuf **编译期**转换（Vite 插件） |
| `runtime` | 原生资产目录 + 随包清单（`native/*.node`、`*.dll`） |
| `sqlite` | 消息库（`@appthreat/sqlite3` 预编译） |
| `websocket` | 原生 WS 帧 |

**刻意不纳入**（约 73k 行，见总蓝图 §九）：`webui` · `mcp` · `sdk` · `ui`。
已核对：上述被排除模块对纳入子集**反向依赖 = 0 处**。

## 与上游的差异（仅"切除"，无"修改"）

1. `packages/*/node_modules`、`packages/*/dist`、`packages/core/tests` 未纳入（构建产物与测试，非源码）。
2. 根级还保留了 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`tsconfig.json`、`LICENSE`、`EULA.md`、`PRIVACY.md`。
   —— 这些是构建入口与许可文档，`packages/core/vite.config.ts` 在缺失许可文档时会**直接 throw**。
3. **没有修改任何一个纳入文件的字节。** 构建脚本在 `%TEMP%` 里准备一份工作副本，
   只做"删掉工作副本里 `pnpm-workspace.yaml` 未声明的包"，不重写 `core/vite.config.ts`。

## 构建说明

```bash
node scripts/build-snowluma-host.mjs
```

脚本行为：
1. 在 `%TEMP%/sl-build-<stamp>/` 复制 `vendor/snowluma/`；
2. `pnpm install --frozen-lockfile`（lockfile 来自上游发行包，pnpm 11.25.0）；
3. `pnpm --filter @snowluma/core build`（用**上游原样**的 `core/vite.config.ts` 挂 Proton 插件）；
4. 把 `dist/index.mjs` + `dist/native/**` 拷进 `out/snowluma-host/`；
5. 复制合格的 `node.exe`（v24.22.1，89.56 MB）到产物根目录。

**为什么 `node.exe` 必须与 `index.mjs` 同目录且文件名必须是 `node.exe`**：
`snowluma-win32-x64.node` 的 PE delay-import 目录把模块名写死成字面量 `node.exe`（33 个 `napi_*` thunk），
宿主镜像名不是 `node.exe` 时加载即 `0xC0000409`。见 `PHASE-0-完成报告.md` §五 D-01。
