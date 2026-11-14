#!/usr/bin/env node
/**
 * st-drive.probe.mjs — P0 探针：证明 NC 主进程能起隐藏 BrowserWindow、加载 ST 前端、
 * 通过 SillyTavern.getContext() 完成「清空 -> 注入 -> 生成 -> 取回 -> 再清空」闭环。
 *
 * 用法（一条命令，零新增依赖）：
 *   node scripts/probe/st-drive.probe.mjs
 *
 * 环境变量（全部可选）：
 *   NC_PROBE_ST_URL            默认 http://127.0.0.1:8000 （必须是 127.0.0.1，不要 localhost）
 *   NC_PROBE_ST_DATA           默认 D:/ST/SillyTavern/data/default-user（只读统计磁盘残留）
 *   NC_PROBE_BASELINE_DIR      默认 <workspace>/DOC/agent--pojia架构/task-pojia 架构/baseline
 *   NC_PROBE_GEN_TIMEOUT_MS    默认 180000（A5 单轮生成上限）
 *   NC_PROBE_READY_TIMEOUT_MS  默认 60000（等 getContext 就绪上限）
 *   NC_PROBE_DISABLE_BLOCK=1   仅用于经验库 P13 突变验证：临时关掉落盘拦截，确认 A7 变红
 *
 * 输出：stdout = 完整 JSON 报告；stderr = 摘要行 + before.txt 路径；退出码 0 表示 failed === 0。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const LOG_FILE = process.env.NC_PROBE_LOG || path.join(process.env.TEMP || '/tmp', 'st-drive.probe.log');

function logStep(name) {
    const line = new Date().toISOString() + ' ' + name + '\n';
    try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* ignore */ }
    try { process.stderr.write('[probe] ' + line); } catch { /* ignore */ }
}

if (!process.versions.electron) {
    // 用本地 electron 二进制重入自身（BrowserWindow 只存在于 Electron 主进程）
    let electronBin;
    try {
        electronBin = require('electron');
    } catch (error) {
        console.error('[probe] 找不到 electron 依赖：' + (error && error.message));
        process.exit(2);
    }
    if (typeof electronBin !== 'string') {
        console.error('[probe] require("electron") 未返回可执行文件路径：' + String(electronBin));
        process.exit(2);
    }
    // 本机全局存在 ELECTRON_RUN_AS_NODE=1：若不剔除，electron.exe 会退化成纯 node，拿不到 BrowserWindow。
    const childEnv = Object.assign({}, process.env);
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [SELF], { stdio: 'inherit', env: childEnv });
    child.on('exit', code => process.exit(code === null ? 1 : code));
    child.on('error', error => {
        console.error('[probe] 拉起 electron 失败：' + (error && error.message));
        process.exit(2);
    });
} else {
    // 注意：这里绝不能顶层 await —— ESM 的顶层 await 会拖住模块求值，
    // Electron 要等模块求值完才发 'ready'，于是 app.whenReady() 永不 resolve（实测踩过）。
    runInElectron().catch(error => {
        logStep('fatal:' + (error && error.message));
        process.stderr.write('[probe] fatal: ' + String(error && error.stack ? error.stack : error) + '\n');
        process.exit(1);
    });
}

const INJECT_MESSAGES = [
    { is_user: true, mes: 'NC-PROBE 注入 1/3：历史里的第一句，非空用于逐字比对。', name: 'User' },
    { is_user: false, mes: 'NC-PROBE 注入 2/3：角色侧回复，含标点与数字 0429。', name: 'Assistant' },
    { is_user: true, mes: 'NC-PROBE 注入 3/3：最后一句用户输入，触发这一轮生成。', name: 'User' },
];

