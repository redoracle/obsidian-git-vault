import type {
    SyncProviderType,
    FileChange,
    Conflict,
    SyncBranchSelection,
} from "./syncProvider";
import type { Status } from "../types";

// ─── State shape ──────────────────────────────────────────────────────────────

export type SyncErrorCode = "ALREADY_EXISTS";

export interface SyncState {
    /** Unix-ms timestamp of the last successful sync, or null if never synced. */
    lastSyncTime: number | null;
    /** Files with local changes not yet pushed. */
    pendingChanges: FileChange[];
    /** Current unresolved merge conflicts. */
    conflicts: Conflict[];
    /** Which backend is currently in use. */
    provider: SyncProviderType;
    /** Whether a sync operation is in flight. */
    isSyncing: boolean;
    /** Whether the host device has network access. */
    isOnline: boolean;
    /** Cumulative count of successful syncs in this session. */
    syncCount: number;
    /**
     * Last error message, if the most recent sync failed.
     * Cleared on the next successful sync.
     */
    lastError: string | null;
    /**
     * Typed sync error classification for UI logic that should not rely on
     * message substring matching.
     */
    lastErrorCode: SyncErrorCode | null;
    /**
     * Cached result of the most recent `git status` call.
     * `null` = status has never been fetched or was explicitly invalidated.
     * Managed via {@link SyncStateManager.updateCachedGitStatus}.
     */
    cachedGitStatus: Status | null;
    /**
     * Latest branch selection (current branch + available branches) for the
     * active provider.  Updated by SyncManager after init and on branch switches.
     * `null` = provider hasn't delivered its first branch selection yet.
     */
    branchSelection: SyncBranchSelection | null;
    /**
     * Granular lifecycle tracking for the branch selection fetch so the UI
     * can distinguish "not yet loaded" from "loading" from "failed".
     */
    branchSelectionStatus: "idle" | "loading" | "ready" | "error";
    /**
     * Human-readable error message when branchSelectionStatus is "error".
     * Cleared on the next successful load.
     */
    branchSelectionError: string | null;
    /**
     * Whether the sync provider has completed initialisation and is ready to
     * serve branch/sync requests.  false = provider is null or still booting.
     */
    providerReady: boolean;
}

function deepFreeze<T>(value: T): Readonly<T> {
    if (value === null || typeof value !== "object") {
        return value as Readonly<T>;
    }

    if (!Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nestedValue of Object.values(
            value as Record<string, unknown>
        )) {
            deepFreeze(nestedValue);
        }
    }

    return value as Readonly<T>;
}

// ─── State manager ────────────────────────────────────────────────────────────

/**
 * SyncStateManager
 *
 * Centralised, single-source-of-truth for Obsidian Git Vault runtime state.
 *
 * Designed to be instantiated once on the plugin and injected wherever needed.
 * Observers register via {@link subscribe} and are notified synchronously on
 * every state mutation – no external reactive library required.
 */
export class SyncStateManager {
    private state: SyncState = {
        lastSyncTime: null,
        pendingChanges: [],
        conflicts: [],
        provider: "git",
        isSyncing: false,
        isOnline: true,
        syncCount: 0,
        lastError: null,
        lastErrorCode: null,
        cachedGitStatus: null,
        branchSelection: null,
        branchSelectionStatus: "idle",
        branchSelectionError: null,
        providerReady: false,
    };

    private listeners: Array<(state: Readonly<SyncState>) => void> = [];

    // ── Read ──────────────────────────────────────────────────────────────

    /** Returns an immutable snapshot of the current state. */
    getState(): Readonly<SyncState> {
        return Object.freeze({
            ...this.state,
            pendingChanges: Object.freeze([
                ...this.state.pendingChanges,
            ]) as unknown as FileChange[],
            conflicts: Object.freeze([
                ...this.state.conflicts,
            ]) as unknown as Conflict[],
            cachedGitStatus: this.state.cachedGitStatus
                ? (deepFreeze({ ...this.state.cachedGitStatus }) as Status)
                : null,
            branchSelection: this.state.branchSelection
                ? (deepFreeze({
                      ...this.state.branchSelection,
                      branches: [...this.state.branchSelection.branches],
                  }) as unknown as SyncBranchSelection)
                : null,
        });
    }

    // ── Write ─────────────────────────────────────────────────────────────

    /**
     * Merge a partial update into the state and notify all listeners.
     * Performs a shallow merge – nested arrays/objects are replaced, not merged.
     */
    update(partial: Partial<SyncState>): void {
        this.state = { ...this.state, ...partial };
        this.notify();
    }

