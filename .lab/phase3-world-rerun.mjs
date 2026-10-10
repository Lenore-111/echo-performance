import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-world-rerun'));
await fs.mkdir(out, { recursive: true });
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const requests = [];
const provider = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    try {
        const data = JSON.parse(body);
        const text = (data.messages || []).map(m => m.content).join('\n');
        const ids = [...text.matchAll(/<message id="(\d+)" swipe="(\d+)" role="(user|assistant)">/g)].map(m => Number(m[1]));
        let payload;
        if (ids.length) payload = {
            memory_digest: { text: `Phase3 archive through message ${ids.at(-1)}.`, through_message_id: ids.at(-1) },
            turn_summaries: ids.map(id => ({ id: `p3_l0_${id}`, source_message_id: id, title: `Message ${id}`, summary: `The fictional traveller recorded message ${id}.`, people: [], locations: [], tags: [] })),
            facts_upsert: [], facts_invalidate: [], clues_upsert: [], clues_resolve: [], chapter_summary: null,
        };
        else if (text.includes('summary_rollup')) payload = { summary_rollup: { title: 'Phase3 stage', summary: 'The archived fictional observations remain consistent.', people: [], locations: [], tags: [] } };
        else throw new Error('Unsupported provider prompt');
        requests.push({ ids, at: Date.now(), kind: ids.length ? 'history' : 'rollup' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }] }));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: String(error) })); }
});
await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e?.stack || e)));
await page.addLocatorHandler(page.locator('#wb-mama-note-modal'), async modal => modal.getByRole('button', { name: '收好纸条' }).click());

const ready = async () => {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance && window.worldBackstageHost);
    await page.evaluate(async () => { const { power_user } = await import('/scripts/power-user.js'); power_user.chat_truncation = 10000; for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
};
const selectEchoBench = () => page.evaluate(async () => {
    const s = await import('/script.js');
    const id = s.characters.findIndex(c => c.name === 'Echo Bench');
    if (id < 0) throw new Error('Echo Bench missing');
    await s.selectCharacterById(id);
    return id;
});
const snapshot = () => page.evaluate(() => {
    const c = SillyTavern.getContext();
    return {
        chat: structuredClone(c.chat),
        store: structuredClone(c.chatMetadata.world_backstage_v1 || null),
        echo: EchoPerformance.stats(),
        liveMes: document.querySelectorAll('#chat > .mes').length,
    };
});
const coreState = store => {
    const s = store?.currentState || {};
    return { clock: s.clock, people: s.people, events: s.events, locations: s.locations, publicImpactLedger: s.publicImpactLedger };
};
const normalizeChat = chat => chat.map(m => { const x = structuredClone(m); delete x.extra?.world_backstage_auto_hidden; if (m.extra?.world_backstage_auto_hidden) x.is_system = false; return x; });
const routeRegen = async content => {
    await page.route('**/api/backends/chat-completions/generate', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: content.mes, reasoning_content: content.reasoning }, finish_reason: 'stop' }] }) }));
};
const doRegen = () => page.evaluate(async () => {
    const s = await import('/script.js'); const { oai_settings } = await import('/scripts/openai.js');
    s.changeMainAPI('openai'); oai_settings.chat_completion_source = 'custom'; oai_settings.custom_url = 'http://127.0.0.1:8041/v1'; oai_settings.custom_model = 'echo-world'; oai_settings.stream_openai = false; s.setOnlineStatus('echo-local');
    await s.Generate('regenerate');
});

