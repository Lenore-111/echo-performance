const BRIDGE_MARK = Symbol.for('echo.performance.native-cold-bridge');
const COMMAND_BRIDGE_MARK = Symbol.for('echo.performance.chat-jump-bridge');
const PIN_MS = 2600;
const TRACE_LIMIT = 160;
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
    const pinTimers = new Map();
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
    };
    let commandBridgeAttempts = 0;
    let commandBridgeTimer = null;

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

    function pushTrace(event, { mesId = null, chunk = null, reason = null, releaseReason = null, extra = null } = {}) {
        lifecycleTrace.push({
            event,
            at: performance.now(),
            mesId: Number.isInteger(Number(mesId)) ? Number(mesId) : null,
            chunkId: chunk?.id ?? null,
            mountReason: reason,
            releaseReason,
            eligibility: chunkEligibility(chunk),
            extra,
        });
        if (lifecycleTrace.length > TRACE_LIMIT) lifecycleTrace.splice(0, lifecycleTrace.length - TRACE_LIMIT);
    }

    function scheduleAfterPin(chunk, mesId = null, reason = null) {
        if (!chunk) return;
        const previous = pinTimers.get(chunk);
        if (previous !== undefined) clearTimeout(previous);

        const run = () => {
            const remaining = Number(chunk.pinUntil || 0) - performance.now();
            if (remaining > 16) {
                pinTimers.set(chunk, setTimeout(run, Math.ceil(remaining) + 24));
                return;
            }
            pinTimers.delete(chunk);
            pushTrace('release-check', { mesId, chunk, reason, releaseReason: 'pin-expired' });
            if (!viewport.enabled || viewport.paused || viewport.generating) {
                pushTrace('compact-skipped', {
                    mesId,
                    chunk,
                    reason,
                    releaseReason: 'viewport-state',
                    extra: { enabled: viewport.enabled, paused: viewport.paused, generating: viewport.generating },
                });
                return;
            }
            bridgeStats.deferredCompacts += 1;
            pushTrace('compact-attempted', { mesId, chunk, reason, releaseReason: 'pin-expired' });
            viewport.scheduleCompact?.(0);
            setTimeout(() => {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    pushTrace('compact-observed', {
                        mesId,
                        chunk,
                        reason,
                        releaseReason: chunk.mounted ? 'still-mounted' : 'detached',
                        extra: { compactSucceeded: !chunk.mounted },
                    });
                }));
            }, 80);
        };

        const delay = Math.max(24, Math.ceil(Number(chunk.pinUntil || 0) - performance.now()) + 24);
        pinTimers.set(chunk, setTimeout(run, delay));
    }

    function pinChunk(mesId, reason = 'temporary-mount') {
        const chunk = viewport.messageToChunk?.get?.(Number(mesId));
        if (!chunk) {
            pushTrace('pin-miss', { mesId, reason });
            return null;
        }
        chunk.pinUntil = Math.max(Number(chunk.pinUntil || 0), performance.now() + PIN_MS);
        pushTrace('pin-set', { mesId, chunk, reason });
        scheduleAfterPin(chunk, Number(mesId), reason);
        return chunk;
    }

    function ensure(mesId, reason) {
        const id = Number(mesId);
        if (!Number.isInteger(id) || id < 0) return null;
        const chunk = pinChunk(id, reason);
        pushTrace('mount-requested', { mesId: id, chunk, reason });
        const node = viewport.ensureMessageMounted(id, { reason });
        if (node instanceof HTMLElement) bridgeStats.apiMounts += 1;
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
            const chunk = pinChunk(mesId, reason);
            pushTrace('operation-started', { mesId, chunk, reason });
            const restored = viewport.ensureMessageMounted(mesId, { reason: 'cold-dom-interaction' });
            if (!(restored instanceof HTMLElement) || !target.isConnected) {
                pushTrace('operation-finished', { mesId, chunk, reason, releaseReason: 'mount-failed' });
                return;
            }

            bridgeStats.domRedispatches += 1;
            queueMicrotask(() => {
                if (target.isConnected) target.click();
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    pushTrace('operation-dispatched', { mesId, chunk, reason });
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
        const chunk = viewport.messageToChunk?.get?.(Number(target)) ?? null;
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
                const chunk = target === null ? null : viewport.messageToChunk?.get?.(target) ?? null;
                if (target !== null) {
                    pushTrace('operation-started', { mesId: target, chunk, reason: 'native-chat-jump-command' });
                    const mounted = ensure(target, 'native-chat-jump-command');
                    if (mounted instanceof HTMLElement) bridgeStats.jumpPreMounts += 1;
                }
                bridgeStats.commandBridgeInvocations += 1;
                const result = await Reflect.apply(originalCallback, this, [args, index]);
                if (target !== null) {
                    await finalizeJump(target);
                    pushTrace('operation-finished', { mesId: target, chunk, reason: 'native-chat-jump-command', releaseReason: 'native-callback-resolved' });
                }
                return result;
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
                    const chunk = mesId === null ? null : viewport.messageToChunk?.get?.(mesId) ?? null;
                    if (mesId !== null) {
                        pushTrace('operation-started', { mesId, chunk, reason: 'native-swipe' });
                        ensure(mesId, 'native-swipe');
                    }
                    try {
                        return await Reflect.apply(context.swipe.to, context.swipe, [event, direction, options]);
                    } finally {
                        if (mesId !== null) pushTrace('operation-finished', { mesId, chunk, reason: 'native-swipe', releaseReason: 'native-promise-settled' });
                    }
                };
            }

            for (const key of ['left', 'right']) {
                if (typeof context.swipe[key] !== 'function') continue;
                bridged.swipe[key] = async function (event, options = {}) {
                    const mesId = resolveSwipeMesId(context, event, options);
                    const chunk = mesId === null ? null : viewport.messageToChunk?.get?.(mesId) ?? null;
                    if (mesId !== null) {
                        pushTrace('operation-started', { mesId, chunk, reason: `native-swipe-${key}` });
                        ensure(mesId, `native-swipe-${key}`);
                    }
                    try {
                        return await Reflect.apply(context.swipe[key], context.swipe, [event, options]);
                    } finally {
                        if (mesId !== null) pushTrace('operation-finished', { mesId, chunk, reason: `native-swipe-${key}`, releaseReason: 'native-promise-settled' });
                    }
                };
            }
        }

        if (typeof context.updateMessageBlock === 'function') {
            bridged.updateMessageBlock = function (messageId, ...args) {
                ensure(messageId, 'native-update-message');
                return Reflect.apply(context.updateMessageBlock, context, [messageId, ...args]);
            };
        }

        if (typeof context.updateReasoningUI === 'function') {
            bridged.updateReasoningUI = function (messageIdOrElement, ...args) {
                if (typeof messageIdOrElement === 'number') ensure(messageIdOrElement, 'native-reasoning');
                return Reflect.apply(context.updateReasoningUI, context, [messageIdOrElement, ...args]);
            };
        }

        for (const key of ['executeSlashCommands', 'executeSlashCommandsWithOptions']) {
            if (typeof context[key] !== 'function') continue;
            bridged[key] = async function (...args) {
                const target = extractChatJumpTarget(args[0]);
                const chunk = target === null ? null : viewport.messageToChunk?.get?.(target) ?? null;
                if (target !== null) {
                    pushTrace('operation-started', { mesId: target, chunk, reason: `${key}:chat-jump` });
                    const mounted = ensure(target, 'native-chat-jump-preflight');
                    if (mounted instanceof HTMLElement) bridgeStats.jumpPreMounts += 1;
                }
                try {
                    return await Reflect.apply(context[key], context, args);
                } finally {
                    if (target !== null) {
                        await finalizeJump(target);
                        pushTrace('operation-finished', { mesId: target, chunk, reason: `${key}:chat-jump`, releaseReason: 'native-promise-settled' });
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
        const chunk = viewport.messageToChunk?.get?.(target) ?? null;
        pushTrace('input-preflight', { mesId: target, chunk, reason: 'native-chat-jump-input' });
        const mounted = ensure(target, 'native-chat-jump-input');
        if (mounted instanceof HTMLElement) bridgeStats.inputPreMounts += 1;
        // Re-verify the currently registered command object after user input. Some
        // SillyTavern startup paths populate the registry after extensions load.
        scheduleCommandBridge(0);
    };
    document.addEventListener('input', onChatInput, true);

    const bridgedGetContext = () => bridgeContext(nativeGetContext());
    globalThis.SillyTavern.getContext = bridgedGetContext;

    const bridge = {
        attachCurrent,
        ensure,
        finalizeJump,
        lifecycle(type) {
            if (['CHAT_CHANGED', 'CHAT_LOADED', 'MORE_MESSAGES_LOADED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'TOOL_CALLS_RENDERED'].includes(type)) {
                queueMicrotask(attachCurrent);
            }
            if (['CHAT_CHANGED', 'CHAT_LOADED'].includes(type)) scheduleCommandBridge(0);
        },
        trace: mesId => lifecycleTrace.filter(entry => mesId == null || entry.mesId === Number(mesId)).map(entry => structuredClone(entry)),
        stats: () => ({ ...bridgeStats, traceCount: lifecycleTrace.length, traceTail: lifecycleTrace.slice(-40).map(entry => structuredClone(entry)) }),
    };

    globalThis.SillyTavern[BRIDGE_MARK] = bridge;
    attachCurrent();
    scheduleCommandBridge(0);
    return bridge;
}
