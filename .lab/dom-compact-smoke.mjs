import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/dom-compact-smoke'));
await fs.mkdir(out, { recursive: true });
const playwrightEntry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(playwrightEntry.startsWith('file:') ? playwrightEntry : pathToFileURL(playwrightEntry).href);
const browser = await chromium.launch({
    executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--enable-precise-memory-info', '--no-sandbox', '--disable-dev-shm-usage'],
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
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
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
    const ids = [...root.querySelectorAll(':scope > .mes')].map(x => Number(x.getAttribute('mesid')));
    return {
        liveMes: ids.length,
        liveRange: ids.length ? [Math.min(...ids), Math.max(...ids)] : null,
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
    await page.waitForTimeout(500);
};

const duplicateIds = () => page.evaluate(() => {
    const ids = [...document.querySelectorAll('#chat > .mes')].map(x => x.getAttribute('mesid'));
    const seen = new Set(); const dup = [];
    for (const id of ids) { if (seen.has(id)) dup.push(id); else seen.add(id); }
    return [...new Set(dup)];
});

const coldState = target => page.evaluate(target => ({
    live: document.querySelector(`#chat > .mes[mesid="${target}"]`) instanceof HTMLElement,
    stats: EchoPerformance.stats(),
}), target);

const testDirectColdSwipe = async target => page.evaluate(async target => {
    const context = SillyTavern.getContext();
    const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
    const liveBefore = document.querySelector(`#chat > .mes[mesid="${target}"]`) instanceof HTMLElement;
    const message = context.chat[target];
    if (!message || !Array.isArray(message.swipes) || message.swipes.length < 2) return { supported: false, liveBefore };
    const before = Number(message.swipe_id ?? 0);
    const desired = before === 0 ? 1 : 0;
    const direction = desired > before ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
    let thrown = null;
    try {
        await context.swipe.to(null, direction, {
            source: SWIPE_SOURCE.SWIPE_PICKER,
            repeated: false,
            forceMesId: target,
            forceSwipeId: desired,
            forceDuration: 0,
        });
    } catch (error) { thrown = String(error?.stack || error); }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const shell = document.querySelector(`#chat > .mes[mesid="${target}"]`);
    const expectedText = context.chat[target]?.mes ?? '';
    return {
        supported: true,
        liveBefore,
        mountedAfter: shell instanceof HTMLElement,
        stateChanged: context.chat[target]?.swipe_id === desired,
        domMatchesState: shell instanceof HTMLElement && shell.querySelector('.mes_text')?.textContent?.includes(expectedText.slice(0, 40)),
        before,
        after: context.chat[target]?.swipe_id,
        thrown,
    };
}, target);

const testJump = async target => page.evaluate(async target => {
    const { executeSlashCommands } = await import('/scripts/slash-commands.js');
    const root = document.querySelector('#chat');
    const liveBefore = document.querySelector(`#chat > .mes[mesid="${target}"]`) instanceof HTMLElement;
    const before = root.scrollTop;
    const started = performance.now();
    await executeSlashCommands(`/chat-jump ${target}`);
    await new Promise(resolve => setTimeout(resolve, 900));
    const shell = document.querySelector(`#chat > .mes[mesid="${target}"]`);
    if (!(shell instanceof HTMLElement)) return { ok: false, liveBefore, reason: 'target missing', ms: performance.now() - started };
    const sr = shell.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    return { ok: sr.bottom > rr.top && sr.top < rr.bottom, liveBefore, before, after: root.scrollTop, ms: performance.now() - started };
}, target);

const testEditAndReasoningAfterJump = async target => page.evaluate(async target => {
    const shell = document.querySelector(`#chat > .mes[mesid="${target}"]`);
    if (!(shell instanceof HTMLElement)) return { edit: false, reasoning: false, reason: 'target missing after jump' };
    const edit = shell.querySelector('.mes_edit');
    let editOk = false;
    if (edit instanceof HTMLElement) {
        edit.click(); await new Promise(r => requestAnimationFrame(r));
        editOk = shell.querySelector('.edit_textarea') instanceof HTMLElement;
        shell.querySelector('.mes_edit_cancel')?.click(); await new Promise(r => requestAnimationFrame(r));
    }
    const header = shell.querySelector('.mes_reasoning_header');
    const details = header?.closest('details');
    let reasoningOk = false;
    if (header instanceof HTMLElement && details instanceof HTMLDetailsElement) {
        if (details.open) header.click();
        header.click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        reasoningOk = details.open && Boolean(details.querySelector('.mes_reasoning')?.textContent?.length);
        if (details.open) header.click();
    }
    return { edit: editOk, reasoning: reasoningOk };
}, target);

const testShowMoreReconcile = async () => page.evaluate(async () => {
    const s = await import('/script.js');
    const before = [...document.querySelectorAll('#chat > .mes')].map(x => Number(x.getAttribute('mesid')));
    await s.showMoreMessages(50);
    await new Promise(r => setTimeout(r, 500));
    const after = [...document.querySelectorAll('#chat > .mes')].map(x => Number(x.getAttribute('mesid')));
    const seen = new Set(); const dup = [];
    for (const id of after) { if (seen.has(id)) dup.push(id); else seen.add(id); }
    return { beforeFirst: before[0] ?? null, afterFirst: after[0] ?? null, duplicates: [...new Set(dup)], stats: EchoPerformance.stats() };
});

const realWheel = async () => {
    const box = await page.locator('#chat').boundingBox();
    if (!box) throw new Error('#chat has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.evaluate(() => {
        window.echoWheelFrames = [];
        window.echoWheelActive = true;
        let last = performance.now();
        const tick = now => {
            if (!window.echoWheelActive) return;
            window.echoWheelFrames.push(now - last); last = now; requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    const before = await domSnapshot();
    for (let i = 0; i < 45; i++) { await page.mouse.wheel(0, -900); await page.waitForTimeout(28); }
    for (let i = 0; i < 45; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(28); }
    await page.waitForTimeout(600);
    const frames = await page.evaluate(() => { window.echoWheelActive = false; return [...window.echoWheelFrames]; });
    const after = await domSnapshot();
    const sorted = [...frames].sort((a,b)=>a-b);
    const p95 = sorted.length ? sorted[Math.floor((sorted.length - 1) * .95)] : null;
    return { before, after, frames, p95, dropped: frames.filter(x => x > 33.4).length };
};

try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039');
    await ready();
    for (const count of [200, 500, 1000]) {
        for (const enabled of [false, true]) {
            await page.evaluate(enabled => EchoPerformance.setEnabled(enabled, false), enabled);
            const loadMs = await openChat(count);
            await page.waitForTimeout(800);
            if (enabled) await waitForCompact(Math.max(1, count - 180));
            const initial = await domSnapshot();
            const result = { count, enabled, loadMs, initial };
            if (enabled) {
                const target = count % 2 === 0 ? Math.max(11, count - 191) : Math.max(11, count - 190);
                await page.evaluate(() => { const root = document.querySelector('#chat'); root.scrollTop = root.scrollHeight; });
                await page.waitForTimeout(2600);
                result.coldBefore = await coldState(target);
                result.directColdSwipe = await testDirectColdSwipe(target);
                await page.evaluate(() => { const root = document.querySelector('#chat'); root.scrollTop = root.scrollHeight; });
                await page.waitForTimeout(2600);
                result.jumpColdBefore = await coldState(target);
                result.jump = await testJump(target);
                result.afterJumpInteractions = await testEditAndReasoningAfterJump(target);
                result.showMore = await testShowMoreReconcile();
                result.duplicates = await duplicateIds();
                await page.evaluate(() => { const root = document.querySelector('#chat'); root.scrollTop = root.scrollHeight; });
                await page.waitForTimeout(2600);
                result.wheel = await realWheel();
                result.final = await domSnapshot();
                const samples = result.final.stats.restoreSamples ?? [];
                result.maxRestoreDriftPx = samples.length ? Math.max(...samples.map(s => Math.abs(s.driftPx ?? 0))) : null;
                result.maxRestoreMs = samples.length ? Math.max(...samples.map(s => s.durationMs ?? 0)) : null;
            }
            rows.push(result);
            await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ rows, errors }, null, 2));
        }
    }
    const off1000 = rows.find(r => r.count === 1000 && !r.enabled);
    const on1000 = rows.find(r => r.count === 1000 && r.enabled);
    const domGate = Boolean(off1000 && on1000)
        && on1000.initial.liveMes >= 100 && on1000.initial.liveMes <= 180
        && on1000.initial.chatElements < off1000.initial.chatElements * 0.45
        && on1000.initial.pageNodes < off1000.initial.pageNodes * 0.60;
    const interactionGate = Boolean(on1000)
        && on1000.jumpColdBefore?.live === false
        && on1000.jump?.ok
        && on1000.afterJumpInteractions?.edit
        && on1000.afterJumpInteractions?.reasoning
        && on1000.duplicates?.length === 0
        && on1000.showMore?.duplicates?.length === 0;
    const directColdGate = Boolean(on1000?.directColdSwipe?.supported && on1000.directColdSwipe.liveBefore === false && on1000.directColdSwipe.mountedAfter && on1000.directColdSwipe.stateChanged && on1000.directColdSwipe.domMatchesState && !on1000.directColdSwipe.thrown);
    const scrollGate = Boolean(on1000) && (on1000.maxRestoreDriftPx ?? Infinity) <= 8 && (on1000.wheel?.p95 ?? Infinity) < 50;
    const verdict = domGate && interactionGate && directColdGate && scrollGate && errors.length === 0 ? 'PASS' : 'FAIL';
    const summary = { verdict, domGate, interactionGate, directColdGate, scrollGate, rows, errors };
    await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ verdict, domGate, interactionGate, directColdGate, scrollGate, errors: errors.length }, null, 2));
    if (verdict !== 'PASS') process.exitCode = 2;
} finally {
    await browser.close();
}
