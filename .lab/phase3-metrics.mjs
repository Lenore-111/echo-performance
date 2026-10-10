import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.LAB_EVIDENCE_DIR || path.join(root, 'evidence/phase3-metrics'));
await fs.mkdir(out, { recursive: true });
const playwrightEntry = process.env.LAB_PLAYWRIGHT_CORE_ENTRY || path.resolve(root, '../qa-tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(playwrightEntry.startsWith('file:') ? playwrightEntry : pathToFileURL(playwrightEntry).href);
const browser = await chromium.launch({ executablePath: process.env.LAB_CHROME || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-precise-memory-info', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.setDefaultTimeout(60000);
const errors = [];
page.on('pageerror', error => errors.push(String(error?.stack || error)));

const q = (values, fraction = .5) => {
    const a = values.filter(Number.isFinite).sort((x, y) => x - y);
    return a.length ? a[Math.floor((a.length - 1) * fraction)] : null;
};

const contiguousRanges = ids => {
    const a = [...new Set(ids)].filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return [];
    const ranges = []; let start = a[0]; let prev = a[0];
    for (const id of a.slice(1)) {
        if (id === prev + 1) { prev = id; continue; }
        ranges.push([start, prev]); start = prev = id;
    }
    ranges.push([start, prev]);
    return ranges;
};

const ready = async () => {
    await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready') && window.EchoPerformance);
    await page.evaluate(async () => {
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
        const { power_user } = await import('/scripts/power-user.js');
        power_user.chat_truncation = 10000;
    });
};

const openChat = async count => page.evaluate(async count => {
    const s = await import('/script.js');
    const id = s.characters.findIndex(c => c.name === 'Echo Bench');
    if (id < 0) throw new Error('Echo Bench fixture character missing');
    await s.selectCharacterById(id);
    const t = performance.now();
    await s.openCharacterChat(`echo-bench-${count}`);
    return performance.now() - t;
}, count);

const waitCompact = async count => {
    const t = Date.now();
    if (count >= 150) await page.waitForFunction(count => {
        const stats = EchoPerformance.stats();
        return stats.enabled && stats.detachedMessageShells >= Math.max(1, count - 180);
    }, count, { timeout: 30000 });
    await page.waitForTimeout(300);
    return Date.now() - t;
};

const snapshot = () => page.evaluate(() => {
    const chat = document.querySelector('#chat');
    const treeCount = node => { const w = document.createTreeWalker(node, NodeFilter.SHOW_ALL); let n = 1; while (w.nextNode()) n++; return n; };
    const liveIds = [...chat.querySelectorAll(':scope > .mes')].map(n => Number(n.getAttribute('mesid'))).filter(Number.isFinite);
    const detachedRanges = [...chat.querySelectorAll(':scope > .echo-dom-chunk-placeholder')].map(n => [Number(n.dataset.echoStart), Number(n.dataset.echoEnd)]).filter(x => x.every(Number.isFinite));
    const ranges = ids => {
        const a = [...new Set(ids)].sort((x,y)=>x-y); if (!a.length) return [];
        const out=[]; let s=a[0], p=a[0]; for (const id of a.slice(1)) { if (id===p+1) {p=id; continue;} out.push([s,p]); s=p=id; } out.push([s,p]); return out;
    };
    return {
        liveMes: liveIds.length,
        mountedRanges: ranges(liveIds),
        detachedRanges,
        chatElements: chat.querySelectorAll('*').length,
        chatNodes: treeCount(chat),
        pageElements: document.querySelectorAll('*').length,
        pageNodes: treeCount(document),
        scrollTop: chat.scrollTop,
        scrollHeight: chat.scrollHeight,
        clientHeight: chat.clientHeight,
        heapUsed: performance.memory?.usedJSHeapSize ?? null,
        heapTotal: performance.memory?.totalJSHeapSize ?? null,
        stats: EchoPerformance.stats(),
    };
});

async function trace(action) {
    const cdp = await page.context().newCDPSession(page);
    const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.start', { categories: '-*,devtools.timeline', options: 'sampling-frequency=10000', transferMode: 'ReturnAsStream' });
    const value = await action();
    await cdp.send('Tracing.end');
    const { stream } = await done;
    let raw = '';
    while (true) {
        const part = await cdp.send('IO.read', { handle: stream });
        raw += part.data;
        if (part.eof) break;
    }
    await cdp.send('IO.close', { handle: stream });
    await cdp.detach();
    let events = [];
    try { events = JSON.parse(raw).traceEvents || []; } catch {}
    const totals = { recalcStyleMs: 0, layoutMs: 0, prePaintMs: 0, paintMs: 0, compositeMs: 0 };
    const counts = { recalcStyle: 0, layout: 0, prePaint: 0, paint: 0, composite: 0 };
    for (const e of events) {
        const ms = Number(e.dur || 0) / 1000;
        if (e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles') { totals.recalcStyleMs += ms; counts.recalcStyle++; }
        else if (e.name === 'Layout') { totals.layoutMs += ms; counts.layout++; }
        else if (e.name === 'PrePaint') { totals.prePaintMs += ms; counts.prePaint++; }
        else if (e.name === 'Paint') { totals.paintMs += ms; counts.paint++; }
        else if (e.name === 'CompositeLayers' || e.name === 'Layerize') { totals.compositeMs += ms; counts.composite++; }
    }
    return { value, totals, counts, traceEvents: events.length };
}

const startLongTasks = () => page.evaluate(() => {
    window.echoP3LongTasks = [];
    window.echoP3LongObserver?.disconnect?.();
    window.echoP3LongObserver = new PerformanceObserver(list => window.echoP3LongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
    window.echoP3LongObserver.observe({ type: 'longtask', buffered: false });
});
const readLongTasks = () => page.evaluate(() => [...(window.echoP3LongTasks || [])]);

const realWheel = async () => {
    const box = await page.locator('#chat').boundingBox();
    if (!box) throw new Error('#chat has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        chat.scrollTop = chat.scrollHeight;
        window.echoP3WheelFrames = [];
        window.echoP3WheelActive = true;
        let last = performance.now();
        const tick = now => { if (!window.echoP3WheelActive) return; window.echoP3WheelFrames.push(now - last); last = now; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
    await page.waitForTimeout(150);
    const before = await snapshot();
    const traced = await trace(async () => {
        for (let i = 0; i < 50; i++) { await page.mouse.wheel(0, -900); await page.waitForTimeout(25); }
        for (let i = 0; i < 50; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(25); }
        await page.waitForTimeout(500);
    });
    const frames = await page.evaluate(() => { window.echoP3WheelActive = false; return [...window.echoP3WheelFrames]; });
    const after = await snapshot();
    return {
        before, after,
        p50Ms: q(frames, .5), p95Ms: q(frames, .95), maxMs: frames.length ? Math.max(...frames) : null,
        droppedOver25: frames.filter(x => x > 25).length,
        droppedOver33: frames.filter(x => x > 33.4).length,
        frameCount: frames.length,
        trace: traced.totals,
        traceCounts: traced.counts,
    };
};

const rows = [];
try {
    await page.goto(process.env.LAB_ST_URL || 'http://127.0.0.1:8039/');
    await ready();
    for (const count of [200, 500, 1000]) {
        for (let repeat = 0; repeat < 3; repeat++) {
            const order = repeat % 2 ? [true, false] : [false, true];
            for (const enabled of order) {
                await page.evaluate(enabled => EchoPerformance.setEnabled(enabled, false), enabled);
                await startLongTasks();
                const loadTrace = await trace(() => openChat(count));
                const compactSettleMs = enabled ? await waitCompact(count) : (await page.waitForTimeout(300), 300);
                const initial = await snapshot();
                const loadLongTasks = await readLongTasks();
                await startLongTasks();
                const wheel = await realWheel();
                const wheelLongTasks = await readLongTasks();
                const final = await snapshot();
                const restore = enabled ? (final.stats.restoreSamples || []) : [];
                rows.push({
                    count, repeat, enabled,
                    loadMs: loadTrace.value,
                    compactSettleMs,
                    loadTrace: loadTrace.totals,
                    loadTraceCounts: loadTrace.counts,
                    initial,
                    loadLongTaskCount: loadLongTasks.length,
                    loadLongTaskTotalMs: loadLongTasks.reduce((n,x)=>n+x.duration,0),
                    wheel,
                    wheelLongTaskCount: wheelLongTasks.length,
                    wheelLongTaskTotalMs: wheelLongTasks.reduce((n,x)=>n+x.duration,0),
                    final,
                    restoreCount: restore.length,
                    restoreP95Ms: q(restore.map(x=>x.durationMs), .95),
                    restoreMaxMs: restore.length ? Math.max(...restore.map(x=>x.durationMs || 0)) : null,
                    driftP95Px: q(restore.map(x=>Math.abs(x.driftPx || 0)), .95),
                    driftMaxPx: restore.length ? Math.max(...restore.map(x=>Math.abs(x.driftPx || 0))) : null,
                    restoreSamples: restore,
                });
                await fs.writeFile(path.join(out, 'rows.json'), JSON.stringify({ rows, errors }, null, 2));
                console.log(JSON.stringify({ count, repeat, enabled, live: initial.liveMes, chatElements: initial.chatElements, pageNodes: initial.pageNodes, loadMs: Math.round(loadTrace.value), wheelP95: wheel.p95Ms, driftMax: rows.at(-1).driftMaxPx }));
            }
        }
    }
    const medians = [];
    for (const count of [200,500,1000]) for (const enabled of [false,true]) {
        const a = rows.filter(r => r.count===count && r.enabled===enabled);
        medians.push({
            count, enabled, repeats: a.length,
            liveMes: q(a.map(r=>r.initial.liveMes)),
            chatElements: q(a.map(r=>r.initial.chatElements)),
            chatNodes: q(a.map(r=>r.initial.chatNodes)),
            pageNodes: q(a.map(r=>r.initial.pageNodes)),
            heapMiB: q(a.map(r=>r.initial.heapUsed/1048576)),
            loadMs: q(a.map(r=>r.loadMs)),
            compactSettleMs: q(a.map(r=>r.compactSettleMs)),
            styleMs: q(a.map(r=>r.loadTrace.recalcStyleMs)),
            layoutMs: q(a.map(r=>r.loadTrace.layoutMs)),
            paintMs: q(a.map(r=>r.loadTrace.paintMs)),
            prePaintMs: q(a.map(r=>r.loadTrace.prePaintMs)),
            loadLongTasks: q(a.map(r=>r.loadLongTaskCount)),
            loadLongTaskTotalMs: q(a.map(r=>r.loadLongTaskTotalMs)),
            wheelP95Ms: q(a.map(r=>r.wheel.p95Ms)),
            wheelDropped33: q(a.map(r=>r.wheel.droppedOver33)),
            wheelLongTasks: q(a.map(r=>r.wheelLongTaskCount)),
            wheelLongTaskTotalMs: q(a.map(r=>r.wheelLongTaskTotalMs)),
            restoreP95Ms: enabled ? q(a.map(r=>r.restoreP95Ms)) : null,
            driftP95Px: enabled ? q(a.map(r=>r.driftP95Px)) : null,
            detachedChunks: enabled ? q(a.map(r=>r.initial.stats.detachedChunks)) : 0,
            mountedRanges: a.map(r=>r.initial.mountedRanges),
            detachedRanges: a.map(r=>r.initial.detachedRanges),
        });
    }
    await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ status: 'MEASURED', browser: await browser.version(), rows: medians, errors }, null, 2));
} finally {
    await browser.close();
}
