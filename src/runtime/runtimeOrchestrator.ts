/**
 * RuntimeOrchestrator
 *
 * A state machine that replaces three overlapping "readiness" booleans that
 * existed on ObsidianGit:
 *
 *   - `gitReady`      (set in `_init()`, reset in `unloadPlugin()`)
 *   - `useSimpleGit`  (computed getter: Platform.isDesktopApp && provider === "git")
 *   - synchronous `syncManager` / `provider.init()` completion
 *
 * Those three flags encoded different aspects of the same underlying phase,
 * making it easy to read a "ready" state at the wrong moment.  The orchestrator
 * collapses them into one named phase so that every consumer asks the same
 * question: "what phase are we in?"
 *
 * ─── Phase model ─────────────────────────────────────────────────────────────
 *
 *   booting ──→ ready ──→ syncing ──→ ready
 *      │           │                    │
 *      │           └──→ reloading ──→ ready
 *      │                    │
 *      └──→ degraded ←──────┘ (any phase can degrade on unrecoverable error)
 *                   └──→ unloaded  (plugin.onunload())
 *
 * ─── Backward compatibility ──────────────────────────────────────────────────
 *
 * `ObsidianGit` still exposes a `gitReady: boolean` getter.  That getter
 * delegates to {@link RuntimeOrchestrator.isGitReady} so the 200+ existing
 * callers of `plugin.gitReady` continue to work without modification.
 *
 * @module
 */

// ─── Phase ────────────────────────────────────────────────────────────────────

export type RuntimePhase =
    | "booting" // plugin.onload() is running; nothing is usable yet
    | "ready" // idle; git repo verified (if needed) and sync provider up
    | "syncing" // a sync operation is in flight
    | "reloading" // sync provider is being torn down and re-created
    | "degraded" // an unrecoverable error; most operations are blocked
    | "unloaded"; // plugin.onunload() completed

// ─── Events ───────────────────────────────────────────────────────────────────

