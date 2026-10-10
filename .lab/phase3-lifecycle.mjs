import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-lifecycle'));
await fs.mkdir(out, { recursive: true });
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e?.stack || e)));
let backendMode = 'success';
let requests = 0;
await page.route('**/api/backends/chat-completions/generate', async route => {
    requests++;
    try {
        if (backendMode === 'delay') {
            await new Promise(r => setTimeout(r, 2500));
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Echo lifecycle delayed reply.', reasoning_content: 'Lifecycle delayed reasoning.' }, finish_reason: 'stop' }] }) });
        } else if (backendMode === 'error') {
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Echo lifecycle deterministic failure' } }) });
        } else if (backendMode === 'abort') {
            await route.abort('failed');
        } else {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Echo lifecycle reply.', reasoning_content: 'Lifecycle reasoning.' }, finish_reason: 'stop' }] }) });
        }
    } catch {}
});

const setup = async () => {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/');
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance);
    await page.evaluate(async () => {
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
        const s = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { oai_settings } = await import('/scripts/openai.js');
        power_user.chat_truncation = 10000;
        const id = s.characters.findIndex(c => c.name === 'Echo Bench');
        if (id < 0) throw new Error('Echo Bench missing');
        await s.selectCharacterById(id);
        await s.openCharacterChat('echo-bench-500');
        EchoPerformance.setEnabled(true, false);
        s.changeMainAPI('openai');
        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = 'http://127.0.0.1:8041/v1';
        oai_settings.custom_model = 'echo-lifecycle';
        oai_settings.stream_openai = false;
        s.setOnlineStatus('echo-local');
        window.echoP3Lifecycle = [];
        const c = SillyTavern.getContext();
        const record = (event, args) => window.echoP3Lifecycle.push({ event, args: args.map(x => typeof x === 'object' ? null : x), stats: EchoPerformance.stats(), at: performance.now() });
        c.eventSource.on(c.eventTypes.GENERATION_STARTED, (...args) => record('started', args));
        c.eventSource.on(c.eventTypes.GENERATION_STOPPED, (...args) => record('stopped', args));
        c.eventSource.on(c.eventTypes.GENERATION_ENDED, (...args) => record('ended', args));
    });
    await page.waitForFunction(() => EchoPerformance.stats().detachedMessageShells >= 300, null, { timeout: 30000 });
};

const snapshot = () => page.evaluate(() => ({ stats: EchoPerformance.stats(), events: structuredClone(window.echoP3Lifecycle || []), chatLength: SillyTavern.getContext().chat.length }));
const clearEvents = () => page.evaluate(() => { window.echoP3Lifecycle = []; });
const waitResumed = async () => {
    try { await page.waitForFunction(() => !EchoPerformance.stats().generating && EchoPerformance.stats().detachedChunks > 0, null, { timeout: 10000 }); return true; }
    catch { return false; }
};

async function nativeGenerate(type, { addUser = false } = {}) {
    return page.evaluate(async ({ type, addUser }) => {
        const s = await import('/script.js');
        let error = null;
        try {
            if (addUser) await s.sendMessageAsUser(`Echo lifecycle ${type} ${Date.now()}`, '');
            await s.Generate(type);
        } catch (e) { error = String(e?.stack || e); }
        return { error, stats: EchoPerformance.stats(), chatLength: s.chat.length };
    }, { type, addUser });
}

const results = {};
try {
    await setup();

    backendMode = 'success';
    await clearEvents();
    const normalBefore = await snapshot();
    const normalResult = await nativeGenerate('normal', { addUser: true });
    const normalResumed = await waitResumed();
    results.normal = { before: normalBefore, result: normalResult, after: await snapshot(), resumed: normalResumed };

    backendMode = 'success';
    await clearEvents();
    const regenResult = await nativeGenerate('regenerate');
    const regenResumed = await waitResumed();
    results.regenerate = { result: regenResult, after: await snapshot(), resumed: regenResumed };

    backendMode = 'delay';
    await clearEvents();
    const stoppedPromise = nativeGenerate('normal', { addUser: true });
    await page.waitForFunction(() => (window.echoP3Lifecycle || []).some(x => x.event === 'started'), null, { timeout: 10000 });
    const frozenAtStop = await snapshot();
    await page.evaluate(() => SillyTavern.getContext().stopGeneration());
    const stoppedResult = await stoppedPromise;
    const stoppedResumed = await waitResumed();
    results.stopped = { frozenAtStop, result: stoppedResult, after: await snapshot(), resumed: stoppedResumed };

    backendMode = 'error';
    await clearEvents();
    const errorResult = await nativeGenerate('normal', { addUser: true });
    const errorResumed = await waitResumed();
    results.error = { result: errorResult, after: await snapshot(), resumed: errorResumed };

    backendMode = 'abort';
    await clearEvents();
    const abortResult = await nativeGenerate('normal', { addUser: true });
    const abortResumed = await waitResumed();
    results.abort = { result: abortResult, after: await snapshot(), resumed: abortResumed };

    backendMode = 'success';
    await clearEvents();
    results.dryRun = await page.evaluate(async () => {
        const s = await import('/script.js');
        const before = { stats: EchoPerformance.stats(), chatLength: s.chat.length };
        let error = null;
        try { await s.Generate('normal', {}, true); } catch (e) { error = String(e?.stack || e); }
        await new Promise(r => setTimeout(r, 300));
        return { before, after: { stats: EchoPerformance.stats(), chatLength: s.chat.length }, events: structuredClone(window.echoP3Lifecycle || []), error };
    });

    const verdicts = {};
    for (const key of ['normal','regenerate','stopped','error','abort']) {
        const r = results[key];
        const events = r.after?.events || [];
        const startedFrozen = events.some(e => e.event === 'started' && e.stats.generating === true);
        verdicts[key] = { startedFrozen, finalGenerating: r.after?.stats?.generating, resumed: r.resumed, events: events.map(e => e.event) };
    }
    const dry = results.dryRun;
    verdicts.dryRun = {
        nativeCallError: dry.error,
        startedDryEventSeen: dry.events.some(e => e.event === 'started' && e.args?.[2] === true),
        compactStateUnchanged: dry.before.stats.generating === dry.after.stats.generating && dry.before.stats.paused === dry.after.stats.paused,
        finalGenerating: dry.after.stats.generating,
        chatLengthDelta: dry.after.chatLength - dry.before.chatLength,
    };
    await fs.writeFile(path.join(out, 'lifecycle.json'), JSON.stringify({ results, verdicts, requests, pageErrors }, null, 2));
    console.log(JSON.stringify(verdicts, null, 2));
} finally {
    await browser.close();
}
