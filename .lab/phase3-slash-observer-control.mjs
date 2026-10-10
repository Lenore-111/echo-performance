import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-slash-observer-control'));
await fs.mkdir(out, { recursive: true });
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);

const allErrors = [];
page.on('pageerror', error => allErrors.push({ at: performance.now?.() ?? Date.now(), message: String(error), stack: String(error?.stack || error) }));

const isObserverError = error => /MutationObserver|parameter 1 is not of type 'Node'|Failed to execute 'observe'/i.test(`${error.message}\n${error.stack}`);
const normalize = error => String(error?.stack || error?.message || error)
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://ST')
    .replace(/:\d+:\d+/g, ':LINE:COL');

async function ready() {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance);
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    });
}

async function openFixture(enabled) {
    await page.evaluate(async enabled => {
        const s = await import('/script.js');
        const id = s.characters.findIndex(c => c.name === 'Echo Bench');
        if (id < 0) throw new Error('Echo Bench missing');
        await s.selectCharacterById(id);
        EchoPerformance.setEnabled(false, false);
        await s.openCharacterChat('echo-bench-1000');
        EchoPerformance.setEnabled(enabled, false);
    }, enabled);
    if (enabled) {
        await page.waitForFunction(() => EchoPerformance.stats().detachedMessageShells >= 800 && EchoPerformance.stats().liveMessageShells <= 180, null, { timeout: 30000 });
    }
}

async function runCase(enabled, target) {
    await openFixture(enabled);
    const start = allErrors.length;
    const before = await page.evaluate(target => ({
        live: Boolean(document.querySelector(`#chat > .mes[mesid="${target}"]`)),
        stats: EchoPerformance.stats(),
    }), target);
    const input = page.locator('#send_textarea');
    await input.click();
    await input.fill(`/chat-jump ${target}`);
    await input.press('Enter');
    await page.waitForTimeout(750);
    const after = await page.evaluate(target => {
        const root = document.querySelector('#chat');
        const node = root.querySelector(`:scope > .mes[mesid="${target}"]`);
        const rr = root.getBoundingClientRect();
        const nr = node?.getBoundingClientRect?.();
        return {
            live: node instanceof HTMLElement,
            visible: Boolean(nr && nr.bottom > rr.top && nr.top < rr.bottom),
            stats: EchoPerformance.stats(),
        };
    }, target);
    const errors = allErrors.slice(start);
    return {
        enabled,
        before,
        after,
        errors,
        observerErrors: errors.filter(isObserverError),
    };
}

try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/');
    await ready();
    const off = await runCase(false, 659);
    await page.reload();
    await ready();
    const on = await runCase(true, 659);

    const offStacks = new Set(off.observerErrors.map(normalize));
    const onStacks = new Set(on.observerErrors.map(normalize));
    const echoExclusive = [...onStacks].filter(stack => !offStacks.has(stack));
    const shared = [...onStacks].filter(stack => offStacks.has(stack));
    const result = {
        off,
        on,
        offObserverCount: off.observerErrors.length,
        onObserverCount: on.observerErrors.length,
        sharedCount: shared.length,
        echoExclusiveCount: echoExclusive.length,
        classification: echoExclusive.length > 0 ? 'ECHO_EXCLUSIVE_ERROR' : (shared.length > 0 ? 'SHARED_ST_BASELINE_ERROR' : 'NO_ERROR_REPRODUCED'),
        sharedStacks: shared,
        echoExclusiveStacks: echoExclusive,
    };
    await fs.writeFile(path.join(out, 'slash-observer-control.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({
        offObserverCount: result.offObserverCount,
        onObserverCount: result.onObserverCount,
        sharedCount: result.sharedCount,
        echoExclusiveCount: result.echoExclusiveCount,
        classification: result.classification,
    }, null, 2));
    if (result.echoExclusiveCount > 0) process.exitCode = 2;
} finally {
    await browser.close();
}
