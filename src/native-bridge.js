const BRIDGE_MARK = Symbol.for('echo.performance.native-cold-bridge');
const COMMAND_BRIDGE_MARK = Symbol.for('echo.performance.chat-jump-bridge');
const OPERATION_GUARD_MS = 60000;
const TRACE_LIMIT = 240;
const COLD_CLICK_SELECTOR = [
    '.mes_edit',
    '.mes_reasoning_header',
    '.mes_reasoning_header_title',
    '.mes_swipe_picker',
    '.swipes-counter.swipe-picker-enabled',
    '.swipe_left',
    '.swipe_right',
].join(', ');

function numericMesId(shell) {
    if (!(shell instanceof Element)) return null;
    const value = Number(shell.getAttribute('mesid'));
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function frame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
}

async function twoFrames() {
    await frame();
    await frame();
}

function visibleInRoot(root, node) {
    if (!(root instanceof HTMLElement) || !(node instanceof HTMLElement)) return false;
    const rr = root.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    return nr.bottom > rr.top && nr.top < rr.bottom;
}

function resolveSwipeMesId(context, event, options = {}) {
    const forced = Number(options?.forceMesId);
    if (Number.isInteger(forced) && forced >= 0) return forced;

    const fromEvent = Number(event?.currentTarget?.closest?.('.mes')?.getAttribute?.('mesid'));
    if (Number.isInteger(fromEvent) && fromEvent >= 0) return fromEvent;

    if (options?.message && Array.isArray(context.chat)) {
        const index = context.chat.indexOf(options.message);
        if (index >= 0) return index;
    }

    return Array.isArray(context.chat) && context.chat.length ? context.chat.length - 1 : null;
}

