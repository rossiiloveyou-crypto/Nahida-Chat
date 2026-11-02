/**
 * snowluma-host 的**受控入口**（PHASE-2 §4.1 G1）。
 *
 * 这不是 SL 的应用入口，**不要** import `core/src/index.ts`：
 * 那个入口会自起 WebUI、跑 update 自重启、抢 SIGINT/SIGTERM（P1 报告 §五 D-02 实测 6 项全命中）。
 *
 * 本入口只做三件事：
 *   1. 把 cwd 定到 NC_SL_HOME（SL 的 config/ logs/ data/ 全是相对路径）；
 *   2. new BridgeManager / OneBotManager / HookManager（**autoLoadOnDiscovery 写死 false**，总蓝图 M2）；
 *   3. 用 `process.send` 实现 NC 主进程发起的 RPC。
 *
 * 构建方式：由 `scripts/build-snowluma-host.mjs` 在 `SL_ENTRY=host/entry.ts` 时
 * 拷进工作副本的 `packages/core/src/nc-host-entry.ts` 并把 vite 的 lib.entry 指向它。
 * **放在 core/src 内是为了能用相对路径引到 `./bridge/manager` 与 `./sys-face-catalog`**
 * （这两个没有 subpath export，用包名引不到）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import {
    isMessageStoreMigrationWorkerData,
    runMessageStoreMigrationWorker,
} from '@snowluma/onebot/message-store-migration-worker';
import { HookManager } from '@snowluma/bridge/hook-manager';
import type { HookProcessInfo } from '@snowluma/bridge/types';
import { configureFileTransport } from '@snowluma/common/log-file-transport';
import { closeLogger, createLogger } from '@snowluma/common/logger';
import {
    DEFAULT_LOG_MAX_TOTAL_MB,
    DEFAULT_LOG_PER_UIN,
    DEFAULT_LOG_RETAIN_DAYS,
    loadRuntimeConfig,
} from '@snowluma/common/runtime';
import { cleanupInvalidPerUinConfigs } from '@snowluma/onebot/config';
import { migrateGlobalSettings } from '@snowluma/onebot/global-config';
import { OneBotInstance } from '@snowluma/onebot/instance';
import { MediaStore } from '@snowluma/onebot/media-store';
import { MessageStore } from '@snowluma/onebot/message-store';
import { OneBotManager } from '@snowluma/onebot/manager';
import { BridgeManager } from './bridge/manager';
import { bindSystemFaceCatalog } from './sys-face-catalog';
import type { JsonObject } from '@snowluma/common/json';
import {
    QQ_HOST_MESSAGE,
    QQ_HOST_RPC,
    type QqActionRequest,
    type QqActionResult,
    type QqHostRpcMethod,
    type QqHostToMain,
    type QqProcessSnapshot,
} from './nc-host-protocol';

const log = createLogger('NC-Host');

/** 30 s 是宿主自己给出的**最后通牒**，不是期望值（PHASE-2 §六 不算失败第 1 条）。 */
const HOME_ENV = 'NC_SL_HOME';

let shuttingDown = false;
let ready = false;

/** `process.versions.napi` 的类型是 `string | undefined`（@types/node），
 *  但 ready 契约里它必须存在——把缺失显式写成 'unknown'，不要用非空断言掩盖。 */
const NAPI_VERSION: string = process.versions.napi ?? 'unknown';

/* ── 1. cwd：必须在任何 SL 模块读 config 之前 ─────────────────────────────── */

function resolveHome(): string {
    const raw = process.env[HOME_ENV];
    if (typeof raw === 'string' && raw.trim()) {
        return path.resolve(raw.trim());
    }
    // 没给就退到当前目录，但**不静默**：NC 侧应该永远给。
    log.warn('%s is not set; falling back to cwd=%s', HOME_ENV, process.cwd());
    return process.cwd();
}

const home = resolveHome();
fs.mkdirSync(home, { recursive: true });

