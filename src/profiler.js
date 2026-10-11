const PROFILE_MARK = Symbol.for('echo.performance.lightweight-profiler');

function finite(value) {
    return Number.isFinite(value) ? value : 0;
}

function clone(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function installLightweightProfiler({ viewport, bridge, root }) {
    if (globalThis[PROFILE_MARK]) return globalThis[PROFILE_MARK];

    const counters = {
        getContextCalls: 0,
        bridgeContextCalls: 0,
        mutationCallbacks: null,
        mutationRecords: null,
        compactSchedules: 0,
        compactRuns: 0,
        compactDuration: 0,
        restoreRuns: 0,
        restoreDuration: 0,
        releaseSweepSchedules: null,
        releaseSweepRuns: null,
        temporaryMounts: 0,
        traceWrites: 0,
        geometryTraceReads: null,
        statusRefreshes: 0,
        statusDomScans: 0,
        rAFSchedules: null,
        observerCallbacks: null,
        longTasks: 0,
        maxLongTask: 0,
        inputDelaySamples: [],
    };

    let expensive = false;
    let longTaskObserver = null;
    let eventObserver = null;
    const originals = [];

    const wrap = (object, key, wrapper) => {
        const original = object?.[key];
        if (typeof original !== 'function') return;
        const wrapped = wrapper(original);
        object[key] = wrapped;
        originals.push(() => {
            if (object[key] === wrapped) object[key] = original;
        });
    };

    wrap(viewport, 'scheduleCompact', original => function (...args) {
        counters.compactSchedules += 1;
        return Reflect.apply(original, this, args);
    });

    wrap(viewport, 'compactFarChunks', original => function (...args) {
        const started = performance.now();
        try {
            return Reflect.apply(original, this, args);
        } finally {
            counters.compactRuns += 1;
            counters.compactDuration += performance.now() - started;
        }
    });

    wrap(viewport, 'restoreChunk', original => function (...args) {
        const started = performance.now();
        try {
            return Reflect.apply(original, this, args);
        } finally {
            counters.restoreRuns += 1;
            counters.restoreDuration += performance.now() - started;
        }
    });

    wrap(bridge, 'ensure', original => function (mesId, ...args) {
        const chunk = viewport?.messageToChunk?.get?.(Number(mesId));
        if (chunk && !chunk.mounted) counters.temporaryMounts += 1;
        return Reflect.apply(original, this, [mesId, ...args]);
    });

    function stopExpensiveObservers() {
        longTaskObserver?.disconnect();
        eventObserver?.disconnect();
        longTaskObserver = null;
        eventObserver = null;
    }

    function setExpensive(enabled) {
        const next = Boolean(enabled);
        if (next === expensive) return expensive;
        expensive = next;
        stopExpensiveObservers();
        bridge?.setTraceGeometry?.(expensive);
        if (!expensive || typeof PerformanceObserver === 'undefined') return expensive;

        try {
            longTaskObserver = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    counters.longTasks += 1;
                    counters.maxLongTask = Math.max(counters.maxLongTask, finite(entry.duration));
                }
            });
            longTaskObserver.observe({ type: 'longtask', buffered: true });
        } catch {
            longTaskObserver = null;
        }

        try {
            eventObserver = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    const delay = finite(entry.processingStart) - finite(entry.startTime);
                    if (delay < 0) continue;
                    counters.inputDelaySamples.push({
                        name: entry.name,
                        delay,
                        duration: finite(entry.duration),
                        startTime: finite(entry.startTime),
                    });
                }
                if (counters.inputDelaySamples.length > 160) {
                    counters.inputDelaySamples.splice(0, counters.inputDelaySamples.length - 160);
                }
            });
            eventObserver.observe({ type: 'event', buffered: true, durationThreshold: 16 });
        } catch {
            eventObserver = null;
        }
        return expensive;
    }

    function markStatusRefresh({ domScan = false } = {}) {
        counters.statusRefreshes += 1;
        if (domScan) counters.statusDomScans += 1;
    }

    function reset() {
        for (const key of Object.keys(counters)) {
            if (Array.isArray(counters[key])) counters[key] = [];
            else if (counters[key] !== null) counters[key] = 0;
        }
    }

    function snapshot({ includeRuntimeStats = true } = {}) {
        const bridgeStats = bridge?.stats?.() ?? {};
        for (const key of [
            'getContextCalls', 'bridgeContextCalls',
            'releaseSweepSchedules', 'releaseSweepRuns',
            'rAFSchedules', 'traceWrites', 'geometryTraceReads',
        ]) {
            const value = Number(bridgeStats[key]);
            if (Number.isFinite(value)) counters[key] = value;
        }

        return {
            capturedAt: Date.now(),
            expensiveInstrumentation: expensive,
            counters: clone(counters),
            runtime: includeRuntimeStats ? {
                viewport: viewport?.stats?.() ?? null,
                bridge: bridgeStats,
                heapUsed: performance?.memory?.usedJSHeapSize ?? null,
                heapTotal: performance?.memory?.totalJSHeapSize ?? null,
                rootChildCount: root?.children?.length ?? null,
            } : null,
            notes: {
                nullCounters: 'Counters reported as null require internal hook instrumentation and are intentionally not approximated by global monkey-patching.',
                inputDelay: 'Event Timing collection is disabled by default and only starts after setExpensive(true).',
                runtimeStats: 'viewport.stats() performs DOM scans; profile() is an explicit diagnostic path, not a production hot path.',
            },
        };
    }

    const api = Object.freeze({
        snapshot,
        reset,
        setExpensive,
        markStatusRefresh,
        dispose() {
            stopExpensiveObservers();
            bridge?.setTraceGeometry?.(false);
            for (const restore of originals.reverse()) restore();
            delete globalThis[PROFILE_MARK];
        },
    });

    globalThis[PROFILE_MARK] = api;
    return api;
}
