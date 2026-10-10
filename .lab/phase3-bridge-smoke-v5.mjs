import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-bridge-smoke-v5'));
await fs.mkdir(out, { recursive: true });
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-precise-memory-info', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);

const errors = [];
page.on('pageerror', error => errors.push({ message: String(error), stack: String(error?.stack || error) }));

const targets = {
    edit: 809,
    reasoning: 759,
    swipe: 709,
    jump: 659,
    scrollTo: 609,
};
const state = { targets, cases: {} };
const save = () => fs.writeFile(path.join(out, 'bridge-smoke-v5.json'), JSON.stringify({ state, errors }, null, 2));
const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();

const duplicateMesIds = () => page.evaluate(() => {
    const seen = new Set();
    const duplicates = [];
    for (const node of document.querySelectorAll('#chat > .mes')) {
        const id = node.getAttribute('mesid');
        if (seen.has(id)) duplicates.push(id);
        else seen.add(id);
    }
    return [...new Set(duplicates)];
});

const viewportEvidence = id => page.evaluate(id => {
    const root = document.querySelector('#chat');
    const matches = [...root.querySelectorAll(`:scope > .mes[mesid="${id}"]`)];
    const node = matches[0];
    const rootRect = root.getBoundingClientRect();
    const nodeRect = node?.getBoundingClientRect?.();
    return {
        count: matches.length,
        unique: matches.length === 1,
        visible: Boolean(nodeRect && nodeRect.bottom > rootRect.top && nodeRect.top < rootRect.bottom),
        scrollTop: root.scrollTop,
        scrollHeight: root.scrollHeight,
        nodeTop: nodeRect?.top ?? null,
        nodeBottom: nodeRect?.bottom ?? null,
        rootTop: rootRect.top,
        rootBottom: rootRect.bottom,
    };
}, id);

const traceFor = id => page.evaluate(id => {
    const bridge = globalThis.SillyTavern?.[Symbol.for('echo.performance.native-cold-bridge')];
    return bridge?.trace?.(id) ?? [];
}, id);

const diagnosticFor = id => page.evaluate(id => {
    const root = document.querySelector('#chat');
    const node = root.querySelector(`:scope > .mes[mesid="${id}"]`);
    const active = document.activeElement;
    const bridge = globalThis.SillyTavern?.[Symbol.for('echo.performance.native-cold-bridge')];
    return {
        live: node instanceof HTMLElement,
        activeElement: active instanceof Element ? { tag: active.tagName, id: active.id || null, className: typeof active.className === 'string' ? active.className : null } : null,
        activeInsideTarget: Boolean(node instanceof HTMLElement && active instanceof Element && node.contains(active)),
        scrollTop: root.scrollTop,
        scrollHeight: root.scrollHeight,
        echo: EchoPerformance.stats(),
        bridge: bridge?.stats?.() ?? null,
        trace: bridge?.trace?.(id) ?? [],
    };
}, id);

async function waitScrollStable(maxMs = 6000) {
    return page.evaluate(async maxMs => {
        const root = document.querySelector('#chat');
        const history = [];
        const started = performance.now();
        let previous = root.scrollTop;
        let stableFrames = 0;
        while (performance.now() - started < maxMs) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const current = root.scrollTop;
            history.push({ at: performance.now(), scrollTop: current });
            if (Math.abs(current - previous) < 0.5) stableFrames += 1;
            else stableFrames = 0;
            previous = current;
            if (stableFrames >= 5) return { stable: true, elapsedMs: performance.now() - started, history: history.slice(-24) };
        }
        return { stable: false, elapsedMs: performance.now() - started, history: history.slice(-24) };
    }, maxMs);
}

