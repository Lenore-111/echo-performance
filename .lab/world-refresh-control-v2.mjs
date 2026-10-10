import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..'), out = path.join(root, 'evidence/acceptance-v2');
const world = JSON.parse(await fs.readFile(path.join(out, 'world-200-off.json'), 'utf8'));
const seed = world.postRegen;
const { chromium } = await import(pathToFileURL(path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage(); page.setDefaultTimeout(60000);
const errors = []; page.on('pageerror', e => errors.push(String(e)));
const ready = async () => {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance && window.worldBackstageHost);
    await page.evaluate(async () => { const s = await import('/script.js'); EchoPerformance.setEnabled(false, true); await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench')); });
};
const snapshot = () => page.evaluate(() => { const c = SillyTavern.getContext(); return { chat: c.chat, state: c.chatMetadata.world_backstage_v1.currentState, echo: EchoPerformance.stats(), autoSettings: { memoryAutoIndexInterval: c.extensionSettings.world_backstage.memoryAutoIndexInterval, autoHideArchivedFloors: c.extensionSettings.world_backstage.autoHideArchivedFloors } }; });
try {
    await page.goto('http://127.0.0.1:8039'); await ready();
    await page.evaluate(async seed => {
        const s = await import('/script.js'); const file = 'echo-world-refresh-control';
        const rows = [{ chat_metadata: { world_backstage_v1: seed.store, echo_fixture: true } }, ...seed.chat];
        const r = await fetch('/api/chats/save', { method: 'POST', headers: s.getRequestHeaders(), body: JSON.stringify({ avatar_url: s.characters[s.this_chid].avatar, file_name: file, chat: rows, force: true }) });
        if (!r.ok) throw new Error(`Control copy failed: ${r.status}`); await s.openCharacterChat(file);
    }, seed);
    const opened = await snapshot(); await page.waitForTimeout(1800); await page.reload(); await ready();
    await page.evaluate(async () => { const s = await import('/script.js'); await s.openCharacterChat('echo-world-refresh-control'); });
    const reloaded = await snapshot();
    const changed = JSON.stringify(seed.store.currentState) !== JSON.stringify(opened.state);
    const result = { status: changed ? 'PARTIAL' : 'PASS', echoDisabledForEntireControl: !opened.echo.enabled && !reloaded.echo.enabled, modelSummarySeed: 'Copied actual post-regeneration state from full automatic workflow, not manufactured summaries.', stateReconstructionDiffWithEchoDisabled: changed, nativeChatUnchanged: JSON.stringify(seed.chat) === JSON.stringify(reloaded.chat), stateCounts: { seedRevision: seed.store.currentState.revision, openRevision: opened.state.revision, reloadRevision: reloaded.state.revision, seedSummaries: seed.store.currentState.storyMemory.summaries.length, openSummaries: opened.state.storyMemory.summaries.length, reloadSummaries: reloaded.state.storyMemory.summaries.length }, autoSettings: reloaded.autoSettings, errors };
    await fs.writeFile(path.join(out, 'world-refresh-control.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
