import { ChatViewport } from './src/viewport.js';

function start() {
    if (window.EchoPerformance) return;
    const getContext = () => SillyTavern.getContext();
    const context = getContext();
    const root = document.querySelector('#chat');
    if (!root || !context.eventSource?.makeFirst) return;
    const settings = context.extensionSettings.echo_performance ??= { enabled: false };
    const viewport = new ChatViewport(root, getContext);
    const { eventSource, eventTypes } = context;
    const eventNames = ['CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_DELETED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED', 'MORE_MESSAGES_LOADED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'TOOL_CALLS_RENDERED'];
    for (const key of eventNames) {
        if (eventTypes[key]) eventSource.makeFirst(eventTypes[key], () => viewport.lifecycle());
    }
    eventSource.makeFirst(eventTypes.GENERATION_STARTED, (_type, _options, dryRun) => {
        // Native prompt precomputation emits STARTED with dryRun=true and no
        // matching ENDED. It does not change message DOM or begin generation.
        if (dryRun) return;
        viewport.generating = true;
        viewport.restoreAll();
    });
    for (const key of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        eventSource.makeFirst(eventTypes[key], () => { viewport.generating = false; viewport.lifecycle(); });
    }
    const panel = document.createElement('div');
    panel.className = 'echo-performance-settings';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Echo Performance</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label class="checkbox_label"><input type="checkbox" data-echo-enable><span>长聊天按需显示（实验功能）</span></label><p>150 楼起启用，最近 40 楼保持原样。让远处的普通楼层延后显示，正文、编辑按钮和历史版本完整保留。媒体、交互页面与自定义标记跳过。</p><p>查找、全选或打印时暂停优化。可随时恢复常规显示。</p><button type="button" class="menu_button" data-echo-restore>恢复常规显示并暂停</button><button type="button" class="menu_button" data-echo-resume>继续按需显示</button><small data-echo-status></small></div></div>`;
    document.querySelector('#extensions_settings2, #extensions_settings')?.append(panel);
    const checkbox = panel.querySelector('[data-echo-enable]');
    checkbox.disabled = !CSS.supports('content-visibility', 'auto');
    checkbox.checked = Boolean(settings.enabled);
    const setEnabled = (enabled, persist = false) => {
        viewport.setEnabled(enabled);
        checkbox.checked = viewport.enabled;
        if (persist) { settings.enabled = viewport.enabled; getContext().saveSettingsDebounced(); }
        showStatus();
    };
    function showStatus() {
        const stats = viewport.stats();
        panel.querySelector('[data-echo-status]').textContent = checkbox.disabled ? '本浏览器暂不支持按需显示。' : stats.enabled ? (stats.paused ? '已恢复常规显示，优化已暂停。' : '按需显示已开启。') : '当前关闭。';
    }
    viewport.onStateChange = showStatus;
    checkbox.addEventListener('change', () => setEnabled(checkbox.checked, true));
    panel.querySelector('[data-echo-restore]').addEventListener('click', () => { viewport.pause(); showStatus(); });
    panel.querySelector('[data-echo-resume]').addEventListener('click', () => setEnabled(true, true));
    window.EchoPerformance = Object.freeze({ setEnabled, restoreAll: () => { viewport.pause(); showStatus(); }, resume: () => setEnabled(true), stats: () => viewport.stats(), pin: shell => { viewport.releaseContainment(shell); shell.setAttribute('data-echo-keep', ''); } });
    setEnabled(Boolean(settings.enabled));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
