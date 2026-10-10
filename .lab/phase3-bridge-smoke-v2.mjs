import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-bridge-smoke-v2'));
await fs.mkdir(out, { recursive: true });
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-precise-memory-info','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push({ message: String(e), stack: String(e?.stack || e) }));
const target = 809;
const state = { target };
const save = async () => fs.writeFile(path.join(out, 'bridge-smoke-v2.json'), JSON.stringify({ state, pageErrors }, null, 2));

const duplicates = () => page.evaluate(() => {
    const ids = [...document.querySelectorAll('#chat > .mes')].map(x => x.getAttribute('mesid'));
    const seen = new Set(), dup = [];
    for (const id of ids) { if (seen.has(id)) dup.push(id); else seen.add(id); }
    return [...new Set(dup)];
});

const releaseAndRecompact = async id => {
    await page.evaluate(() => {
        const input = document.querySelector('#send_textarea');
        input?.focus();
        const chat = document.querySelector('#chat');
        chat.scrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight - 4);
        chat.dispatchEvent(new Event('scroll'));
        requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; chat.dispatchEvent(new Event('scroll')); });
    });
    await page.waitForTimeout(3300);
    try {
        await page.waitForFunction(id => !document.querySelector(`#chat > .mes[mesid="${id}"]`), id, { timeout: 12000 });
        return { detached: true };
    } catch (error) {
        return page.evaluate(id => ({
            detached: false,
            activeTag: document.activeElement?.tagName,
            activeId: document.activeElement?.id || null,
            activeInTarget: Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)?.contains(document.activeElement)),
            stats: EchoPerformance.stats(),
        }), id);
    }
};

const viewport = id => page.evaluate(id => {
    const root = document.querySelector('#chat');
    const nodes = [...root.querySelectorAll(`:scope > .mes[mesid="${id}"]`)];
    const node = nodes[0];
    const rr = root.getBoundingClientRect();
    const nr = node?.getBoundingClientRect?.();
    return { count: nodes.length, unique: nodes.length === 1, visible: Boolean(nr && nr.bottom > rr.top && nr.top < rr.bottom), scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, rootTop: rr.top, rootBottom: rr.bottom, nodeTop: nr?.top ?? null, nodeBottom: nr?.bottom ?? null };
}, id);