async function runInElectron() {
    const electronApi = require('electron');
    const { app, BrowserWindow, session } = electronApi;
    logStep('boot:' + (typeof electronApi) + ':app=' + (typeof app));

    // 独立 userData：与默认 Electron profile 隔离，避免残留实例的 profile 锁把 ready 卡死
    const userDataDir = path.join(process.env.TEMP || '/tmp', 'nc-probe-' + process.pid);
    app.setPath('userData', userDataDir);

    const ST_URL = process.env.NC_PROBE_ST_URL || 'http://127.0.0.1:8000';
    const ST_DATA = process.env.NC_PROBE_ST_DATA || 'D:/ST/SillyTavern/data/default-user';
    const READY_TIMEOUT_MS = Number(process.env.NC_PROBE_READY_TIMEOUT_MS || 60000);
    const GEN_TIMEOUT_MS = Number(process.env.NC_PROBE_GEN_TIMEOUT_MS || 180000);
    const CONNECT_TIMEOUT_MS = Number(process.env.NC_PROBE_CONNECT_TIMEOUT_MS || 45000);
    const DISABLE_BLOCK = process.env.NC_PROBE_DISABLE_BLOCK === '1';
    const PARTITION = 'persist:nc-probe';

    const CANCEL_PATTERNS = [
        /\/api\/chats\/save(\?|$)/,
        /\/api\/chats\/delete(\?|$)/,
        /\/api\/chats\/rename(\?|$)/,
        /\/api\/chats\/import(\?|$)/,
        /\/api\/backups\//,
    ];

    const startedAt = new Date();
    const cancelled = [];
    const report = {
        probe: 'st-drive',
        version: 1,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        durationMs: null,
        env: {
            electron: process.versions.electron,
            node: process.versions.node,
            chrome: process.versions.chrome,
            stUrl: ST_URL,
            partition: PARTITION,
            blockDisabled: DISABLE_BLOCK,
            genTimeoutMs: GEN_TIMEOUT_MS,
        },
        disk: null,
        checks: {},
        assertions: { total: 8, passed: 0, failed: 0, skipped: 0, items: [] },
        reset: { after: null, charactersDelta: null },
        cancelledWrites: [],
        notes: [],
        stopped: null,
    };

    const items = report.assertions.items;
    const record = (id, ok, extra) => {
        items.push(Object.assign({ id, ok }, extra || {}));
    };

    logStep('beforeSwitches');
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.disableHardwareAcceleration();

    report.disk = { before: countDisk(ST_DATA), after: null };

    logStep('waitReady');
    await Promise.race([
        app.whenReady(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('APP_READY_TIMEOUT 30s')), 30000)),
    ]);
    logStep('ready');

    const sess = session.fromPartition(PARTITION);
    logStep('session');
    sess.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    sess.setPermissionCheckHandler(() => false);

    if (!DISABLE_BLOCK) {
        sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
            const url = details.url || '';
            if (CANCEL_PATTERNS.some(re => re.test(url))) {
                cancelled.push({ url, method: details.method, at: new Date().toISOString(), resourceType: details.resourceType });
                callback({ cancel: true });
                return;
            }
            callback({});
        });
    }

    logStep('createWindow');
    const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: false,
            session: sess,
            backgroundThrottling: false,
            spellcheck: false,
        },
    });
    win.webContents.setBackgroundThrottling(false);
    logStep('windowCreated');
    win.webContents.on('did-fail-load', (_e, code, desc, url) => logStep('did-fail-load:' + code + ':' + desc + ':' + url));
    win.webContents.on('did-finish-load', () => logStep('did-finish-load'));

    const js = expr => win.webContents.executeJavaScript(expr, true);

    try {
        const loadStarted = Date.now();
        logStep('loadURL');
        await win.loadURL(ST_URL);
        logStep('loaded');
        const readyMs = await waitForContext(js, READY_TIMEOUT_MS);
        logStep('contextReady:' + readyMs);
        report.checks.ready = { ok: true, ms: readyMs, loadMs: Date.now() - loadStarted };

        logStep('A1');
        const A1 = await js(A1_EXPR);
        logStep('A1done');
        report.checks.A1 = A1;
        const a1ok = Array.isArray(A1.missing) && A1.missing.length === 0;
        record('A1', a1ok, { missing: A1.missing, characters: A1.characters });
        if (!a1ok) {
            report.stopped = { reason: 'A1 缺字段（P4 死刑判决，按 PHASE-0 三节停止条件 3 上报）', missing: A1.missing };
        }

        const A2 = await js(A2_EXPR);
        report.checks.A2 = A2;
        if (A2.exists) {
            record('A2', true, { exists: true });
        } else {
            record('A2', true, { exists: false, skipped: true, note: '未发现 NC Bridge 角色；登记 H-08，不创建' });
            report.assertions.skipped += 1;
        }

        const A3 = await js(CLEAR_EXPR);
        report.checks.A3 = Object.assign({ charactersAtA1: A1.characters }, A3);
        const a3ok = A3.chat === 0 && A3.metadata === 0 && A3.prompts === 0;
        const a3bOk = A3.characters === A1.characters;
        record('A3', a3ok, { chat: A3.chat, metadata: A3.metadata, prompts: A3.prompts });
        record('A3b', a3bOk, { characters: A3.characters, expected: A1.characters, note: a3bOk ? 'characters 未被 resetChatState 误清' : 'characters 变了：误用了 resetChatState' });

        const A4 = await js(injectExpr(INJECT_MESSAGES));
        report.checks.A4 = A4;
        record('A4', A4.equal === true && A4.userMappingEqual === true, {
            equal: A4.equal,
            userMappingEqual: A4.userMappingEqual,
            expected: A4.expected,
            actual: A4.actual,
        });

        logStep('ensureConnected');
        const CONNECT = await js(connectExpr(CONNECT_TIMEOUT_MS));
        report.checks.connect = CONNECT;
        logStep('connectDone:' + JSON.stringify(CONNECT));

        logStep('A5start');
        const A5 = await js(generateExpr(GEN_TIMEOUT_MS));
        logStep('A5done');
        report.checks.A5 = A5;
        const a5ok = A5.ok === true && typeof A5.value === 'string' && A5.value.length > 0;
        record('A5', a5ok, {
            ok: A5.ok,
            timeout: !!A5.timeout,
            ms: A5.ms,
            length: A5.length,
            error: A5.error || null,
        });

        const A6 = await js(tagExpr(typeof A5.value === 'string' ? A5.value : ''));
        report.checks.A6 = Object.assign({ sample: typeof A5.value === 'string' ? A5.value.slice(0, 400) : null }, A6);
        const a6ok = A6.hasTag === true;
        record('A6', a6ok || !a5ok, {
            hasTag: A6.hasTag,
            matched: A6.matched,
            note: a6ok ? '原稿含 <tag> 形态标签' : (a5ok ? '当前预设可能不使用标签' : 'A5 未产出文本，A6 无从判定'),
        });

        if (cancelled.length === 0) {
            const active = await js(ACTIVE_SAVE_EXPR);
            report.checks.A7ActiveProbe = active;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        report.cancelledWrites = cancelled.slice(0, 50);
        report.checks.A7 = {
            cancelled: cancelled.length,
            urls: Array.from(new Set(cancelled.map(c => c.url))),
            sample: cancelled.slice(0, 8),
        };
        record('A7', cancelled.length >= 1, { cancelled: cancelled.length, urls: report.checks.A7.urls });

        const A8 = await js(CLEAR_EXPR);
        report.checks.A8 = Object.assign({ charactersAtA1: A1.characters }, A8);
        const a8ok = A8.chat === 0 && A8.metadata === 0 && A8.prompts === 0 && A8.characters === A1.characters;
        record('A8', a8ok, { chat: A8.chat, metadata: A8.metadata, prompts: A8.prompts, characters: A8.characters, expectedCharacters: A1.characters });

        report.reset.after = { chat: A8.chat, metadata: A8.metadata, prompts: A8.prompts };
        report.reset.charactersDelta = A8.characters - A1.characters;
    } catch (error) {
        report.stopped = report.stopped || { reason: 'probe_exception', error: String(error && error.stack ? error.stack : error) };
        record('EXC', false, { error: String(error && error.message ? error.message : error) });
    } finally {
        report.disk.after = countDisk(ST_DATA);
        try { win.destroy(); } catch { /* ignore */ }
    }

    const failedIds = items.filter(i => i.ok !== true).map(i => i.id);
    const passed = items.filter(i => i.ok === true && !i.skipped).length;
    report.assertions.failed = failedIds.length;
    report.assertions.passed = passed;
    report.assertions.failedIds = failedIds;
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();

    logStep('writeBaseline');
    writeBaseline(report);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');

    const verdict = report.assertions.failed === 0 ? 'PASS' : 'FAIL';
    process.stderr.write('SUMMARY: ' + verdict + ' ' + passed + '/' + report.assertions.total +
        ' (failed ' + report.assertions.failed + ', skipped ' + report.assertions.skipped + ')\n');
    const code = report.assertions.failed === 0 ? 0 : 1;
    app.exit(code);
}