if (path.resolve(process.cwd()) !== home) {
    process.chdir(home);
    log.info('cwd → %s', home);
}

export function currentHome(): string {
    return home;
}

/* ── 2. IPC 发送：判 process.send 存在（无 IPC 直接跑时不该崩） ─────────────── */

function send(message: QqHostToMain): void {
    if (typeof process.send !== 'function' || !process.connected) {
        return;
    }
    try {
        process.send(message);
    } catch (error) {
        // 父进程已经走了：再多说一句也没人听
        log.warn('ipc send failed: %s', error instanceof Error ? error.message : String(error));
    }
}

function sendLog(level: 'info' | 'warn' | 'error', message: string): void {
    send({
        kind: QQ_HOST_MESSAGE.log,
        level,
        scope: 'NC-Host',
        time: new Date().toISOString(),
        line: message,
    });
}

/* ── 3. 进程守卫：与上游同款（掉管道不能带走整个宿主） ───────────────────────── */

function installProcessGuards(): void {
    process.on('unhandledRejection', (reason) => {
        log.error(
            'unhandledRejection (kept alive): %s',
            reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
        );
    });
    process.on('uncaughtException', (error) => {
        log.error('uncaughtException (kept alive): %s', error.stack ?? error.message);
    });
}

/* ── 3b. DEBUG-01：MessageStore 初始化失败的修复与观测 ─────────────────────────── */

/**
 * 根因（DEBUG-01 实测）：
 *   vendor 的 `instance.ts:151-152` 里 MediaStore 与 MessageStore **指向同一个**
 *   `data/<uin>/messages.db`（前者直接用 messages.db，后者拿 messages.json 再 .json→.db）。
 *   两个连接并发执行 `PRAGMA journal_mode = WAL` 会抢独占锁 → `SQLITE_BUSY` →
 *   `SqliteDatabase.initialization` 永久 rejected（Promise 一次性），此后**每一条消息**
 *   都在 `cacheMessageEvent` 抛错，而 `dispatchEvent` 是裸 await、错误被上层吞掉 ⇒ 消息静默全丢。
 *
 * 修复分两步，全部在 host 侧，**不碰 vendor**：
 *   ① `prewarmStoreFiles()`：构造实例**之前**用同步 API 把两个 db 文件建好并切成 WAL。
 *      文件已存在且已是 WAL 时，后续那两个连接的 `PRAGMA journal_mode=WAL` 变成 no-op，
 *      不再需要独占锁 ⇒ 从源头消除 BUSY。
 *   ② `guardStoreInit()`：给三个 store 的 initialization 挂日志（失败可见）+ 对 MessageStore
 *      做一次「失败即重建」（重建时用绝对路径，顺带绕开相对路径的不确定性）。
 */

let DatabaseSyncCtor: (new (file: string) => { exec: (sql: string) => void; close: () => void }) | null | undefined;

function resolveDatabaseSync(): typeof DatabaseSyncCtor {
    if (DatabaseSyncCtor !== undefined) return DatabaseSyncCtor;
    try {
        // node 22.5+ 内置；宿主固定 v24.22.1（M10）。老 node 上拿到 null，退化为「不预热」。
        const mod = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: unknown };
        DatabaseSyncCtor = typeof mod.DatabaseSync === 'function'
            ? (mod.DatabaseSync as NonNullable<typeof DatabaseSyncCtor>)
            : null;
    } catch {
        DatabaseSyncCtor = null;
    }
    return DatabaseSyncCtor;
}

/** 同步预热一个 SQLite 文件：建目录 → 建库 → busy_timeout → WAL → 关闭。任何失败都只告警。 */
function prewarmDb(file: string): void {
    const Ctor = resolveDatabaseSync();
    if (!Ctor) {
        log.warn('[store-prewarm] node:sqlite 不可用，跳过 %s', file);
        return;
    }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const db = new Ctor(file);
        try {
            db.exec('PRAGMA busy_timeout = 5000');
            db.exec('PRAGMA journal_mode = WAL');
            db.exec('PRAGMA synchronous = NORMAL');
        } finally {
            db.close();
        }
        log.info('[store-prewarm] ok %s', file);
    } catch (error) {
        log.warn('[store-prewarm] failed %s: %s', file, error instanceof Error ? error.message : String(error));
    }
}

