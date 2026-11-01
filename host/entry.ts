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

async function main(): Promise<void> {
    const runtimeConfig = loadRuntimeConfig();
    await configureFileTransport({
        maxTotalMb: runtimeConfig.logMaxTotalMb ?? DEFAULT_LOG_MAX_TOTAL_MB,
        retainDays: runtimeConfig.logRetainDays ?? DEFAULT_LOG_RETAIN_DAYS,
        perUinEnabled: runtimeConfig.logPerUin ?? DEFAULT_LOG_PER_UIN,
    });

    log.info('SnowLuma host starting (controlled entry)');
    sendLog('info', 'SnowLuma host starting (controlled entry)');

    // 与上游一致的一次性迁移；不做的话 per-UIN 配置会被旧值覆盖。
    migrateGlobalSettings();
    cleanupInvalidPerUinConfigs();

    const bridgeManager = new BridgeManager();
    bindSystemFaceCatalog(bridgeManager, { dataRoot: path.join(home, 'data') });

    // 🔴 事件 tap 必须挂在**实例工厂**里：manager.startSession 同步调用它（E6），
    // 早于任何事件（E5）；轮询 getInstances() 会漏掉「实例刚建好、第一条事件」的窗口。
    const oneBotManager = new OneBotManager({
        createInstance: (uin, bridge, config, globalSettings) => {
            const instance = new OneBotInstance(uin, bridge, config, globalSettings);
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

installProcessGuards();
main().catch(async (error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log.error(message);
    send({ kind: QQ_HOST_MESSAGE.fatal, message });
    await closeLogger();
    process.exit(1);
});
