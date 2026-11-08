#!/usr/bin/env node
/**
 * 构建 snowluma-host（PHASE-1 核心产物）
 *
 * 产出：<repo>/out/snowluma-host/
 *   ├─ index.mjs                       SL 单文件 ESM bundle
 *   ├─ native/                         SL 原生资产（snowluma / websocket / ffmpeg / sqlite）
 *   ├─ check-node-version.cjs          随包版本门禁（供自检与排障）
 *   ├─ EULA.md / PRIVACY.md            许可与隐私文档（随 SL 上游一同分发）
 *   ├─ package.json                    runtime manifest
 *   └─ node.exe                        v24.22.1 运行宿主（H-05=(a)）
 *
 * PHASE-2 新增（SL_ENTRY）：
 *   默认入口是 **受控入口** `host/entry.ts`（只引用 Bridge/OneBot/Hook 三件，不起 WebUI、不跑 update）。
 *   P1 的产物入口是 SL 上游应用入口（会自起 WebUI、抢信号），不能当 IPC 宿主（P1 报告 §五 D-02）。
 *   `SL_ENTRY=upstream` 可回到 P1 行为（仅供对照/排障）；`SL_ENTRY=<相对路径>.ts` 可指定其它入口。
 *
 * 设计要点（每条都有 PHASE-0 实测依据）：
 *  1. 不在 NC 里构建：SL 的 vite 配置依赖 monorepo 布局（packages/* + 根 dist），
 *     因此在 %TEMP% 下准备一份工作副本，把 vendor/snowluma 覆盖进去后再构建。
 *  2. 构建入口用 vendor 里 **上游原样** 的 packages/core/vite.config.ts —— 不重写插件配置，
 *     避免"自以为挂上了插件"（J-07：版本/配置达标 ≠ 能力可用）。脚本只做两件事：
 *     删掉未被 vendor 纳入的 workspace 包（webui/mcp/sdk/ui），并保证原生资产齐全。
 *  3. node.exe 必须与 index.mjs 同目录且文件名为 node.exe：
 *     snowluma-win32-x64.node 的 PE delay-import 把模块名写死为字面量 "node.exe"（P0 D-01）。
 *  4. 产物验收：index.mjs 必须 (a) 5MB~50MB、(b) 不含 "was not transformed"。
 *     不达标直接 exit 1，不产出半成品。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const vendorRoot = path.join(repoRoot, 'vendor', 'snowluma');
const outDir = path.join(repoRoot, 'out', 'snowluma-host');

/** SL 的构建只覆盖这些 workspace 包；vendor 里没有的必须从工作副本的 workspace glob 中消失。 */
const KEPT_PACKAGES = [
    'bridge',
    'common',
    'core',
    'onebot',
    'proto-defs',
    'protocol',
    'proton',
    'runtime',
    'sqlite',
    'websocket',
];

/** 宿主 node 的最低版本（SL 的 check-node-version.cjs 硬门禁）。 */
const REQUIRED_NODE = [24, 22, 1];
const NODE_RANGE = '^24.22.1 || >=26.12.1';

const MIN_BUNDLE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

/** PHASE-2：默认受控入口（相对 repo 根）。SL_ENTRY=upstream 回到 P1 的上游应用入口。 */
const DEFAULT_SL_ENTRY = 'host/entry.ts';

/** 受控入口**不允许**出现在产物里的上游装配符号（PHASE-2 §六 G1b / 停止条件 S2）。 */
const FORBIDDEN_IN_CONTROLLED_BUNDLE = [
    'initWebUI',
    'runApplication',
    'createNotificationManager',
    'createStateWiring',
    '__BUILD_WEBUI__',
    'webui/server',
    'update/startup',
    'notifications/manager',
    "from 'hono",
    'from "hono',
    '@hono/node-server',
];

/**
 * 解析 SL_ENTRY：
 *   - 未设置 / 空 → 受控入口 host/entry.ts
 *   - 'upstream'  → 上游 packages/core/src/index.ts（P1 行为，仅对照用）
 *   - '<路径>'    → 该 .ts 文件（相对 repo 根）
 * 返回 null 表示"用上游入口"，否则返回 { absPath, kind }。
 */
function resolveEntry() {
    const raw = (process.env.SL_ENTRY ?? '').trim();
    if (raw === 'upstream') {
        log('SL_ENTRY=upstream → 使用上游应用入口（对照模式，**不能**当 IPC 宿主）');
        return null;
    }

    const rel = raw || DEFAULT_SL_ENTRY;
    const abs = path.resolve(repoRoot, rel);

    if (!fs.existsSync(abs)) {
        fail('SL_ENTRY 指向的入口不存在：' + abs);
    }
    log('SL_ENTRY 受控入口：' + rel);

    return { absPath: abs, kind: 'controlled' };
}