/** 预热某个账号的全部 store 文件。媒体与消息**必须是同一个文件**（vendor 现状），只预热一次。 */
function prewarmStoreFiles(uin: string): void {
    prewarmDb(path.resolve(home, 'data', uin, 'messages.db'));
    prewarmDb(path.resolve(home, 'data', uin, 'reactions.db'));
}

function initMessageOf(error: unknown): string {
    return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * 挂上初始化日志；MessageStore 失败则用**绝对路径**重建一次。
 * 注意：只重建 messageStore —— MediaStore 被 `mediaIndexer`/`converterCtx` 直接持有引用，
 * 换掉会脱钩，风险远大于收益。
 */
/**
 * DEBUG-01 诊断自检（仅当 `NC_SL_DB_SELFTEST=1` 时运行，跑完即退出）。
 * 在**真实宿主进程里**构造 vendor 原版 MessageStore / MediaStore，把被空 catch 吞掉的错误打出来。
 * 这是唯一能在没有 QQ 登录的情况下复现该故障的入口。
 */
async function runDbSelfTest(): Promise<void> {
    const dataRoot = path.join(home, 'data');
    const uins = fs.existsSync(dataRoot)
        ? fs.readdirSync(dataRoot).filter((name) => /^\d+$/.test(name))
        : [];
    const uin = uins[0] ?? 'selftest';
    const base = path.join(dataRoot, uin);
    fs.mkdirSync(base, { recursive: true });
    log.info('[selftest] uin=%s base=%s cwd=%s', uin, base, process.cwd());

    const probe = (label: string, make: () => { initialization: Promise<void> }): Promise<void> => {
        try {
            const store = make();
            return store.initialization.then(
                () => log.info('[selftest] %s OK', label),
                (error: unknown) => log.error('[selftest] %s FAIL :: %s', label, initMessageOf(error)),
            );
        } catch (error) {
            log.error('[selftest] %s THREW :: %s', label, initMessageOf(error));
            return Promise.resolve();
        }
    };

    // ① 先跑真正的修复路径：prewarm（node:sqlite）—— 验证它在宿主进程里可用
    prewarmStoreFiles(uin);
    log.info('[selftest] prewarm 已执行，messages.db 应已存在且为 WAL');

    // 单个：MessageStore（相对路径，与 instance.ts:152 完全一致）
    await probe('message(seq,rel)', () => new MessageStore(path.join('data', uin, 'messages.json')));
    // 单个：MessageStore（绝对路径）
    await probe('message(seq,abs)', () => new MessageStore(path.join(base, 'messages.json')));
    // 并发：MediaStore 与 MessageStore **同一个文件**（复刻 instance.ts:151-152 的抢锁）
    await Promise.all([
        probe('media(conc)', () => new MediaStore(path.join('data', uin, 'messages.db'))),
        probe('message(conc)', () => new MessageStore(path.join('data', uin, 'messages.json'))),
    ]);
    log.info('[selftest] done');
}

function guardStoreInit(instance: unknown, uin: string): void {
    const holder = instance as Record<string, unknown>;
    const targets: Array<{ name: string; key: string; file: string }> = [
        { name: 'media', key: 'mediaStore', file: path.resolve(home, 'data', uin, 'messages.db') },
        { name: 'message', key: 'messageStore', file: path.resolve(home, 'data', uin, 'messages.db') },
        { name: 'reaction', key: 'reactionStore', file: path.resolve(home, 'data', uin, 'reactions.db') },
    ];
    for (const target of targets) {
        const store = holder[target.key] as
            | { initialization?: Promise<void>; constructor?: unknown; close?: () => Promise<void> }
            | undefined;
        if (!store?.initialization) continue;
        store.initialization.then(
            () => log.info('[store] init ok store=%s uin=%s db=%s', target.name, uin, target.file),
            (error: unknown) => {
                log.error(
                    '[store] init FAILED store=%s uin=%s db=%s err=%s',
                    target.name,
                    uin,
                    target.file,
                    initMessageOf(error),
                );
                if (target.name !== 'message') return;
                // 只重试一次：重建前先尽力关掉旧的（它可能 already failed，close 内部会吞）。
                void (async () => {
                    try {
                        await store.close?.();
                    } catch {
                        /* 旧实例已废，忽略 */
                    }
                    try {
                        const Ctor = store.constructor as new (file: string) => {
                            initialization: Promise<void>;
                        };
                        const rebuilt = new Ctor(target.file);
                        holder[target.key] = rebuilt;
                        await rebuilt.initialization;
                        log.info('[store] rebuilt ok uin=%s db=%s', uin, target.file);
                    } catch (rebuildError) {
                        log.error('[store] rebuilt FAILED uin=%s db=%s err=%s', uin, target.file, initMessageOf(rebuildError));
                    }
                })();
            },
        );
    }
}

/* ── 4. 快照投影：只过能 JSON 序列化的字段 ─────────────────────────────────── */

function toSnapshot(info: HookProcessInfo): QqProcessSnapshot {
    return {
        pid: info.pid,
        name: info.name,
        path: info.path,
        injected: info.injected === true,
        connected: info.connected === true,
        loggedIn: info.loggedIn === true,
        uin: info.uin,
        status: info.status,
        error: info.error,
        method: info.method,
        account: info.account ? { uin: info.account.uin, nickname: info.account.nickname } : null,
    };
}

function requirePid(params: unknown): number {
    const pid =
        typeof params === 'object' && params !== null ? (params as { pid?: unknown }).pid : undefined;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        throw new Error('pid must be a positive integer');
    }
    return pid;
}