const A1_EXPR = [
    '(() => {',
    '    const ctx = SillyTavern.getContext();',
    '    const need = ["chat","characters","chatMetadata","extensionPrompts","generate","eventSource","eventTypes","setExtensionPrompt"];',
    '    return {',
    '        present: need.filter(k => k in ctx),',
    '        missing: need.filter(k => !(k in ctx)),',
    '        characters: ctx.characters.length,',
    '        chat: ctx.chat.length,',
    '        metadata: Object.keys(ctx.chatMetadata).length,',
    '        prompts: Object.keys(ctx.extensionPrompts).length,',
    '        hasStopGeneration: typeof ctx.stopGeneration === "function",',
    '        characterNames: ctx.characters.slice(0, 60).map(c => c && c.name),',
    '        activeCharacter: ctx.characters[ctx.characterId] ? ctx.characters[ctx.characterId].name : null,',
    '        userAgent: navigator.userAgent,',
    '    };',
    '})()',
].join('\n');

const A2_EXPR = [
    '(() => {',
    '    const ctx = SillyTavern.getContext();',
    '    const names = ctx.characters.map(c => c && c.name).filter(Boolean);',
    '    return {',
    '        exists: names.some(n => n === "NC Bridge"),',
    '        candidates: names.filter(n => /bridge/i.test(n)),',
    '        total: names.length,',
    '    };',
    '})()',
].join('\n');