async function leaveTargetAndObserve(id) {
    const beforeLeave = await diagnosticFor(id);
    await page.evaluate(() => {
        const input = document.querySelector('#send_textarea');
        input?.focus({ preventScroll: true });
        const chat = document.querySelector('#chat');
        chat.scrollTo({ top: chat.scrollHeight, behavior: 'auto' });
        chat.dispatchEvent(new Event('scroll'));
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    let recompacted = false;
    try {
        await page.waitForFunction(id => !document.querySelector(`#chat > .mes[mesid="${id}"]`), id, { timeout: 7000 });
        recompacted = true;
    } catch {}

    const afterLeave = await diagnosticFor(id);
    return { recompacted, beforeLeave, afterLeave, trace: await traceFor(id) };
}

async function nativeSlash(command, id) {
    const beforeBridge = await page.evaluate(() => EchoPerformance.stats().bridge);
    const input = page.locator('#send_textarea');
    await input.click();
    await input.fill(command);
    await input.press('Enter');
    try {
        await page.waitForFunction(({ id, previous }) => {
            const stats = EchoPerformance.stats().bridge;
            const target = document.querySelector(`#chat > .mes[mesid="${id}"]`);
            return stats.commandBridgeInvocations > previous && target instanceof HTMLElement;
        }, { id, previous: beforeBridge.commandBridgeInvocations }, { timeout: 10000 });
    } catch {}
    const scrollSettled = await waitScrollStable();
    return { scrollSettled, viewport: await viewportEvidence(id), bridge: await page.evaluate(() => EchoPerformance.stats().bridge) };
}

async function collectCase(name, fn) {
    try {
        state.cases[name] = await fn();
    } catch (error) {
        state.cases[name] = { pass: false, harnessError: String(error?.stack || error) };
    }
    await save();
}

try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/');
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance);
    await page.evaluate(async targets => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
        const s = await import('/script.js');
        const characterId = s.characters.findIndex(c => c.name === 'Echo Bench');
        if (characterId < 0) throw new Error('Echo Bench missing');
        await s.selectCharacterById(characterId);
        EchoPerformance.setEnabled(false, false);
        await s.openCharacterChat('echo-bench-1000');
        EchoPerformance.setEnabled(false, false);
        window.p3refs = {};
        for (const [name, id] of Object.entries(targets)) {
            const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
            window.p3refs[name] = {
                shell,
                edit: shell?.querySelector('.mes_edit') ?? null,
                reasoning: shell?.querySelector('.mes_reasoning_header, .mes_reasoning_header_title') ?? null,
            };
        }
    }, targets);

    state.eligibility = await page.evaluate(targets => import('/script.js').then(s => Object.fromEntries(Object.entries(targets).map(([name, id]) => [name, {
        id,
        swipeable: s.isMessageSwipeable(id, s.chat[id]),
        overswipeBehavior: s.getOverswipeBehavior(id, s.chat[id]),
        isUser: Boolean(s.chat[id]?.is_user),
    }]))), targets);

    await page.evaluate(() => EchoPerformance.setEnabled(true, false));
    await page.waitForFunction(() => EchoPerformance.stats().detachedMessageShells >= 800 && EchoPerformance.stats().liveMessageShells <= 180, null, { timeout: 30000 });
    state.initial = await page.evaluate(targets => ({
        stats: EchoPerformance.stats(),
        live: Object.fromEntries(Object.entries(targets).map(([name, id]) => [name, Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`))])),
    }), targets);

    await collectCase('edit', async () => {
        const id = targets.edit;
        const result = await page.evaluate(async id => {
            const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
            window.p3refs.edit.edit?.click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
            const textarea = shell?.querySelector('.edit_textarea');
            let saved = false;
            if (textarea instanceof HTMLTextAreaElement) {
                textarea.value += ' [P3B-V5]';
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                shell.querySelector('.mes_edit_done')?.click();
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                saved = SillyTavern.getContext().chat[id]?.mes?.includes('[P3B-V5]') === true
                    && shell.querySelector('.mes_text')?.textContent?.includes('[P3B-V5]') === true;
            }
            return { beforeLive, mountedAfter: shell instanceof HTMLElement, editorOpened: textarea instanceof HTMLTextAreaElement, saved };
        }, id);
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        return { ...result, duplicates, release, pass: !result.beforeLive && result.mountedAfter && result.editorOpened && result.saved && duplicates.length === 0 && release.recompacted };
    });

    await collectCase('reasoning', async () => {
        const id = targets.reasoning;
        const result = await page.evaluate(async id => {
            const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
            window.p3refs.reasoning.reasoning?.click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
            const details = shell?.querySelector('details');
            return {
                beforeLive,
                mountedAfter: shell instanceof HTMLElement,
                open: details instanceof HTMLDetailsElement ? details.open : null,
                contentLength: shell?.querySelector('.mes_reasoning')?.textContent?.length ?? 0,
            };
        }, id);
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        return { ...result, duplicates, release, pass: !result.beforeLive && result.mountedAfter && result.open === true && result.contentLength > 0 && duplicates.length === 0 && release.recompacted };
    });

    await collectCase('swipe', async () => {
        const id = targets.swipe;
        const result = await page.evaluate(async id => {
            const context = SillyTavern.getContext();
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
            const before = Number(context.chat[id].swipe_id ?? 0);
            const desired = before === 0 ? 1 : 0;
            let thrown = null;
            try {
                await context.swipe.to(null, desired > before ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT, {
                    source: SWIPE_SOURCE.SWIPE_PICKER,
                    repeated: false,
                    forceMesId: id,
                    forceSwipeId: desired,
                    forceDuration: 0,
                });
            } catch (error) {
                thrown = String(error?.stack || error);
            }
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
            return {
                beforeLive,
                mountedAfter: shell instanceof HTMLElement,
                before,
                desired,
                after: context.chat[id]?.swipe_id,
                stateChanged: context.chat[id]?.swipe_id === desired,
                domText: shell?.querySelector('.mes_text')?.textContent || '',
                chatText: context.chat[id]?.mes || '',
                swipeText: context.chat[id]?.swipes?.[context.chat[id]?.swipe_id] || '',
                thrown,
            };
        }, id);
        result.domMatches = norm(result.domText).includes(norm(result.chatText).slice(0, 80)) || norm(result.domText).includes(norm(result.swipeText).slice(0, 80));
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        return { ...result, duplicates, release, pass: !result.beforeLive && result.mountedAfter && result.stateChanged && result.domMatches && !result.thrown && duplicates.length === 0 && release.recompacted };
    });

    await collectCase('chatJump', async () => {
        const id = targets.jump;
        const beforeLive = await page.evaluate(id => Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)), id);
        const command = await nativeSlash(`/chat-jump ${id}`, id);
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        const pass = !beforeLive && command.viewport.unique && command.viewport.visible && duplicates.length === 0 && command.bridge.inputPreMounts > 0 && command.bridge.commandBridgeInvocations > 0 && release.recompacted;
        return { beforeLive, command, duplicates, release, pass };
    });

    await collectCase('scrollToMessage', async () => {
        const id = targets.scrollTo;
        const beforeLive = await page.evaluate(id => Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)), id);
        const command = await nativeSlash(`/chat-scrollto ${id}`, id);
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        const pass = !beforeLive && command.viewport.unique && command.viewport.visible && duplicates.length === 0 && command.bridge.commandBridgeInvocations > 0 && release.recompacted;
        return { beforeLive, command, duplicates, release, pass };
    });

    await collectCase('reconciliation', async () => {
        const before = await page.evaluate(() => EchoPerformance.stats());
        await page.evaluate(async () => {
            const s = await import('/script.js');
            await s.showMoreMessages(50);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const after = await page.evaluate(() => EchoPerformance.stats());
        const duplicates = await duplicateMesIds();
        return { before, after, duplicates, pass: duplicates.length === 0 && after.nativeReconciliations >= before.nativeReconciliations };
    });

    await collectCase('wheelRestore', async () => {
        await page.evaluate(() => {
            const chat = document.querySelector('#chat');
            document.querySelector('#send_textarea')?.focus({ preventScroll: true });
            chat.scrollTo({ top: chat.scrollHeight, behavior: 'auto' });
        });
        const box = await page.locator('#chat').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.evaluate(() => {
            window.p3frames = [];
            window.p3active = true;
            let last = performance.now();
            const tick = now => {
                if (!window.p3active) return;
                window.p3frames.push(now - last);
                last = now;
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        for (let i = 0; i < 35; i++) { await page.mouse.wheel(0, -900); await page.waitForTimeout(24); }
        for (let i = 0; i < 35; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(24); }
        await page.waitForTimeout(400);
        return page.evaluate(() => {
            window.p3active = false;
            const frames = [...window.p3frames].sort((a, b) => a - b);
            const samples = EchoPerformance.stats().restoreSamples || [];
            const p95Ms = frames.length ? frames[Math.floor((frames.length - 1) * 0.95)] : null;
            const driftMaxPx = samples.length ? Math.max(...samples.map(x => Math.abs(x.driftPx || 0))) : null;
            return { p95Ms, dropped33: frames.filter(x => x > 33.4).length, driftMaxPx, restoreMaxMs: samples.length ? Math.max(...samples.map(x => x.durationMs || 0)) : null, pass: (p95Ms ?? Infinity) < 50 && (driftMaxPx ?? Infinity) <= 8 };
        });
    });

    state.regenerate = await page.evaluate(id => import('/script.js').then(s => ({
        historicalTarget: id,
        historicalSwipeable: s.isMessageSwipeable(id, s.chat[id]),
        historicalOverswipeBehavior: s.getOverswipeBehavior(id, s.chat[id]),
        currentTarget: s.chat.length - 1,
        currentMounted: Boolean(document.querySelector(`#chat > .mes[mesid="${s.chat.length - 1}"]`)),
    })), targets.swipe);
    state.regenerate.pass = state.regenerate.historicalSwipeable || state.regenerate.currentMounted;
    state.regenerate.note = state.regenerate.historicalSwipeable
        ? 'Historical target has a native swipe/regenerate path.'
        : 'SillyTavern 1.18.0 reports the detached historical target as not swipeable; current regenerate target remains in the hot mounted window.';

    state.final = await page.evaluate(() => ({ stats: EchoPerformance.stats(), live: document.querySelectorAll('#chat > .mes').length }));
    state.final.duplicates = await duplicateMesIds();
    state.observerErrors = errors.filter(error => /MutationObserver|parameter 1 is not of type 'Node'|Failed to execute 'observe'/i.test(`${error.message}\n${error.stack}`));
    state.observerClassification = state.observerErrors.length ? 'REPRODUCED' : 'NOT_REPRODUCED';

    state.gates = {
        coreStillHealthy: state.initial.stats.liveMessageShells <= 180 && state.initial.stats.detachedMessageShells >= 800,
        edit: state.cases.edit?.pass === true,
        reasoning: state.cases.reasoning?.pass === true,
        swipe: state.cases.swipe?.pass === true,
        chatJump: state.cases.chatJump?.pass === true,
        scrollToMessage: state.cases.scrollToMessage?.pass === true,
        reconciliation: state.cases.reconciliation?.pass === true,
        wheelRestore: state.cases.wheelRestore?.pass === true,
        regenerateInvariant: state.regenerate.pass === true,
        duplicateMesIdZero: state.final.duplicates.length === 0,
    };
    state.verdict = Object.values(state.gates).every(Boolean) ? 'PASS' : 'FAIL';
    await save();
    console.log(JSON.stringify({ verdict: state.verdict, gates: state.gates, observerClassification: state.observerClassification, observerErrors: state.observerErrors, cases: Object.fromEntries(Object.entries(state.cases).map(([name, value]) => [name, { pass: value?.pass, harnessError: value?.harnessError ?? null, release: value?.release ? { recompacted: value.release.recompacted, afterLive: value.release.afterLeave?.live, traceTail: value.release.trace?.slice(-8) } : null }])) }, null, 2));
    if (state.verdict !== 'PASS') process.exitCode = 2;
} catch (error) {
    state.fatalHarnessError = String(error?.stack || error);
    await save();
    console.error(state.fatalHarnessError);
    process.exitCode = 3;
} finally {
    await browser.close();
}