/** invokeAction 的入参校验。非法形状直接 throw —— 宿主不做业务判断，但**必须**校验形状。 */
function readActionParams(params: unknown): QqActionRequest {
    if (typeof params !== 'object' || params === null) {
        throw new Error('invokeAction params must be an object');
    }
    const raw = params as { uin?: unknown; action?: unknown; params?: unknown };
    if (typeof raw.uin !== 'string' || !raw.uin.trim()) {
        throw new Error('invokeAction uin must be a non-empty string');
    }
    if (typeof raw.action !== 'string' || !raw.action.trim()) {
        throw new Error('invokeAction action must be a non-empty string');
    }
    if (raw.params !== undefined && (typeof raw.params !== 'object' || raw.params === null)) {
        throw new Error('invokeAction params.params must be an object');
    }
    return {
        uin: raw.uin.trim(),
        action: raw.action.trim(),
        params: raw.params as Record<string, unknown> | undefined,
    };
}

/* ── 5. 主体 ───────────────────────────────────────────────────────────────── */

let mainEntered = false;

async function main(): Promise<void> {
    if (mainEntered) {
        log.warn('main 被重复调用，已忽略（pid=%s）', process.pid);
        return;
    }
    mainEntered = true;
    log.debug('main enter pid=%s', process.pid);
    const runtimeConfig = loadRuntimeConfig();
    await configureFileTransport({
        maxTotalMb: runtimeConfig.logMaxTotalMb ?? DEFAULT_LOG_MAX_TOTAL_MB,
        retainDays: runtimeConfig.logRetainDays ?? DEFAULT_LOG_RETAIN_DAYS,
        perUinEnabled: runtimeConfig.logPerUin ?? DEFAULT_LOG_PER_UIN,
    });

    log.info('SnowLuma host starting (controlled entry)');
    sendLog('info', 'SnowLuma host starting (controlled entry)');

    // DEBUG-01：诊断自检入口（不带 QQ 也能复现 store 初始化失败）
    if (process.env.NC_SL_DB_SELFTEST === '1') {
        await runDbSelfTest();
        process.exit(0);
    }

    // 与上游一致的一次性迁移；不做的话 per-UIN 配置会被旧值覆盖。
    migrateGlobalSettings();
    cleanupInvalidPerUinConfigs();

    const bridgeManager = new BridgeManager();
    bindSystemFaceCatalog(bridgeManager, { dataRoot: path.join(home, 'data') });

    // 🔴 事件 tap 必须挂在**实例工厂**里：manager.startSession 同步调用它（E6），
    // 早于任何事件（E5）；轮询 getInstances() 会漏掉「实例刚建好、第一条事件」的窗口。
    const oneBotManager = new OneBotManager({
        createInstance: (uin, bridge, config, globalSettings) => {
            // DEBUG-01 修复 ①：先同步把两个 db 文件建好并切成 WAL，
            // 避免 MediaStore / MessageStore 并发抢同一个文件的 WAL 独占锁。
            prewarmStoreFiles(uin);
            const instance = new OneBotInstance(uin, bridge, config, globalSettings);
            // DEBUG-01 修复 ②：初始化成功/失败都要可见；MessageStore 失败即重建。
            guardStoreInit(instance, uin);
            instance.subscribeDebugEvents((event) => {
                send({ kind: QQ_HOST_MESSAGE.event, uin, event });
            });
            return instance;
        },
    });
    oneBotManager.bind(bridgeManager);

    // 🔴 autoLoadOnDiscovery 写死 false：多 QQ 进程必须由用户在 NC 里显式选择（总蓝图 M2 / D2）
    const hookManager = new HookManager({
        bridgeManager,
        autoLoadOnDiscovery: false,
    });

    const shutdown = async (reason: string, code = 0): Promise<void> => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        log.warn('shutting down (%s)…', reason);
        let exitCode = code;

        try {
            await oneBotManager.dispose();
        } catch (error) {
            exitCode = 1;
            log.error(
                'OneBot shutdown failed: %s',
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
        }

        try {
            hookManager.dispose();
        } catch (error) {
            exitCode = 1;
            log.error(
                'hook shutdown failed: %s',
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
        }

        try {
            await bridgeManager.dispose();
        } catch (error) {
            exitCode = 1;
            log.error(
                'bridge shutdown failed: %s',
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
        }

        await closeLogger();
        process.exit(exitCode);
    };

    const dispatch = async (method: QqHostRpcMethod, params: unknown): Promise<unknown> => {
        switch (method) {
            case QQ_HOST_RPC.listProcesses: {
                const list = await hookManager.listProcesses();
                return list.map(toSnapshot);
            }
            case QQ_HOST_RPC.loadProcess:
                return toSnapshot(await hookManager.loadProcess(requirePid(params)));
            case QQ_HOST_RPC.unloadProcess:
                return toSnapshot(await hookManager.unloadProcess(requirePid(params)));
            case QQ_HOST_RPC.refreshProcess:
                return toSnapshot(await hookManager.refreshProcess(requirePid(params)));
            case QQ_HOST_RPC.status:
                return {
                    node: process.versions.node,
                    napi: NAPI_VERSION,
                    home,
                    pid: process.pid,
                    uptimeMs: Math.round(process.uptime() * 1000),
                    ready,
                    accounts: oneBotManager.getConnectionStatuses().map((item) => ({
                        uin: item.uin,
                        nickname: item.nickname,
                        adapters: item.adapters.length,
                    })),
                };
            case QQ_HOST_RPC.invokeAction: {
                const req = readActionParams(params);
                const instance = oneBotManager.getInstance(req.uin);
                if (!instance) {
                    throw new Error('account not ready: ' + req.uin);
                }
                const response = await instance.invokeAction(
                    req.action,
                    (req.params ?? {}) as JsonObject,
                );
                const data =
                    typeof response.data === 'object' && response.data !== null
                        ? (response.data as Record<string, unknown>)
                        : {};
                const rawId = data.message_id;
                const result: QqActionResult = {
                    ok: response.status === 'ok',
                    retcode: typeof response.retcode === 'number' ? response.retcode : -1,
                    messageId:
                        typeof rawId === 'number' || typeof rawId === 'string'
                            ? String(rawId)
                            : null,
                    error:
                        response.status === 'ok'
                            ? null
                            : (response.wording ??
                              response.message ??
                              'retcode=' + String(response.retcode)),
                };
                return result;
            }
            case QQ_HOST_RPC.shutdown:
                // 先把回包排出去再拆，否则 NC 会以为超时
                setImmediate(() => {
                    void shutdown('rpc');
                });
                return { ok: true };
            default:
                throw new Error('unknown method: ' + String(method));
        }
    };

    process.on('message', (message: unknown) => {
        // 兼容 SL 上游的裸字符串契约（P0 实测就吃这个）
        if (message === 'shutdown') {
            void shutdown('launcher');
            return;
        }
        if (typeof message !== 'object' || message === null) {
            return;
        }

        const envelope = message as {
            kind?: string;
            id?: number;
            method?: QqHostRpcMethod;
            params?: unknown;
        };

        if (envelope.kind === 'shutdown') {
            void shutdown('launcher');
            return;
        }

        if (envelope.kind !== 'request' || typeof envelope.id !== 'number') {
            return;
        }

        const id = envelope.id;
        const method = envelope.method as QqHostRpcMethod;

        void dispatch(method, envelope.params).then(
            (result) => {
                send({ kind: QQ_HOST_MESSAGE.response, id, ok: true, result });
            },
            (error: unknown) => {
                send({
                    kind: QQ_HOST_MESSAGE.response,
                    id,
                    ok: false,
                    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
                });
            },
        );
    });

    process.on('disconnect', () => {
        void shutdown('parent disconnected');
    });

    // 自己注册信号：上游那套在 main() 里，我们不调用它（§4.1 约束 ③）
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });

    ready = true;
    send({
        kind: QQ_HOST_MESSAGE.ready,
        pid: process.pid,
        node: process.versions.node,
        napi: NAPI_VERSION,
        home,
        startedAt: Date.now(),
    });
    log.info('snowluma-host ready (pid=%d, node=%s, napi=%s)', process.pid, process.versions.node, NAPI_VERSION);
}