/**
 * 把受控入口 + 它的本地依赖拷进工作副本的 packages/core/src/，并把 vite 的 lib.entry 指过去。
 *
 * 为什么放在 core/src 内：受控入口要引 `./bridge/manager`（BridgeManager）与
 * `./sys-face-catalog`，这两个在 @snowluma/core 的 exports 里**没有 subpath**，
 * 用包名引不到；放同目录才能用相对路径（PHASE-2 §4.1）。
 */
function installEntry(workRoot, entry) {
    const coreSrc = path.join(workRoot, 'packages', 'core', 'src');
    if (!fs.existsSync(coreSrc)) {
        fail('工作副本缺 packages/core/src');
    }

    const target = path.join(coreSrc, 'nc-host-entry.ts');
    fs.copyFileSync(entry.absPath, target);

    // 入口同目录的 .ts 兄弟文件（如协议）一并拷入，保持相对 import 成立
    const entryDir = path.dirname(entry.absPath);
    const siblings = fs
        .readdirSync(entryDir)
        .filter((name) => name.endsWith('.ts') && path.join(entryDir, name) !== entry.absPath);
    for (const name of siblings) {
        fs.copyFileSync(path.join(entryDir, name), path.join(coreSrc, name));
    }

    // RPC 契约的真源在 src/shared/qqHost.ts（两端共用），这里落成入口的本地模块
    const contract = path.join(repoRoot, 'src', 'shared', 'qqHost.ts');
    if (fs.existsSync(contract)) {
        fs.copyFileSync(contract, path.join(coreSrc, 'nc-host-protocol.ts'));
    } else {
        fail('缺少 src/shared/qqHost.ts（受控入口的 RPC 契约真源）');
    }

    // 只改 lib.entry 一行，其它保持上游原样（P1 D-01 的结论：不要重写 vite 配置）
    const configPath = path.join(workRoot, 'packages', 'core', 'vite.config.ts');
    const original = fs.readFileSync(configPath, 'utf8');
    const needle = "index: path.resolve(__dirname, 'src/index.ts'),";
    if (!original.includes(needle)) {
        fail('core/vite.config.ts 的 lib.entry 形状与预期不符，拒绝盲目改写：' + needle);
    }
    const patched = original.replace(needle, "index: path.resolve(__dirname, 'src/nc-host-entry.ts'),");
    fs.writeFileSync(configPath, patched, 'utf8');
    log('lib.entry → packages/core/src/nc-host-entry.ts');
}

/** 受控入口自身的类型检查（拦下 NC 门禁覆盖不到的漂移）。 */
function typecheckEntry(workRoot, hostNode, env) {
    const tscBin = path.join(workRoot, 'node_modules', '.bin', 'tsc.CMD');
    const tscScript = path.join(workRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const args = ['--noEmit', '-p', path.join('packages', 'core', 'tsconfig.json')];
    let output = '';

    try {
        const command = fs.existsSync(tscScript) ? hostNode : tscBin;
        const argv = fs.existsSync(tscScript) ? [tscScript, ...args] : args;
        output = execFileSync(command, argv, { cwd: workRoot, env, encoding: 'utf8', stdio: 'pipe' });
        log('受控入口类型检查通过');
    } catch (error) {
        output = String(error.stdout ?? '') + String(error.stderr ?? '');
    }

    const ours = output
        .split(/\r?\n/)
        .filter((line) => line.includes('nc-host-entry.ts') || line.includes('nc-host-protocol.ts'))
        .filter(Boolean);

    if (ours.length > 0) {
        fail('受控入口类型检查失败：\n        ' + ours.join('\n        '));
    }
}

/** 受控入口的产物不得含上游装配符号（G1b / S2）。 */
function assertControlledBundle(bundleText) {
    const hits = FORBIDDEN_IN_CONTROLLED_BUNDLE.filter((marker) => bundleText.includes(marker));
    if (hits.length > 0) {
        fail(
            '受控入口产物里出现了上游装配符号：' +
                hits.join(', ') +
                '（停止条件 S2：依赖闭包没断开，WebUI/update 又被打回来了）',
        );
    }
    log('G1b：产物不含 initWebUI / runApplication / notification / stateWiring / webui / update / hono');
}

function log(message) {
    console.log('[snowluma-host] ' + message);
}

function fail(message) {
    console.error('[snowluma-host] ERROR: ' + message);
    process.exit(1);
}

function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return (
        d.getFullYear() +
        p(d.getMonth() + 1) +
        p(d.getDate()) +
        '-' +
        p(d.getHours()) +
        p(d.getMinutes()) +
        p(d.getSeconds())
    );
}

