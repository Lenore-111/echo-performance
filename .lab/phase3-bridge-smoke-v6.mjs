import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-bridge-smoke-v6'));
await fs.mkdir(out, { recursive: true });
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const browser = await chromium.launch({
    executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--enable-precise-memory-info', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);

const pageErrors = [];
page.on('pageerror', error => pageErrors.push({ message: String(error), stack: String(error?.stack || error) }));

await page.addInitScript(() => {
    window.__echoP3Scenario = 'boot';
    window.__echoP3ObserverFailures = [];
    const originalObserve = MutationObserver.prototype.observe;
    MutationObserver.prototype.observe = function (target, options) {
        try {
            return Reflect.apply(originalObserve, this, [target, options]);
        } catch (error) {
            let targetEvidence;
            if (target instanceof Node) {
                targetEvidence = {
                    nodeType: target.nodeType,
                    nodeName: target.nodeName,
                    id: target instanceof Element ? target.id || null : null,
                    className: target instanceof Element && typeof target.className === 'string' ? target.className : null,
                    connected: target.isConnected ?? null,
                };
            } else {
                targetEvidence = { type: typeof target, value: String(target) };
            }
            window.__echoP3ObserverFailures.push({
                scenario: window.__echoP3Scenario || 'unknown',
                target: targetEvidence,
                message: String(error),
                stack: String(error?.stack || error),
            });
            throw error;
        }
    };
});

const targets = {
    edit: 809,
    reasoning: 759,
    swipe: 709,
    jump: 659,
};
const state = { targets, cases: {} };
const save = () => fs.writeFile(path.join(out, 'bridge-smoke-v6.json'), JSON.stringify({ state, pageErrors }, null, 2));
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

const bridgeEvidence = id => page.evaluate(id => {
    const bridge = globalThis.SillyTavern?.[Symbol.for('echo.performance.native-cold-bridge')];
    return {
        trace: bridge?.trace?.(id) ?? [],
        temporaryMounts: bridge?.temporaryMounts?.() ?? bridge?.stats?.()?.temporaryMounts ?? [],
        stats: bridge?.stats?.() ?? null,
    };
}, id);

const diagnosticFor = id => page.evaluate(id => {
    const root = document.querySelector('#chat');
    const node = root?.querySelector(`:scope > .mes[mesid="${id}"]`);
    const active = document.activeElement;
    const bridge = globalThis.SillyTavern?.[Symbol.for('echo.performance.native-cold-bridge')];
    return {
        live: node instanceof HTMLElement,
        activeElement: active instanceof Element ? {
            tag: active.tagName,
            id: active.id || null,
            className: typeof active.className === 'string' ? active.className : null,
        } : null,
        activeInsideTarget: Boolean(node instanceof HTMLElement && active instanceof Element && node.contains(active)),
        scrollTop: root?.scrollTop ?? null,
        scrollHeight: root?.scrollHeight ?? null,
        echo: EchoPerformance.stats(),
        bridge: bridge?.stats?.() ?? null,
    };
}, id);

function traceGate(trace) {
    const events = trace.map(entry => entry.event);
    const detachedResult = trace.some(entry => entry.event === 'compact-result' && entry.extra?.result === 'detached');
    const releaseAtZero = trace.some(entry => entry.event === 'release-requested' && entry.extra?.activeOperations === 0);
    return {
        events,
        operationStarted: events.includes('operation-started'),
        mountRequested: events.includes('mount-requested'),
        mountFinished: events.includes('mount-finished'),
        operationFinished: events.includes('operation-finished'),
        releaseRequested: events.includes('release-requested'),
        releaseAtZero,
        eligibleForCompact: events.includes('eligible-for-compact'),
        compactAttempted: events.includes('compact-attempted'),
        detachedResult,
        pass: events.includes('operation-started')
            && events.includes('mount-requested')
            && events.includes('mount-finished')
            && events.includes('operation-finished')
            && events.includes('release-requested')
            && releaseAtZero
            && events.includes('eligible-for-compact')
            && events.includes('compact-attempted')
            && detachedResult,
    };
}

async function leaveTargetAndObserve(id) {
    const beforeLeave = await diagnosticFor(id);
    await page.evaluate(() => {
        document.querySelector('#send_textarea')?.focus({ preventScroll: true });
        const chat = document.querySelector('#chat');
        chat?.scrollTo({ top: chat.scrollHeight, behavior: 'auto' });
        chat?.dispatchEvent(new Event('scroll'));
    });

    let detached = false;
    try {
        await page.waitForFunction(id => !document.querySelector(`#chat > .mes[mesid="${id}"]`), id, { timeout: 7000 });
        detached = true;
    } catch {}

    const afterLeave = await diagnosticFor(id);
    const bridge = await bridgeEvidence(id);
    return {
        detached,
        beforeLeave,
        afterLeave,
        trace: bridge.trace,
        traceGate: traceGate(bridge.trace),
        registryAfter: bridge.temporaryMounts,
        detachedState: !afterLeave.live,
    };
}

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
            if (stableFrames >= 5) return { stable: true, history: history.slice(-24) };
        }
        return { stable: false, history: history.slice(-24) };
    }, maxMs);
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
    const viewport = await page.evaluate(id => {
        const root = document.querySelector('#chat');
        const matches = [...root.querySelectorAll(`:scope > .mes[mesid="${id}"]`)];
        const node = matches[0];
        const rr = root.getBoundingClientRect();
        const nr = node?.getBoundingClientRect?.();
        return {
            count: matches.length,
            unique: matches.length === 1,
            visible: Boolean(nr && nr.bottom > rr.top && nr.top < rr.bottom),
            scrollTop: root.scrollTop,
        };
    }, id);
    return { scrollSettled, viewport, bridge: await page.evaluate(() => EchoPerformance.stats().bridge) };
}

