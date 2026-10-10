import { DomCompactor } from './src/dom-compact.js';
import { installNativeColdBridge } from './src/native-bridge.js';

function start() {
    if (window.EchoPerformance) return;
    const nativeGetContext = SillyTavern.getContext.bind(SillyTavern);
    const getContext = () => nativeGetContext();
    const context = getContext();
    const root = document.querySelector('#chat');
    if (!root || !context.eventSource?.makeFirst) return;

    const settings = context.extensionSettings.echo_performance ??= { enabled: false };
    const viewport = new DomCompactor(root, getContext);
    const bridge = installNativeColdBridge(viewport, nativeGetContext);
    const { eventSource, eventTypes } = context;

    const eventNames = [
        'CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_DELETED',
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
        'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED',
        'MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED',
        'MORE_MESSAGES_LOADED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED',
        'TOOL_CALLS_RENDERED',
    ];

    for (const key of eventNames) {
        if (!eventTypes[key]) continue;
        eventSource.makeFirst(eventTypes[key], (...args) => {
            bridge.lifecycle(key, ...args);
            viewport.lifecycle(key, ...args);
        });
    }

    const isSlashCommandPreflight = type => {
        // SillyTavern emits GENERATION_STARTED before it checks whether the chat
        // input is actually a slash command. When the slash command consumes the
        // input, Generate() returns after unblockGeneration() without emitting a
        // matching GENERATION_ENDED. Freezing at STARTED would therefore leave
        // Echo permanently stuck in generating=true after commands such as
        // /chat-jump. Only defer the ordinary chat-input generation path; real
        // regenerate/swipe/quiet/etc. generations still freeze immediately.
        if (type !== undefined && type !== 'normal') return false;
        const input = document.querySelector('#send_textarea');
        return input instanceof HTMLTextAreaElement && input.value.trimStart().startsWith('/');
    };

    eventSource.makeFirst(eventTypes.GENERATION_STARTED, (type, _options, dryRun) => {
        // SillyTavern prompt precomputation emits STARTED with dryRun=true and no
        // matching ENDED. Treating that as a real generation permanently freezes
        // compaction, so dry runs must be ignored completely.
        if (dryRun) return;
        if (isSlashCommandPreflight(type)) return;
        viewport.generationStarted();
    });

    if (eventTypes.GENERATION_AFTER_COMMANDS) {
        eventSource.makeFirst(eventTypes.GENERATION_AFTER_COMMANDS, (_type, _options, dryRun) => {
            // This event is only emitted when Generate() survives slash-command
            // processing and is actually continuing into a generation. It closes
            // the preflight gap above without changing the normal STARTED path.
            if (dryRun || viewport.generating) return;
            viewport.generationStarted();
        });
    }

    for (const key of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (!eventTypes[key]) continue;
        eventSource.makeFirst(eventTypes[key], () => viewport.generationEnded());
    }

    const panel = document.createElement('div');
    panel.className = 'echo-performance-settings';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Echo Performance</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label class="checkbox_label"><input type="checkbox" data-echo-enable><span>DOM Compact Prototype（实验功能）</span></label><p>保留完整聊天数据，仅让近期消息与少量预加载历史保持在 live DOM。更早消息按 50 楼 chunk 保存原节点并从 #chat detach，向上滚动时原样恢复。</p><p>不删除消息、不重新 render 缓存节点、不修改世界背面。生成期间暂停 compact；dryRun 不改变状态。查找、全选和打印会恢复全部消息并暂停。</p><button type="button" class="menu_button" data-echo-restore>恢复全部 DOM 并暂停</button><button type="button" class="menu_button" data-echo-resume>继续 DOM Compact</button><small data-echo-status></small></div></div>`;
    document.querySelector('#extensions_settings2, #extensions_settings')?.append(panel);

    const checkbox = panel.querySelector('[data-echo-enable]');
    const supported = typeof IntersectionObserver !== 'undefined'
        && typeof MutationObserver !== 'undefined'
        && typeof DocumentFragment !== 'undefined';
    checkbox.disabled = !supported;
    checkbox.checked = Boolean(settings.enabled) && supported;

    const setEnabled = (enabled, persist = false) => {
        viewport.setEnabled(enabled);
        bridge.attachCurrent();
        checkbox.checked = viewport.enabled;
        if (persist) {
            settings.enabled = viewport.enabled;
            getContext().saveSettingsDebounced();
        }
        showStatus();
    };

    function showStatus() {
        const stats = viewport.stats();
        const status = panel.querySelector('[data-echo-status]');
        if (!supported) {
            status.textContent = '当前浏览器缺少 DOM Compact 所需能力。';
            return;
        }
        if (!stats.enabled) {
            status.textContent = '当前关闭。';
            return;
        }
        if (stats.paused) {
            status.textContent = `已暂停，当前 ${stats.liveMessageShells} 楼 live DOM。`;
            return;
        }
        if (stats.generating) {
            status.textContent = `生成中冻结 compact；当前 ${stats.liveMessageShells} 楼 live DOM。`;
            return;
        }
        status.textContent = `live ${stats.liveMessageShells} 楼 / detached ${stats.detachedMessageShells} 楼；${stats.detachedChunks} 个冷 chunk。`;
    }

    viewport.onStateChange = showStatus;
    checkbox.addEventListener('change', () => setEnabled(checkbox.checked, true));
    panel.querySelector('[data-echo-restore]').addEventListener('click', () => {
        viewport.pause();
        showStatus();
    });
    panel.querySelector('[data-echo-resume]').addEventListener('click', () => {
        if (!viewport.enabled) setEnabled(true, true);
        else viewport.resume();
        showStatus();
    });

    window.EchoPerformance = Object.freeze({
        setEnabled,
        restoreAll: () => {
            viewport.pause();
            showStatus();
        },
        resume: () => {
            if (!viewport.enabled) setEnabled(true);
            else viewport.resume();
            showStatus();
        },
        stats: () => ({ ...viewport.stats(), bridge: bridge.stats() }),
        ensureMessageMounted: (mesId, reason = 'external-request') => viewport.ensureMessageMounted(mesId, { reason }),
        pin: shell => viewport.pin(shell),
    });

    // Experimental baseline remains default-off. A previously saved explicit
    // opt-in is respected after refresh so reload/re-entry behavior can be tested.
    setEnabled(Boolean(settings.enabled));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
