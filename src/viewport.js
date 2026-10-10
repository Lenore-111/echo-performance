// Defer the browser's offscreen layout/paint, retaining the complete native DOM.
// The detached-node prototype failed the scroll gate and is not shipped.
const INERT_TAGS = new Set(['P', 'BR', 'STRONG', 'EM', 'B', 'I', 'S', 'DEL', 'BLOCKQUOTE', 'OL', 'UL', 'LI', 'CODE', 'HR', 'Q']);
const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };

export class ChatViewport {
    constructor(root, getContext) {
        this.root = root;
        this.getContext = getContext;
        this.enabled = false;
        this.generating = false;
        this.paused = false;
        this.contained = new Map();
        this.near = new Set();
        this.observed = new Set();
        this.queue = new Set();
        this.pinned = new WeakSet();
        this.timer = null;
        this.frame = null;
        this.intersections = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    this.near.add(entry.target);
                    this.queue.delete(entry.target);
                } else {
                    this.near.delete(entry.target);
                    this.queue.add(entry.target);
                }
            }
            this.schedule();
        }, { root, rootMargin: '2000px 0px', threshold: 0 });
        this.mutations = new MutationObserver(records => {
            this.processMutations(records);
            if (!this.generating) this.refresh();
        });
        this.resize = new ResizeObserver(() => {
            const width = root.clientWidth;
            if (width !== this.width) {
                this.width = width;
                this.restoreAll();
                this.refresh();
            }
        });
        this.resize.observe(root);
        this.beforeInteraction = event => {
            const shell = event.target instanceof Element ? event.target.closest('#chat > .mes') : null;
            if (shell) this.releaseContainment(shell);
        };
        for (const name of ['pointerdown', 'click', 'focusin', 'keydown', 'contextmenu']) document.addEventListener(name, this.beforeInteraction, true);
        document.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && ['f', 'a', 'p'].includes(event.key.toLowerCase())) this.pause();
        }, true);
        document.addEventListener('selectionchange', () => {
            if (!window.getSelection()?.isCollapsed) this.pause();
        });
        window.addEventListener('beforeprint', () => this.pause());
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled) && CSS.supports('content-visibility', 'auto');
        this.paused = false;
        if (!this.enabled) {
            this.restoreAll();
            this.mutations.disconnect();
            this.intersections.disconnect();
            this.observed.clear();
            this.near.clear();
            this.queue.clear();
            return;
        }
        this.mutations.observe(this.root, OBSERVE_OPTIONS);
        this.refresh();
    }

    pause() {
        this.paused = true;
        this.restoreAll();
        this.onStateChange?.();
    }

    processMutations(records) {
        // New native/plugin content owns its layout. Release its constraints and
        // pin it for the lifetime of this DOM shell, even if it becomes plain text.
        for (const record of records) {
            const shell = record.target instanceof Element ? record.target.closest('.mes') : record.target.parentElement?.closest('.mes');
            if (shell && this.contained.has(shell)) {
                this.pinned.add(shell);
                this.releaseContainment(shell);
            }
        }
    }

    refresh() {
        if (!this.enabled) return;
        const shells = new Set(this.root.querySelectorAll(':scope > .mes'));
        for (const shell of this.observed) {
            if (!shells.has(shell)) {
                this.intersections.unobserve(shell);
                this.observed.delete(shell);
                this.near.delete(shell);
                this.queue.delete(shell);
                this.releaseContainment(shell);
            }
        }
        for (const shell of shells) {
            if (!this.observed.has(shell)) {
                this.observed.add(shell);
                this.intersections.observe(shell);
            }
            if (!this.near.has(shell)) this.queue.add(shell);
        }
        this.schedule();
    }

    schedule() {
        if (this.timer || this.frame || !this.queue.size || !this.enabled || this.paused || this.generating) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.frame = requestAnimationFrame(() => {
                this.frame = null;
                this.deferLayout();
            });
        }, 120);
    }

    eligible(shell, context) {
        const id = Number(shell.getAttribute('mesid'));
        if (!shell.isConnected || context.chat.length < 150 || this.observed.size < 150) return false;
        if (!Number.isInteger(id) || id < 0 || id >= context.chat.length - 40 || this.near.has(shell) || this.contained.has(shell) || this.pinned.has(shell)) return false;
        if (shell.contains(document.activeElement) || shell.querySelector('textarea, input:not(.del_checkbox), .del_checkbox:checked, iframe, img:not(.avatar img), video, audio, canvas, [contenteditable="true"], details[open]')) return false;
        const text = shell.querySelector('.mes_text');
        if (!text?.childNodes.length || shell.hasAttribute('data-echo-keep') || text.hasAttribute('data-echo-keep')) return false;
        if (shell.style.contentVisibility || shell.style.containIntrinsicBlockSize || shell.style.minHeight) return false;
        for (const node of text.querySelectorAll('*')) {
            if (!INERT_TAGS.has(node.tagName) || node.attributes.length) return false;
        }
        return true;
    }

    deferLayout() {
        if (!this.enabled || this.paused || this.generating) return;
        this.processMutations(this.mutations.takeRecords());
        const context = this.getContext();
        const rootRect = this.root.getBoundingClientRect();
        const measurements = [];
        // Measure every candidate before any writes. Repeated small read/write
        // batches forced a full chat reflow between batches on the pinned host.
        for (const shell of this.queue) {
            this.queue.delete(shell);
            if (!this.eligible(shell, context)) continue;
            const rect = shell.getBoundingClientRect();
            if (rect.bottom >= rootRect.top - 2000 && rect.top <= rootRect.bottom + 2000) continue;
            const style = getComputedStyle(shell);
            const paddingAndBorder = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
            if (rect.height > 0) measurements.push({ shell, size: `auto ${rect.height - paddingAndBorder}px`, minHeight: `${style.boxSizing === 'border-box' ? rect.height : rect.height - paddingAndBorder}px` });
        }
        for (const saved of measurements) {
            const { shell, size, minHeight } = saved;
            shell.style.contentVisibility = 'auto';
            shell.style.containIntrinsicBlockSize = size;
            // Flex items in the pinned host collapse with intrinsic size alone.
            // A measured floor keeps the scrollbar and message positions stable.
            shell.style.minHeight = minHeight;
            this.contained.set(shell, saved);
        }
    }

    releaseContainment(shell) {
        const saved = this.contained.get(shell);
        if (!saved) return;
        // Only remove our own values; an external style replacement wins.
        if (shell.style.contentVisibility === 'auto') shell.style.removeProperty('content-visibility');
        if (shell.style.containIntrinsicBlockSize === saved.size) shell.style.removeProperty('contain-intrinsic-block-size');
        if (shell.style.minHeight === saved.minHeight) shell.style.removeProperty('min-height');
        this.contained.delete(shell);
    }

    restoreAll() {
        clearTimeout(this.timer);
        cancelAnimationFrame(this.frame);
        this.timer = null;
        this.frame = null;
        for (const shell of this.contained.keys()) this.releaseContainment(shell);
    }

    lifecycle() {
        if (!this.enabled) return;
        this.restoreAll();
        this.refresh();
    }

    stats() {
        return { enabled: this.enabled, paused: this.paused, generating: this.generating, deferredMessages: this.contained.size, liveMessageShells: this.observed.size };
    }
}