    // ── Convenience mutators ──────────────────────────────────────────────

    setProvider(provider: SyncProviderType): void {
        this.update({ provider });
    }

    setOnline(online: boolean): void {
        this.update({ isOnline: online });
    }

    markSyncStart(): void {
        this.update({ isSyncing: true, lastError: null, lastErrorCode: null });
    }

    markSyncSuccess(filesChanged = 0): void {
        this.update({
            isSyncing: false,
            lastSyncTime: Date.now(),
            syncCount: this.state.syncCount + 1,
            lastError: null,
            lastErrorCode: null,
            pendingChanges: filesChanged > 0 ? [] : this.state.pendingChanges,
        });
    }

    markSyncError(
        errorMessage: string,
        errorCode: SyncErrorCode | null = null
    ): void {
        // `ALREADY_EXISTS` is treated as a neutral no-op state, so the
        // provider message is intentionally ignored while lastErrorCode keeps
        // the classification for downstream notices.
        this.update({
            isSyncing: false,
            lastError: errorCode === "ALREADY_EXISTS" ? null : errorMessage,
            lastErrorCode: errorCode,
        });
    }

    setConflicts(conflicts: Conflict[]): void {
        this.update({ conflicts });
    }

    clearConflicts(): void {
        this.update({ conflicts: [] });
    }

    addPendingChange(change: FileChange): void {
        // Deduplicate by path
        const existing = this.state.pendingChanges.findIndex(
            (c) => c.path === change.path
        );
        const updated = [...this.state.pendingChanges];
        if (existing >= 0) {
            updated[existing] = change;
        } else {
            updated.push(change);
        }
        this.update({ pendingChanges: updated });
    }

    removePendingChange(path: string): void {
        this.update({
            pendingChanges: this.state.pendingChanges.filter(
                (c) => c.path !== path
            ),
        });
    }

    clearPendingChanges(): void {
        this.update({ pendingChanges: [] });
    }

    // ── Branch selection ───────────────────────────────────────────────────

    /**
     * Store the latest branch selection from the active provider.
     * Pass `null` to invalidate (e.g. during provider teardown).
     * Sets status to "ready" when a selection is provided, "idle" when null.
     */
    setBranchSelection(selection: SyncBranchSelection | null): void {
        this.update({
            branchSelection: selection,
            branchSelectionStatus: selection ? "ready" : "idle",
            branchSelectionError: null,
        });
    }

    /**
     * Mark branch selection as in-flight so the UI can show a loading
     * indicator without waiting for the next provider round-trip.
     */
    setBranchSelectionLoading(): void {
        this.update({
            branchSelectionStatus: "loading",
            branchSelectionError: null,
        });
    }

    /**
     * Store a successful branch selection result in one atomic update.
     */
    setBranchSelectionReady(selection: SyncBranchSelection): void {
        this.update({
            branchSelection: selection,
            branchSelectionStatus: "ready",
            branchSelectionError: null,
        });
    }

    /**
     * Record a branch selection fetch failure so the UI can surface a
     * recoverable error instead of silently rendering an empty list.
     */
    setBranchSelectionError(error: string): void {
        this.update({
            branchSelectionStatus: "error",
            branchSelectionError: error,
        });
    }

    /**
     * Mark the provider as ready (or not) for UI consumers.
     */
    setProviderReady(ready: boolean): void {
        this.update({ providerReady: ready });
    }

    // ── Cached git status ─────────────────────────────────────────────────

    /**
     * Store the result of a `git status` call.
     * Pass `null` to explicitly invalidate the cache (e.g. after a commit).
     */
    updateCachedGitStatus(status: Status | null): void {
        this.state = { ...this.state, cachedGitStatus: status };
        // Deliberately do NOT call notify() here — this is a read-cache
        // update, not a reactive state change.  UI components that need
        // the live status should already be subscribed to gitManager events.
    }

    /**
     * Return the last cached `git status`, or `null` if none is available.
     * Callers must handle `null` and fall back to a fresh status call.
     */
    getCachedGitStatus(): Status | null {
        return this.state.cachedGitStatus;
    }

    // ── Observer ──────────────────────────────────────────────────────────

    /**
     * Register a callback that is called synchronously whenever the state changes.
     *
     * @returns A disposer function – call it to unsubscribe.
     */
    subscribe(listener: (state: Readonly<SyncState>) => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    private notify(): void {
        const snapshot = this.getState();
        const listeners = [...this.listeners];
        for (const listener of listeners) {
            try {
                listener(snapshot);
            } catch (e) {
                console.error("SyncStateManager: listener threw an error", e);
            }
        }
    }
}
