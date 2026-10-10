// Reproduce the pinned host's stale editor-autocomplete resize listener with
// Echo explicitly disabled. This is evidence, not a patch to SillyTavern.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const { chromium } = await import(pathToFileURL(process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(e.stack || String(e)));
try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039');
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'));
    await page.evaluate(async () => {
        const s = await import('/script.js'); EchoPerformance.setEnabled(false);
        await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench'));
        await s.openCharacterChat('echo-bench-150');
    });
    await page.locator('#chat>.mes[mesid="140"] .mes_edit').scrollIntoViewIfNeeded();
    await page.locator('#chat>.mes[mesid="140"] .mes_edit').click();
    await page.locator('#curEditTextarea').fill('Control edit, then cancel.');
    await page.locator('#chat>.mes[mesid="140"] .mes_edit_cancel').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);
    const evidence = { echoEnabled: await page.evaluate(() => EchoPerformance.stats().enabled), runtimeCommit: '8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8', errors, reproduced: errors.some(e => e.includes('/autocomplete/AutoComplete.js')) };
    await fs.writeFile(path.join(root, 'evidence/upstream-control.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
