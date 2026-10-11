const HOT_MESSAGE_COUNT = 100;
const CHUNK_SIZE = 50;
const PRELOAD_MARGIN_PX = 1600;
const EVICT_MARGIN_PX = 2600;
const COMPACT_DELAY_MS = 180;
const INTERACTION_PIN_MS = 1800;
const MAX_RESTORE_SAMPLES = 80;
const MUTATION_OPTIONS = { childList: true, subtree: true, characterData: true };

function numericMesId(element) {
    if (!(element instanceof Element)) return null;
    const value = Number(element.getAttribute('mesid'));
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function directMessages(root) {
    return [...root.querySelectorAll(':scope > .mes')].filter(element => numericMesId(element) !== null);
}

function directMessageById(root, mesId) {
    return root.querySelector(`:scope > .mes[mesid="${Number(mesId)}"]`);
}

function clampHeight(value) {
    return Number.isFinite(value) ? Math.max(1, value) : 1;
}

export class DomCompactor {
    constructor(root, getContext) {
        this.root = root;
        this.getContext = getContext;
        this.enabled = false;
        this.paused = false;
        this.generating = false;
        this.width = root.clientWidth;
        this.chunks = [];
        this.messageToChunk = new Map();
        this.pinned = new WeakSet();
        this.compactTimer = null;
        this.compactFrame = null;
        this.buildTimer = null;
        this.observingMutations = false;
        this.observingResize = false;
        this.internalMutation = false;
        this.chunkSerial = 0;
        this.lastCompactDurationMs = 0;
        this.lastReconcileDurationMs = 0;
        this.nativeReconciliations = 0;
        this.restoreSamples = [];
        this.onStateChange = null;
        this.performanceCounters = {
            mutationCallbacks: 0,
            mutationRecords: 0,
            intersectionObserverCallbacks: 0,
            intersectionObserverEntries: 0,
            resizeObserverCallbacks: 0,
            resizeObserverEntries: 0,
            observerCallbacks: 0,
            rAFSchedules: 0,
        };

        this.placeholderObserver = new IntersectionObserver(entries => {
            this.performanceCounters.intersectionObserverCallbacks += 1;
            this.performanceCounters.intersectionObserverEntries += entries.length;
            this.performanceCounters.observerCallbacks += 1;
            if (!this.enabled || this.paused || this.generating) return;
            const candidates = entries
                .filter(entry => entry.isIntersecting)
                .map(entry => this.chunks.find(chunk => chunk.placeholder === entry.target))
                .filter(chunk => chunk && !chunk.mounted)
                .sort((a, b) => b.endId - a.endId);
            if (!candidates.length) return;
            // Restore one chunk at a time. A large rootMargin can intersect two
            // neighboring placeholders; restoring both in the same frame defeats
            // the purpose of a bounded warm window.
            this.restoreChunk(candidates[0], { reason: 'viewport-preload' });
            this.scheduleCompact();
        }, { root, rootMargin: `${PRELOAD_MARGIN_PX}px 0px`, threshold: 0 });

        this.mutations = new MutationObserver(records => {
            this.performanceCounters.mutationCallbacks += 1;
            this.performanceCounters.mutationRecords += records.length;
            this.performanceCounters.observerCallbacks += 1;
            if (this.internalMutation || !this.enabled) return;
            let directStructureChanged = false;
            for (const record of records) {
                if (record.target === this.root && record.type === 'childList') directStructureChanged = true;
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                const shell = target?.closest?.('#chat > .mes');
                if (!shell) continue;
                const id = numericMesId(shell);
                const chunk = id === null ? null : this.messageToChunk.get(id);
                if (chunk) chunk.dirty = true;
            }
            if (directStructureChanged && !this.generating) this.scheduleBuild();
            this.scheduleCompact();
        });

        this.resize = new ResizeObserver(entries => {
            this.performanceCounters.resizeObserverCallbacks += 1;
            this.performanceCounters.resizeObserverEntries += entries.length;
            this.performanceCounters.observerCallbacks += 1;
            const width = this.root.clientWidth;
            if (!this.enabled || !width || Math.abs(width - this.width) < 1) return;
            this.width = width;
            // Cached placeholder heights are width-dependent. Rebuild from the
            // original nodes instead of guessing new wrapped text heights.
            this.rebuildFromLiveDom('resize');
        });
        this.onScroll = () => {
            if (!this.enabled || this.paused || this.generating) return;
            this.scheduleCompact();
        };
        this.root.addEventListener('scroll', this.onScroll, { passive: true });

        this.beforeInteraction = event => {
            if (!this.enabled || this.paused || this.generating) return;
            const shell = event.target instanceof Element ? event.target.closest('#chat > .mes') : null;
            if (!shell) return;
            const id = numericMesId(shell);
            const chunk = id === null ? null : this.messageToChunk.get(id);
            if (chunk) chunk.pinUntil = performance.now() + INTERACTION_PIN_MS;
        };
        for (const name of ['pointerdown', 'click', 'focusin', 'contextmenu']) {
            document.addEventListener(name, this.beforeInteraction, true);
        }

        document.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && ['f', 'a', 'p'].includes(event.key.toLowerCase())) this.pause();
        }, true);
        window.addEventListener('beforeprint', () => this.pause());
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled)
            && typeof IntersectionObserver !== 'undefined'
            && typeof MutationObserver !== 'undefined'
            && typeof DocumentFragment !== 'undefined';
        this.paused = false;
        if (!this.enabled) {
            this.restoreAll({ clear: true, reason: 'disabled' });
            this.disconnectMutationObserver();
            this.disconnectResizeObserver();
            this.cancelScheduledWork();
            this.onStateChange?.();
            return;
        }
        this.connectMutationObserver();
        this.connectResizeObserver();
        this.scheduleBuild(0);
        this.onStateChange?.();
    }

    pause() {
        if (!this.enabled) return;
        this.paused = true;
        this.restoreAll({ clear: false, reason: 'manual-pause' });
        this.disconnectMutationObserver();
        this.disconnectResizeObserver();
        this.cancelScheduledWork();
        this.onStateChange?.();
    }

    resume() {
        if (!this.enabled) return;
        this.paused = false;
        this.connectMutationObserver();
        this.connectResizeObserver();
        this.scheduleBuild(0);
        this.scheduleCompact();
        this.onStateChange?.();
    }

    generationStarted() {
        if (!this.enabled) return;
        this.generating = true;
        this.disconnectMutationObserver();
        this.disconnectResizeObserver();
        this.cancelScheduledWork();
        const context = this.getContext();
        if (context.chat.length) this.ensureMessageMounted(context.chat.length - 1, { reason: 'generation-start' });
        this.onStateChange?.();
    }

    generationEnded() {
        if (!this.enabled) return;
        this.generating = false;
        this.connectMutationObserver();
        this.connectResizeObserver();
        this.scheduleBuild(0);
        this.scheduleCompact();
        this.onStateChange?.();
    }

    lifecycle(type, ...args) {
        if (!this.enabled) return;
        switch (type) {
            case 'CHAT_CHANGED':
            case 'CHAT_LOADED':
            case 'CHAT_DELETED':
                this.discardDetachedState();
                this.scheduleBuild(0);
                return;
            case 'MORE_MESSAGES_LOADED':
                this.reconcileNativeRenders();
                this.scheduleBuild(80);
                this.scheduleCompact(320);
                return;
            case 'MESSAGE_DELETED':
                this.dropChunksPastChatEnd();
                this.scheduleBuild(80);
                this.scheduleCompact();
                return;
            default: {
                const mesId = Number(args[0]);
                if (Number.isInteger(mesId) && mesId >= 0 && this.messageToChunk.has(mesId)) {
                    this.ensureMessageMounted(mesId, { reason: `native-${type.toLowerCase()}` });
                }
                this.scheduleBuild(80);
                this.scheduleCompact();
            }
        }
    }

    scheduleBuild(delay = 80) {
        if (!this.enabled || this.paused || this.generating) return;
        clearTimeout(this.buildTimer);
        this.buildTimer = setTimeout(() => {
            this.buildTimer = null;
            if (!this.enabled || this.paused || this.generating) return;
            this.buildColdChunks();
        }, delay);
    }

    scheduleCompact(delay = COMPACT_DELAY_MS) {
        if (!this.enabled || this.paused || this.generating) return;
        clearTimeout(this.compactTimer);
        this.compactTimer = setTimeout(() => {
            this.compactTimer = null;
            if (this.compactFrame) cancelAnimationFrame(this.compactFrame);
            this.performanceCounters.rAFSchedules += 1;
            this.compactFrame = requestAnimationFrame(() => {
                this.compactFrame = null;
                this.compactFarChunks();
            });
        }, delay);
    }

    cancelScheduledWork() {
        clearTimeout(this.compactTimer);
        clearTimeout(this.buildTimer);
        if (this.compactFrame) cancelAnimationFrame(this.compactFrame);
        this.compactTimer = null;
        this.buildTimer = null;
        this.compactFrame = null;
    }

    connectMutationObserver() {
        if (this.observingMutations || !this.enabled) return;
        this.mutations.observe(this.root, MUTATION_OPTIONS);
        this.observingMutations = true;
    }

    disconnectMutationObserver() {
        this.mutations.disconnect();
        this.observingMutations = false;
    }

    connectResizeObserver() {
        if (this.observingResize || !this.enabled || this.paused || this.generating) return;
        this.resize.observe(this.root);
        this.observingResize = true;
    }

    disconnectResizeObserver() {
        this.resize.disconnect();
        this.observingResize = false;
    }

    withMutationSilenced(fn) {
        const reconnect = this.observingMutations;
        if (reconnect) this.disconnectMutationObserver();
        this.internalMutation = true;
        try {
            return fn();
        } finally {
            this.internalMutation = false;
            if (reconnect && this.enabled && !this.paused && !this.generating) this.connectMutationObserver();
        }
    }

    isChunkable(shell) {
        if (!(shell instanceof HTMLElement) || shell.parentElement !== this.root) return false;
        if (shell.hasAttribute('data-echo-keep') || shell.hasAttribute('data-echo-no-detach') || this.pinned.has(shell)) return false;
        if (shell.contains(document.activeElement)) return false;
        // Detaching an active browsing context or media element can reset state.
        // Keep those rare shells live in the first prototype; ordinary plugin
        // attributes/listeners on the message node are preserved by detach.
        if (shell.querySelector('iframe, video, audio, canvas, [contenteditable="true"], textarea:focus, input:focus')) return false;
        return true;
    }

    buildColdChunks() {
        if (!this.enabled || this.paused || this.generating) return;
        const started = performance.now();
        this.reconcileNativeRenders();
        const context = this.getContext();
        const hotStart = Math.max(0, context.chat.length - HOT_MESSAGE_COUNT);
        const shells = directMessages(this.root);
        if (shells.length <= HOT_MESSAGE_COUNT + CHUNK_SIZE) return;

        const newChunks = [];
        let segment = [];
        const flushSegment = () => {
            if (!segment.length) return;
            for (let i = 0; i < segment.length; i += CHUNK_SIZE) {
                const nodes = segment.slice(i, i + CHUNK_SIZE);
                if (nodes.length) newChunks.push(this.registerChunk(nodes));
            }
            segment = [];
        };

        for (const shell of shells) {
            const id = numericMesId(shell);
            const tracked = id === null ? null : this.messageToChunk.get(id);
            if (id !== null && id < hotStart && !tracked && this.isChunkable(shell)) {
                segment.push(shell);
            } else {
                flushSegment();
            }
        }
        flushSegment();
        if (!newChunks.length) return;

        const rootRect = this.root.getBoundingClientRect();
        const newestChunk = newChunks.reduce((best, chunk) => !best || chunk.endId > best.endId ? chunk : best, null);
        const toDetach = [];
        for (const chunk of newChunks) {
            const first = chunk.nodes[0];
            const last = chunk.nodes.at(-1);
            const firstRect = first.getBoundingClientRect();
            const lastRect = last.getBoundingClientRect();
            const visible = lastRect.bottom >= rootRect.top - 400 && firstRect.top <= rootRect.bottom + 400;
            // Keep exactly one newest cold chunk as the initial warm zone.
            if (visible || chunk === newestChunk) continue;
            toDetach.push(chunk);
        }
        this.compactMany(toDetach, 'initial-build');
        this.lastCompactDurationMs = performance.now() - started;
        this.scheduleCompact();
        this.onStateChange?.();
    }

    registerChunk(nodes) {
        const ids = nodes.map(numericMesId).filter(id => id !== null);
        const chunk = {
            id: ++this.chunkSerial,
            startId: Math.min(...ids),
            endId: Math.max(...ids),
            nodes: [...nodes],
            fragment: document.createDocumentFragment(),
            placeholder: null,
            height: 0,
            mounted: true,
            dirty: false,
            pinUntil: 0,
        };
        this.chunks.push(chunk);
        for (const id of ids) this.messageToChunk.set(id, chunk);
        return chunk;
    }

    measureChunkHeight(chunk) {
        const connected = chunk.nodes.filter(node => node.parentElement === this.root);
        if (!connected.length) return clampHeight(chunk.height);
        const first = connected[0];
        const last = connected.at(-1);
        const firstRect = first.getBoundingClientRect();
        const next = last.nextElementSibling;
        let height;
        if (next instanceof HTMLElement) {
            height = next.getBoundingClientRect().top - firstRect.top;
        } else {
            height = last.getBoundingClientRect().bottom - firstRect.top;
            const marginBottom = parseFloat(getComputedStyle(last).marginBottom);
            if (Number.isFinite(marginBottom)) height += marginBottom;
        }
        return clampHeight(height);
    }

    createPlaceholder(chunk, height) {
        const placeholder = document.createElement('div');
        placeholder.className = 'echo-dom-chunk-placeholder';
        placeholder.dataset.echoChunk = String(chunk.id);
        placeholder.dataset.echoStart = String(chunk.startId);
        placeholder.dataset.echoEnd = String(chunk.endId);
        placeholder.setAttribute('aria-hidden', 'true');
        this.setPlaceholderHeight(placeholder, height);
        return placeholder;
    }

    setPlaceholderHeight(placeholder, height) {
        const px = `${clampHeight(height)}px`;
        placeholder.style.height = px;
        placeholder.style.minHeight = px;
        placeholder.style.flex = `0 0 ${px}`;
    }

    compactMany(chunks, reason = 'compact') {
        const candidates = chunks.filter(chunk => this.canCompactChunk(chunk));
        if (!candidates.length) return;
        const measurements = candidates.map(chunk => [chunk, this.measureChunkHeight(chunk)]);
        const started = performance.now();
        this.withScrollAnchor(() => this.withMutationSilenced(() => {
            for (const [chunk, height] of measurements) this.detachChunkInternal(chunk, height);
        }), { type: 'compact', reason, range: [candidates[0].startId, candidates.at(-1).endId] });
        this.lastCompactDurationMs = performance.now() - started;
    }

    canCompactChunk(chunk) {
        if (!chunk?.mounted || !chunk.nodes.length || performance.now() < chunk.pinUntil) return false;
        if (chunk.nodes.some(node => node.parentElement !== this.root || node.contains(document.activeElement) || this.pinned.has(node))) return false;
        return true;
    }

    detachChunkInternal(chunk, height) {
        if (!this.canCompactChunk(chunk)) return false;
        const first = chunk.nodes[0];
        const placeholder = chunk.placeholder ?? this.createPlaceholder(chunk, height);
        this.setPlaceholderHeight(placeholder, height);
        chunk.height = clampHeight(height);
        chunk.placeholder = placeholder;
        this.root.insertBefore(placeholder, first);
        const fragment = document.createDocumentFragment();
        for (const node of chunk.nodes) {
            if (node.parentElement === this.root) fragment.append(node);
        }
        chunk.fragment = fragment;
        chunk.mounted = false;
        chunk.dirty = false;
        this.placeholderObserver.observe(placeholder);
        return true;
    }

    compactFarChunks() {
        if (!this.enabled || this.paused || this.generating) return;
        const rootRect = this.root.getBoundingClientRect();
        const far = [];
        for (const chunk of this.chunks) {
            if (!this.canCompactChunk(chunk)) continue;
            const connected = chunk.nodes.filter(node => node.parentElement === this.root);
            if (!connected.length) continue;
            const firstRect = connected[0].getBoundingClientRect();
            const lastRect = connected.at(-1).getBoundingClientRect();
            const isFar = lastRect.bottom < rootRect.top - EVICT_MARGIN_PX || firstRect.top > rootRect.bottom + EVICT_MARGIN_PX;
            if (isFar) far.push(chunk);
        }
        if (far.length) this.compactMany(far, 'far-evict');
        this.onStateChange?.();
    }

    restoreChunk(chunk, { reason = 'ensure-message' } = {}) {
        if (!chunk || chunk.mounted) return chunk?.nodes?.find(node => node.parentElement === this.root) ?? null;
        const started = performance.now();
        this.withScrollAnchor(() => this.withMutationSilenced(() => {
            this.removeForeignNodesForChunk(chunk);
            this.restoreChunkInternal(chunk);
        }), { type: 'restore', reason, range: [chunk.startId, chunk.endId], started });
        this.scheduleCompact();
        this.onStateChange?.();
        return chunk.nodes.find(node => node.parentElement === this.root) ?? null;
    }

    restoreChunkInternal(chunk) {
        if (!chunk || chunk.mounted) return;
        if (chunk.placeholder) this.placeholderObserver.unobserve(chunk.placeholder);
        const insertionPoint = chunk.placeholder?.parentElement === this.root
            ? chunk.placeholder
            : this.findInsertionPoint(chunk.endId);
        this.root.insertBefore(chunk.fragment, insertionPoint ?? null);
        if (chunk.placeholder?.parentElement === this.root) chunk.placeholder.remove();
        chunk.fragment = document.createDocumentFragment();
        chunk.mounted = true;
        chunk.dirty = false;
    }

    findInsertionPoint(endId) {
        for (const child of this.root.children) {
            if (child.classList.contains('echo-dom-chunk-placeholder')) {
                const start = Number(child.dataset.echoStart);
                if (Number.isInteger(start) && start > endId) return child;
            }
            const id = numericMesId(child);
            if (id !== null && id > endId) return child;
        }
        return null;
    }

    removeForeignNodesForChunk(chunk) {
        const originals = new Set(chunk.nodes);
        for (const shell of directMessages(this.root)) {
            const id = numericMesId(shell);
            if (id === null || id < chunk.startId || id > chunk.endId) continue;
            if (!originals.has(shell)) shell.remove();
        }
    }

    ensureMessageMounted(mesId, { reason = 'ensure-message' } = {}) {
        const id = Number(mesId);
        if (!Number.isInteger(id) || id < 0) return null;
        const existing = directMessageById(this.root, id);
        const chunk = this.messageToChunk.get(id);
        if (existing instanceof HTMLElement && (!chunk || chunk.nodes.includes(existing))) return existing;
        if (!chunk) return existing instanceof HTMLElement ? existing : null;
        if (!chunk.mounted) this.restoreChunk(chunk, { reason });
        const original = chunk.nodes.find(node => numericMesId(node) === id && node.parentElement === this.root);
        return original ?? directMessageById(this.root, id);
    }

    reconcileNativeRenders() {
        if (!this.enabled || this.internalMutation) return;
        const started = performance.now();
        const affected = new Set();
        const foreign = [];
        for (const shell of directMessages(this.root)) {
            const id = numericMesId(shell);
            const chunk = id === null ? null : this.messageToChunk.get(id);
            if (!chunk || chunk.nodes.includes(shell)) continue;
            affected.add(chunk);
            foreign.push(shell);
        }
        if (!affected.size) return;

        this.withScrollAnchor(() => this.withMutationSilenced(() => {
            for (const shell of foreign) shell.remove();
            for (const chunk of [...affected].sort((a, b) => a.startId - b.startId)) {
                if (!chunk.mounted) this.restoreChunkInternal(chunk);
            }
        }), { type: 'restore', reason: 'native-more-messages', range: [Math.min(...[...affected].map(c => c.startId)), Math.max(...[...affected].map(c => c.endId))], started });
        this.nativeReconciliations += 1;
        this.lastReconcileDurationMs = performance.now() - started;
        this.scheduleCompact(320);
    }

    findVisualAnchor() {
        const rootRect = this.root.getBoundingClientRect();
        for (const shell of directMessages(this.root)) {
            const rect = shell.getBoundingClientRect();
            if (rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1) {
                return { element: shell, top: rect.top };
            }
        }
        return null;
    }

    withScrollAnchor(action, sample = null) {
        const anchor = this.findVisualAnchor();
        const beforeScrollTop = this.root.scrollTop;
        const beforeHeight = this.root.scrollHeight;
        const beforeAnchorTop = anchor?.top ?? null;
        const started = sample?.started ?? performance.now();
        action();
        const afterHeight = this.root.scrollHeight;

        if (anchor?.element?.isConnected && anchor.element.parentElement === this.root) {
            const afterTop = anchor.element.getBoundingClientRect().top;
            this.root.scrollTop += afterTop - beforeAnchorTop;
        } else {
            this.root.scrollTop = beforeScrollTop + (afterHeight - beforeHeight);
        }

        const finalTop = anchor?.element?.isConnected && anchor.element.parentElement === this.root
            ? anchor.element.getBoundingClientRect().top
            : null;
        const drift = beforeAnchorTop === null || finalTop === null ? 0 : finalTop - beforeAnchorTop;
        if (sample) {
            this.restoreSamples.push({
                type: sample.type,
                reason: sample.reason,
                startId: sample.range?.[0] ?? null,
                endId: sample.range?.[1] ?? null,
                durationMs: performance.now() - started,
                beforeScrollTop,
                afterScrollTop: this.root.scrollTop,
                scrollHeightDelta: this.root.scrollHeight - beforeHeight,
                driftPx: drift,
            });
            if (this.restoreSamples.length > MAX_RESTORE_SAMPLES) this.restoreSamples.splice(0, this.restoreSamples.length - MAX_RESTORE_SAMPLES);
        }
    }

    restoreAll({ clear = false, reason = 'restore-all' } = {}) {
        const detached = this.chunks.filter(chunk => !chunk.mounted);
        if (detached.length) {
            const started = performance.now();
            this.withScrollAnchor(() => this.withMutationSilenced(() => {
                for (const chunk of detached.sort((a, b) => a.startId - b.startId)) {
                    this.removeForeignNodesForChunk(chunk);
                    this.restoreChunkInternal(chunk);
                }
            }), { type: 'restore', reason, range: [detached[0].startId, detached.at(-1).endId], started });
        }
        if (clear) this.clearChunkRegistry();
        this.onStateChange?.();
    }

    clearChunkRegistry() {
        this.placeholderObserver.disconnect();
        for (const placeholder of this.root.querySelectorAll(':scope > .echo-dom-chunk-placeholder')) placeholder.remove();
        this.chunks = [];
        this.messageToChunk.clear();
    }

    discardDetachedState() {
        this.cancelScheduledWork();
        this.withMutationSilenced(() => {
            for (const placeholder of this.root.querySelectorAll(':scope > .echo-dom-chunk-placeholder')) placeholder.remove();
        });
        this.placeholderObserver.disconnect();
        this.chunks = [];
        this.messageToChunk.clear();
        this.restoreSamples = [];
    }

    rebuildFromLiveDom(reason = 'rebuild') {
        if (!this.enabled || this.paused || this.generating) return;
        this.restoreAll({ clear: true, reason });
        this.performanceCounters.rAFSchedules += 2;
        requestAnimationFrame(() => requestAnimationFrame(() => this.scheduleBuild(0)));
    }

    dropChunksPastChatEnd() {
        const length = this.getContext().chat.length;
        const keep = [];
        for (const chunk of this.chunks) {
            if (chunk.startId < length) {
                keep.push(chunk);
                continue;
            }
            if (chunk.placeholder) this.placeholderObserver.unobserve(chunk.placeholder);
            if (chunk.placeholder?.parentElement === this.root) chunk.placeholder.remove();
            for (const node of chunk.nodes) this.messageToChunk.delete(numericMesId(node));
        }
        this.chunks = keep;
    }

    pin(shell) {
        if (!(shell instanceof HTMLElement)) return;
        this.pinned.add(shell);
        shell.setAttribute('data-echo-keep', '');
        const id = numericMesId(shell);
        const chunk = id === null ? null : this.messageToChunk.get(id);
        if (chunk && !chunk.mounted) this.restoreChunk(chunk, { reason: 'pin' });
    }

    performanceStats() {
        return { ...this.performanceCounters };
    }

    stats({ includeDomScan = true } = {}) {
        const liveMessages = directMessages(this.root).length;
        const detachedMessages = this.chunks.reduce((count, chunk) => count + (chunk.mounted ? 0 : chunk.nodes.length), 0);
        const mountedColdMessages = this.chunks.reduce((count, chunk) => count + (chunk.mounted ? chunk.nodes.length : 0), 0);
        return {
            enabled: this.enabled,
            paused: this.paused,
            generating: this.generating,
            hotMessageTarget: HOT_MESSAGE_COUNT,
            chunkSize: CHUNK_SIZE,
            liveMessageShells: liveMessages,
            detachedMessageShells: detachedMessages,
            mountedColdMessages,
            chunkCount: this.chunks.length,
            detachedChunks: this.chunks.filter(chunk => !chunk.mounted).length,
            mountedColdChunks: this.chunks.filter(chunk => chunk.mounted).length,
            placeholderCount: this.root.querySelectorAll(':scope > .echo-dom-chunk-placeholder').length,
            liveChatElements: includeDomScan ? this.root.querySelectorAll('*').length : null,
            performanceCounters: this.performanceStats(),
            nativeReconciliations: this.nativeReconciliations,
            lastCompactDurationMs: this.lastCompactDurationMs,
            lastReconcileDurationMs: this.lastReconcileDurationMs,
            restoreSamples: [...this.restoreSamples],
        };
    }
}