const CLEAR_EXPR = [
    '(() => {',
    '    const ctx = SillyTavern.getContext();',
    '    ctx.chat.length = 0;',
    '    Object.keys(ctx.chatMetadata).forEach(k => delete ctx.chatMetadata[k]);',
    '    Object.keys(ctx.extensionPrompts).forEach(k => delete ctx.extensionPrompts[k]);',
    '    return {',
    '        chat: ctx.chat.length,',
    '        metadata: Object.keys(ctx.chatMetadata).length,',
    '        prompts: Object.keys(ctx.extensionPrompts).length,',
    '        characters: ctx.characters.length,',
    '    };',
    '})()',
].join('\n');

function injectExpr(messages) {
    return [
        '(() => {',
        '    const input = ' + JSON.stringify(messages) + ';',
        '    const ctx = SillyTavern.getContext();',
        '    const built = input.map((m, i) => ({',
        '        is_user: m.is_user,',
        '        mes: m.mes,',
        '        name: m.name,',
        '        send_date: new Date(Date.now() + i * 1000).toISOString(),',
        '        is_system: false,',
        '        extra: {},',
        '    }));',
        '    ctx.chat.splice(0, ctx.chat.length, ...built);',
        '    const actual = ctx.chat.map(m => m.mes);',
        '    const userFlags = ctx.chat.map(m => m.is_user);',
        '    return {',
        '        equal: actual.length === input.length && actual.every((v, i) => v === input[i].mes),',
        '        userMappingEqual: userFlags.length === input.length && userFlags.every((v, i) => v === input[i].is_user),',
        '        expected: input.map(m => m.mes),',
        '        actual,',
        '        length: ctx.chat.length,',
        '    };',
        '})()',
    ].join('\n');
}