try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/');
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance);
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
        for (const d of document.querySelectorAll('dialog[open]')) d.close();
        const s = await import('/script.js');
        const id = s.characters.findIndex(c => c.name === 'Echo Bench');
        if (id < 0) throw new Error('Echo Bench missing');
        await s.selectCharacterById(id);
        EchoPerformance.setEnabled(false, false);
        await s.openCharacterChat('echo-bench-1000');
        EchoPerformance.setEnabled(false, false);
    });

    state.eligibility = await page.evaluate(id => import('/script.js').then(s => ({
        isMessageSwipeable: s.isMessageSwipeable(id, s.chat[id]),
        overswipeBehavior: s.getOverswipeBehavior(id, s.chat[id]),
        isLast: id === s.chat.length - 1,
        lastId: s.chat.length - 1,
    })), target);

    await page.evaluate(id => {
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        if (!(shell instanceof HTMLElement)) throw new Error('target missing before compact');
        window.echoP3BRefs = { shell, edit: shell.querySelector('.mes_edit'), reasoning: shell.querySelector('.mes_reasoning_header') || shell.querySelector('.mes_reasoning_header_title') };
    }, target);

    await page.evaluate(() => EchoPerformance.setEnabled(true, false));
    await page.waitForFunction(() => EchoPerformance.stats().detachedMessageShells >= 800 && EchoPerformance.stats().liveMessageShells <= 180, null, { timeout: 30000 });
    state.initial = await page.evaluate(id => ({ live: Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`)), stats: EchoPerformance.stats(), refsConnected: Object.fromEntries(Object.entries(window.echoP3BRefs).map(([k,v])=>[k,Boolean(v?.isConnected)])) }), target);
    await save();

    state.coldEdit = await page.evaluate(async id => {
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        window.echoP3BRefs.edit?.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        const ta = shell?.querySelector('.edit_textarea');
        let saved = false;
        if (ta instanceof HTMLTextAreaElement) {
            ta.value += ' [ECHO-P3B-EDIT]';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            shell.querySelector('.mes_edit_done')?.click();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            saved = SillyTavern.getContext().chat[id]?.mes?.includes('ECHO-P3B-EDIT') === true && shell.querySelector('.mes_text')?.textContent?.includes('ECHO-P3B-EDIT') === true;
        }
        return { beforeLive, mountedAfter: shell instanceof HTMLElement, editorOpened: ta instanceof HTMLTextAreaElement, saved, bridge: EchoPerformance.stats().bridge };
    }, target);
    state.coldEdit.duplicates = await duplicates();
    state.afterEditRecompact = await releaseAndRecompact(target);
    await save();

    state.coldReasoning = await page.evaluate(async id => {
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        window.echoP3BRefs.reasoning?.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        const details = shell?.querySelector('details');
        return { beforeLive, mountedAfter: shell instanceof HTMLElement, open: details instanceof HTMLDetailsElement ? details.open : null, contentLength: shell?.querySelector('.mes_reasoning')?.textContent?.length ?? 0, bridge: EchoPerformance.stats().bridge };
    }, target);
    state.coldReasoning.duplicates = await duplicates();
    state.afterReasoningRecompact = await releaseAndRecompact(target);
    await save();

    state.coldSwipe = await page.evaluate(async id => {
        const c = SillyTavern.getContext();
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        const before = Number(c.chat[id].swipe_id ?? 0);
        const desired = before === 0 ? 1 : 0;
        const direction = desired > before ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        let thrown = null;
        try { await c.swipe.to(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, repeated: false, forceMesId: id, forceSwipeId: desired, forceDuration: 0 }); }
        catch (e) { thrown = String(e?.stack || e); }
        const shell = document.querySelector(`#chat > .mes[mesid="${id}"]`);
        return { beforeLive, mountedAfter: shell instanceof HTMLElement, before, desired, after: c.chat[id]?.swipe_id, stateChanged: c.chat[id]?.swipe_id === desired, domMatches: shell instanceof HTMLElement && shell.querySelector('.mes_text')?.textContent?.includes((c.chat[id]?.mes || '').slice(0,40)), thrown, bridge: EchoPerformance.stats().bridge };
    }, target);
    state.coldSwipe.duplicates = await duplicates();
    state.afterSwipeRecompact = await releaseAndRecompact(target);
    await save();

    state.chatJump = await page.evaluate(async id => {
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        const input = document.querySelector('#send_textarea');
        input.value = `/chat-jump ${id}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const { executeSlashCommandsOnChatInput } = await import('/scripts/slash-commands.js');
        await executeSlashCommandsOnChatInput();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { beforeLive, bridge: EchoPerformance.stats().bridge };
    }, target);
    state.chatJump.viewport = await viewport(target);
    state.chatJump.duplicates = await duplicates();
    state.afterJumpRecompact = await releaseAndRecompact(target);
    await save();

    state.scrollTo = await page.evaluate(async id => {
        const beforeLive = Boolean(document.querySelector(`#chat > .mes[mesid="${id}"]`));
        const input = document.querySelector('#send_textarea');
        input.value = `/chat-scrollto ${id}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const { executeSlashCommandsOnChatInput } = await import('/scripts/slash-commands.js');
        await executeSlashCommandsOnChatInput();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { beforeLive, bridge: EchoPerformance.stats().bridge };
    }, target);
    state.scrollTo.viewport = await viewport(target);
    state.scrollTo.duplicates = await duplicates();
    state.afterScrollToRecompact = await releaseAndRecompact(target);
    await save();

    state.moreMessages = await page.evaluate(async () => {
        const s = await import('/script.js');
        const before = EchoPerformance.stats();
        await s.showMoreMessages(50);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { before, after: EchoPerformance.stats() };
    });
    state.moreMessages.duplicates = await duplicates();

    await page.evaluate(() => { const c=document.querySelector('#chat'); document.querySelector('#send_textarea')?.focus(); c.scrollTop=c.scrollHeight; });
    const box = await page.locator('#chat').boundingBox();
    await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
    await page.evaluate(() => { window.p3bFrames=[]; window.p3bRun=true; let last=performance.now(); const tick=now=>{ if(!window.p3bRun)return; window.p3bFrames.push(now-last); last=now; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    for (let i=0;i<35;i++){ await page.mouse.wheel(0,-900); await page.waitForTimeout(24); }
    for (let i=0;i<35;i++){ await page.mouse.wheel(0,900); await page.waitForTimeout(24); }
    await page.waitForTimeout(400);
    state.scroll = await page.evaluate(() => {
        window.p3bRun=false;
        const frames=[...window.p3bFrames].sort((a,b)=>a-b); const samples=EchoPerformance.stats().restoreSamples||[];
        return { p95Ms:frames.length?frames[Math.floor((frames.length-1)*.95)]:null, dropped33:frames.filter(x=>x>33.4).length, restoreCount:samples.length, driftMaxPx:samples.length?Math.max(...samples.map(x=>Math.abs(x.driftPx||0))):null, restoreMaxMs:samples.length?Math.max(...samples.map(x=>x.durationMs||0)):null };
    });

    state.coldRegenerate = await page.evaluate(id => import('/script.js').then(s => ({
        eligibleViaNormalNativeUi: s.isMessageSwipeable(id, s.chat[id]),
        overswipeBehavior: s.getOverswipeBehavior(id, s.chat[id]),
        currentRegenerateTarget: s.chat.length - 1,
        currentRegenerateMounted: Boolean(document.querySelector(`#chat > .mes[mesid="${s.chat.length-1}"]`)),
        interpretation: s.isMessageSwipeable(id, s.chat[id]) ? 'eligible-cold-native-path' : 'historical target is not user-reachable for regenerate; current regenerate target remains in always-live hot window',
    })), target);
    state.final = await page.evaluate(() => ({ stats: EchoPerformance.stats(), liveMes: document.querySelectorAll('#chat > .mes').length }));
    state.final.duplicates = await duplicates();

    const observerErrors = pageErrors.filter(e => /MutationObserver|parameter 1 is not of type 'Node'|Failed to execute 'observe'/i.test(`${e.message}\n${e.stack}`));
    state.observerErrors = observerErrors;
    state.gates = {
        compactCore: state.initial.stats.liveMessageShells <= 180 && state.initial.stats.detachedMessageShells >= 800,
        edit: state.coldEdit.beforeLive === false && state.coldEdit.mountedAfter && state.coldEdit.editorOpened && state.coldEdit.saved && state.coldEdit.duplicates.length === 0 && state.afterEditRecompact.detached,
        reasoning: state.coldReasoning.beforeLive === false && state.coldReasoning.mountedAfter && state.coldReasoning.open === true && state.coldReasoning.contentLength > 0 && state.coldReasoning.duplicates.length === 0 && state.afterReasoningRecompact.detached,
        swipe: state.coldSwipe.beforeLive === false && state.coldSwipe.mountedAfter && state.coldSwipe.stateChanged && state.coldSwipe.domMatches && !state.coldSwipe.thrown && state.coldSwipe.duplicates.length === 0 && state.afterSwipeRecompact.detached,
        chatJump: state.chatJump.beforeLive === false && state.chatJump.viewport.unique && state.chatJump.viewport.visible && state.chatJump.duplicates.length === 0 && state.chatJump.bridge.commandBridgeInvocations > 0,
        scrollTo: state.scrollTo.beforeLive === false && state.scrollTo.viewport.unique && state.scrollTo.viewport.visible && state.scrollTo.duplicates.length === 0,
        reconciliation: state.moreMessages.duplicates.length === 0 && state.moreMessages.after.nativeReconciliations >= state.moreMessages.before.nativeReconciliations,
        scroll: (state.scroll.p95Ms ?? Infinity) < 50 && (state.scroll.driftMaxPx ?? Infinity) <= 8,
        observer: observerErrors.length === 0,
        regenerateInvariant: state.coldRegenerate.eligibleViaNormalNativeUi || state.coldRegenerate.currentRegenerateMounted,
        duplicates: state.final.duplicates.length === 0,
    };
    state.verdict = Object.values(state.gates).every(Boolean) ? 'PASS' : 'FAIL';
    await save();
    console.log(JSON.stringify({ verdict:state.verdict, gates:state.gates, observerErrors:observerErrors.length, bridge:state.final.stats.bridge, coldRegenerate:state.coldRegenerate }, null, 2));
    if (state.verdict !== 'PASS') process.exitCode=2;
} catch (error) {
    state.harnessError = String(error?.stack || error);
    await save();
    console.error(state.harnessError);
    process.exitCode=3;
} finally {
    await browser.close();
}