const cases = [];
try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/'); await ready();
    for (const enabled of [false, true]) {
        const worldFile = `echo-phase3-world-rerun-1000-${enabled ? 'on' : 'off'}`;
        await selectEchoBench();
        await page.evaluate(async ({ worldFile }) => {
            const s = await import('/script.js');
            const avatar = s.characters[s.this_chid].avatar;
            const r = await fetch('/api/chats/get', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, file_name: 'echo-bench-1000' }) });
            const rows = await r.json(); rows[0].chat_metadata = { echo_phase3_world_fixture: true };
            const save = await fetch('/api/chats/save', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, file_name: worldFile, chat: rows, force: true }) });
            if (!save.ok) throw new Error(`world fixture save failed ${save.status}`);
        }, { worldFile });
        await page.evaluate(async ({ worldFile, enabled, providerUrl }) => {
            const s = await import('/script.js'); await s.openCharacterChat(worldFile); EchoPerformance.setEnabled(enabled, false);
            await worldBackstageHost.updatePublicOpinionSettings({ enabled: true, memorySystemEnabled: true, injectionMemory: true, memoryAutoIndexInterval: 10, autoHideArchivedFloors: true, apiMode: 'custom', customApiUrl: providerUrl, customApiKey: 'echo-phase3-local-only', customApiModel: 'echo-deterministic', customApiTransport: 'direct', autoRetryCount: 0 });
        }, { worldFile, enabled, providerUrl });
        if (enabled) await page.waitForFunction(() => EchoPerformance.stats().detachedMessageShells >= 800, null, { timeout: 30000 });
        const before = await snapshot();
        const requestStart = requests.length;
        const last = { mes: before.chat.at(-1).mes, reasoning: before.chat.at(-1).extra?.reasoning || '' };
        await routeRegen(last); await doRegen(); await page.unroute('**/api/backends/chat-completions/generate');
        let workflowError = null;
        try {
            await page.waitForFunction(() => {
                const c = SillyTavern.getContext(); const mem = c.chatMetadata.world_backstage_v1?.currentState?.storyMemory;
                return mem?.indexedThroughMessageId >= 979 && c.chat.some(m => m.extra?.world_backstage_auto_hidden);
            }, null, { timeout: 240000 });
            await page.waitForTimeout(2000);
            await page.evaluate(() => worldBackstageHost.updatePublicOpinionSettings({ memoryAutoIndexInterval: 1 }));
            await routeRegen(last); await doRegen(); await page.unroute('**/api/backends/chat-completions/generate');
            await page.waitForFunction(() => SillyTavern.getContext().chatMetadata.world_backstage_v1?.currentState?.storyMemory?.indexedThroughMessageId >= 999, null, { timeout: 240000 });
            await page.waitForTimeout(2000);
        } catch (e) { workflowError = String(e?.stack || e); }
        const after = await snapshot();
        const hiddenIds = after.chat.flatMap((m,i)=>m.extra?.world_backstage_auto_hidden ? [i] : []);
        const archives = after.store?.memorySummaryArchive || [];
        const summaries = after.store?.currentState?.storyMemory?.summaries || [];
        const covered = new Set([...archives,...summaries].filter(s=>s.level===0 && s.startMessageId===s.endMessageId && s.summary).map(s=>s.endMessageId));
        const preRefreshCore = coreState(after.store); const preRefreshHidden = [...hiddenIds]; const preRefreshIndexed = after.store?.currentState?.storyMemory?.indexedThroughMessageId;
        await page.reload(); await ready(); await selectEchoBench();
        await page.evaluate(async ({ worldFile, enabled }) => { const s=await import('/script.js'); await s.openCharacterChat(worldFile); EchoPerformance.setEnabled(enabled, false); }, { worldFile, enabled });
        if (enabled) await page.waitForFunction(() => EchoPerformance.stats().detachedMessageShells >= 800, null, { timeout: 30000 });
        const refreshed = await snapshot();
        const refreshedHidden = refreshed.chat.flatMap((m,i)=>m.extra?.world_backstage_auto_hidden ? [i] : []);
        const checks = {
            workflowCompleted: !workflowError && after.store?.currentState?.storyMemory?.indexedThroughMessageId >= 999,
            automaticRequests: requests.slice(requestStart).some(x=>x.kind==='history'),
            hiddenCovered: hiddenIds.length > 0 && hiddenIds.every(i => covered.has(i) && i <= 994),
            originalHistoryPreserved: JSON.stringify(normalizeChat(after.chat).slice(0,-1)) === JSON.stringify(normalizeChat(before.chat).slice(0,-1)),
            worldCoreNotAdvancedByArchive: JSON.stringify(coreState(before.store)) === JSON.stringify(coreState(after.store)),
            refreshWorldCoreStable: JSON.stringify(preRefreshCore) === JSON.stringify(coreState(refreshed.store)),
            refreshHiddenStable: JSON.stringify(preRefreshHidden) === JSON.stringify(refreshedHidden),
            refreshIndexedStable: preRefreshIndexed === refreshed.store?.currentState?.storyMemory?.indexedThroughMessageId,
            echoRecompactAfterRefresh: !enabled || (refreshed.echo.detachedMessageShells >= 800 && refreshed.liveMes <= 180),
        };
        cases.push({ enabled, workflowError, requestCount: requests.length-requestStart, hiddenCount: hiddenIds.length, indexedThrough: after.store?.currentState?.storyMemory?.indexedThroughMessageId, refreshedIndexedThrough: refreshed.store?.currentState?.storyMemory?.indexedThroughMessageId, checks });
        await fs.writeFile(path.join(out,'world.json'), JSON.stringify({ cases, pageErrors }, null, 2));
        console.log(JSON.stringify({ enabled, workflowError, hidden: hiddenIds.length, indexed: cases.at(-1).indexedThrough, checks }));
    }
    const off = cases.find(x=>!x.enabled), on=cases.find(x=>x.enabled);
    const echoOnlyDifference = off && on ? Object.fromEntries(Object.keys(on.checks).map(k=>[k,{off:off.checks[k],on:on.checks[k]}])) : null;
    await fs.writeFile(path.join(out,'summary.json'), JSON.stringify({ status: cases.every(c=>Object.values(c.checks).every(Boolean)) ? 'PASS' : 'PARTIAL', cases, echoOnlyDifference, pageErrors }, null, 2));
} finally { provider.close(); await browser.close(); }
