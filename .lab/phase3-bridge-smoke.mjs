import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-bridge-smoke'));
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

const sleep = ms => page.waitForTimeout(ms);
const target = 809;

const ready = async () => {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance);
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    });
};

const openFixture = async () => page.evaluate(async () => {
    const s = await import('/script.js');
    const id = s.characters.findIndex(c => c.name === 'Echo Bench');
    if (id < 0) throw new Error('Echo Bench fixture missing');
    await s.selectCharacterById(id);
    EchoPerformance.setEnabled(false, false);
    await s.openCharacterChat('echo-bench-1000');
    EchoPerformance.setEnabled(false, false);
});

const duplicateIds = () => page.evaluate(() => {
    const ids = [...document.querySelectorAll('#chat > .mes')].map(x => x.getAttribute('mesid'));
    const seen = new Set();
    return [...new Set(ids.filter(id => seen.has(id) || !seen.add(id)))];
});

const live = id => page.evaluate(id => document.querySelector(`#chat > .mes[mesid="${id}"]`) instanceof HTMLElement, id);

const scrollBottomAndRecompact = async id => {
    await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        chat.scrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight - 2);
        chat.dispatchEvent(new Event('scroll'));
        requestAnimationFrame(() => {
            chat.scrollTop = chat.scrollHeight;
            chat.dispatchEvent(new Event('scroll'));
        });
    });
    await sleep(3100);
    await page.waitForFunction(id => !document.querySelector(`#chat > .mes[mesid="${id}"]`), id, { timeout: 15000 });
};

const viewportEvidence = id => page.evaluate(id => {
    const root = document.querySelector('#chat');
    const matches = [...root.querySelectorAll(`:scope > .mes[mesid="${id}"]`)];
    const node = matches[0];
    const rr = root.getBoundingClientRect();
    const nr = node?.getBoundingClientRect?.();
    return {
        unique: matches.length === 1,
        count: matches.length,
        visible: Boolean(nr && nr.bottom > rr.top && nr.top < rr.bottom),
        rootTop: rr.top,
        rootBottom: rr.bottom,
        nodeTop: nr?.top ?? null,
        nodeBottom: nr?.bottom ?? null,
        scrollTop: root.scrollTop,
        scrollHeight: root.scrollHeight,
    };
}, id);