export type RuntimeEvent =
    | { type: "boot-started" }
    | { type: "boot-succeeded"; gitAvailable: boolean; isSimpleGit: boolean }
    | { type: "boot-failed"; reason: string }
    | { type: "sync-started" }
    | { type: "sync-finished" }
    | { type: "reload-started" }
    | { type: "reload-finished"; gitAvailable: boolean; isSimpleGit: boolean }
    | { type: "reload-failed"; reason: string }
    | { type: "fatal-error"; reason: string }
    | { type: "unload" };

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class RuntimeOrchestrator {
    private _phase: RuntimePhase = "booting";
    /** Whether the native git binary + repository is available. */
    private _gitAvailable = false;
    /** Whether the native (simple-git) backend is active (vs isomorphic-git). */
    private _isSimpleGit = false;

    private listeners: Array<
        (phase: RuntimePhase, prev: RuntimePhase) => void
    > = [];

    // ── Read ──────────────────────────────────────────────────────────────

    get phase(): RuntimePhase {
        return this._phase;
    }

    /**
     * Equivalent to the old `plugin.gitReady`.
     *
     * `true` when:
     *  - the phase is `ready` or `syncing` (operations are permitted), AND
     *  - the native git binary + local repository were verified during boot.
     *
     * This is the canonical replacement for `plugin.gitReady`.
     */
    get isGitReady(): boolean {
        return (
            (this._phase === "ready" || this._phase === "syncing") &&
            this._gitAvailable
        );
    }

    /**
     * Equivalent to the old `plugin.useSimpleGit`.
     *
     * `true` when the runtime is using the native simple-git backend
     * (desktop + git provider).  Used to gate desktop-only features like
     * line-authoring.
     */
    get useSimpleGit(): boolean {
        return this._isSimpleGit;
    }

    // ── Transitions (event-driven state machine) ──────────────────────────

    dispatch(event: RuntimeEvent): void {
        const prev = this._phase;
        const next = this._transition(this._phase, event);
        if (next === null) {
            // Transition was a no-op or invalid — log for debugging.
            console.debug(
                `[RuntimeOrchestrator] ignored event "${event.type}" in phase "${this._phase}"`
            );
            return;
        }

        // Apply supplementary state from the event payload before notification.
        if (
            event.type === "boot-succeeded" ||
            event.type === "reload-finished"
        ) {
            this._gitAvailable = event.gitAvailable;
            this._isSimpleGit = event.isSimpleGit;
        }
        if (
            event.type === "boot-failed" ||
            event.type === "reload-failed" ||
            event.type === "fatal-error" ||
            event.type === "unload"
        ) {
            this._gitAvailable = false;
            this._isSimpleGit = false;
        }

        this._phase = next;
        this._notify(next, prev);
    }

    // ── Observer ──────────────────────────────────────────────────────────

    /**
     * Register a listener called whenever the phase changes.
     * @returns unsubscribe function
     */
    onPhaseChange(
        listener: (phase: RuntimePhase, prev: RuntimePhase) => void
    ): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    /**
     * Resolve when the orchestrator reaches the target phase.
     * Rejects if it transitions to `"unloaded"` first, or to `"degraded"`
     * before a target other than `"unloaded"`.
     */
    waitForPhase(target: RuntimePhase, timeoutMs?: number): Promise<void> {
        if (this._phase === target) return Promise.resolve();
        if (this.shouldRejectPhase(this._phase, target)) {
            return Promise.reject(
                new Error(
                    `RuntimeOrchestrator: reached "${this._phase}" before "${target}"`
                )
            );
        }
        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            const cleanup = () => {
                if (timeoutId !== undefined) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                unsub();
            };

            const unsub = this.onPhaseChange((phase) => {
                if (phase === target) {
                    cleanup();
                    resolve();
                } else if (this.shouldRejectPhase(phase, target)) {
                    cleanup();
                    reject(
                        new Error(
                            `RuntimeOrchestrator: reached "${phase}" before "${target}"`
                        )
                    );
                }
            });

            if (timeoutMs !== undefined) {
                timeoutId = setTimeout(() => {
                    cleanup();
                    reject(
                        new Error(
                            `RuntimeOrchestrator: timed out waiting for "${target}" after ${timeoutMs}ms`
                        )
                    );
                }, timeoutMs);
            }
        });
    }

    private shouldRejectPhase(
        phase: RuntimePhase,
        target: RuntimePhase
    ): boolean {
        return (
            phase === "unloaded" ||
            (phase === "degraded" && target !== "unloaded")
        );
    }

    // ── State machine table ───────────────────────────────────────────────

    private _transition(
        current: RuntimePhase,
        event: RuntimeEvent
    ): RuntimePhase | null {
        switch (event.type) {
            case "boot-started":
                return null;

            case "boot-succeeded":
                return current === "booting" ? "ready" : null;

            case "boot-failed":
                return current === "booting" ? "degraded" : null;

            case "sync-started":
                return current === "ready" ? "syncing" : null;

            case "sync-finished":
                return current === "syncing" ? "ready" : null;

            case "reload-started":
                // Reload can be triggered from ready or syncing.
                return current === "ready" || current === "syncing"
                    ? "reloading"
                    : null;

            case "reload-finished":
                return current === "reloading" ? "ready" : null;

            case "reload-failed":
                return current === "reloading" ? "degraded" : null;

            case "fatal-error":
                return current !== "unloaded" ? "degraded" : null;

            case "unload":
                // Unload is valid from any non-already-unloaded phase.
                return current !== "unloaded" ? "unloaded" : null;
        }
    }

    private _notify(phase: RuntimePhase, prev: RuntimePhase): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(phase, prev);
            } catch (e) {
                console.error(
                    "[RuntimeOrchestrator] phase-change listener threw:",
                    e
                );
            }
        }
    }
}
