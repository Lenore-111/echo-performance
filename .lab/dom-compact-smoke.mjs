import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'evidence/dom-compact-smoke');
await fs.mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));

const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);

const errors = [];
const rows = [];
page.on('pageerror', error => errors.push(String(error)));

const ready = async () => {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance);
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
    });
};

const openChat = async count => page.evaluate(async count => {
    const s = await import('/script.js');
    const index = s.characters.findIndex(c => c.name === 'Echo Bench');
    if (index < 0) throw new Error('Echo Bench character missing');
    await s.selectCharacterById(index);
    const started = performance.now();
    await s.openCharacterChat(`echo-bench-${count}`);
    return performance.now() - started;
}, count);

const domSnapshot = () => page.evaluate(() => {
    const root = document.querySelector('#chat');
    const walk = node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ALL);
        let count = 1;
        while (walker.nextNode()) count++;
        return count;
    };
    return {
        liveMes: root.querySelectorAll(':scope > .mes').length,
        chatElements: root.querySelectorAll('*').length,
        pageNodes: walk(document),
        chatNodes: walk(root),
        scrollTop: root.scrollTop,
        scrollHeight: root.scrollHeight,
        stats: EchoPerformance.stats(),
    };
});

const waitForCompact = async expectedDetached => {
    await page.waitForFunction(expectedDetached => {
        const stats = EchoPerformance.stats();
        return stats.detachedMessageShells >= expectedDetached && stats.detachedChunks > 0;
    }, expectedDetached, { timeout: 30000 });
    await page.waitForTimeout(300);
};

const ensureOldMessage = async target => page.evaluate(target => {
    const before = EchoPerformance.stats();
    const node = EchoPerformance.ensureMessageMounted(target, 'smoke-ensure');
    const after = EchoPerformance.stats();
    return {
        found: node instanceof HTMLElement,
        sameMesId: node?.getAttribute('mesid') === String(target),
        before,
        after,
        connected: Boolean(node?.isConnected),
    };
}, target);

const testSwipe = async target => page.evaluate(async target => {
    EchoPerformance.ensureMessageMounted(target, 'smoke-swipe');
    const s = await import('/script.js');
    const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
    const message = s.chat[target];
    const before = message?.swipe_id;
    if (!message || !Array.isArray(message.swipes) || message.swipes.length < 2) return { supported: false, reason: 'fixture has <2 swipes' };
    const desired = before === 0 ? 1 : 0;
    const direction = desired > before ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
    const started = performance.now();
    await s.swipe(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: target, forceSwipeId: desired });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
        supported: true,
        ok: s.chat[target].swipe_id === desired && document.querySelector(`#chat > .mes[mesid="${target}"]`) instanceof HTMLElement,
        ms: performance.now() - started,
        before,
        after: s.chat[target].swipe_id,
    };
}, target);

const testEdit = async target => page.evaluate(async target => {
    const shell = EchoPerformance.ensureMessageMounted(target, 'smoke-edit');
    if (!(shell instanceof HTMLElement)) return { ok: false, reason: 'not mounted' };
    const button = shell.querySelector('.mes_edit');
    if (!(button instanceof HTMLElement)) return { ok: false, reason: 'edit button missing' };
    button.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const editor = shell.querySelector('.edit_textarea');
    const opened = editor instanceof HTMLElement;
    shell.querySelector('.mes_edit_cancel')?.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { ok: opened && !shell.querySelector('.edit_textarea'), opened };
}, target);

const testReasoning = async target => page.evaluate(async target => {
    const shell = EchoPerformance.ensureMessageMounted(target, 'smoke-reasoning');
    if (!(shell instanceof HTMLElement)) return { ok: false, reason: 'not mounted' };
    const header = shell.querySelector('.mes_reasoning_header');
    const details = header?.closest('details');
    if (!(header instanceof HTMLElement) || !(details instanceof HTMLDetailsElement)) return { ok: false, reason: 'reasoning fixture missing' };
    if (details.open) header.click();
    const started = performance.now();
    header.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = { ok: details.open && Boolean(details.querySelector('.mes_reasoning')?.textContent?.length), open: details.open, ms: performance.now() - started };
    if (details.open) header.click();
    return result;
}, target);

const testJump = async target => page.evaluate(async target => {
    const { executeSlashCommands } = await import('/scripts/slash-commands.js');
    const root = document.querySelector('#chat');
    const before = root.scrollTop;
    const started = performance.now();
    await executeSlashCommands(`/chat-jump ${target}`);
    await new Promise(resolve => setTimeout(resolve, 800));
    const shell = document.querySelector(`#chat > .mes[mesid="${target}"]`);
    if (!(shell instanceof HTMLElement)) return { ok: false, reason: 'target missing', ms: performance.now() - started };
    const sr = shell.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    return { ok: sr.bottom > rr.top && sr.top < rr.bottom, before, after: root.scrollTop, ms: performance.now() - started };
}, target);

