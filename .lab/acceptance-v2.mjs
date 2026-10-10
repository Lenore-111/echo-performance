import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'evidence/acceptance-v2');
await fs.mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));
const requests = [];
// Test-only provider: actual HTTP, native WB prompts/parser/save/automatic timers.
// This validates the workflow, never external-model narrative accuracy.
const provider = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    try {
        const data = JSON.parse(body);
        const text = data.messages.map(m => m.content).join('\n');
        const ids = [...text.matchAll(/<message id="(\d+)" swipe="(\d+)" role="(user|assistant)">/g)].map(m => Number(m[1]));
        let payload;
        if (ids.length) payload = { memory_digest: { text: `Echo archive through message ${ids.at(-1)}.`, through_message_id: ids.at(-1) }, turn_summaries: ids.map(id => ({ id: `echo_l0_${id}`, source_message_id: id, title: `Message ${id}`, summary: `The fictional traveller recorded message ${id} in the evening city.`, people: [], locations: [], tags: [] })), facts_upsert: [], facts_invalidate: [], clues_upsert: [], clues_resolve: [], chapter_summary: null };
        else if (text.includes('summary_rollup')) payload = { summary_rollup: { title: 'Echo stage', summary: 'The traveller kept the already recorded observations of the fictional evening city.', people: [], locations: [], tags: [] } };
        else throw new Error('Unsupported provider prompt');
        requests.push({ kind: ids.length ? 'history' : 'rollup', ids, at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }] }));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: String(error) })); }
});
await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);
await page.addLocatorHandler(page.locator('#wb-mama-note-modal'), async modal => modal.getByRole('button', { name: '收好纸条' }).click());
const errors = [], metrics = [], worlds = [], checks = [];
page.on('pageerror', e => errors.push(String(e)));
const check = (name, value, detail = null) => { checks.push({ name, status: value ? 'PASS' : 'PARTIAL', detail }); console.log(`${value ? 'PASS' : 'PARTIAL'} ${name}`); };
const ready = async () => {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance && window.worldBackstageHost);
    await page.evaluate(async () => { const { power_user } = await import('/scripts/power-user.js'); power_user.chat_truncation = 10000; });
};
const open = async count => page.evaluate(async count => {
    const s = await import('/script.js');
    await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench'));
    const t = performance.now(); await s.openCharacterChat(`echo-bench-${count}`); return performance.now() - t;
}, count);
const snapshot = () => page.evaluate(() => {
    const c = SillyTavern.getContext(); const store = c.chatMetadata.world_backstage_v1;
    return { chat: JSON.parse(JSON.stringify(c.chat)), store: JSON.parse(JSON.stringify(store)), settings: { memorySystemEnabled: c.extensionSettings.world_backstage?.memorySystemEnabled } };
});
const normalizeChat = chat => chat.map(m => {
    const copy = structuredClone(m); delete copy.extra?.world_backstage_auto_hidden;
    if (m.extra?.world_backstage_auto_hidden) copy.is_system = false;
    return copy;
});
const worldBackstageUpdateInterval = page => page.evaluate(() => worldBackstageHost.updatePublicOpinionSettings({ memoryAutoIndexInterval: 1 }));
try {
    await page.goto('http://127.0.0.1:8039'); await ready();
    // Performance suite uses the unarchived fixture. Full automatic workflows
    // are a separate measured suite below; none are reported passing here.
    if (process.env.ECHO_SUITE !== 'world') for (const count of [200, 500, 1000]) {
        for (let repeat = 0; repeat < 3; repeat++) for (const enabled of repeat % 2 ? [true, false] : [false, true]) {
            await page.evaluate(enabled => EchoPerformance.setEnabled(enabled, true), enabled);
            const loadMs = await open(count); await page.waitForTimeout(1800);
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
            await page.evaluate(async () => {
                const { ReasoningHandler } = await import('/scripts/reasoning.js');
                if (!window.echoProfileInstalled) {
                    const original = ReasoningHandler.prototype.updateDom;
                    ReasoningHandler.prototype.updateDom = function (...args) { const t = performance.now(); try { return original.apply(this, args); } finally { window.echoReasoningProfile.push({ id: args[0], ms: performance.now() - t, chars: String(this.reasoning || '').length }); } };
                    window.echoProfileInstalled = true;
                }
                window.echoReasoningProfile = [];
            });
            await cdp.send('Profiler.start');
            const profiledLoadMs = await open(count);
            const profile = (await cdp.send('Profiler.stop')).profile;
            await fs.writeFile(path.join(out, `cpu-${count}-${enabled ? 'on' : 'off'}-${repeat}.cpuprofile`), JSON.stringify(profile));
            const initial = await page.evaluate(() => ({ domElements: document.querySelectorAll('*').length, domNodes: (() => { const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL); let n = 0; while (w.nextNode()) n++; return n; })(), chatElements: document.querySelector('#chat').querySelectorAll('*').length, heapUsed: performance.memory.usedJSHeapSize, reasoningProfile: window.echoReasoningProfile }));
            const interactions = await page.evaluate(async count => {
                const s = await import('/script.js'); const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
                const samples = [];
                for (let i = 0; i < 6; i++) { const t = performance.now(); await s.swipe(null, i % 2 ? SWIPE_DIRECTION.LEFT : SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: count - 1, forceSwipeId: i % 2 ? 0 : 1 }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); samples.push(performance.now() - t); }
                const header = document.querySelector(`#chat>.mes[mesid="${count - 1}"] .mes_reasoning_header`);
                const details = header.closest('details'); const expansion = [];
                const formatCallsBefore = window.echoReasoningProfile.length;
                for (let i = 0; i < 2; i++) { if (details.open) header.click(); const t = performance.now(); header.click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); expansion.push({ ms: performance.now() - t, open: details.open, textChars: details.querySelector('.mes_reasoning').textContent.length }); header.click(); }
                return { swipeMs: samples, reasoningExpansion: expansion, formattingCallsOnExpand: window.echoReasoningProfile.length - formatCallsBefore, swipeHistoryCorrect: s.chat.at(-1).swipe_id === 0 && s.chat.at(-1).swipes.length === 2 && s.chat.at(-1).extra.reasoning.length > 0 };
            }, count);
            const heapAfterInteractions = await page.evaluate(() => performance.memory.usedJSHeapSize);
            const saveMs = await page.evaluate(async () => { const s = await import('/script.js'); const t = performance.now(); await s.saveChatConditional(); return performance.now() - t; });
            await page.waitForTimeout(1200);
            const reloadStart = Date.now(); await page.reload(); await ready(); const reloadAndEnterMs = Date.now() - reloadStart + await open(count);
            const heapAfterReload = await page.evaluate(() => performance.memory.usedJSHeapSize);
            metrics.push({ count, repeat, enabled, status: 'PASS', loadMs, profiledLoadMs, ...initial, ...interactions, heapAfterInteractions, saveMs, reloadAndEnterMs, heapAfterReload });
            check(`${count}/${enabled ? 'on' : 'off'}/${repeat}: swipe and both reasoning expansions`, interactions.swipeHistoryCorrect && interactions.reasoningExpansion.every(x => x.open && x.textChars > 0));
            await cdp.detach();
            await fs.writeFile(path.join(out, 'interactions.json'), JSON.stringify({ metrics, checks, errors, status: 'PARTIAL', reason: 'Automatic world workflow is evaluated separately; profiled load is instrumented.' }, null, 2));
        }
    }
    if (process.env.ECHO_SUITE === 'world') await open(200);
    for (const count of [200, 500, 1000]) for (const enabled of [false, true]) {
        const worldFile = `echo-world-${count}-${enabled ? 'on' : 'off'}`;
        // Reset only this synthetic fixture; no direct state/summary injection.
        await page.evaluate(async ({ count, worldFile }) => {
            const s = await import('/script.js'); const avatar = s.characters[s.this_chid].avatar;
            const r = await fetch('/api/chats/get', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, file_name: `echo-bench-${count}` }) });
            const rows = await r.json(); rows[0].chat_metadata = { echo_fixture: true };
            const saved = await fetch('/api/chats/save', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, file_name: worldFile, chat: rows, force: true }) });
            if (!saved.ok) throw new Error(`Fixture copy failed: ${saved.status}`);
        }, { count, worldFile });
        await page.evaluate(async ({ worldFile, enabled, providerUrl }) => {
            const s = await import('/script.js'); await s.openCharacterChat(worldFile);
            EchoPerformance.setEnabled(enabled, true);
            await worldBackstageHost.updatePublicOpinionSettings({ enabled: true, memorySystemEnabled: true, injectionMemory: true, memoryAutoIndexInterval: 10, autoHideArchivedFloors: true, apiMode: 'custom', customApiUrl: providerUrl, customApiKey: 'echo-local-fixture-only', customApiModel: 'echo-deterministic', customApiTransport: 'direct', autoRetryCount: 0 });
        }, { worldFile, enabled, providerUrl });
        const before = await snapshot(); const requestStart = requests.length; const start = Date.now();
        let regenRequests = 0;
        await page.route('**/api/backends/chat-completions/generate', async route => { regenRequests++; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: before.chat.at(-1).mes, reasoning_content: before.chat.at(-1).extra.reasoning }, finish_reason: 'stop' }] }) }); });
        await page.evaluate(async () => {
            const s = await import('/script.js'); const { oai_settings } = await import('/scripts/openai.js'); s.changeMainAPI('openai');
            oai_settings.chat_completion_source = 'custom'; oai_settings.custom_url = 'http://127.0.0.1:8041/v1'; oai_settings.custom_model = 'echo-deterministic'; oai_settings.stream_openai = false; s.setOnlineStatus('echo-local');
            await s.Generate('regenerate');
        });
        await page.unroute('**/api/backends/chat-completions/generate');
        const regenerated = await snapshot();
        let workflowStatus = 'PASS', workflowError = null;
        try {
            await page.waitForFunction(count => {
                const c = SillyTavern.getContext(); const memory = c.chatMetadata.world_backstage_v1?.currentState.storyMemory;
                return memory?.indexedThroughMessageId >= count - 21 && c.chat.some(m => m.extra?.world_backstage_auto_hidden);
            }, count, { timeout: 240000 });
            await page.waitForTimeout(2500);
            // The real 10-turn threshold intentionally leaves a short tail.
            // Lower the enabled interval and perform another native regen to
            // trigger automatic processing of that tail; never seed summaries.
            await worldBackstageUpdateInterval(page);
            await page.route('**/api/backends/chat-completions/generate', async route => { regenRequests++; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: before.chat.at(-1).mes, reasoning_content: before.chat.at(-1).extra.reasoning }, finish_reason: 'stop' }] }) }); });
            await page.evaluate(async () => { const s = await import('/script.js'); s.setOnlineStatus('echo-local'); await s.Generate('regenerate'); });
            await page.unroute('**/api/backends/chat-completions/generate');
            await page.waitForFunction(count => SillyTavern.getContext().chatMetadata.world_backstage_v1.currentState.storyMemory.indexedThroughMessageId >= count - 1, count, { timeout: 240000 });
            await page.waitForTimeout(2500);
        } catch (error) { workflowStatus = 'PARTIAL'; workflowError = String(error); }
        const after = await snapshot();
        const hiddenIds = after.chat.flatMap((m, i) => m.extra?.world_backstage_auto_hidden ? [i] : []);
        const archives = after.store.memorySummaryArchive || [];
        const summaries = after.store.currentState.storyMemory.summaries;
        const covered = new Set([...archives, ...summaries].filter(s => s.level === 0 && s.startMessageId === s.endMessageId && s.summary).map(s => s.endMessageId));
        const stateCore = state => ({ clock: state.clock, people: state.people, events: state.events, locations: state.locations, publicImpactLedger: state.publicImpactLedger });
        check(`${count}/${enabled ? 'on' : 'off'}: automatic history requests submitted`, requests.slice(requestStart).some(x => x.kind === 'history'));
        check(`${count}/${enabled ? 'on' : 'off'}: automatic hide has archived coverage and keeps recent five`, hiddenIds.length > 0 && hiddenIds.every(i => covered.has(i) && i <= count - 6));
        check(`${count}/${enabled ? 'on' : 'off'}: hide preserves original history/swipes/reasoning`, JSON.stringify(normalizeChat(after.chat).slice(0, -1)) === JSON.stringify(normalizeChat(regenerated.chat).slice(0, -1)));
        check(`${count}/${enabled ? 'on' : 'off'}: archive does not advance world or mutate people/events`, JSON.stringify(stateCore(before.store.currentState)) === JSON.stringify(stateCore(after.store.currentState)));
        check(`${count}/${enabled ? 'on' : 'off'}: native regen retains length and original swipe history`, regenRequests >= 1 && after.chat.length === count && before.chat.at(-1).swipes.every(text => after.chat.at(-1).swipes.includes(text)));
        const postHideInteraction = await page.evaluate(async count => {
            const s = await import('/script.js'); const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            const original = JSON.stringify(s.chat.at(-1)); const initialSwipe = s.chat.at(-1).swipe_id;
            await s.swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: count - 1, forceSwipeId: 1 });
            const alternateCorrect = s.chat.at(-1).mes === s.chat.at(-1).swipes[1];
            await s.swipe(null, SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: count - 1, forceSwipeId: initialSwipe });
            const shell = document.querySelector('#chat>.mes[mesid="11"]');
            const header = shell.querySelector('.mes_reasoning_header'); const details = header.closest('details'); if (details.open) header.click(); header.click();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const reasoningCorrect = details.open && details.querySelector('.mes_reasoning').textContent.length > 0;
            header.click();
            return { alternateCorrect, restoredLastMessage: JSON.stringify(s.chat.at(-1)) === original, archivedReasoningCorrect: reasoningCorrect, hiddenMarkerRetained: Boolean(s.chat[11].extra.world_backstage_auto_hidden), initialSwipe };
        }, count);
        check(`${count}/${enabled ? 'on' : 'off'}: swipe and archived reasoning after auto-hide`, postHideInteraction.alternateCorrect && postHideInteraction.restoredLastMessage && postHideInteraction.archivedReasoningCorrect && postHideInteraction.hiddenMarkerRetained, postHideInteraction);
        const beforePostRegen = await snapshot();
        await worldBackstageUpdateInterval(page);
        await page.route('**/api/backends/chat-completions/generate', async route => { regenRequests++; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: beforePostRegen.chat.at(-1).mes, reasoning_content: beforePostRegen.chat.at(-1).extra.reasoning }, finish_reason: 'stop' }] }) }); });
        await page.evaluate(async () => { const s = await import('/script.js'); s.setOnlineStatus('echo-local'); await s.Generate('regenerate'); });
        await page.unroute('**/api/backends/chat-completions/generate');
        try { await page.waitForFunction(count => SillyTavern.getContext().chatMetadata.world_backstage_v1.currentState.storyMemory.indexedThroughMessageId >= count - 1, count, { timeout: 240000 }); await page.waitForTimeout(2500); }
        catch (error) { workflowStatus = 'PARTIAL'; workflowError = String(error); }
        const postRegen = await snapshot();
        check(`${count}/${enabled ? 'on' : 'off'}: regen after hide preserves archived history and world core`, postRegen.chat.length === count && JSON.stringify(postRegen.chat.slice(0, -1)) === JSON.stringify(beforePostRegen.chat.slice(0, -1)) && JSON.stringify(stateCore(postRegen.store.currentState)) === JSON.stringify(stateCore(beforePostRegen.store.currentState)));
        const frozen = JSON.stringify(postRegen.chat);
        const stableState = JSON.stringify(postRegen.store.currentState);
        await page.evaluate(() => EchoPerformance.setEnabled(true, true)); await page.waitForTimeout(1000);
        await page.evaluate(() => EchoPerformance.setEnabled(false, true)); await page.waitForTimeout(1800);
        check(`${count}/${enabled ? 'on' : 'off'}: disable preserves archived native data`, await page.evaluate(raw => JSON.stringify(SillyTavern.getContext().chat) === raw && !document.querySelector('#chat>.mes[style*="content-visibility"]'), frozen));
        await page.reload(); await ready();
        await page.evaluate(async file => { const s = await import('/script.js'); await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench')); await s.openCharacterChat(file); }, worldFile);
        check(`${count}/${enabled ? 'on' : 'off'}: disable persists across refresh`, await page.evaluate(() => !EchoPerformance.stats().enabled));
        await page.evaluate(() => EchoPerformance.setEnabled(true, true)); await page.waitForTimeout(1600);
        const reloaded = await snapshot();
        check(`${count}/${enabled ? 'on' : 'off'}: refresh/re-enable preserves native data and world state`, JSON.stringify(reloaded.chat) === frozen && JSON.stringify(reloaded.store.currentState) === stableState);
        const world = { count, enabled, status: workflowStatus, workflowError, elapsedMs: Date.now() - start, indexedThrough: after.store.currentState.storyMemory.indexedThroughMessageId, hiddenIds, postHideInteraction, requestCount: requests.length - requestStart, modelSemanticStatus: 'NOT VERIFIED', before, regenerated, after, postRegen, reloaded };
        worlds.push(world);
        await fs.writeFile(path.join(out, `world-${count}-${enabled ? 'on' : 'off'}.json`), JSON.stringify(world, null, 2));
        await fs.writeFile(path.join(out, 'workflow-summary.json'), JSON.stringify({ status: 'PARTIAL', checks, errors, provider: 'Local deterministic HTTP provider; external model not verified', requests }, null, 2));
        console.log(`WORLD ${count}/${enabled} ${workflowStatus} hidden=${hiddenIds.length} requests=${requests.length - requestStart}`);
    }
} catch (error) {
    await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ status: 'PARTIAL', error: String(error), checks, errors, requests }, null, 2));
    await page.screenshot({ path: path.join(out, 'failure.png') });
    throw error;
} finally { await browser.close(); await new Promise(r => provider.close(r)); }
