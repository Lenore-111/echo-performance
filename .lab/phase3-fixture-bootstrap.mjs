import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-bridge-smoke-v6'));
await fs.mkdir(out, { recursive: true });
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

const consoleLines = [];
const pageErrors = [];
let stage = 'created-page';
page.on('console', message => consoleLines.push({ type: message.type(), text: message.text() }));
page.on('pageerror', error => pageErrors.push({ message: String(error), stack: String(error?.stack || error) }));

async function writeDiagnostic(error = null) {
    let browserState = null;
    try {
        browserState = await page.evaluate(() => {
            const context = window.SillyTavern?.getContext?.();
            const appReadyType = context?.eventTypes?.APP_READY ?? null;
            return {
                href: location.href,
                readyState: document.readyState,
                title: document.title,
                hasSillyTavern: Boolean(window.SillyTavern),
                hasGetContext: Boolean(window.SillyTavern?.getContext),
                hasTextarea: Boolean(document.querySelector('#send_textarea')),
                onboardingOpen: Boolean(document.querySelector('dialog[open] .onboarding')),
                openDialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => ({
                    id: dialog.id || null,
                    className: typeof dialog.className === 'string' ? dialog.className : null,
                    text: (dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
                })),
                appReadyType,
                appReadySeen: Boolean(context?.eventSource?.autoFireLastArgs?.has?.(appReadyType)),
                appReadyStringSeen: Boolean(context?.eventSource?.autoFireLastArgs?.has?.('app_ready')),
                characterCount: Array.isArray(context?.characters) ? context.characters.length : null,
                extensionLoaded: Boolean(window.EchoPerformance),
                bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
            };
        });
    } catch (diagnosticError) {
        browserState = { diagnosticError: String(diagnosticError?.stack || diagnosticError) };
    }

    const diagnostic = {
        stage,
        error: error ? String(error?.stack || error) : null,
        browserState,
        pageErrors,
        consoleTail: consoleLines.slice(-120),
    };
    await fs.writeFile(path.join(out, 'bootstrap-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    try {
        await page.screenshot({ path: path.join(out, 'bootstrap.png'), fullPage: true });
    } catch {}
    return diagnostic;
}

try {
    stage = 'navigate';
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/', { waitUntil: 'domcontentloaded' });

    stage = 'wait-shell-or-onboarding';
    await page.waitForFunction(() => {
        const onboarding = document.querySelector('dialog[open] .onboarding');
        const shellReady = Boolean(window.SillyTavern?.getContext && document.querySelector('#send_textarea'));
        return Boolean(onboarding) || shellReady;
    });

    stage = 'resolve-onboarding';
    const onboarding = page.locator('dialog[open] .onboarding');
    if (await onboarding.count()) {
        const nameInput = page.locator('dialog[open] .popup-input');
        if (await nameInput.count()) await nameInput.fill('Echo Tester');
        const ok = page.locator('dialog[open] .popup-button-ok');
        if (!(await ok.count())) throw new Error('Onboarding was visible but OK button was missing');
        await ok.click();
    }

    stage = 'wait-shell';
    await page.waitForFunction(() => Boolean(window.SillyTavern?.getContext && document.querySelector('#send_textarea')));

    stage = 'wait-app-ready';
    await page.waitForFunction(() => {
        const context = window.SillyTavern?.getContext?.();
        if (!context?.eventSource?.autoFireLastArgs) return false;
        const appReadyType = context.eventTypes?.APP_READY;
        return Boolean((appReadyType && context.eventSource.autoFireLastArgs.has(appReadyType))
            || context.eventSource.autoFireLastArgs.has('app_ready'));
    });

    stage = 'build-fixture';
    const result = await page.evaluate(async () => {
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
        const s = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;

        let characterId = s.characters.findIndex(c => c.name === 'Echo Bench');
        if (characterId < 0) {
            const form = new FormData();
            form.set('ch_name', 'Echo Bench');
            form.set('description', 'Synthetic Phase 3 benchmark fixture. No model calls required.');
            form.set('first_mes', 'Echo benchmark ready.');
            const headers = s.getRequestHeaders();
            delete headers['Content-Type'];
            const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
            if (!response.ok) throw new Error(`create character failed: ${response.status}`);
            await s.getCharacters();
            characterId = s.characters.findIndex(c => c.name === 'Echo Bench');
        }
        if (characterId < 0) throw new Error('Echo Bench fixture character missing after create');
        await s.selectCharacterById(characterId);

        const paragraph = 'The fictional city settled into the evening. A traveller checked the timetable beside the station window while lights came on along the river. The conversation stayed calm and ordinary, leaving enough text for layout and interaction testing.';
        const sendDate = '2026-10-10T12:00:00.000Z';
        const messages = Array.from({ length: 1000 }, (_, i) => {
            const text = `Message ${i}: **Echo Phase 3 benchmark**\n\n${Array.from({ length: 8 }, (_, j) => `${j + 1}. ${paragraph}`).join('\n\n')}\n\n> Synthetic fixture for DOM lifecycle testing.`;
            if (i % 2 === 0) {
                return {
                    name: 'You',
                    is_user: true,
                    is_system: false,
                    send_date: sendDate,
                    mes: text,
                    extra: {},
                };
            }
            return {
                name: 'Echo Bench',
                is_user: false,
                is_system: false,
                send_date: sendDate,
                mes: text,
                extra: { reasoning: paragraph.repeat(4), reasoning_duration: 1000 },
                swipe_id: 0,
                swipes: [text, `Alternate message ${i}\n\n${paragraph}`],
                swipe_info: [
                    { send_date: sendDate, extra: { reasoning: paragraph.repeat(4), reasoning_duration: 1000 } },
                    { send_date: sendDate, extra: {} },
                ],
            };
        });

        const fileName = 'echo-bench-1000';
        const chat = [{ user_name: 'Echo Tester', character_name: 'Echo Bench', chat_metadata: { echo_fixture: true, phase: '3B-v6' } }, ...messages];
        const response = await fetch('/api/chats/save', {
            method: 'POST',
            headers: s.getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: s.characters[s.this_chid].avatar,
                file_name: fileName,
                chat,
                force: true,
            }),
        });
        if (!response.ok) throw new Error(`fixture save failed: ${response.status}`);
        return { characterId, fileName, messages: messages.length };
    });

    stage = 'complete';
    const diagnostic = await writeDiagnostic();
    await fs.writeFile(path.join(out, 'bootstrap-result.json'), JSON.stringify({ fixture: 'READY', ...result, diagnostic }, null, 2));
    console.log(JSON.stringify({ fixture: 'READY', ...result }, null, 2));
} catch (error) {
    const diagnostic = await writeDiagnostic(error);
    console.error(JSON.stringify({ fixture: 'FAILED', stage, error: String(error?.stack || error), diagnostic }, null, 2));
    throw error;
} finally {
    await browser.close();
}
