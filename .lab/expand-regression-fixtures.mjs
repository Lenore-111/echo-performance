import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const entry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(entry.startsWith('file:') ? entry : pathToFileURL(entry).href);
const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
};
if (process.env.LAB_CHROME) launchOptions.executablePath = process.env.LAB_CHROME;
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);

try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const context = window.SillyTavern?.getContext?.();
        const type = context?.eventTypes?.APP_READY;
        return Boolean(window.EchoPerformance && context?.eventSource?.autoFireLastArgs
            && ((type && context.eventSource.autoFireLastArgs.has(type)) || context.eventSource.autoFireLastArgs.has('app_ready')));
    });

    const result = await page.evaluate(async () => {
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
        const s = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
        const characterId = s.characters.findIndex(character => character.name === 'Echo Bench');
        if (characterId < 0) throw new Error('Echo Bench missing while expanding regression fixtures');
        await s.selectCharacterById(characterId);
        const avatar = s.characters[s.this_chid].avatar;
        const sourceResponse = await fetch('/api/chats/get', {
            method: 'POST',
            headers: s.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, file_name: 'echo-bench-1000' }),
        });
        if (!sourceResponse.ok) throw new Error(`source fixture read failed: ${sourceResponse.status}`);
        const sourceRows = await sourceResponse.json();
        if (!Array.isArray(sourceRows) || sourceRows.length < 1001) {
            throw new Error(`source fixture incomplete: ${Array.isArray(sourceRows) ? sourceRows.length : 'not-array'}`);
        }

        const created = [];
        for (const count of [150, 200, 500]) {
            const metadata = structuredClone(sourceRows[0]);
            metadata.chat_metadata ||= {};
            metadata.chat_metadata.echo_fixture = true;
            metadata.chat_metadata.regression_count = count;
            const chat = [metadata, ...structuredClone(sourceRows.slice(1, count + 1))];
            const fileName = `echo-bench-${count}`;
            const response = await fetch('/api/chats/save', {
                method: 'POST',
                headers: s.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, file_name: fileName, chat, force: true }),
            });
            if (!response.ok) throw new Error(`${fileName} save failed: ${response.status}`);
            created.push({ fileName, messages: count });
        }
        return { sourceMessages: sourceRows.length - 1, created };
    });
    console.log(JSON.stringify({ fixtures: 'READY', ...result }, null, 2));
} finally {
    await browser.close();
}