const result = {};
try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/');
    await ready();
    await openFixture();

    result.nativeEligibility = await page.evaluate(id => {
        const s = window.__echoScriptPromise ??= import('/script.js');
        return s.then(mod => ({
            messageExists: Boolean(mod.chat[id]),
            isMessageSwipeable: mod.isMessageSwipeable(id, mod.chat[id]),
            overswipeBehavior: mod.getOverswipeBehavior(id, mod.chat[id]),
            isLast: id === mod.chat.length - 1,
            lastMessageId: mod.chat.length - 1,
        }));
    }, target);

    await page.evaluate(id => {
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        if (!(shell instanceof HTMLElement)) throw new Error('cold target missing before compact');
        window.echoBridgeRefs = {
            shell,
            edit: shell.querySelector('.mes_edit'),
            reasoning: shell.querySelector('.mes_reasoning_header') || shell.querySelector('.mes_reasoning_header_title'),
            swipeRight: shell.querySelector('.swipe_right'),
        };
        window.echoBridgeOriginalText = SillyTavern.getContext().chat[id].mes;
    }, target);

    await page.evaluate(() => EchoPerformance.setEnabled(true, false));
    await page.waitForFunction(() => EchoPerformance.stats().detachedMessageShells >= 800 && EchoPerformance.stats().liveMessageShells <= 180, null, { timeout: 30000 });
    await scrollBottomAndRecompact(target);
    result.initial = await page.evaluate(id => ({
        targetLive: Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)),
        refsConnected: Object.fromEntries(Object.entries(window.echoBridgeRefs).map(([k,v]) => [k, Boolean(v?.isConnected)])),
        stats: EchoPerformance.stats(),
    }), target);

    // Cold edit: invoke the original edit control while its message shell is detached.
    result.coldEdit = await page.evaluate(async id => {
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        const ref = window.echoBridgeRefs.edit;
        ref?.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        const textarea = shell?.querySelector('.edit_textarea');
        const opened = textarea instanceof HTMLTextAreaElement;
        let saved = false;
        let dataCorrect = false;
        let domCorrect = false;
        if (opened) {
            const marker = ' [ECHO-BRIDGE-EDIT]';
            textarea.value = `${window.echoBridgeOriginalText}${marker}`;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            shell.querySelector('.mes_edit_done')?.click();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const c = SillyTavern.getContext();
            dataCorrect = c.chat[id]?.mes?.endsWith(marker) === true;
            domCorrect = shell.querySelector('.mes_text')?.textContent?.includes('ECHO-BRIDGE-EDIT') === true;
            saved = dataCorrect && domCorrect;
        }
        return { beforeLive, mountedAfter: shell instanceof HTMLElement, opened, saved, dataCorrect, domCorrect, bridge: EchoPerformance.stats().bridge };
    }, target);
    result.coldEdit.duplicates = await duplicateIds();

    // Restore fixture text through the native editor while mounted so later tests start clean.
    await page.evaluate(async id => {
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        shell?.querySelector('.mes_edit')?.click();
        await new Promise(r => requestAnimationFrame(r));
        const textarea = shell?.querySelector('.edit_textarea');
        if (textarea instanceof HTMLTextAreaElement) {
            textarea.value = window.echoBridgeOriginalText;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            shell.querySelector('.mes_edit_done')?.click();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        }
    }, target);

    await scrollBottomAndRecompact(target);

    // Cold reasoning: detached original header must mount then continue the browser/native details behavior.
    result.coldReasoning = await page.evaluate(async id => {
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        const ref = window.echoBridgeRefs.reasoning;
        ref?.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        const details = shell?.querySelector('.mes_reasoning_details') || ref?.closest?.('details');
        return {
            beforeLive,
            mountedAfter: shell instanceof HTMLElement,
            open: details instanceof HTMLDetailsElement ? details.open : null,
            contentLength: shell?.querySelector('.mes_reasoning')?.textContent?.length ?? 0,
            bridge: EchoPerformance.stats().bridge,
        };
    }, target);
    result.coldReasoning.duplicates = await duplicateIds();

    await scrollBottomAndRecompact(target);

    // Cold swipe through SillyTavern's public native context API, with no manual ensure call.
    result.coldSwipe = await page.evaluate(async id => {
        const c = SillyTavern.getContext();
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        const message = c.chat[id];
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        const before = Number(message.swipe_id ?? 0);
        const desired = before === 0 ? 1 : 0;
        const direction = desired > before ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        let thrown = null;
        try {
            await c.swipe.to(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, repeated: false, forceMesId: id, forceSwipeId: desired, forceDuration: 0 });
        } catch (error) { thrown = String(error?.stack || error); }
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        const expected = c.chat[id]?.mes ?? '';
        return {
            beforeLive,
            mountedAfter: shell instanceof HTMLElement,
            before,
            desired,
            after: c.chat[id]?.swipe_id,
            stateChanged: c.chat[id]?.swipe_id === desired,
            domMatchesState: shell instanceof HTMLElement && shell.querySelector('.mes_text')?.textContent?.includes(expected.slice(0, 40)),
            thrown,
            bridge: EchoPerformance.stats().bridge,
        };
    }, target);
    result.coldSwipe.duplicates = await duplicateIds();

    await scrollBottomAndRecompact(target);

    // User-facing /chat-jump parser path, not the extension context helper.
    result.chatJump = await page.evaluate(async id => {
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        const input = document.querySelector('#send_textarea');
        input.value = `/chat-jump ${id}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const { executeSlashCommandsOnChatInput } = await import('/scripts/slash-commands.js');
        await executeSlashCommandsOnChatInput();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { beforeLive, bridge: EchoPerformance.stats().bridge };
    }, target);
    result.chatJump.viewport = await viewportEvidence(target);
    result.chatJump.duplicates = await duplicateIds();

    await scrollBottomAndRecompact(target);

    // Alias exercises the same registered native command object as scroll-to-message.
    result.scrollToMessage = await page.evaluate(async id => {
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        const input = document.querySelector('#send_textarea');
        input.value = `/chat-scrollto ${id}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const { executeSlashCommandsOnChatInput } = await import('/scripts/slash-commands.js');
        await executeSlashCommandsOnChatInput();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { beforeLive, bridge: EchoPerformance.stats().bridge };
    }, target);
    result.scrollToMessage.viewport = await viewportEvidence(target);
    result.scrollToMessage.duplicates = await duplicateIds();

    await scrollBottomAndRecompact(target);

    // Existing MORE_MESSAGES_LOADED reconciliation must remain duplicate-free.
    result.moreMessages = await page.evaluate(async () => {
        const s = await import('/script.js');
        const before = EchoPerformance.stats();
        await s.showMoreMessages(50);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const after = EchoPerformance.stats();
        return { before, after };
    });
    result.moreMessages.duplicates = await duplicateIds();

    // Real wheel path after several cold restores, recording anchoring samples.
    await page.evaluate(() => { const root = document.querySelector('#chat'); root.scrollTop = root.scrollHeight; });
    const box = await page.locator('#chat').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.evaluate(() => {
        window.echoBridgeFrames = [];
        window.echoBridgeFrameActive = true;
        let last = performance.now();
        const tick = now => { if (!window.echoBridgeFrameActive) return; window.echoBridgeFrames.push(now - last); last = now; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
    for (let i = 0; i < 50; i++) { await page.mouse.wheel(0, -900); await sleep(24); }
    for (let i = 0; i < 50; i++) { await page.mouse.wheel(0, 900); await sleep(24); }
    await sleep(400);
    result.scroll = await page.evaluate(() => {
        window.echoBridgeFrameActive = false;
        const frames = [...window.echoBridgeFrames].sort((a,b)=>a-b);
        const samples = EchoPerformance.stats().restoreSamples || [];
        return {
            p95Ms: frames.length ? frames[Math.floor((frames.length - 1) * .95)] : null,
            droppedOver33: frames.filter(x => x > 33.4).length,
            restoreCount: samples.length,
            restoreP95Ms: samples.length ? [...samples].sort((a,b)=>a.durationMs-b.durationMs)[Math.floor((samples.length - 1)*.95)].durationMs : null,
            driftMaxPx: samples.length ? Math.max(...samples.map(x => Math.abs(x.driftPx || 0))) : null,
            samples,
        };
    });

    result.coldRegenerate = await page.evaluate(id => {
        const sPromise = window.__echoScriptPromise ??= import('/script.js');
        return sPromise.then(s => ({
            eligibleViaNormalNativeUi: s.isMessageSwipeable(id, s.chat[id]),
            overswipeBehavior: s.getOverswipeBehavior(id, s.chat[id]),
            targetIsColdCandidate: id < s.chat.length - 100,
            currentRegenerateTarget: s.chat.length - 1,
            currentRegenerateMounted: Boolean(document.querySelector(`#chat > .mes[mesid="${s.chat.length - 1}"]`)),
            note: 'Historical cold regenerate is only executed when SillyTavern marks that message swipeable; otherwise current regenerate remains in the always-live hot window.',
        }));
    }, target);

    result.final = await page.evaluate(() => ({ stats: EchoPerformance.stats(), liveMes: document.querySelectorAll('#chat > .mes').length }));
    result.final.duplicates = await duplicateIds();

    const observerErrors = pageErrors.filter(e => /MutationObserver|observe\(\).*Node|parameter 1 is not of type 'Node'/i.test(`${e.message}\n${e.stack}`));
    const gates = {
        compactCore: result.initial.stats.liveMessageShells <= 180 && result.initial.stats.detachedMessageShells >= 800,
        coldEdit: result.coldEdit.beforeLive === false && result.coldEdit.mountedAfter && result.coldEdit.opened && result.coldEdit.saved && result.coldEdit.duplicates.length === 0,
        coldReasoning: result.coldReasoning.beforeLive === false && result.coldReasoning.mountedAfter && result.coldReasoning.open === true && result.coldReasoning.contentLength > 0 && result.coldReasoning.duplicates.length === 0,
        coldSwipe: result.coldSwipe.beforeLive === false && result.coldSwipe.mountedAfter && result.coldSwipe.stateChanged && result.coldSwipe.domMatchesState && !result.coldSwipe.thrown && result.coldSwipe.duplicates.length === 0,
        chatJump: result.chatJump.beforeLive === false && result.chatJump.viewport.unique && result.chatJump.viewport.visible && result.chatJump.duplicates.length === 0 && result.chatJump.bridge.commandBridgeInvocations > 0,
        scrollToMessage: result.scrollToMessage.beforeLive === false && result.scrollToMessage.viewport.unique && result.scrollToMessage.viewport.visible && result.scrollToMessage.duplicates.length === 0,
        reconciliation: result.moreMessages.duplicates.length === 0 && result.moreMessages.after.nativeReconciliations >= result.moreMessages.before.nativeReconciliations,
        scroll: (result.scroll.p95Ms ?? Infinity) < 50 && (result.scroll.driftMaxPx ?? Infinity) <= 8,
        observer: observerErrors.length === 0,
        regenerateInvariant: result.coldRegenerate.eligibleViaNormalNativeUi || result.coldRegenerate.currentRegenerateMounted,
    };
    const verdict = Object.values(gates).every(Boolean) ? 'PASS' : 'FAIL';
    await fs.writeFile(path.join(out, 'bridge-smoke.json'), JSON.stringify({ verdict, gates, target, result, pageErrors, observerErrors }, null, 2));
    console.log(JSON.stringify({ verdict, gates, observerErrors: observerErrors.length, pageErrors: pageErrors.length, bridge: result.final.stats.bridge }, null, 2));
    if (verdict !== 'PASS') process.exitCode = 2;
} finally {
    await browser.close();
}