const testRegen = async () => {
    const fixture = await page.evaluate(() => {
        const c = SillyTavern.getContext();
        const last = c.chat.at(-1);
        return { length: c.chat.length, mes: last?.mes ?? '', reasoning: last?.extra?.reasoning ?? '' };
    });
    let requests = 0;
    await page.route('**/api/backends/chat-completions/generate', async route => {
        requests += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: fixture.mes, reasoning_content: fixture.reasoning }, finish_reason: 'stop' }] }),
        });
    });
    try {
        return await page.evaluate(async fixture => {
            const s = await import('/script.js');
            const { oai_settings } = await import('/scripts/openai.js');
            const context = SillyTavern.getContext();
            window.echoCompactGenerationStates = [];
            const started = (_type, _options, dryRun) => {
                if (!dryRun) window.echoCompactGenerationStates.push({ event: 'started', stats: EchoPerformance.stats() });
            };
            const ended = () => window.echoCompactGenerationStates.push({ event: 'ended', stats: EchoPerformance.stats() });
            context.eventSource.on(context.eventTypes.GENERATION_STARTED, started);
            context.eventSource.on(context.eventTypes.GENERATION_ENDED, ended);
            s.changeMainAPI('openai');
            oai_settings.chat_completion_source = 'custom';
            oai_settings.custom_url = 'http://127.0.0.1:8041/v1';
            oai_settings.custom_model = 'echo-deterministic';
            oai_settings.stream_openai = false;
            s.setOnlineStatus('echo-local');
            const before = EchoPerformance.stats();
            await s.Generate('regenerate');
            await new Promise(resolve => setTimeout(resolve, 500));
            const after = EchoPerformance.stats();
            context.eventSource.removeListener(context.eventTypes.GENERATION_STARTED, started);
            context.eventSource.removeListener(context.eventTypes.GENERATION_ENDED, ended);
            return {
                ok: s.chat.length === fixture.length && !after.generating,
                before,
                after,
                lifecycle: window.echoCompactGenerationStates,
                finalLength: s.chat.length,
            };
        }, fixture);
    } finally {
        await page.unroute('**/api/backends/chat-completions/generate');
    }
};

try {
    await page.goto('http://127.0.0.1:8039');
    await ready();

    for (const count of [200, 500, 1000]) {
        for (const enabled of [false, true]) {
            await page.evaluate(enabled => EchoPerformance.setEnabled(enabled, false), enabled);
            const loadMs = await openChat(count);
            await page.waitForTimeout(600);

            if (enabled) {
                const expectedDetached = Math.max(1, count - 180);
                await waitForCompact(expectedDetached);
            }

            const initial = await domSnapshot();
            const result = { count, enabled, loadMs, initial };

            if (enabled) {
                const target = Math.max(10, count - 190);
                result.ensure = await ensureOldMessage(target);
                result.swipe = await testSwipe(target);
                result.edit = await testEdit(target);
                result.reasoning = await testReasoning(target);

                // Return to the bottom before exercising the native jump path so
                // the target is cold again and ST must request historical DOM.
                await page.evaluate(() => {
                    const root = document.querySelector('#chat');
                    root.scrollTop = root.scrollHeight;
                });
                await page.waitForTimeout(2500);
                result.beforeJump = await domSnapshot();
                result.jump = await testJump(target);
                result.afterJump = await domSnapshot();
                result.regen = await testRegen();

                const samples = EchoPerformance ? result.afterJump.stats.restoreSamples ?? [] : [];
                result.maxRestoreDriftPx = samples.length ? Math.max(...samples.map(sample => Math.abs(sample.driftPx ?? 0))) : null;
                result.maxRestoreMs = samples.length ? Math.max(...samples.map(sample => sample.durationMs ?? 0)) : null;
            }

            rows.push(result);
            await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ rows, errors }, null, 2));
        }
    }

    const off1000 = rows.find(row => row.count === 1000 && !row.enabled);
    const on1000 = rows.find(row => row.count === 1000 && row.enabled);
    const generationFreezeOk = on1000?.regen?.lifecycle?.some(x => x.event === 'started' && x.stats.generating)
        && on1000?.regen?.lifecycle?.some(x => x.event === 'ended' && !x.stats.generating);
    const verdict = !off1000 || !on1000 ? 'NOT VERIFIED'
        : on1000.initial.liveMes <= 180
            && on1000.initial.chatElements < off1000.initial.chatElements * 0.45
            && on1000.initial.pageNodes < off1000.initial.pageNodes * 0.60
            && on1000.ensure?.found
            && on1000.edit?.ok
            && on1000.reasoning?.ok
            && on1000.jump?.ok
            && on1000.regen?.ok
            && generationFreezeOk
            && (on1000.swipe?.supported === false || on1000.swipe?.ok)
            && (on1000.maxRestoreDriftPx ?? Infinity) <= 8
            ? 'PASS'
            : 'PARTIAL';

    const summary = {
        verdict,
        note: 'Smoke gate only. PASS means the prototype is worth full Phase 3 profiling; it is not a stable-release verdict.',
        thresholds: { maxLiveMes1000: 180, maxChatElementsRatio1000: 0.45, maxPageNodesRatio1000: 0.60, maxRestoreDriftPx: 8 },
        rows,
        errors,
    };
    await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ verdict, errors: errors.length }, null, 2));
} finally {
    await browser.close();
}
