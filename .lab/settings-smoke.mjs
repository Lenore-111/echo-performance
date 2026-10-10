import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const { chromium } = await import(pathToFileURL(process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(30000);
await page.addLocatorHandler(page.locator('#wb-mama-note-modal'), async modal => {
    await modal.getByRole('button', { name: '收好纸条' }).click();
});
const checks = [], errors = [];
page.on('pageerror', e => errors.push(e.stack || String(e)));
const panel = page.locator('.echo-performance-settings');
const check = (name, result) => { assert.equal(result, true, name); checks.push(name); console.log(`PASS ${name}`); };
const open = async () => {
    // Closing the asynchronously shown World Backstage note also closes native
    // drawers. Reopen through native controls after the overlay is dismissed.
    for (let attempt = 0; attempt < 4; attempt++) {
        if (!await page.locator('#rm_extensions_block').isVisible()) await page.locator('#extensions-settings-button .drawer-toggle').click();
        await page.waitForTimeout(500);
        if (await panel.locator('.inline-drawer-content').isVisible()) return;
        try { await panel.locator('.inline-drawer-toggle').click({ timeout: 1500 }); }
        catch (error) { if (await page.locator('#rm_extensions_block').isVisible()) throw error; }
        if (await panel.locator('.inline-drawer-content').isVisible()) return;
    }
    throw new Error('Settings drawer did not remain open');
};
try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039');
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'));
    await page.evaluate(async () => {
        const s = await import('/script.js'); const { power_user } = await import('/scripts/power-user.js'); power_user.chat_truncation = 10000;
        await s.selectCharacterById(s.characters.findIndex(c => c.name === 'Echo Bench')); await s.openCharacterChat('echo-bench-150');
    });
    await open();
    await panel.locator('[data-echo-enable]').uncheck();
    await panel.locator('[data-echo-enable]').check();
    await page.waitForFunction(() => EchoPerformance.stats().deferredMessages >= 50);
    check('real settings checkbox enables lazy rendering', await page.evaluate(() => EchoPerformance.stats().enabled));
    await page.waitForTimeout(1800);
    await page.reload();
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'));
    check('enabled setting survives real settings save and reload', await page.evaluate(() => EchoPerformance.stats().enabled && SillyTavern.getContext().extensionSettings.echo_performance.enabled));
    await open();
    await panel.locator('[data-echo-restore]').click();
    check('real pause button releases constraints and updates status', await page.evaluate(() => EchoPerformance.stats().paused && EchoPerformance.stats().deferredMessages === 0) && (await panel.locator('[data-echo-status]').innerText()).includes('暂停'));
    await panel.locator('[data-echo-resume]').click();
    check('real resume button re-enables display', await page.evaluate(() => EchoPerformance.stats().enabled && !EchoPerformance.stats().paused));
    await page.screenshot({ path: path.join(root, 'evidence/settings-desktop.png') });
    await panel.locator('[data-echo-enable]').uncheck();
    await page.waitForTimeout(1800);
    await page.reload();
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'));
    check('disable persists and leaves original node display intact', await page.evaluate(() => !EchoPerformance.stats().enabled && !SillyTavern.getContext().extensionSettings.echo_performance.enabled && !document.querySelector('#chat>.mes[style*="content-visibility"]')));
    check('no page exceptions', errors.length === 0);
    await fs.writeFile(path.join(root, 'evidence/settings-smoke.json'), JSON.stringify({ checks, errors, complete: true, worldHostVersion: await page.evaluate(() => window.worldBackstageHost?.version ?? null) }, null, 2));
} catch (error) {
    console.log(await panel.evaluate(el => { const rows = []; for (let p = el; p; p = p.parentElement) rows.push({tag:p.tagName,id:p.id,cls:p.className,display:getComputedStyle(p).display,visibility:getComputedStyle(p).visibility}); return rows; }));
    await page.screenshot({ path: path.join(root, 'evidence/settings-failure.png') });
    throw error;
} finally { await browser.close(); }