function rmrf(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EBUSY') {
            fail(
                '无法删除 ' + target + '：目录被占用（' + error.code + '）。\n' +
                    '        通常是上一次的 snowluma-host 进程还在跑。先结束它（taskkill /PID <pid> /F），再重跑。',
            );
        }
        throw error;
    }
}

function ensureDir(target) {
    fs.mkdirSync(target, { recursive: true });
}

/** 递归复制（保留相对结构），skip 命中的名字整棵跳过。 */
function copyTree(from, to, skip = new Set()) {
    ensureDir(to);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (skip.has(entry.name)) {
            continue;
        }
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyTree(src, dst, skip);
        } else if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(src), dst);
        } else {
            fs.copyFileSync(src, dst);
            fs.chmodSync(dst, fs.statSync(src).mode);
        }
    }
}

function sha256(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 把上一轮产物里的 node.exe 缓存到 %TEMP%，供重建复用。
 * 这样"第一次构建靠 P0 沙箱 / SNOWLUMA_HOST_NODE，之后自给自足"。
 */
function cachedHostNode() {
    const cache = path.join(os.tmpdir(), 'sl-host-node-24.22.1-win-x64', 'node.exe');
    const fromOut = path.join(outDir, 'node.exe');
    if (fs.existsSync(cache) && fs.statSync(cache).size > 50 * 1024 * 1024) {
        return cache;
    }
    if (!fs.existsSync(fromOut) || fs.statSync(fromOut).size < 50 * 1024 * 1024) {
        return null;
    }
    ensureDir(path.dirname(cache));
    fs.copyFileSync(fromOut, cache);
    log('缓存上一轮产物的 node.exe → ' + cache);
    return cache;
}

function isVersionAtLeast(version, [major, minor, patch]) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!m) {
        return false;
    }
    const [a, b, c] = m.slice(1, 4).map(Number);
    return a > major || (a === major && (b > minor || (b === minor && c >= patch)));
}

/** 定位一个合格的 node.exe（>= 24.22.1 且文件名为 node.exe）。 */
function resolveHostNode() {
    const candidates = [];
    if (process.env.SNOWLUMA_HOST_NODE) {
        candidates.push(process.env.SNOWLUMA_HOST_NODE);
    }
    // 上一轮产物里的随包 node：先落一份副本到 %TEMP% 缓存，否则重建时会被 rmrf 删掉
    const cached = cachedHostNode();
    if (cached) {
        candidates.push(cached);
    }
    // P0 沙箱里下载好的 v24.22.1
    const sandbox = path.join(os.tmpdir(), 'sl-probe-20261031-002117', 'node24-22-1');
    candidates.push(path.join(sandbox, 'node-v24.22.1-win-x64', 'node.exe'));
    // 兜底：本机 PATH 上的 node
    candidates.push(process.execPath);

    for (const candidate of candidates) {
        if (!candidate || !fs.existsSync(candidate)) {
            continue;
        }
        if (path.basename(candidate).toLowerCase() !== 'node.exe') {
            continue;
        }
        let version;
        try {
            version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
        } catch {
            continue;
        }
        if (isVersionAtLeast(version.replace(/^v/, ''), REQUIRED_NODE)) {
            log('host node: ' + candidate + ' (' + version + ')');
            return candidate;
        }
        log('skip ' + candidate + ' (' + version + ' 低于 ' + NODE_RANGE + ')');
    }

    fail(
        '找不到合格的 node.exe（需要 ' +
            NODE_RANGE +
            '，且文件名必须是 node.exe）。\n' +
            '        设置 SNOWLUMA_HOST_NODE=<绝对路径> 指向一份合格的 node.exe。',
    );
}

/** 定位 pnpm：SL 要求 pnpm 11.25.0（packageManager），本机 corepack 缓存里已有。 */
function resolvePnpm() {
    const overridden = process.env.SNOWLUMA_PNPM;
    if (overridden && fs.existsSync(overridden)) {
        return { script: overridden, label: 'env SNOWLUMA_PNPM' };
    }

    const corepackRoot = path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'node',
        'corepack',
        'v1',
        'pnpm',
    );
    if (fs.existsSync(corepackRoot)) {
        const versions = fs
            .readdirSync(corepackRoot)
            .filter((name) => fs.existsSync(path.join(corepackRoot, name, 'bin', 'pnpm.cjs')))
            .sort((a, b) => {
                const pa = a.split('.').map(Number);
                const pb = b.split('.').map(Number);
                for (let i = 0; i < 3; i += 1) {
                    if ((pa[i] || 0) !== (pb[i] || 0)) {
                        return (pb[i] || 0) - (pa[i] || 0);
                    }
                }
                return 0;
            });
        const exact = versions.find((v) => v === '11.25.0');
        const chosen = exact ?? versions[0];
        if (chosen) {
            return {
                script: path.join(corepackRoot, chosen, 'bin', 'pnpm.cjs'),
                label: 'corepack pnpm ' + chosen,
            };
        }
    }

    fail('找不到 pnpm：请设置 SNOWLUMA_PNPM=<pnpm.cjs 绝对路径>');
}

