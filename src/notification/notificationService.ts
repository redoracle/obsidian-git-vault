/**
 * NotificationService
 *
 * A single, typed notification surface for the entire plugin.
 * Replaces the three ad-hoc methods on ObsidianGit:
 *   - makeSyncNotice()
 *   - displayMessage()
 *   - displayError()
 *
 * Callers receive the same runtime behaviour they had before; what changes is
 * that every notification path now flows through one class with a common
 * interface, enabling consistent deduplication, severity routing, and
 * progress-notice lifecycle management.
 *
 * @module
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Severity levels exposed by the notification service for external consumers.
 */
export type NotifLevel = "info" | "warning" | "error" | "debug";

export const NO_CHANGES_PREFIX = "No changes";

export interface NotifOptions {
    timeout?: number;
    /**
     * Deduplication tag.  Within a 3-second window, two calls with the same
     * tag and message are collapsed into one toast.
     */
    tag?: string;
    /**
     * Whether the message should bypass the user's "disable popups" preference.
     * Use sparingly — normally only for errors and action-required prompts.
     */
    forceToast?: boolean;
    /**
     * Marks a message as a no-changes notification so the user preference can
     * suppress it without relying on a hardcoded string match.
     */
    isNoChanges?: boolean;
}

export interface ProgressHandle {
    update(message: string): void;
    complete(finalMessage?: string): void;
    fail(errorMessage: string): void;
}

/** Subset of the Obsidian Notice API used by this service. */
export interface INoticeFactory {
    create(
        message: string,
        duration?: number
    ): {
        hide(): void;
        setMessage(text: string): void;
    };
}

/** Subset of the plugin that this service needs. */
export interface INotificationHost {
    /** Whether popups are disabled by the user. */
    disablePopups: boolean;
    /** Whether to suppress "no changes" notifications. */
    disablePopupsForNoChanges: boolean;
    /** Whether error toasts are enabled. */
    showErrorNotices: boolean;
    /** Status bar message forwarding — optional so tests can omit it. */
    statusBar?: { displayMessage(msg: string, timeout: number): void };
    /** Plugin id for console prefixing. */
    pluginId: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class NotificationService {
    private readonly dedupMap = new Map<string, number>();
    private static readonly DEDUP_WINDOW_MS = 3_000;

    constructor(
        private readonly noticeFactory: INoticeFactory,
        private readonly host: INotificationHost
    ) {}

    // ── One-shot notifications ────────────────────────────────────────────

    /**
     * Show an informational toast + status bar message.
     * Respects the user's popup-disable preference unless `forceToast` is set.
     *
     * Deduplication: when no explicit `tag` is supplied, the message text
     * itself is used as the dedup key.  This means back-to-back calls with
     * an identical message (e.g. cascading provider-reload failures) are
     * collapsed into a single toast within the 3-second window without
     * callers needing to supply a tag.
     */
    info(message: string, opts: NotifOptions = {}): void {
        const { timeout = 4_000, tag, forceToast = false } = opts;

        this.host.statusBar?.displayMessage(message.toLowerCase(), timeout);
        console.log("%s:", this.host.pluginId, message);

        if (!forceToast && this.host.disablePopups) return;
        if (
            !forceToast &&
            this.host.disablePopupsForNoChanges &&
            (opts.isNoChanges ?? message.startsWith(NO_CHANGES_PREFIX))
        )
            return;

        // Explicit tag takes priority; fall back to message content so
        // identical toasts within the window are collapsed automatically.
        const dedupTag = tag ?? message;
        if (this.isDeduped(dedupTag, message)) return;

        this.noticeFactory.create(message, timeout);
        this.recordDedup(dedupTag, message);
    }

    /**
     * Show a warning toast.  Always visible (but dedup-able).
     * Falls back to message-content dedup when no tag is provided.
     */
    warning(message: string, opts: NotifOptions = {}): void {
        const { timeout = 6_000, tag } = opts;

        this.host.statusBar?.displayMessage(message.toLowerCase(), timeout);
        console.warn("%s:", this.host.pluginId, message);

        const dedupTag = tag ?? message;
        if (this.isDeduped(dedupTag, message)) return;
        this.noticeFactory.create(message, timeout);
        this.recordDedup(dedupTag, message);
    }

    /**
     * Show an error toast.
     * - Normalises `unknown` inputs to `Error`.
     * - Suppresses if the user has `showErrorNotices = false`.
     * - Always logs to the console.
     */
    error(data: unknown, opts: NotifOptions = {}): void {
        const { timeout = 10_000, tag, forceToast = false } = opts;

        // Normalise to Error
        let err: Error;
        if (data instanceof Error) {
            err = data;
        } else {
            err = new Error(String(data));
        }

        console.error("%s:", this.host.pluginId, err.stack ?? err.message);
        this.host.statusBar?.displayMessage(err.message.toLowerCase(), timeout);

        if (!forceToast && !this.host.showErrorNotices) return;

        const dedupTag = tag ?? err.message;
        if (this.isDeduped(dedupTag, err.message)) return;

        this.noticeFactory.create(err.message, timeout);
        this.recordDedup(dedupTag, err.message);
    }

    /**
     * Developer-mode message — only logs to the console when running outside
     * production.
     */
    debug(message: string, context?: Record<string, unknown>): void {
        if (process.env.NODE_ENV !== "production") {
            if (context) {
                console.debug("%s:", this.host.pluginId, message, context);
            } else {
                console.debug("%s:", this.host.pluginId, message);
            }
        }
    }

    // ── Long-lived progress ──────────────────────────────────────────────

    /**
     * Create a persistent toast that can be updated or dismissed.
     *
     * Usage:
     * ```ts
     * const p = notif.progress("Syncing…");
     * p.update("Syncing 3 / 10 files…");
     * p.complete("Sync complete");
     * ```
     */
    progress(initialMessage: string): ProgressHandle {
        const notice = this.noticeFactory.create(initialMessage, 0);
        let hideTimeoutId: ReturnType<typeof setTimeout> | undefined;
        let finished = false;

        const scheduleHide = (delayMs: number): void => {
            if (hideTimeoutId !== undefined) {
                clearTimeout(hideTimeoutId);
            }
            hideTimeoutId = setTimeout(() => {
                hideTimeoutId = undefined;
                notice.hide();
            }, delayMs);
        };

        return {
            update: (msg) => {
                if (finished) {
                    return;
                }
                notice.setMessage(msg);
            },
            complete: (msg) => {
                if (finished) {
                    return;
                }
                finished = true;
                if (msg) notice.setMessage(msg);
                // Brief visibility so the user sees the final state.
                scheduleHide(2_000);
            },
            fail: (msg) => {
                if (finished) {
                    return;
                }
                finished = true;
                notice.setMessage(msg);
                scheduleHide(10_000);
            },
        };
    }

    // ── Private helpers ──────────────────────────────────────────────────

    private getDedupKey(tag: string, msg: string): string {
        return JSON.stringify([tag, msg]);
    }

    private isDeduped(tag: string, msg: string): boolean {
        const cutoff = Date.now() - NotificationService.DEDUP_WINDOW_MS;
        for (const [key, timestamp] of this.dedupMap) {
            if (timestamp < cutoff) {
                this.dedupMap.delete(key);
            }
        }

        const dedupKey = this.getDedupKey(tag, msg);
        const last = this.dedupMap.get(dedupKey);
        if (last === undefined) {
            return false;
        }
        return Date.now() - last < NotificationService.DEDUP_WINDOW_MS;
    }

    private recordDedup(tag: string, msg: string): void {
        this.dedupMap.set(this.getDedupKey(tag, msg), Date.now());
    }
}