async function collectCase(name, fn) {
    await page.evaluate(name => { window.__echoP3Scenario = name; }, name).catch(() => {});
    try {
        state.cases[name] = await fn();
    } catch (error) {
        state.cases[name] = { pass: false, error: String(error?.stack || error), trace: [], evidence: null };
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

    await page.evaluate(() => EchoPerformance.setEnabled(true, false));
    await page.waitForFunction(() => EchoPerformance.stats().detachedMessageShells >= 800 && EchoPerformance.stats().liveMessageShells <= 180, null, { timeout: 30000 });
    state.initial = await page.evaluate(targets => ({
        stats: EchoPerformance.stats(),
        live: Object.fromEntries(Object.entries(targets).map(([name, id]) => [name, Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`))])),
    }), targets);

    await collectCase('cold-edit', async () => {
        const id = targets.edit;
        const result = await page.evaluate(async id => {
            const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
            const marker = ` [P3B-V6-${Date.now()}]`;
            window.p3refs.edit.edit?.click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
            const textarea = shell?.querySelector('.edit_textarea');
            let saved = false;
            if (textarea instanceof HTMLTextAreaElement) {
                textarea.value += marker;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                shell.querySelector('.mes_edit_done')?.click();
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                saved = SillyTavern.getContext().chat[id]?.mes?.includes(marker) === true
                    && shell.querySelector('.mes_text')?.textContent?.includes(marker) === true;
            }
            return {
                beforeLive,
                mountedDuring: shell instanceof HTMLElement,
                editorOpened: textarea instanceof HTMLTextAreaElement,
                saved,
            };
        }, id);
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        return {
            ...result,
            duplicates,
            trace: release.trace,
            error: null,
            evidence: release,
            pass: !result.beforeLive && result.mountedDuring && result.editorOpened && result.saved
                && duplicates.length === 0 && release.detached && release.detachedState && release.traceGate.pass,
        };
    });

    await collectCase('cold-reasoning', async () => {
        const id = targets.reasoning;
        const result = await page.evaluate(async id => {
            const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
            window.p3refs.reasoning.reasoning?.click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
            const details = shell?.querySelector('details');
            const opened = details instanceof HTMLDetailsElement ? details.open : null;
            const contentLength = shell?.querySelector('.mes_reasoning')?.textContent?.length ?? 0;
            shell?.querySelector('.mes_reasoning_header, .mes_reasoning_header_title')?.click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const closed = details instanceof HTMLDetailsElement ? details.open === false : false;
            return { beforeLive, mountedDuring: shell instanceof HTMLElement, opened, closed, contentLength };
        }, id);
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        return {
            ...result,
            duplicates,
            trace: release.trace,
            error: null,
            evidence: release,
            pass: !result.beforeLive && result.mountedDuring && result.opened === true && result.closed === true
                && result.contentLength > 0 && duplicates.length === 0 && release.detached && release.detachedState && release.traceGate.pass,
        };
    });

    await collectCase('cold-swipe', async () => {
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
            const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
            return {
                beforeLive,
                mountedAtCompletion: shell instanceof HTMLElement,
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
        result.domMatches = norm(result.domText).includes(norm(result.chatText).slice(0, 80))
            || norm(result.domText).includes(norm(result.swipeText).slice(0, 80));
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        return {
            ...result,
            duplicates,
            trace: release.trace,
            error: result.thrown,
            evidence: release,
            pass: !result.beforeLive && result.mountedAtCompletion && result.stateChanged && result.domMatches && !result.thrown
                && duplicates.length === 0 && release.detached && release.detachedState && release.traceGate.pass,
        };
    });

    await collectCase('cold-jump', async () => {
        const id = targets.jump;
        const beforeLive = await page.evaluate(id => Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)), id);
        const command = await nativeSlash(`/chat-jump ${id}`, id);
        const duplicates = await duplicateMesIds();
        const release = await leaveTargetAndObserve(id);
        return {
            beforeLive,
            command,
            duplicates,
            trace: release.trace,
            error: null,
            evidence: release,
            pass: !beforeLive && command.viewport.unique && command.viewport.visible && command.scrollSettled.stable
                && command.bridge.inputPreMounts > 0 && command.bridge.commandBridgeInvocations > 0
                && duplicates.length === 0 && release.detached && release.detachedState && release.traceGate.pass,
        };
    });

    state.final = await page.evaluate(() => ({
        stats: EchoPerformance.stats(),
        live: document.querySelectorAll('#chat > .mes').length,
        observerFailures: window.__echoP3ObserverFailures ?? [],
    }));
    state.final.duplicates = await duplicateMesIds();
    state.observerErrors = pageErrors.filter(error => /MutationObserver|parameter 1 is not of type 'Node'|Failed to execute 'observe'/i.test(`${error.message}\n${error.stack}`));
    state.observerClassification = (state.final.observerFailures.length || state.observerErrors.length) ? 'REPRODUCED' : 'NOT_REPRODUCED';

    state.gates = {
        phase3ACoreHealthy: state.initial.stats.liveMessageShells <= 180 && state.initial.stats.detachedMessageShells >= 800,
        coldEdit: state.cases['cold-edit']?.pass === true,
        coldSwipe: state.cases['cold-swipe']?.pass === true,
        coldReasoning: state.cases['cold-reasoning']?.pass === true,
        coldJump: state.cases['cold-jump']?.pass === true,
        duplicateMesIdZero: state.final.duplicates.length === 0,
    };
    state.phase3A = state.gates.phase3ACoreHealthy ? 'PASS' : 'FAIL';
    state.phase3B = [state.gates.coldEdit, state.gates.coldSwipe, state.gates.coldReasoning, state.gates.coldJump, state.gates.duplicateMesIdZero].every(Boolean) ? 'PASS' : 'FAIL';
    state.phase3Overall = state.phase3A === 'PASS' && state.phase3B === 'PASS' ? 'PASS' : 'FAIL';
    await save();

    const summary = Object.fromEntries(Object.entries(state.cases).map(([name, value]) => [name, {
        result: value?.pass ? 'PASS' : 'FAIL',
        error: value?.error ?? value?.harnessError ?? null,
        trace: value?.trace ?? [],
        evidence: value?.evidence ?? null,
    }]));
    console.log(JSON.stringify({
        phase3A: state.phase3A,
        phase3B: state.phase3B,
        phase3Overall: state.phase3Overall,
        observerClassification: state.observerClassification,
        observerFailures: state.final.observerFailures,
        observerErrors: state.observerErrors,
        duplicateMesIds: state.final.duplicates,
        cases: summary,
    }, null, 2));
    if (state.phase3Overall !== 'PASS') process.exitCode = 2;
} catch (error) {
    state.fatalHarnessError = String(error?.stack || error);
    await save();
    console.error(state.fatalHarnessError);
    process.exitCode = 3;
} finally {
    await browser.close();
}
