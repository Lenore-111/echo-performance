const BRIDGE_MARK = Symbol.for('echo.performance.native-cold-bridge');
const COMMAND_BRIDGE_MARK = Symbol.for('echo.performance.chat-jump-bridge');
const PIN_MS = 2600;
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
        return { attachCurrent: () => {}, lifecycle: () => {}, stats: () => ({ installed: false }) };
    }

    if (globalThis.SillyTavern[BRIDGE_MARK]) return globalThis.SillyTavern[BRIDGE_MARK];

    const attachedShells = new WeakSet();
    const pinTimers = new Map();
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

    function scheduleAfterPin(chunk) {
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
            if (!viewport.enabled || viewport.paused || viewport.generating) return;
            bridgeStats.deferredCompacts += 1;
            viewport.scheduleCompact?.(0);
        };

        const delay = Math.max(24, Math.ceil(Number(chunk.pinUntil || 0) - performance.now()) + 24);
        pinTimers.set(chunk, setTimeout(run, delay));
    }

    function pinChunk(mesId) {
        const chunk = viewport.messageToChunk?.get?.(Number(mesId));
        if (!chunk) return null;
        chunk.pinUntil = Math.max(Number(chunk.pinUntil || 0), performance.now() + PIN_MS);
        scheduleAfterPin(chunk);
        return chunk;
    }

    function ensure(mesId, reason) {
        const id = Number(mesId);
        if (!Number.isInteger(id) || id < 0) return null;
        pinChunk(id);
        const node = viewport.ensureMessageMounted(id, { reason });
        if (node instanceof HTMLElement) bridgeStats.apiMounts += 1;
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
            pinChunk(mesId);
            const restored = viewport.ensureMessageMounted(mesId, { reason: 'cold-dom-interaction' });
            if (!(restored instanceof HTMLElement) || !target.isConnected) return;

            bridgeStats.domRedispatches += 1;
            queueMicrotask(() => {
                if (target.isConnected) target.click();
            });
        }, true);
    }

    function attachCurrent() {
        const root = viewport.root instanceof HTMLElement ? viewport.root : document.querySelector('#chat');
        if (!(root instanceof HTMLElement)) return;
        for (const shell of root.querySelectorAll(':scope > .mes')) attachShell(shell);
    }

    async function finalizeJump(target) {
        await twoFrames();
        const root = viewport.root;
        if (!(root instanceof HTMLElement)) return false;
        const matches = [...root.querySelectorAll(`:scope > .mes[mesid="${target}"]`)];
        if (matches.length !== 1) return false;
        const node = matches[0];
        if (!(node instanceof HTMLElement)) return false;
        if (!visibleInRoot(root, node)) {
            node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
            bridgeStats.jumpFallbackScrolls += 1;
            await twoFrames();
        }
        return visibleInRoot(root, node);
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
                    const mounted = ensure(target, 'native-chat-jump-command');
                    if (mounted instanceof HTMLElement) bridgeStats.jumpPreMounts += 1;
                }
                bridgeStats.commandBridgeInvocations += 1;
                const result = await Reflect.apply(originalCallback, this, [args, index]);
                if (target !== null) await finalizeJump(target);
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
                    if (mesId !== null) ensure(mesId, 'native-swipe');
                    return Reflect.apply(context.swipe.to, context.swipe, [event, direction, options]);
                };
            }

            for (const key of ['left', 'right']) {
                if (typeof context.swipe[key] !== 'function') continue;
                bridged.swipe[key] = async function (event, options = {}) {
                    const mesId = resolveSwipeMesId(context, event, options);
                    if (mesId !== null) ensure(mesId, `native-swipe-${key}`);
                    return Reflect.apply(context.swipe[key], context.swipe, [event, options]);
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
                if (target !== null) {
                    const mounted = ensure(target, 'native-chat-jump-preflight');
                    if (mounted instanceof HTMLElement) bridgeStats.jumpPreMounts += 1;
                }
                const result = await Reflect.apply(context[key], context, args);
                if (target !== null) await finalizeJump(target);
                return result;
            };
        }

        return bridged;
    }

    const onChatInput = event => {
        const input = event.target;
        if (!(input instanceof HTMLTextAreaElement) || input.id !== 'send_textarea') return;
        const target = extractChatJumpTarget(input.value);
        if (target === null) return;
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
        stats: () => ({ ...bridgeStats }),
    };

    globalThis.SillyTavern[BRIDGE_MARK] = bridge;
    attachCurrent();
    scheduleCommandBridge(0);
    return bridge;
}