function extractChatJumpTarget(value) {
    const text = String(value ?? '');
    const match = text.match(/(?:^|[\n|;])\s*\/(?:chat-jump|chat-scrollto|floor-teleport)\s+(-?\d+)/i);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

function commandTarget(value) {
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

export function installNativeColdBridge(viewport, nativeGetContext) {
    if (!viewport || typeof nativeGetContext !== 'function' || !globalThis.SillyTavern) {
        return { attachCurrent: () => {}, lifecycle: () => {}, stats: () => ({ installed: false }), trace: () => [] };
    }

    if (globalThis.SillyTavern[BRIDGE_MARK]) return globalThis.SillyTavern[BRIDGE_MARK];

    const attachedShells = new WeakSet();
    const temporaryMounts = new Map();
    const safetyTimers = new Map();
    const jumpLocks = new Map();
    const lifecycleTrace = [];
    const bridgeStats = {
        installed: true,
        apiMounts: 0,
        domRedispatches: 0,
        jumpPreMounts: 0,
        jumpFallbackScrolls: 0,
        inputPreMounts: 0,
        deferredCompacts: 0,
        commandBridgeInstalled: false,
        commandBridgeInvocations: 0,
        safetyReleases: 0,
    };
    let commandBridgeAttempts = 0;
    let commandBridgeTimer = null;
    let releaseSweepFrame = null;

    function describeActiveElement(chunk) {
        const active = document.activeElement;
        if (!(active instanceof Element)) return { activeElement: null, activeInChunk: false };
        const activeInChunk = Boolean(chunk?.nodes?.some(node => node.contains(active)));
        return {
            activeElement: {
                tag: active.tagName,
                id: active.id || null,
                className: typeof active.className === 'string' ? active.className : null,
            },
            activeInChunk,
        };
    }

    function chunkEligibility(chunk) {
        if (!chunk) return null;
        const root = viewport.root;
        const connected = chunk.nodes.filter(node => node.parentElement === root);
        const rootRect = root instanceof HTMLElement ? root.getBoundingClientRect() : null;
        const firstRect = connected[0]?.getBoundingClientRect?.() ?? null;
        const lastRect = connected.at(-1)?.getBoundingClientRect?.() ?? null;
        const far = Boolean(rootRect && firstRect && lastRect
            && (lastRect.bottom < rootRect.top - 2600 || firstRect.top > rootRect.bottom + 2600));
        const foreignParent = chunk.mounted && chunk.nodes.some(node => node.parentElement !== root);
        const pinnedNode = chunk.nodes.some(node => viewport.pinned?.has?.(node));
        const active = describeActiveElement(chunk);
        return {
            chunkId: chunk.id,
            range: [chunk.startId, chunk.endId],
            mounted: Boolean(chunk.mounted),
            pinRemainingMs: Math.max(0, Number(chunk.pinUntil || 0) - performance.now()),
            activeInChunk: active.activeInChunk,
            activeElement: active.activeElement,
            foreignParent,
            pinnedNode,
            connectedCount: connected.length,
            far,
            canCompact: typeof viewport.canCompactChunk === 'function' ? viewport.canCompactChunk(chunk) : null,
            rootScrollTop: root instanceof HTMLElement ? root.scrollTop : null,
            rootScrollHeight: root instanceof HTMLElement ? root.scrollHeight : null,
            firstTop: firstRect?.top ?? null,
            lastBottom: lastRect?.bottom ?? null,
            rootTop: rootRect?.top ?? null,
            rootBottom: rootRect?.bottom ?? null,
        };
    }

    function snapshotRecord(record) {
        if (!record) return null;
        return {
            mesId: record.mesId,
            chunkId: record.chunkId,
            mountReason: record.mountReason,
            mountedAt: record.mountedAt,
            temporaryPin: record.temporaryPin,
            activeOperations: record.activeOperations,
            operationFinished: record.operationFinished,
            releaseRequested: record.releaseRequested,
            eligibleForCompact: record.eligibleForCompact,
            compactAttempted: record.compactAttempted,
            compactResult: record.compactResult ? structuredClone(record.compactResult) : null,
        };
    }

    function pushTrace(event, { mesId = null, chunk = null, reason = null, releaseReason = null, extra = null } = {}) {
        const id = Number(mesId);
        const record = Number.isInteger(id) ? temporaryMounts.get(id) ?? null : null;
        lifecycleTrace.push({
            event,
            at: performance.now(),
            mesId: Number.isInteger(id) ? id : null,
            chunkId: chunk?.id ?? record?.chunkId ?? null,
            mountReason: reason ?? record?.mountReason ?? null,
            releaseReason,
            temporaryMount: snapshotRecord(record),
            eligibility: chunkEligibility(chunk),
            extra,
        });
        if (lifecycleTrace.length > TRACE_LIMIT) lifecycleTrace.splice(0, lifecycleTrace.length - TRACE_LIMIT);
    }

    function chunkFor(mesId) {
        return viewport.messageToChunk?.get?.(Number(mesId)) ?? null;
    }

    function createTemporaryMount(mesId, chunk, reason) {
        const record = {
            mesId: Number(mesId),
            chunkId: chunk?.id ?? null,
            mountReason: reason ?? 'temporary-mount',
            mountedAt: null,
            temporaryPin: true,
            activeOperations: 0,
            operationFinished: false,
            releaseRequested: false,
            eligibleForCompact: false,
            compactAttempted: false,
            compactResult: null,
            _attemptInFlight: false,
            _lastBlockReason: null,
        };
        temporaryMounts.set(record.mesId, record);
        armSafetyRelease(record);
        return record;
    }

    function getTemporaryMount(mesId, reason = null, { createForDetached = true } = {}) {
        const id = Number(mesId);
        if (!Number.isInteger(id) || id < 0) return { record: null, chunk: null };
        const chunk = chunkFor(id);
        let record = temporaryMounts.get(id) ?? null;
        if (!record && createForDetached && chunk && !chunk.mounted) record = createTemporaryMount(id, chunk, reason);
        if (record && chunk) record.chunkId = chunk.id;
        return { record, chunk };
    }

    function clearSafetyTimer(mesId) {
        const timer = safetyTimers.get(Number(mesId));
        if (timer !== undefined) clearTimeout(timer);
        safetyTimers.delete(Number(mesId));
    }

    function armSafetyRelease(record) {
        if (!record) return;
        clearSafetyTimer(record.mesId);
        safetyTimers.set(record.mesId, setTimeout(() => {
            safetyTimers.delete(record.mesId);
            const current = temporaryMounts.get(record.mesId);
            if (current !== record || record.releaseRequested) return;
            bridgeStats.safetyReleases += 1;
            pushTrace('operation-timeout', {
                mesId: record.mesId,
                chunk: chunkFor(record.mesId),
                reason: record.mountReason,
                releaseReason: 'operation-guard-timeout',
                extra: { activeOperations: record.activeOperations },
            });
            record.activeOperations = 0;
            record.operationFinished = true;
            record.temporaryPin = false;
            jumpLocks.delete(record.mesId);
            requestRelease(record, 'operation-guard-timeout');
        }, OPERATION_GUARD_MS));
    }

    function incrementJumpLock(mesId) {
        const id = Number(mesId);
        jumpLocks.set(id, (jumpLocks.get(id) ?? 0) + 1);
    }

    function decrementJumpLock(mesId) {
        const id = Number(mesId);
        const next = Math.max(0, (jumpLocks.get(id) ?? 0) - 1);
        if (next) jumpLocks.set(id, next);
        else jumpLocks.delete(id);
    }

    function isJumpReason(reason) {
        return String(reason ?? '').includes('chat-jump') || String(reason ?? '').includes('chat-scrollto') || String(reason ?? '').includes('floor-teleport');
    }

    function beginOperation(mesId, reason) {
        const id = Number(mesId);
        const { record, chunk } = getTemporaryMount(id, reason, { createForDetached: true });
        if (record) {
            record.activeOperations += 1;
            record.operationFinished = false;
            record.releaseRequested = false;
            record.eligibleForCompact = false;
            record.compactAttempted = false;
            record.compactResult = null;
            record.temporaryPin = true;
            record._attemptInFlight = false;
            record._lastBlockReason = null;
            if (isJumpReason(reason)) incrementJumpLock(id);
            armSafetyRelease(record);
        }
        pushTrace('operation-started', {
            mesId: id,
            chunk,
            reason,
            extra: { activeOperations: record?.activeOperations ?? 0, temporary: Boolean(record) },
        });
        return record;
    }

    function finishOperation(mesId, reason, releaseReason = 'operation-complete') {
        const id = Number(mesId);
        const record = temporaryMounts.get(id) ?? null;
        const chunk = chunkFor(id);
        if (record) {
            record.activeOperations = Math.max(0, record.activeOperations - 1);
            if (isJumpReason(reason)) decrementJumpLock(id);
        }
        pushTrace('operation-finished', {
            mesId: id,
            chunk,
            reason,
            releaseReason,
            extra: { activeOperations: record?.activeOperations ?? 0 },
        });
        if (!record || record.activeOperations !== 0) return;
        record.operationFinished = true;
        record.temporaryPin = false;
        requestRelease(record, releaseReason);
    }

    function requestRelease(record, releaseReason) {
        if (!record) return;
        record.releaseRequested = true;
        clearSafetyTimer(record.mesId);
        pushTrace('release-requested', {
            mesId: record.mesId,
            chunk: chunkFor(record.mesId),
            reason: record.mountReason,
            releaseReason,
            extra: { activeOperations: record.activeOperations },
        });
        scheduleReleaseSweep();
    }

    function interactiveLockReason(record, chunk) {
        if (!chunk?.mounted) return null;
        if (chunk.nodes.some(node => node.querySelector?.('.edit_textarea, textarea:focus, input:focus, [contenteditable="true"]:focus'))) {
            return 'editing-lock';
        }
        const active = document.activeElement;
        if (active instanceof Element && chunk.nodes.some(node => node.contains(active))) return 'focus-lock';
        if (String(record?.mountReason ?? '').includes('reasoning') && chunk.nodes.some(node => node.querySelector?.('details[open]'))) {
            return 'reasoning-open';
        }
        return null;
    }

    function siblingLockReason(record, chunk) {
        if (!chunk) return null;
        for (const other of temporaryMounts.values()) {
            if (other === record || other.chunkId !== chunk.id) continue;
            if (other.activeOperations > 0) return 'chunk-operation-active';
            if (!other.releaseRequested) return 'chunk-temporary-mount-active';
        }
        return null;
    }

    function releaseBlockReason(record, chunk) {
        if (!record.releaseRequested) return 'release-not-requested';
        if (record.activeOperations !== 0) return 'operation-active';
        if (!viewport.enabled) return 'viewport-disabled';
        if (viewport.paused) return 'viewport-paused';
        if (viewport.generating) return 'generation-lock';
        if ((jumpLocks.get(record.mesId) ?? 0) > 0) return 'jump-lock';
        if (!chunk) return 'chunk-missing';
        const interaction = interactiveLockReason(record, chunk);
        if (interaction) return interaction;
        return siblingLockReason(record, chunk);
    }

    function emitBlocked(record, chunk, reason) {
        if (record._lastBlockReason === reason) return;
        record._lastBlockReason = reason;
        record.eligibleForCompact = false;
        record.compactResult = { result: 'blocked', reason };
        pushTrace('compact-result', {
            mesId: record.mesId,
            chunk,
            reason: record.mountReason,
            releaseReason: reason,
            extra: { result: 'blocked', reason, attempted: false },
        });
    }

    function finishDetachedChunk(chunk) {
        if (!chunk) return;
        for (const record of [...temporaryMounts.values()]) {
            if (record.chunkId !== chunk.id) continue;
            record.eligibleForCompact = true;
            record.compactResult = { result: 'detached' };
            pushTrace('compact-result', {
                mesId: record.mesId,
                chunk,
                reason: record.mountReason,
                releaseReason: 'detached',
                extra: { result: 'detached' },
            });
            clearSafetyTimer(record.mesId);
            temporaryMounts.delete(record.mesId);
            jumpLocks.delete(record.mesId);
        }
    }

    function observeCompactResult(record, chunk) {
        setTimeout(() => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const current = temporaryMounts.get(record.mesId);
                if (current !== record) return;
                record._attemptInFlight = false;
                if (!chunk.mounted) {
                    finishDetachedChunk(chunk);
                    return;
                }

                const eligibility = chunkEligibility(chunk);
                let reason = releaseBlockReason(record, chunk);
                if (!reason && !eligibility?.far) reason = 'not-far';
                if (!reason && eligibility?.canCompact === false) reason = 'chunk-ineligible';
                if (!reason) reason = 'compact-not-detached';
                record.compactResult = { result: 'blocked', reason };
                record._lastBlockReason = reason;
                pushTrace('compact-result', {
                    mesId: record.mesId,
                    chunk,
                    reason: record.mountReason,
                    releaseReason: reason,
                    extra: { result: 'blocked', reason, attempted: true },
                });
            }));
        }, 0);
    }

    function attemptRelease(record) {
        if (!record || record._attemptInFlight) return;
        const chunk = chunkFor(record.mesId);
        if (chunk && !chunk.mounted) {
            finishDetachedChunk(chunk);
            return;
        }
        const blocked = releaseBlockReason(record, chunk);
        if (blocked) {
            emitBlocked(record, chunk, blocked);
            return;
        }

        record.eligibleForCompact = true;
        record._lastBlockReason = null;
        pushTrace('eligible-for-compact', {
            mesId: record.mesId,
            chunk,
            reason: record.mountReason,
            extra: { activeOperations: record.activeOperations },
        });

        // Bridge-owned temporary mounts use operation state as the release authority.
        // A click/focus pin created while the temporary chunk was mounted must not
        // turn normal release back into a timer-driven lifecycle.
        if (chunk && Number(chunk.pinUntil || 0) > performance.now()) chunk.pinUntil = 0;

        record.compactAttempted = true;
        record._attemptInFlight = true;
        bridgeStats.deferredCompacts += 1;
        pushTrace('compact-attempted', {
            mesId: record.mesId,
            chunk,
            reason: record.mountReason,
            extra: { activeOperations: record.activeOperations },
        });
        viewport.scheduleCompact?.(0);
        observeCompactResult(record, chunk);
    }

    function runReleaseSweep() {
        releaseSweepFrame = null;
        for (const record of [...temporaryMounts.values()]) {
            if (record.releaseRequested) attemptRelease(record);
        }
    }

    function scheduleReleaseSweep() {
        if (releaseSweepFrame !== null) return;
        releaseSweepFrame = requestAnimationFrame(() => {
            releaseSweepFrame = requestAnimationFrame(runReleaseSweep);
        });
    }

    function resetTemporaryMounts(reason) {
        if (!temporaryMounts.size) return;
        for (const record of temporaryMounts.values()) {
            clearSafetyTimer(record.mesId);
            pushTrace('temporary-mount-reset', {
                mesId: record.mesId,
                chunk: chunkFor(record.mesId),
                reason: record.mountReason,
                releaseReason: reason,
            });
        }
        temporaryMounts.clear();
        jumpLocks.clear();
    }

    function ensure(mesId, reason) {
        const id = Number(mesId);
        if (!Number.isInteger(id) || id < 0) return null;
        const { record, chunk } = getTemporaryMount(id, reason, { createForDetached: true });
        pushTrace('mount-requested', {
            mesId: id,
            chunk,
            reason,
            extra: { activeOperations: record?.activeOperations ?? 0, temporary: Boolean(record) },
        });
        const node = viewport.ensureMessageMounted(id, { reason });
        if (node instanceof HTMLElement) bridgeStats.apiMounts += 1;
        if (record && node instanceof HTMLElement) {
            record.mountedAt ??= performance.now();
            record.temporaryPin = true;
            armSafetyRelease(record);
        }
        pushTrace('mount-finished', {
            mesId: id,
            chunk,
            reason,
            extra: { mounted: node instanceof HTMLElement, connected: Boolean(node?.isConnected) },
        });
        return node;
    }

    function attachShell(shell) {
        if (!(shell instanceof HTMLElement) || attachedShells.has(shell)) return;
        const mesId = numericMesId(shell);
        if (mesId === null) return;
        attachedShells.add(shell);

        shell.addEventListener('click', event => {
            if (!viewport.enabled || shell.parentElement === viewport.root) return;
            const target = event.target instanceof Element ? event.target.closest(COLD_CLICK_SELECTOR) : null;
            if (!(target instanceof HTMLElement) || !shell.contains(target)) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            const reason = `cold-dom-interaction:${target.className || target.tagName}`;
            beginOperation(mesId, reason);
            const restored = ensure(mesId, reason);
            const chunk = chunkFor(mesId);
            if (!(restored instanceof HTMLElement) || !target.isConnected) {
                finishOperation(mesId, reason, 'mount-failed');
                return;
            }

            bridgeStats.domRedispatches += 1;
            queueMicrotask(() => {
                if (target.isConnected) target.click();
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    pushTrace('operation-dispatched', { mesId, chunk, reason });
                    finishOperation(mesId, reason, 'dom-event-dispatched');
                }));
            });
        }, true);
    }

    function attachCurrent() {
        const root = viewport.root instanceof HTMLElement ? viewport.root : document.querySelector('#chat');
        if (!(root instanceof HTMLElement)) return;
        for (const shell of root.querySelectorAll(':scope > .mes')) attachShell(shell);
    }

    async function finalizeJump(target) {
        const chunk = chunkFor(target);
        pushTrace('jump-finalize-started', { mesId: Number(target), chunk, reason: 'native-chat-jump' });
        await twoFrames();
        const root = viewport.root;
        if (!(root instanceof HTMLElement)) return false;
        const matches = [...root.querySelectorAll(`:scope > .mes[mesid="${target}"]`)];
        if (matches.length !== 1) {
            pushTrace('jump-finalize-finished', { mesId: Number(target), chunk, reason: 'native-chat-jump', releaseReason: 'target-not-unique', extra: { count: matches.length } });
            return false;
        }
        const node = matches[0];
        if (!(node instanceof HTMLElement)) return false;
        if (!visibleInRoot(root, node)) {
            node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
            bridgeStats.jumpFallbackScrolls += 1;
            await twoFrames();
        }
        const visible = visibleInRoot(root, node);
        pushTrace('jump-finalize-finished', { mesId: Number(target), chunk, reason: 'native-chat-jump', extra: { visible } });
        return visible;
    }

    async function installChatJumpCommandBridge() {
        commandBridgeAttempts += 1;
        try {
            const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
            const command = SlashCommandParser?.commands?.['chat-jump'];
            if (!command || typeof command.callback !== 'function') return false;
            if (command[COMMAND_BRIDGE_MARK]) {
                bridgeStats.commandBridgeInstalled = true;
                return true;
            }

            const originalCallback = command.callback;
            command.callback = async function (args, index) {
                const target = commandTarget(index);
                if (target !== null) {
                    beginOperation(target, 'native-chat-jump-command');
                    const mounted = ensure(target, 'native-chat-jump-command');
                    if (mounted instanceof HTMLElement) bridgeStats.jumpPreMounts += 1;
                }
                bridgeStats.commandBridgeInvocations += 1;
                try {
                    return await Reflect.apply(originalCallback, this, [args, index]);
                } finally {
                    if (target !== null) {
                        await finalizeJump(target);
                        finishOperation(target, 'native-chat-jump-command', 'native-callback-resolved');
                    }
                }
            };
            Object.defineProperty(command, COMMAND_BRIDGE_MARK, { value: true, configurable: false });
            bridgeStats.commandBridgeInstalled = true;
            return true;
        } catch (error) {
            console.warn('[Echo Performance] Could not install chat-jump bridge yet.', error);
            return false;
        }
    }

    function scheduleCommandBridge(delay = 0) {
        if (commandBridgeTimer !== null) clearTimeout(commandBridgeTimer);
        commandBridgeTimer = setTimeout(async () => {
            commandBridgeTimer = null;
            const installed = await installChatJumpCommandBridge();
            if (!installed && commandBridgeAttempts < 20) scheduleCommandBridge(120);
        }, Math.max(0, delay));
    }

    function bridgeContext(context) {
        if (!context || typeof context !== 'object') return context;
        const bridged = { ...context };

        if (context.swipe && typeof context.swipe === 'object') {
            bridged.swipe = { ...context.swipe };

            if (typeof context.swipe.to === 'function') {
                bridged.swipe.to = async function (event, direction, options = {}) {
                    const mesId = resolveSwipeMesId(context, event, options);
                    if (mesId !== null) {
                        beginOperation(mesId, 'native-swipe');
                        ensure(mesId, 'native-swipe');
                    }
                    try {
                        return await Reflect.apply(context.swipe.to, context.swipe, [event, direction, options]);
                    } finally {
                        if (mesId !== null) finishOperation(mesId, 'native-swipe', 'native-promise-settled');
                    }
                };
            }

            for (const key of ['left', 'right']) {
                if (typeof context.swipe[key] !== 'function') continue;
                bridged.swipe[key] = async function (event, options = {}) {
                    const mesId = resolveSwipeMesId(context, event, options);
                    const reason = `native-swipe-${key}`;
                    if (mesId !== null) {
                        beginOperation(mesId, reason);
                        ensure(mesId, reason);
                    }
                    try {
                        return await Reflect.apply(context.swipe[key], context.swipe, [event, options]);
                    } finally {
                        if (mesId !== null) finishOperation(mesId, reason, 'native-promise-settled');
                    }
                };
            }
        }

        if (typeof context.updateMessageBlock === 'function') {
            bridged.updateMessageBlock = function (messageId, ...args) {
                const reason = 'native-update-message';
                beginOperation(messageId, reason);
                ensure(messageId, reason);
                try {
                    return Reflect.apply(context.updateMessageBlock, context, [messageId, ...args]);
                } finally {
                    finishOperation(messageId, reason, 'native-call-returned');
                }
            };
        }

        if (typeof context.updateReasoningUI === 'function') {
            bridged.updateReasoningUI = function (messageIdOrElement, ...args) {
                if (typeof messageIdOrElement !== 'number') {
                    return Reflect.apply(context.updateReasoningUI, context, [messageIdOrElement, ...args]);
                }
                const reason = 'native-reasoning';
                beginOperation(messageIdOrElement, reason);
                ensure(messageIdOrElement, reason);
                try {
                    return Reflect.apply(context.updateReasoningUI, context, [messageIdOrElement, ...args]);
                } finally {
                    finishOperation(messageIdOrElement, reason, 'native-call-returned');
                }
            };
        }

        for (const key of ['executeSlashCommands', 'executeSlashCommandsWithOptions']) {
            if (typeof context[key] !== 'function') continue;
            bridged[key] = async function (...args) {
                const target = extractChatJumpTarget(args[0]);
                const reason = `${key}:chat-jump`;
                if (target !== null) {
                    beginOperation(target, reason);
                    const mounted = ensure(target, 'native-chat-jump-preflight');
                    if (mounted instanceof HTMLElement) bridgeStats.jumpPreMounts += 1;
                }
                try {
                    return await Reflect.apply(context[key], context, args);
                } finally {
                    if (target !== null) {
                        await finalizeJump(target);
                        finishOperation(target, reason, 'native-promise-settled');
                    }
                }
            };
        }

        return bridged;
    }

    const onChatInput = event => {
        const input = event.target;
        if (!(input instanceof HTMLTextAreaElement) || input.id !== 'send_textarea') return;
        const target = extractChatJumpTarget(input.value);
        if (target === null) return;
        const chunk = chunkFor(target);
        pushTrace('input-preflight', { mesId: target, chunk, reason: 'native-chat-jump-input' });
        const mounted = ensure(target, 'native-chat-jump-input');
        if (mounted instanceof HTMLElement) bridgeStats.inputPreMounts += 1;
        // Re-verify the currently registered command object after user input. Some
        // SillyTavern startup paths populate the registry after extensions load.
        scheduleCommandBridge(0);
    };
    document.addEventListener('input', onChatInput, true);

    const onReleaseRelevantEvent = () => scheduleReleaseSweep();
    for (const name of ['click', 'focusin', 'focusout', 'keyup', 'toggle']) {
        document.addEventListener(name, onReleaseRelevantEvent, true);
    }
    viewport.root?.addEventListener?.('scroll', onReleaseRelevantEvent, { passive: true });

    const bridgedGetContext = () => bridgeContext(nativeGetContext());
    globalThis.SillyTavern.getContext = bridgedGetContext;

    const bridge = {
        attachCurrent,
        ensure,
        finalizeJump,
        lifecycle(type) {
            if (['CHAT_CHANGED', 'CHAT_LOADED'].includes(type)) resetTemporaryMounts(`lifecycle:${type.toLowerCase()}`);
            if (['CHAT_CHANGED', 'CHAT_LOADED', 'MORE_MESSAGES_LOADED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'TOOL_CALLS_RENDERED'].includes(type)) {
                queueMicrotask(attachCurrent);
            }
            if (['CHAT_CHANGED', 'CHAT_LOADED'].includes(type)) scheduleCommandBridge(0);
            scheduleReleaseSweep();
        },
        trace: mesId => lifecycleTrace.filter(entry => mesId == null || entry.mesId === Number(mesId)).map(entry => structuredClone(entry)),
        temporaryMounts: () => [...temporaryMounts.values()].map(record => snapshotRecord(record)),
        stats: () => ({
            ...bridgeStats,
            temporaryMountCount: temporaryMounts.size,
            temporaryMounts: [...temporaryMounts.values()].map(record => snapshotRecord(record)),
            traceCount: lifecycleTrace.length,
            traceTail: lifecycleTrace.slice(-40).map(entry => structuredClone(entry)),
        }),
    };

    globalThis.SillyTavern[BRIDGE_MARK] = bridge;
    attachCurrent();
    scheduleCommandBridge(0);
    return bridge;
}