function run(command, args, options = {}) {
    log('$ ' + [command, ...args].join(' '));
    return execFileSync(command, args, {
        stdio: 'inherit',
        ...options,
    });
}

function prepareWorkspace(workRoot) {
    log('准备构建工作副本：' + workRoot);
    rmrf(workRoot);
    ensureDir(workRoot);

    // 1) 只把 vendor 纳入的包放进 [packages] 目录
    const packagesDir = path.join(workRoot, 'packages');
    ensureDir(packagesDir);
    for (const name of KEPT_PACKAGES) {
        const src = path.join(vendorRoot, 'packages', name);
        if (!fs.existsSync(src)) {
            fail('vendor 缺少包 packages/' + name);
        }
        copyTree(src, path.join(packagesDir, name));
    }

    // 2) 根级工程文件
    for (const file of ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.json']) {
        const src = path.join(vendorRoot, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(workRoot, file));
        }
    }
    // 上游 lockfile 若被 vendor 保留就复用（--frozen-lockfile 需要）
    const lock = path.join(vendorRoot, 'pnpm-lock.yaml');
    if (fs.existsSync(lock)) {
        fs.copyFileSync(lock, path.join(workRoot, 'pnpm-lock.yaml'));
    }

    // 3) 许可文档：core/vite.config.ts 缺它们会直接 throw
    for (const file of ['LICENSE', 'EULA.md', 'PRIVACY.md']) {
        const src = path.join(vendorRoot, file);
        if (!fs.existsSync(src)) {
            fail('vendor 缺少 ' + file + '（core/vite.config.ts 会因缺失许可文档而中止构建）');
        }
        fs.copyFileSync(src, path.join(workRoot, file));
    }
}

