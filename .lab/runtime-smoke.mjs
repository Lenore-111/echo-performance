import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const { chromium } = await import(pathToFileURL(process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence'));
await fs.mkdir(out, { recursive: true });
const checks = []; const errors = [];
page.on('pageerror', e => { errors.push(e.stack || String(e)); console.log(`PAGE ERROR ${e.stack || e}`); });
const check = (name, actual, expected = true) => { assert.deepEqual(actual, expected, name); checks.push(name); console.log(`PASS ${name}`); };
const settle = () => page.waitForFunction(() => {
    const stats = EchoPerformance.stats();
    const chatLength = SillyTavern.getContext().chat.length;
    return stats.enabled === true
        && stats.generating === false
        && stats.liveMessageShells + stats.detachedMessageShells === chatLength;
});
try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039');
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'), { timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.EchoPerformance));
    if (process.env.ECHO_COMPAT) {
        await page.waitForFunction(() => window.__worldBackstageLoaded && window.worldBackstageHost);
        await page.evaluate(async () => {
            await worldBackstageHost.updatePublicOpinionSettings({ enabled: true, autoSync: false, worldAutoEnabled: false, worldSimulationEnabled: false, socialAutoEnabled: false, publicOpinionAutoEnabled: false, memoryAutoIndexInterval: 0, autoHideArchivedFloors: false });
        });
        check('World Backstage bootstrap and real host loaded', true);
    }
    await page.evaluate(async () => {
        const s = await import('/script.js'); const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
        await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench'));
        await s.openCharacterChat('echo-bench-150');
        EchoPerformance.setEnabled(false);
        window.echoRawBefore = JSON.stringify(s.chat);
        const shell = document.querySelector('#chat > .mes[mesid="0"]');
        window.echoFirstChild = shell.querySelector('.mes_text').firstChild;
        window.echoBeforeHTML = shell.querySelector('.mes_text').innerHTML;
        window.echoBeforeHeight = document.querySelector('#chat').scrollHeight;
        window.echoMetadataBefore = JSON.stringify(s.chat_metadata);
        EchoPerformance.setEnabled(true);
    });
    await settle();
    check('150 message shells and IDs preserved', await page.evaluate(() => [...document.querySelectorAll('#chat > .mes')].every((m, i) => Number(m.getAttribute('mesid')) === i) && document.querySelectorAll('#chat > .mes').length === 150));
    check('lazy rendering leaves chat array byte-identical', await page.evaluate(() => JSON.stringify(SillyTavern.getContext().chat) === window.echoRawBefore));
    check('lazy rendering leaves metadata byte-identical', await page.evaluate(async () => JSON.stringify((await import('/script.js')).chat_metadata) === window.echoMetadataBefore));
    if (process.env.ECHO_COMPAT) {
        const publicBefore = await page.evaluate(() => JSON.stringify(worldBackstageHost.getPublicSurface()));
        await page.evaluate(() => worldBackstageHost.open());
        await page.waitForSelector('#world-backstage-root', { state: 'visible' });
        await page.screenshot({ path: path.join(out, 'world-backstage-open.png') });
        await page.evaluate(() => worldBackstageHost.close());
        check('World Backstage real panel opens and closes without changing public state', await page.evaluate(before => JSON.stringify(worldBackstageHost.getPublicSurface()) === before, publicBefore));
    }
    check('scroll height preserved within 2px', await page.evaluate(() => Math.abs(document.querySelector('#chat').scrollHeight - window.echoBeforeHeight) <= 2));
    check('recent 40 messages remain fully present and unconstrained', await page.evaluate(() => [...document.querySelectorAll('#chat>.mes')].slice(-40).every(m => m.querySelector('.mes_text').textContent.length > 0 && !m.style.contentVisibility)));
    await page.evaluate(() => EchoPerformance.setEnabled(false));
    check('disable restores HTML and original node identity', await page.evaluate(() => {
        const t = document.querySelector('#chat>.mes[mesid="0"] .mes_text');
        const stats = EchoPerformance.stats();
        return t.innerHTML === window.echoBeforeHTML
            && t.firstChild === window.echoFirstChild
            && stats.detachedMessageShells === 0
            && stats.liveMessageShells === SillyTavern.getContext().chat.length;
    }));
    await page.evaluate(() => EchoPerformance.setEnabled(true)); await settle();
    // A third-party consumer receives native events only after parked DOM restores.
    check('native event consumer sees complete DOM without layout constraints', await page.evaluate(async () => {
        const c = SillyTavern.getContext(); let result = false;
        const consumer = () => { result = [...document.querySelectorAll('#chat>.mes')].every(m => !m.style.contentVisibility && m.querySelector('.mes_text').textContent.length > 0); };
        c.eventSource.on(c.eventTypes.MESSAGE_UPDATED, consumer);
        await c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, 149);
        c.eventSource.removeListener(c.eventTypes.MESSAGE_UPDATED, consumer);
        return result;
    }));
    await settle();
    check('external DOM replacement is retained and releases layout constraints', await page.evaluate(async () => {
        const t = document.querySelector('#chat>.mes[mesid="0"] .mes_text');
        t.innerHTML = '<p data-custom-render="true">Replacement from another extension</p>';
        await new Promise(r => setTimeout(r, 150));
        return t.textContent === 'Replacement from another extension' && !t.closest('.mes').style.contentVisibility;
    }));
    await page.evaluate(async () => { const s = await import('/script.js'); s.updateMessageBlock(0, s.chat[0]); });
    await page.evaluate(async () => {
        const s = await import('/script.js');
        s.chat[2].mes = '<iframe title="Echo interactive fixture" srcdoc="<button>Fixture</button>"></iframe>';
        s.updateMessageBlock(2, s.chat[2]);
        const iframe = document.createElement('iframe'); iframe.title = 'Echo interactive fixture'; iframe.srcdoc = '<button>Fixture</button>';
        document.querySelector('#chat>.mes[mesid="2"] .mes_text').replaceChildren(iframe);
        const t = document.querySelector('#chat>.mes[mesid="4"] .mes_text'); t.innerHTML = '<p class="plugin-custom">Custom plugin markup</p>';
        const shell = document.querySelector('#chat>.mes[mesid="6"]'); EchoPerformance.pin(shell);
    });
    await page.waitForTimeout(1800);
    check('iframe/custom markup/pinned shells remain attached', await page.evaluate(() => [2, 4, 6].every(id => !document.querySelector(`#chat>.mes[mesid="${id}"]`).style.contentVisibility)));
    await page.evaluate(async () => { const s = await import('/script.js'); await s.openCharacterChat('echo-bench-150'); }); await settle();
    // Scroll through the real viewport, then use the native editor buttons.
    await page.locator('#chat>.mes[mesid="10"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.locator('#chat>.mes[mesid="10"] .mes_edit').click();
    await page.locator('#curEditTextarea').fill('Echo edited through the native editor.');
    await page.locator('#chat>.mes[mesid="10"] .mes_edit_done').click();
    check('native historical edit updates data and displayed message', await page.evaluate(() => SillyTavern.getContext().chat[10].mes === 'Echo edited through the native editor.' && document.querySelector('#chat>.mes[mesid="10"] .mes_text').textContent.includes('Echo edited')));
    await page.locator('#chat>.mes[mesid="12"] .mes_edit').scrollIntoViewIfNeeded();
    await page.locator('#chat>.mes[mesid="12"] .mes_edit').click();
    await page.locator('#curEditTextarea').fill('Unsaved edit, must cancel.');
    await page.locator('#chat>.mes[mesid="12"] .mes_edit_cancel').click();
    check('native edit cancel retains original', await page.evaluate(() => !SillyTavern.getContext().chat[12].mes.includes('Unsaved edit')));
    await page.evaluate(async () => {
        const s = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        await s.swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 11, forceSwipeId: 1 });
    });
    check('native historical swipe selects alternate without deleting history', await page.evaluate(() => { const m = SillyTavern.getContext().chat[11]; return m.swipe_id === 1 && m.mes.startsWith('Alternate message 11') && m.swipes.length === 2; }));
    await page.evaluate(async () => {
        const s = await import('/script.js'); const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        await s.swipe(null, SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 11, forceSwipeId: 0 });
    });
    check('swipe back restores reasoning and original history', await page.evaluate(() => { const m = SillyTavern.getContext().chat[11]; return m.swipe_id === 0 && m.mes.startsWith('Message 11:') && m.extra.reasoning.length > 0 && m.swipes.length === 2; }));
    await page.locator('#chat>.mes[mesid="11"] .mes_reasoning_header').scrollIntoViewIfNeeded();
    await page.locator('#chat>.mes[mesid="11"] .mes_reasoning_header').click();
    check('historical reasoning expands normally', await page.locator('#chat>.mes[mesid="11"] .mes_reasoning_details').evaluate(n => n.open && n.querySelector('.mes_reasoning').textContent.length > 0));
    await page.locator('#chat>.mes[mesid="11"] .mes_reasoning_header').click();
    await page.evaluate(() => { document.querySelector('#chat').scrollTop = document.querySelector('#chat').scrollHeight; EchoPerformance.resume(); }); await settle();
    await page.keyboard.press('Control+f'); await page.keyboard.press('Escape');
    check('browser find restores normal layout and pauses optimization', await page.evaluate(() => {
        const stats = EchoPerformance.stats();
        return stats.paused
            && stats.detachedMessageShells === 0
            && stats.liveMessageShells === SillyTavern.getContext().chat.length
            && [...document.querySelectorAll('#chat>.mes .mes_text')].every(t => t.textContent.length > 0);
    }));
    await page.evaluate(() => EchoPerformance.resume()); await settle();
    let generationRequests = 0;
    await page.route('**/api/backends/chat-completions/generate', async route => {
        generationRequests++;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Echo deterministic regenerated reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } }) });
    });
    await page.evaluate(async () => {
        const s = await import('/script.js'); const { oai_settings } = await import('/scripts/openai.js');
        s.changeMainAPI('openai');
        oai_settings.chat_completion_source = 'custom'; oai_settings.custom_url = 'http://127.0.0.1:8040/v1'; oai_settings.custom_model = 'echo-fixture'; oai_settings.stream_openai = false;
        s.setOnlineStatus('echo-fixture');
        await s.Generate('regenerate');
    });
    check('native regeneration uses deterministic provider transport once', generationRequests, 1);
    check('native regeneration retains historical messages and exits suspension', await page.evaluate(() => { const c = SillyTavern.getContext(); return c.chat.length === 150 && c.chat[10].mes === 'Echo edited through the native editor.' && c.chat.at(-1).mes === 'Echo deterministic regenerated reply.' && !EchoPerformance.stats().generating; }));
    await page.unroute('**/api/backends/chat-completions/generate');
    await page.evaluate(async () => { await SillyTavern.getContext().saveChat(); });
    // The pinned ST version leaves editor autocomplete resize listeners alive
    // after closing an editor. Reload before independent viewport QA; a separate
    // disabled-extension control reproduces and records that native issue.
    await page.reload();
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'), { timeout: 60000 });
    await page.evaluate(async () => {
        const s = await import('/script.js'); const { power_user } = await import('/scripts/power-user.js'); power_user.chat_truncation = 10000;
        await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench')); await s.openCharacterChat('echo-bench-150'); EchoPerformance.setEnabled(true);
    });
    await settle();
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(1500);
    check('mobile viewport has no horizontal chat overflow', await page.evaluate(() => { const c = document.querySelector('#chat'); return c.scrollWidth <= c.clientWidth + 2; }));
    await page.screenshot({ path: path.join(out, 'mobile-390.png') });
    await page.setViewportSize({ width: 320, height: 640 }); await page.waitForTimeout(1500);
    check('narrow viewport has no horizontal chat overflow', await page.evaluate(() => { const c = document.querySelector('#chat'); return c.scrollWidth <= c.clientWidth + 2; }));
    await page.screenshot({ path: path.join(out, 'mobile-320.png') });
    await page.setViewportSize({ width: 1440, height: 980 }); await page.waitForTimeout(1000);
    const chatBox = await page.locator('#chat').boundingBox();
    await page.mouse.move(chatBox.x + chatBox.width / 2, chatBox.y + chatBox.height / 2);
    const scrollBefore = await page.locator('#chat').evaluate(n => n.scrollTop);
    await page.mouse.wheel(0, -1600); await page.waitForTimeout(300);
    check('real browser wheel scroll moves through history', await page.locator('#chat').evaluate((n, before) => n.scrollTop < before, scrollBefore));
    check('visible messages retain readable body after wheel scroll', await page.evaluate(() => {
        const r = document.querySelector('#chat').getBoundingClientRect();
        return [...document.querySelectorAll('#chat>.mes')].filter(m => { const b = m.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; }).every(m => m.querySelector('.mes_text').textContent.length > 0);
    }));
    check('saved JSONL readback retains edits, swipes, reasoning and all 150 messages', await page.evaluate(async () => {
        const s = await import('/script.js'); await s.saveChatConditional();
        const r = await fetch('/api/chats/get', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: s.characters[s.this_chid].avatar, file_name: s.characters[s.this_chid].chat }) });
        const rows = await r.json(); const messages = rows.slice(1);
        return messages.length === 150 && messages[10].mes === s.chat[10].mes && messages[11].swipes.length === 2 && messages[11].extra.reasoning === s.chat[11].extra.reasoning;
    }));
    check('no page exceptions', errors, []);
    await page.screenshot({ path: path.join(out, 'runtime-desktop.png') });
} finally {
    await fs.writeFile(path.join(out, process.env.ECHO_COMPAT ? 'compat-smoke.json' : 'runtime-smoke.json'), JSON.stringify({ checks, errors, browser: await browser.version(), runtimeCommit: '8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8', worldBackstage: process.env.ECHO_COMPAT ? { commit: 'f9babfa0ee0bd3003d3529fd171b83103cfee4c1', manifestVersion: '2.5.8', automaticModelJobsDisabled: true, autoHideArchivedFloors: false } : null, complete: checks.includes('no page exceptions') }, null, 2));
    await browser.close();
}