function generateExpr(timeoutMs) {
    return [
        '(async () => {',
        '    const ctx = SillyTavern.getContext();',
        '    const t0 = performance.now();',
        '    const timeoutMs = ' + Number(timeoutMs) + ';',
        '    let timer = null;',
        '    const timeoutPromise = new Promise((_resolve, reject) => {',
        '        timer = setTimeout(() => {',
        '            const err = new Error("PROBE_TIMEOUT");',
        '            err.__probeTimeout = true;',
        '            reject(err);',
        '        }, timeoutMs);',
        '    });',
        '    try {',
        '        const raw = await Promise.race([Promise.resolve().then(() => ctx.generate("normal")), timeoutPromise]);',
        '        const value = typeof raw === "string" ? raw : (raw === undefined || raw === null ? "" : String(raw));',
        '        return {',
        '            ok: true,',
        '            ms: Math.round(performance.now() - t0),',
        '            length: value.length,',
        '            value,',
        '            rawType: typeof raw,',
        '            chatAfter: ctx.chat.length,',
        '            lastMes: ctx.chat.length ? String(ctx.chat[ctx.chat.length - 1].mes || "") : "",',
        '        };',
        '    } catch (error) {',
        '        const isTimeout = !!(error && error.__probeTimeout);',
        '        if (isTimeout) { try { ctx.stopGeneration(); } catch (_e) { /* ignore */ } }',
        '        return {',
        '            ok: false,',
        '            timeout: isTimeout,',
        '            ms: Math.round(performance.now() - t0),',
        '            length: 0,',
        '            value: "",',
        '            error: isTimeout ? "timeout" : String(error && error.stack ? error.stack : error),',
        '            chatAfter: ctx.chat.length,',
        '        };',
        '    } finally {',
        '        if (timer) { clearTimeout(timer); }',
        '    }',
        '})()',
    ].join('\n');
}

function connectExpr(timeoutMs) {
    return [
        '(async () => {',
        '    const ctx = SillyTavern.getContext();',
        '    const t0 = performance.now();',
        '    const timeoutMs = ' + Number(timeoutMs) + ';',
        '    if (ctx.onlineStatus && ctx.onlineStatus !== "no_connection") {',
        '        return { attempted: false, ok: true, status: ctx.onlineStatus, ms: 0 };',
        '    }',
        '    const btn = document.querySelector("#api_button_openai");',
        '    if (!btn) { return { attempted: false, ok: false, error: "#api_button_openai not found", ms: 0 }; }',
        '    btn.click();',
        '    const deadline = Date.now() + timeoutMs;',
        '    while (Date.now() < deadline) {',
        '        const s = SillyTavern.getContext().onlineStatus;',
        '        if (s && s !== "no_connection") {',
        '            return { attempted: true, ok: true, status: s, ms: Math.round(performance.now() - t0) };',
        '        }',
        '        await new Promise(r => setTimeout(r, 250));',
        '    }',
        '    return { attempted: true, ok: false, status: SillyTavern.getContext().onlineStatus, ms: Math.round(performance.now() - t0), error: "online_status stayed no_connection" };',
        '})()',
    ].join('\n');
}

function tagExpr(text) {
    return [
        '(() => {',
        '    const text = ' + JSON.stringify(text) + ';',
        '    const re = /<[a-z_][a-z0-9_]*>/i;',
        '    const m = re.exec(text);',
        '    return { hasTag: !!m, matched: m ? m[0] : null, length: text.length };',
        '})()',
    ].join('\n');
}