/* ── 9. 入口分流：本文件既是「宿主入口」，也会被 vendor 当成「迁移 worker 脚本」 ──────
 *
 * 🔴 DEBUG-01 根因：`onebot/src/message-store-migration-task.ts:51-57` 用
 *    `process.argv[1]` 作为 worker 脚本路径，并且只在 `.ts/.mts` 时走源码引导；
 *    我们的受控入口是 **单文件 index.mjs** ⇒ `sourceEntry=false` ⇒
 *    `new Worker(process.argv[1], { workerData })` **直接把这个入口当 worker 跑**。
 *
 *    结果：worker 里又跑了一遍 `main()`（日志里能看到同一个 pid 出现两次
 *    「main enter / SnowLuma host starting」），却**从不实现迁移 worker 协议**，
 *    于是 `onReady` 永远不来 ⇒ `OneBotManager.startSession` 永远不跑
 *    ⇒ **一个 OneBot 实例都不会创建** ⇒ 消息全部静默丢弃。
 *
 *    修法：检测到 `workerData` 是迁移任务就只跑迁移 worker，绝不跑 main()。
 */
if (isMessageStoreMigrationWorkerData(workerData)) {
    void runMessageStoreMigrationWorker(workerData).catch((error: unknown) => {
        parentPort?.postMessage({
            kind: 'failed',
            message: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        process.exitCode = 1;
    });
} else {
    installProcessGuards();
    main().catch(async (error: unknown) => {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log.error(message);
        send({ kind: QQ_HOST_MESSAGE.fatal, message });
        await closeLogger();
        process.exit(1);
    });
}
