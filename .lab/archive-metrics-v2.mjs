import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..'), out = path.join(root, 'evidence/acceptance-v2');
const { chromium } = await import(pathToFileURL(path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);
const rows = [], errors = [], unexpectedModelRequests = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('request', r => { if (r.url().includes('/chat/completions') || r.url().includes('/chat-completions/generate')) unexpectedModelRequests.push({ url: r.url(), at: Date.now() }); });
const ready = async () => {
    await page.waitForFunction(() => window.EchoPerformance && window.worldBackstageHost && window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'));
    await page.evaluate(async () => { const s = await import('/script.js'); const { power_user } = await import('/scripts/power-user.js'); power_user.chat_truncation = 10000; await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench')); });
};
try {
    await page.goto('http://127.0.0.1:8039'); await ready();
    for (const count of [200, 500, 1000]) {
        const fixture = await page.evaluate(async count => {
            const s = await import('/script.js'); const r = await fetch('/api/chats/get', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: s.characters[s.this_chid].avatar, file_name: `echo-world-${count}-off` }) });
            if (!r.ok) throw new Error(`Archive read: ${r.status}`); return r.json();
        }, count);
        for (let repeat = 0; repeat < 3; repeat++) for (const enabled of repeat % 2 ? [true, false] : [false, true]) {
            const file = `echo-archive-bench-${count}-${enabled ? 'on' : 'off'}-${repeat}`;
            const requestBefore = unexpectedModelRequests.length;
            const setup = await page.evaluate(async ({ fixture, file, enabled }) => {
                const s = await import('/script.js'); const c = SillyTavern.getContext();
                const settings = c.extensionSettings.world_backstage;
                if (!settings.memorySystemEnabled || !settings.autoHideArchivedFloors || !settings.injectionMemory || settings.memoryAutoIndexInterval <= 0) throw new Error('Required automatic features must remain enabled');
                const saved = await fetch('/api/chats/save', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: s.characters[s.this_chid].avatar, file_name: file, chat: fixture, force: true }) });
                if (!saved.ok) throw new Error(`Archive fixture copy: ${saved.status}`);
                EchoPerformance.setEnabled(enabled, true);
                window.archiveLongTasks = []; window.archiveObserver?.disconnect();
                window.archiveObserver = new PerformanceObserver(list => archiveLongTasks.push(...list.getEntries().map(e => ({ duration: e.duration, start: e.startTime }))));
                archiveObserver.observe({ type: 'longtask' });
                const t = performance.now(); await s.openCharacterChat(file);
                return { loadMs: performance.now() - t, autoSettings: { memorySystemEnabled: settings.memorySystemEnabled, autoHideArchivedFloors: settings.autoHideArchivedFloors, injectionMemory: settings.injectionMemory, memoryAutoIndexInterval: settings.memoryAutoIndexInterval } };
            }, { fixture, file, enabled });
            await page.waitForTimeout(2200);
            const initial = await page.evaluate(() => {
                const c = SillyTavern.getContext(); const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL); let nodes = 0; while (walker.nextNode()) nodes++;
                return { domNodes: nodes, chatElements: document.querySelector('#chat').querySelectorAll('*').length, heapBefore: performance.memory.usedJSHeapSize, hiddenFloors: c.chat.filter(m => m.extra?.world_backstage_auto_hidden).length, indexedThrough: c.chatMetadata.world_backstage_v1.currentState.storyMemory.indexedThroughMessageId, echo: EchoPerformance.stats() };
            });
            const interaction = await page.evaluate(async count => {
                const s = await import('/script.js'); const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
                const swipeMs = [], reasoningMs = [], scrollMs = []; let swipeCorrect = true;
                for (let i = 0; i < 6; i++) { const t = performance.now(); const swipeId = i % 2 ? 0 : 1; await s.swipe(null, i % 2 ? SWIPE_DIRECTION.LEFT : SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 11, forceSwipeId: swipeId }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); swipeMs.push(performance.now() - t); swipeCorrect &&= s.chat[11].mes === s.chat[11].swipes[swipeId]; }
                const hiddenMarkerRetainedAfterSwipe = Boolean(s.chat[11].extra.world_backstage_auto_hidden);
                const header = document.querySelector('#chat>.mes[mesid="11"] .mes_reasoning_header'), details = header.closest('details');
                for (let i = 0; i < 2; i++) { if (details.open) header.click(); const t = performance.now(); header.click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); reasoningMs.push({ ms: performance.now() - t, open: details.open, chars: details.querySelector('.mes_reasoning').textContent.length }); header.click(); }
                const chat = document.querySelector('#chat'); let last = performance.now();
                for (let i = 0; i < 80; i++) { chat.scrollTop = (chat.scrollHeight - chat.clientHeight) * (i < 40 ? 1 - i / 39 : (i - 40) / 39); await new Promise(r => requestAnimationFrame(r)); const now = performance.now(); scrollMs.push(now - last); last = now; }
                const t = performance.now(); await s.saveChatConditional();
                return { swipeMs, swipeCorrect, hiddenMarkerRetainedAfterSwipe, reasoningMs, scrollMs, saveMs: performance.now() - t, heapAfter: performance.memory.usedJSHeapSize, longTasks: archiveLongTasks };
            }, count);
            if (await page.locator('#wb-mama-note-modal').isVisible()) await page.locator('#wb-mama-note-modal').getByRole('button', { name: '收好纸条' }).click();
            const box = await page.locator('#chat').boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            const wheelBefore = await page.locator('#chat').evaluate(n => n.scrollTop);
            await page.mouse.wheel(0, -1200); await page.waitForTimeout(180);
            const wheelAfter = await page.locator('#chat').evaluate(n => n.scrollTop);
            const visibleBodiesPresent = await page.evaluate(() => { const root = document.querySelector('#chat'), r = root.getBoundingClientRect(); return [...root.querySelectorAll(':scope > .mes')].filter(m => { const b = m.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; }).every(m => m.querySelector('.mes_text').textContent.length > 0); });
            const refreshStart = Date.now(); await page.reload(); await ready();
            await page.evaluate(async file => { const s = await import('/script.js'); await s.openCharacterChat(file); }, file);
            const refreshAndEnterMs = Date.now() - refreshStart;
            const afterReload = await page.evaluate(() => ({ heapAfterReload: performance.memory.usedJSHeapSize, echoEnabledAfterReload: EchoPerformance.stats().enabled, configuredEnabledAfterReload: SillyTavern.getContext().extensionSettings.echo_performance.enabled }));
            const status = initial.hiddenFloors === count - 5 && initial.indexedThrough === count - 1 && interaction.swipeCorrect && interaction.hiddenMarkerRetainedAfterSwipe && interaction.reasoningMs.every(x => x.open && x.chars > 0) && wheelAfter < wheelBefore && visibleBodiesPresent && afterReload.echoEnabledAfterReload === enabled && afterReload.configuredEnabledAfterReload === enabled && requestBefore === unexpectedModelRequests.length ? 'PASS' : 'PARTIAL';
            rows.push({ count, enabled, repeat, status, ...setup, ...initial, ...interaction, wheelBefore, wheelAfter, visibleBodiesPresent, refreshAndEnterMs, ...afterReload });
            console.log(JSON.stringify({ count, enabled, repeat, status, hidden: initial.hiddenFloors, loadMs: Math.round(setup.loadMs), saveMs: Math.round(interaction.saveMs) }));
            await fs.writeFile(path.join(out, 'archived-metrics.json'), JSON.stringify({ status: 'PARTIAL', reason: 'World reload state mismatch is tracked separately; these are actual archived-history measurements, not blanket compatibility PASS.', rows, errors, unexpectedModelRequests }, null, 2));
        }
    }
} finally { await browser.close(); }