const ACTIVE_SAVE_EXPR = [
    '(async () => {',
    '    try {',
    '        const res = await fetch("/api/chats/save", {',
    '            method: "POST",',
    '            headers: { "Content-Type": "application/json" },',
    '            body: JSON.stringify({ ch_name: "default_Assistant", file_name: "nc-probe-should-be-blocked" }),',
    '        });',
    '        return { blocked: false, status: res.status };',
    '    } catch (error) {',
    '        return { blocked: true, error: String(error && error.message ? error.message : error) };',
    '    }',
    '})()',
].join('\n');

async function waitForContext(js, timeoutMs) {
    const probeExpr = [
        // 就绪判据必须覆盖三件事，否则会在「只加载完 script.js」时就误判就绪：
        //   1) characters 已从 /api/characters/all 拉回（长度 > 0）；
        //   2) 启动状态检查已把 online_status 从 no_connection 抬起来（Generate 的 hasBackendConnection）；
        //   3) 输入框已挂上（DOM 初始化完成）。
        '(() => {',
        '    try {',
        '        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) { return false; }',
        '        if (document.readyState !== "complete") { return false; }',
        '        const ctx = SillyTavern.getContext();',
        '        const h = typeof ctx.getRequestHeaders === "function" ? ctx.getRequestHeaders() : {};',
        '        return Array.isArray(ctx.chat)',
        '            && Array.isArray(ctx.characters)',
        '            && ctx.characters.length > 0',
        '            && !!(h["X-CSRF-Token"] || h["x-csrf-token"])',
        '            && !!document.querySelector("#send_textarea");',
        '    } catch (error) { return false; }',
        '})()',
    ].join('\n');
    const t0 = Date.now();
    let lastError = null;
    while (Date.now() - t0 < timeoutMs) {
        try {
            const ok = await js(probeExpr);
            if (ok) { return Date.now() - t0; }
        } catch (error) {
            lastError = String(error && error.message ? error.message : error);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('READY_TIMEOUT after ' + timeoutMs + 'ms' + (lastError ? ' (' + lastError + ')' : ''));
}

function countDisk(root) {
    const result = { root, chats: null, backups: null, characters: null };
    for (const dir of ['chats', 'backups', 'characters']) {
        try {
            result[dir] = countFiles(path.join(root, dir));
        } catch {
            result[dir] = null;
        }
    }
    return result;
}

function countFiles(dir) {
    let n = 0;
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) { stack.push(full); } else if (entry.isFile()) { n += 1; }
        }
    }
    return n;
}

function stampNow() {
    const d = new Date();
    const p = v => String(v).padStart(2, '0');
    return p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function baselineDir() {
    if (process.env.NC_PROBE_BASELINE_DIR) { return process.env.NC_PROBE_BASELINE_DIR; }
    const repoRoot = path.resolve(path.dirname(SELF), '..', '..');
    return path.join(path.dirname(repoRoot), 'DOC', 'agent--pojia架构', 'task-pojia 架构', 'baseline');
}

function writeBaseline(report) {
    const dir = baselineDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'st-drive.' + stampNow() + '.before.txt');
        const disk = report.disk || { before: null, after: null };
        const delta = (disk.before && disk.after) ? {
            chats: disk.after.chats - disk.before.chats,
            backups: disk.after.backups - disk.before.backups,
            characters: disk.after.characters - disk.before.characters,
        } : null;
        const payload = Object.assign({}, report, {
            diskDelta: delta,
            failed: report.assertions.failed,
            passed: report.assertions.passed,
            skipped: report.assertions.skipped,
        });
        fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        process.stderr.write('BASELINE: ' + file + '\n');
    } catch (error) {
        process.stderr.write('BASELINE_WRITE_FAILED: ' + String(error && error.message ? error.message : error) + '\n');
    }
}
