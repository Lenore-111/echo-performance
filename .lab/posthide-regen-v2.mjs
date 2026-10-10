import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startProvider } from './provider-v2.mjs';
const root = path.resolve(import.meta.dirname, '..'), out = path.join(root, 'evidence/acceptance-v2');
const provider = await startProvider();
const { chromium } = await import(pathToFileURL(path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage(); page.setDefaultTimeout(60000);
const rows = [], errors = [];
page.on('pageerror', e => errors.push(e.stack || String(e)));
const ready = async () => {
    await page.waitForFunction(() => window.EchoPerformance && window.worldBackstageHost && window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'));
    await page.evaluate(async () => { const s = await import('/script.js'); const { power_user } = await import('/scripts/power-user.js'); power_user.chat_truncation = 10000; await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench')); });
};
const snapshot = () => page.evaluate(() => { const c = SillyTavern.getContext(); return { chat: c.chat, store: c.chatMetadata.world_backstage_v1, echo: EchoPerformance.stats() }; });
const core = store => { const s = store.currentState; return { clock: s.clock, people: s.people, events: s.events, locations: s.locations, publicImpactLedger: s.publicImpactLedger }; };
try {
    await page.goto('http://127.0.0.1:8039'); await ready();
    for (const count of [200, 500, 1000]) for (const enabled of [false, true]) {
        const file = `echo-posthide-clean-${count}-${enabled ? 'on' : 'off'}`;
        await page.evaluate(async ({ count, file, enabled, url }) => {
            const s = await import('/script.js'); const avatar = s.characters[s.this_chid].avatar;
            const r = await fetch('/api/chats/get', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, file_name: `echo-world-${count}-off` }) });
            if (!r.ok) throw new Error(`Read actual archived fixture: ${r.status}`); const data = await r.json();
            const saved = await fetch('/api/chats/save', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, file_name: file, chat: data, force: true }) });
            if (!saved.ok) throw new Error(`Copy actual archived fixture: ${saved.status}`);
            await s.openCharacterChat(file); EchoPerformance.setEnabled(enabled, true);
            await worldBackstageHost.updatePublicOpinionSettings({ enabled: true, memorySystemEnabled: true, injectionMemory: true, memoryAutoIndexInterval: 1, autoHideArchivedFloors: true, apiMode: 'custom', customApiUrl: url, customApiKey: 'echo-local-fixture-only', customApiModel: 'echo-deterministic', customApiTransport: 'direct', autoRetryCount: 0 });
        }, { count, file, enabled, url: provider.url });
        const before = await snapshot(), requestStart = provider.requests.length;
        const reply = `Verified post-hide regeneration for ${count} message fixture. This is a new reply, not the previous selected text.`;
        let foregroundRequests = 0;
        await page.route('**/api/backends/chat-completions/generate', async route => {
            foregroundRequests++;
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply, reasoning_content: 'A deterministic post-hide reasoning record.' }, finish_reason: 'stop' }] }) });
        });
        await page.evaluate(async url => {
            const s = await import('/script.js'); const { oai_settings } = await import('/scripts/openai.js'); s.changeMainAPI('openai');
            oai_settings.chat_completion_source = 'custom'; oai_settings.custom_url = url; oai_settings.custom_model = 'echo-deterministic'; oai_settings.stream_openai = false; s.setOnlineStatus('echo-local'); await s.Generate('regenerate');
        }, provider.url);
        await page.unroute('**/api/backends/chat-completions/generate');
        await page.waitForTimeout(3000);
        let summaryWaitError = null;
        try {
            await page.waitForFunction(({ count, reply }) => {
                const store = SillyTavern.getContext().chatMetadata.world_backstage_v1;
                return [...store.currentState.storyMemory.summaries, ...(store.memorySummaryArchive || [])].some(s => s.level === 0 && s.startMessageId === count - 1 && s.endMessageId === count - 1 && String(s.summary).includes(reply));
            }, { count, reply }, { timeout: 15000 });
        } catch (error) { summaryWaitError = String(error); }
        const after = await snapshot();
        const nativeHistoryPreserved = JSON.stringify(before.chat.slice(0, -1)) === JSON.stringify(after.chat.slice(0, -1));
        const nativeRegenerationCorrect = foregroundRequests === 1 && after.chat.length === count && after.chat.at(-1).mes === reply && after.chat.at(-1).swipes.length === 1 && !after.echo.generating;
        const hiddenHistoryPreserved = after.chat.filter(m => m.extra?.world_backstage_auto_hidden).length === count - 5;
        const worldCorePreserved = JSON.stringify(core(before.store)) === JSON.stringify(core(after.store));
        const summaryFromNewReplyRequested = provider.requests.slice(requestStart).some(r => r.kind === 'history' && r.regeneratedTextPresent);
        const summaryFromNewReplyCommitted = [...after.store.currentState.storyMemory.summaries, ...(after.store.memorySummaryArchive || [])].some(s => s.level === 0 && s.startMessageId === count - 1 && s.endMessageId === count - 1 && String(s.summary).includes(reply));
        const summary = { count, enabled, status: nativeHistoryPreserved && nativeRegenerationCorrect && hiddenHistoryPreserved && worldCorePreserved && summaryFromNewReplyRequested && summaryFromNewReplyCommitted ? 'PASS' : 'PARTIAL', nativeHistoryPreserved, nativeRegenerationCorrect, hiddenHistoryPreserved, worldCorePreserved, summaryFromNewReplyRequested, summaryFromNewReplyCommitted, summaryWaitError, foregroundRequests, automaticRequests: provider.requests.slice(requestStart), externalModelSemanticStatus: 'NOT VERIFIED' };
        rows.push(summary);
        await fs.writeFile(path.join(out, `posthide-clean-${count}-${enabled ? 'on' : 'off'}.json`), JSON.stringify({ ...summary, before, after }, null, 2));
        await fs.writeFile(path.join(out, 'posthide-clean-summary.json'), JSON.stringify({ status: rows.every(r => r.status === 'PASS') && !errors.length ? 'PASS' : 'PARTIAL', reason: 'Actual archived fixtures, distinct new reply, no out-of-range swipe attempt; provider semantics remain NOT VERIFIED.', rows, errors }, null, 2));
        console.log(JSON.stringify(summary));
    }
} finally { await browser.close(); await provider.close(); }