function main() {
    if (!fs.existsSync(vendorRoot)) {
        fail('缺少 vendor/snowluma/，请先落位 vendor（PHASE-1 §4.1）');
    }

    const hostNode = resolveHostNode();
    const pnpm = resolvePnpm();
    const entry = resolveEntry();
    const workRoot = path.join(os.tmpdir(), 'sl-build-' + stamp());

    prepareWorkspace(workRoot);
    if (entry) {
        installEntry(workRoot, entry);
    }

    const env = { ...process.env };
    // pnpm 自己要用合格 node 启动；子进程一律用随包 node 的目录当 PATH 头
    // 🔴 Windows 上 Node 把环境变量名按原样给出（通常是大写 P 的 "Path"）。
    //    这里只写 env.PATH 会新建一个**大写 PATH** 并把它设成 "hostNodeDir;"，
    //    于是子进程（pnpm 的 prepare 钩子里的 "pnpm run build"）找不到 pnpm。
    //    必须保持原键名，并向它前面插入 host node 目录。
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = path.dirname(hostNode) + path.delimiter + (env[pathKey] || '');
    delete env.NODE_OPTIONS;
    // NC 是 pnpm 工程；这里必须让 pnpm 走"独立工程"语义
    delete env.npm_config_user_agent;

    const lockPath = path.join(workRoot, 'pnpm-lock.yaml');
    const installArgs = ['install', '--reporter=append-only'];
    if (fs.existsSync(lockPath)) {
        installArgs.push('--frozen-lockfile');
    }
    log('安装依赖（' + pnpm.label + '）：' + workRoot);
    try {
        run(hostNode, [pnpm.script, ...installArgs], { cwd: workRoot, env });
    } catch (error) {
        fail(
            'pnpm install 失败（exit ' +
                (error.status ?? '?') +
                '）。工作副本保留在 ' +
                workRoot +
                ' 供排查。',
        );
    }

    // 受控入口的类型检查：NC 自己的 tsconfig 覆盖不到 host/（它 import 的是 @snowluma/*），
    // 所以必须在这里对**工作副本**跑一次 tsc，否则入口里的类型漂移不会被任何门禁抓到。
    // 只对本 Phase 新增的两个文件报错，SL 上游自身的类型问题不归我们管。
    if (entry) {
        typecheckEntry(workRoot, hostNode, env);
    }

    // 构建：直接用 vendor 里上游原样的 core/vite.config.ts
    log('构建 @snowluma/core …');
    let buildOk = true;
    try {
        run(hostNode, [pnpm.script, '--filter', '@snowluma/core', 'build'], { cwd: workRoot, env });
    } catch (error) {
        buildOk = false;
        log('构建失败（exit ' + (error.status ?? '?') + '）');
    }

    const bundle = path.join(workRoot, 'dist', 'index.mjs');
    if (!buildOk || !fs.existsSync(bundle)) {
        fail('未产出 dist/index.mjs。工作副本保留在 ' + workRoot);
    }

    const bundleBytes = fs.statSync(bundle).size;
    log(
        'index.mjs: ' +
            (bundleBytes / 1024 / 1024).toFixed(2) +
            ' MB（上限 ' +
            MAX_BUNDLE_BYTES / 1024 / 1024 +
            ' MB）',
    );
    if (bundleBytes < MIN_BUNDLE_BYTES) {
        fail('index.mjs 只有 ' + bundleBytes + ' 字节，远小于预期——Proton 未内联或入口选错');
    }
    if (bundleBytes > MAX_BUNDLE_BYTES) {
        fail('index.mjs 超过 ' + MAX_BUNDLE_BYTES + ' 字节（S2 停止条件：Proton 未内联或打进了不该打的依赖）');
    }

    const bundleText = fs.readFileSync(bundle, 'utf8');
    if (bundleText.includes('was not transformed')) {
        fail('index.mjs 里仍有 "was not transformed" 桩：Proton 插件未生效');
    }
    if (!bundleText.startsWith('import { createRequire as __snowlumaCreateRequire }')) {
        fail('index.mjs 缺少 banner 注入的 createRequire —— 与上游 core/vite.config.ts 的输出形状不符');
    }
    if (entry) {
        assertControlledBundle(bundleText);
    }

    // 组装产物目录
    log('组装 ' + outDir);
    rmrf(outDir);
    ensureDir(outDir);
    fs.copyFileSync(bundle, path.join(outDir, 'index.mjs'));

    const distDir = path.join(workRoot, 'dist');
    for (const file of ['check-node-version.cjs', 'launcher.bat', 'package.json', 'EULA.md', 'PRIVACY.md']) {
        const src = path.join(distDir, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(outDir, file));
        }
    }

    const nativeSrc = path.join(distDir, 'native');
    if (!fs.existsSync(nativeSrc)) {
        fail('dist/native 不存在：sqliteBuildPlugin / cp 未生效');
    }
    copyTree(nativeSrc, path.join(outDir, 'native'));

    // 布局校验（common/src/native-path.ts 只查 moduleDir/native）
    const required = [
        'native/snowluma-win32-x64.node',
        'native/snowluma-win32-x64.dll',
        'native/websocket-win32-x64.node',
        'native/ffmpeg/ffmpegAddon.win32.x64.node',
        'native/sqlite/manifest.json',
        'native/sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node',
    ];
    for (const rel of required) {
        if (!fs.existsSync(path.join(outDir, rel))) {
            fail('产物缺 ' + rel);
        }
    }

    // 随包宿主 node.exe（H-05=(a)）。必须复制而不是移动：外部来源要保留给复跑。
    const hostTarget = path.join(outDir, 'node.exe');
    fs.copyFileSync(hostNode, hostTarget);
    const hostVersion = execFileSync(hostTarget, ['--version'], { encoding: 'utf8' }).trim();
    if (!isVersionAtLeast(hostVersion.replace(/^v/, ''), REQUIRED_NODE)) {
        fail('随包 node.exe 版本 ' + hostVersion + ' 不满足 ' + NODE_RANGE);
    }

    // 自检：check-node-version.cjs 必须放行
    try {
        execFileSync(hostTarget, [path.join(outDir, 'check-node-version.cjs')], { stdio: 'pipe' });
    } catch {
        fail('check-node-version.cjs 拒绝了随包 node.exe —— 版本门禁未通过');
    }

    log('完成。产物摘要：');
    log('  index.mjs        ' + (bundleBytes / 1024 / 1024).toFixed(2) + ' MB  sha256=' + sha256(bundle).slice(0, 16) + '…');
    log('  node.exe         ' + hostVersion + '  ' + (fs.statSync(hostTarget).size / 1024 / 1024).toFixed(2) + ' MB');
    log('  native/          snowluma / websocket / ffmpeg / sqlite');
    log('  work copy        ' + workRoot + '（可删除）');
}

main();
