import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const { chromium } = await import(pathToFileURL(process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence'));
await fs.mkdir(out, { recursive: true });
const mode = process.env.ECHO_MODE || 'baseline';
const results = [];
try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/');
    await page.waitForFunction(() => window.SillyTavern?.getContext && document.querySelector('#send_textarea'), { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('dialog[open] .onboarding') || SillyTavern.getContext().eventSource.autoFireLastArgs.has(SillyTavern.getContext().eventTypes.APP_READY), { timeout: 60000 });
    if (await page.locator('dialog[open] .onboarding').count()) {
        await page.locator('dialog[open] .popup-input').fill('Echo Tester');
        await page.locator('dialog[open] .popup-button-ok').click();
    }
    await page.evaluate(() => new Promise(resolve => {
        const context = SillyTavern.getContext();
        context.eventSource.once(context.eventTypes.APP_READY, resolve);
    }));
    if (mode !== 'baseline') await page.waitForFunction(() => Boolean(window.EchoPerformance));
    await page.evaluate(async mode => {
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
        const s = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
        if (window.EchoPerformance) window.EchoPerformance.setEnabled(mode !== 'baseline');
        let id = s.characters.findIndex(c => c.name === 'Echo Bench');
        if (id < 0) {
            const form = new FormData();
            form.set('ch_name', 'Echo Bench');
            form.set('description', 'A fictional benchmark character. No model calls are needed.');
            form.set('first_mes', 'Echo benchmark ready.');
            const headers = s.getRequestHeaders();
            delete headers['Content-Type'];
            const r = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
            if (!r.ok) throw new Error(`create character: ${r.status}`);
            await s.getCharacters();
            id = s.characters.findIndex(c => c.name === 'Echo Bench');
        }
        await s.selectCharacterById(id);
        window.echoLongTasks = [];
        window.echoGenerationEvents = [];
        const ec = SillyTavern.getContext();
        ec.eventSource.on(ec.eventTypes.GENERATION_STARTED, (...args) => window.echoGenerationEvents.push({ type: 'start', args }));
        ec.eventSource.on(ec.eventTypes.GENERATION_ENDED, (...args) => window.echoGenerationEvents.push({ type: 'end', args }));
        window.echoObserver = new PerformanceObserver(list => window.echoLongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
        window.echoObserver.observe({ type: 'longtask', buffered: false });
    }, mode);
    for (const count of (process.env.ECHO_COUNTS || '50,150,350,700').split(',').map(Number)) {
        const setup = await page.evaluate(async count => {
            const s = await import('/script.js');
            const paragraph = 'The fictional city settled into the evening. At the station, a traveller checked the timetable and put away a folded map. The window reflected a quiet street, a small cafe, and the lamps along the river. Nobody was in a hurry; the conversation followed the changing weather and tomorrow’s plans.';
            const messages = Array.from({ length: count }, (_, i) => {
                const text = `Message ${i}: **Echo benchmark**\n\n` + Array.from({ length: 8 }, (_, j) => `${j + 1}. ${paragraph}`).join('\n\n') + '\n\n> A small observation, kept for later.\n\n`echo-fixture`';
                return { name: i % 2 ? 'Echo Bench' : 'You', is_user: !(i % 2), is_system: false, send_date: '2026-10-09T12:00:00.000Z', mes: text, extra: i % 2 ? { reasoning: paragraph.repeat(4), reasoning_duration: 1000 } : {}, ...(i % 2 ? { swipe_id: 0, swipes: [text, `Alternate message ${i}\n\n${paragraph}`], swipe_info: [{ send_date: '2026-10-09T12:00:00.000Z', extra: { reasoning: paragraph.repeat(4), reasoning_duration: 1000 } }, { send_date: '2026-10-09T12:00:00.000Z', extra: {} }] } : {}) };
            });
            const file = `echo-bench-${count}`;
            const data = [{ user_name: 'unused', character_name: 'unused', chat_metadata: { echo_fixture: true } }, ...messages];
            const r = await fetch('/api/chats/save', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: s.characters[s.this_chid].avatar, file_name: file, chat: data, force: true }) });
            if (!r.ok) throw new Error(`fixture save failed: ${r.status}`);
            return { file, payloadBytes: new TextEncoder().encode(JSON.stringify(data)).length };
        }, count);
        for (let repeat = 0; repeat < Number(process.env.ECHO_REPEATS || 3); repeat++) {
            const caseModes = mode === 'paired' ? (repeat % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) : [mode];
            for (const caseMode of caseModes) {
            await page.evaluate(mode => window.EchoPerformance?.setEnabled(mode !== 'baseline'), caseMode);
            await page.waitForTimeout(100);
            await page.evaluate(() => { window.echoLongTasks.length = 0; });
            const loadMs = await page.evaluate(async file => { const s = await import('/script.js'); const t = performance.now(); await s.openCharacterChat(file); return performance.now() - t; }, setup.file);
            if (caseMode !== 'baseline' && count >= 150) {
                try { await page.waitForFunction(() => window.EchoPerformance.stats().deferredMessages >= Math.min(40, SillyTavern.getContext().chat.length - 60), null, { timeout: 15000 }); }
                catch (error) { const diagnostic = await page.evaluate(() => ({ stats: EchoPerformance.stats(), generationEvents: window.echoGenerationEvents, chatLength: SillyTavern.getContext().chat.length, shells: document.querySelectorAll('#chat>.mes').length, selection: String(window.getSelection()), pins: document.querySelectorAll('[data-echo-keep]').length })); console.log('DEFER DIAGNOSTIC', diagnostic); await fs.writeFile(path.join(out, 'generation-diagnostic.json'), JSON.stringify(diagnostic, null, 2)); throw error; }
            }
            await page.waitForTimeout(4000);
            const initial = await page.evaluate(() => {
                const c = document.querySelector('#chat');
                return { domNodes: document.querySelectorAll('*').length, chatNodes: c.querySelectorAll('*').length, messageShells: c.querySelectorAll('.mes').length, heapUsed: performance.memory?.usedJSHeapSize ?? null, heapTotal: performance.memory?.totalJSHeapSize ?? null, scrollHeight: c.scrollHeight, compressed: window.EchoPerformance?.stats() ?? null };
            });
            assert.equal(initial.messageShells, count);
            if (caseMode !== 'baseline') assert.equal(initial.compressed.enabled, true);
            const interaction = await page.evaluate(async () => {
                const a = document.querySelector('#send_textarea');
                const times = [];
                for (let i = 0; i < 10; i++) {
                    const t = performance.now(); a.focus(); a.value = `echo input ${i}`; a.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    times.push(performance.now() - t);
                }
                a.value = ''; a.dispatchEvent(new Event('input', { bubbles: true }));
                return times;
            });
            const scroll = await page.evaluate(async () => {
                const c = document.querySelector('#chat'); const frames = []; let last = performance.now();
                for (let i = 0; i < 80; i++) {
                    c.scrollTop = (c.scrollHeight - c.clientHeight) * (i < 40 ? 1 - i / 39 : (i - 40) / 39);
                    await new Promise(r => requestAnimationFrame(r));
                    const t = performance.now(); frames.push(t - last); last = t;
                }
                return { frames, finalScrollTop: c.scrollTop, finalHeight: c.scrollHeight, clientHeight: c.clientHeight };
            });
            const save = await page.evaluate(async () => {
                const s = await import('/script.js'); const samples = [];
                const raw = JSON.stringify(s.chat); const serializeStart = performance.now(); JSON.stringify(s.chat); const serializeMs = performance.now() - serializeStart;
                for (let i = 0; i < 3; i++) { const t = performance.now(); await s.saveChatConditional(); samples.push(performance.now() - t); }
                return { samples, serializeMs, payloadBytes: new TextEncoder().encode(raw).length, unchanged: JSON.stringify(s.chat) === raw };
            });
            assert.equal(save.unchanged, true);
            const tasks = await page.evaluate(() => [...window.echoLongTasks]);
            results.push({ mode: caseMode, count, repeat, loadMs, ...initial, inputToTwoFramesMs: interaction, scroll, save, longTasks: tasks });
            console.log(JSON.stringify({ mode: caseMode, count, repeat, loadMs: Math.round(loadMs), chatNodes: initial.chatNodes, longTasks: tasks.length }));
            }
        }
        await page.screenshot({ path: path.join(out, `${mode}-${count}.png`) });
    }
    await fs.writeFile(path.join(out, `${mode}.json`), JSON.stringify({ date: '2026-10-09', browser: await browser.version(), viewport: page.viewportSize(), runtimeCommit: '8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8', methodology: 'Synthetic markdown/reasoning/two-swipe fixture loaded and saved through real SillyTavern APIs. Three repeats; all messages rendered (chat_truncation=10000). Input dispatch to two animation frames is a proxy, not INP. Scroll sweep is scripted scrollTop per frame, not physical wheel input. Heap is precise Chromium performance.memory without forced GC.', results, errors }, null, 2));
    assert.deepEqual(errors, []);
} finally { await browser.close(); }
