import type { App } from "obsidian";

export interface INoticeHandle {
    hide(): void;
    setMessage(text: string): void;
}

export interface INoticePresenter {
    show(message: string, duration?: number): INoticeHandle;
    dispose(): void;
}

const NOTICE_HOST_CLASS = "git-vault-notice-host";

export class BottomCenterNoticePresenter implements INoticePresenter {
    private hostEl: HTMLElement | null = null;
    private readonly autoHideTimers = new Set<ReturnType<typeof setTimeout>>();
    /**
     * Short-term dedup map keyed by message text.
     * Prevents the same string from spawning multiple toasts within the
     * window — covers the `showNotice()` path which bypasses
     * `NotificationService` (used by API clients inside the settings panel).
     */
    private readonly messageDedupMap = new Map<string, number>();
    private static readonly DEDUP_WINDOW_MS = 3_000;

    constructor(private readonly app: App) {}

    show(message: string, duration?: number): INoticeHandle {
        // Prune stale entries and check for a recent identical toast.
        const now = Date.now();
        const cutoff = now - BottomCenterNoticePresenter.DEDUP_WINDOW_MS;
        for (const [key, ts] of this.messageDedupMap) {
            if (ts < cutoff) this.messageDedupMap.delete(key);
        }
        const lastSeen = this.messageDedupMap.get(message);
        if (
            lastSeen !== undefined &&
            now - lastSeen < BottomCenterNoticePresenter.DEDUP_WINDOW_MS
        ) {
            // Return a no-op handle — callers that use showNotice() for
            // fire-and-forget error messages are unaffected; callers that need
            // interactive handles (progress notices) use distinct initial
            // messages and won't hit this branch.
            return { hide: () => undefined, setMessage: () => undefined };
        }
        this.messageDedupMap.set(message, now);
        const host = this.ensureHost();
        const noticeEl = document.createElement("div");
        noticeEl.className = "notice";
        noticeEl.textContent = message;
        host.appendChild(noticeEl);

        let hideTimeoutId: ReturnType<typeof setTimeout> | undefined;
        let cleaned = false;

        const cleanup = (): void => {
            if (cleaned) {
                return;
            }
            cleaned = true;
            if (hideTimeoutId !== undefined) {
                clearTimeout(hideTimeoutId);
                this.autoHideTimers.delete(hideTimeoutId);
                hideTimeoutId = undefined;
            }
            noticeEl.remove();
            if (host === this.hostEl && host.childElementCount === 0) {
                host.remove();
                this.hostEl = null;
            }
        };

        if (duration !== 0) {
            const timeoutMs = duration ?? 5_000;
            hideTimeoutId = setTimeout(cleanup, timeoutMs);
            this.autoHideTimers.add(hideTimeoutId);
        }

        return {
            hide: cleanup,
            setMessage: (text: string) => {
                if (cleaned) {
                    return;
                }
                noticeEl.textContent = text;
            },
        };
    }

    dispose(): void {
        for (const id of this.autoHideTimers) {
            clearTimeout(id);
        }
        this.autoHideTimers.clear();
        this.messageDedupMap.clear();
        this.hostEl?.remove();
        this.hostEl = null;
    }

    private ensureHost(): HTMLElement {
        if (this.hostEl?.isConnected) return this.hostEl;

        const root = this.app.workspace.containerEl ?? document.body;
        const host = document.createElement("div");
        host.className = NOTICE_HOST_CLASS;
        root.appendChild(host);
        this.hostEl = host;
        return host;
    }
}
