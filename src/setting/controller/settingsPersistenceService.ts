/**
 * SettingsPersistenceService
 *
 * Formalises the save → reload → redraw sequencing contract that was previously
 * expressed by 57+ ad-hoc `await plugin.saveSettings()` call-sites in
 * settings.ts, many followed inline by `reloadSyncManager()` and/or
 * `refreshDisplayWithDelay()`.
 *
 * Key properties:
 *  1. All save/reload operations are serialised through a FIFO queue so
 *     concurrent calls cannot race.
 *  2. For the reload-sync code path, `refreshDisplayWithDelay()` is scheduled
 *     only when `options.redraw` is true; the UI redraw is therefore
 *     conditional for synchronous reloads rather than unconditional.
 *  3. Change classification is declared once (near the settings type) instead
 *     of being repeated at every call-site.
 *
 * @module
 */

import type { ObsidianGitSettings } from "../../types";

// ─── Change classification ────────────────────────────────────────────────────

/**
 * Every field in {@link ObsidianGitSettings} falls into one of three classes:
 *
 * - `persist-only`   – disk write; no runtime effect.
 * - `reload-sync`    – disk write + provider reload (new endpoint, credential,
 *                       or encryption flag).
 * - `redraw-only`    – disk write + re-render the settings tab (UI structure
 *                       changes: show/hide conditional sections).
 */
export type ChangeClass = "persist-only" | "reload-sync" | "redraw-only";

/**
 * Declare which class each sensitive field belongs to.
 * Anything not listed defaults to `persist-only`.
 */
export const SETTINGS_CHANGE_CLASS: Partial<
    Record<keyof ObsidianGitSettings, ChangeClass>
> = {
    // Provider selection / identity
    activeSyncProvider: "reload-sync",
    // GitHub
    githubOwner: "reload-sync",
    githubRepo: "reload-sync",
    githubBranch: "reload-sync",
    // GitLab
    gitlabProjectId: "reload-sync",
    gitlabBranch: "reload-sync",
    gitlabBaseUrl: "reload-sync",
    // Gitea
    giteaOwner: "reload-sync",
    giteaRepo: "reload-sync",
    giteaBranch: "reload-sync",
    giteaBaseUrl: "reload-sync",
    // Encryption
    apiEncryptionEnabled: "reload-sync",
    // Smart-trigger toggles that add/remove UI sub-sections
    syncOnFileChange: "reload-sync",
    syncOnNetworkReconnect: "reload-sync",
    // UI-structure fields
    differentIntervalCommitAndPush: "redraw-only",
    disablePopups: "redraw-only",
    customMessageOnAutoBackup: "redraw-only",
    autoBackupAfterFileChange: "redraw-only",
    disablePush: "redraw-only",
    pullBeforePush: "redraw-only",
};

// ─── Minimal interface for what the service needs from the plugin ─────────────

export interface IPersistencePluginContext {
    settings: ObsidianGitSettings;
    saveSettings: () => Promise<void>;
}

// ─── Serial queue ─────────────────────────────────────────────────────────────

/**
 * A lightweight FIFO queue that serialises async operations.
 * Unlike the existing `PromiseQueue`, this one:
 *   - Returns a `Promise<void>` so callers can `await` each commit.
 *   - Has no dependency on `ObsidianGit` (testable in isolation).
 */
class SerialQueue {
    private chain: Promise<void> = Promise.resolve();

    enqueue(task: () => Promise<void>): Promise<void> {
        const next = this.chain.then(() => task());
        // Make the chain wait for `next` to settle (not just resolve), so a
        // rejection in one task does not skip subsequent tasks.
        this.chain = next.then(
            () => {},
            () => {}
        );
        return next;
    }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface ISettingsPersistenceService {
    /**
     * Commit a single field change.
     * The change class is resolved automatically from {@link SETTINGS_CHANGE_CLASS}.
     */
    commit<K extends keyof ObsidianGitSettings>(
        field: K,
        value: ObsidianGitSettings[K]
    ): Promise<void>;

    /**
     * Commit multiple field changes in one save cycle.
     * The most severe change class among all fields is applied.
     */
    commitBatch(changes: Partial<ObsidianGitSettings>): Promise<void>;

    /** Persist whatever is currently in memory without triggering reload. */
    persistOnly(): Promise<void>;

    /** Persist and reload the sync provider. */
    persistAndReloadSync(): Promise<void>;

    /** Persist, reload, and schedule a tab redraw. */
    persistAndReloadSyncAndRedraw(): Promise<void>;
}

export class SettingsPersistenceService implements ISettingsPersistenceService {
    private readonly queue = new SerialQueue();

    constructor(
        private readonly plugin: IPersistencePluginContext,
        private readonly reloadSyncManager: () => Promise<void>,
        private readonly scheduleRedraw: () => void
    ) {}

    // ── Field-oriented API (preferred for new code) ───────────────────────

    commit<K extends keyof ObsidianGitSettings>(
        field: K,
        value: ObsidianGitSettings[K]
    ): Promise<void> {
        this.plugin.settings[field] = value;
        const cls = SETTINGS_CHANGE_CLASS[field] ?? "persist-only";
        return this._enqueue(cls, {
            redraw: cls === "reload-sync" || cls === "redraw-only",
        });
    }

    commitBatch(changes: Partial<ObsidianGitSettings>): Promise<void> {
        Object.assign(this.plugin.settings, changes);
        const cls = this._resolveClassForBatch(changes);
        return this._enqueue(cls, {
            redraw: cls === "reload-sync" || cls === "redraw-only",
        });
    }

    // ── Legacy intent API (backward-compatible with existing helpers) ─────

    persistOnly(): Promise<void> {
        return this._enqueue("persist-only");
    }

    persistAndReloadSync(): Promise<void> {
        return this._enqueue("reload-sync", { redraw: false });
    }

    persistAndReloadSyncAndRedraw(): Promise<void> {
        return this._enqueue("reload-sync", { redraw: true });
    }

    // ── Internal ──────────────────────────────────────────────────────────

    private _enqueue(
        cls: ChangeClass,
        options: { redraw?: boolean } = {}
    ): Promise<void> {
        return this.queue.enqueue(async () => {
            await this.plugin.saveSettings();

            if (cls === "reload-sync") {
                try {
                    await this.reloadSyncManager();
                } catch (err) {
                    // Log but never rethrow — settings are saved; a reload
                    // failure should not leave the UI in an unrecoverable state.
                    console.error(
                        "[SettingsPersistenceService] reloadSyncManager threw:",
                        err
                    );
                } finally {
                    if (options.redraw) {
                        this.scheduleRedraw();
                    }
                }
                return;
            }

            if (cls === "redraw-only") {
                if (cls === "redraw-only" && options.redraw) {
                    this.scheduleRedraw();
                }
            }
        });
    }

    private _resolveClassForBatch(
        changes: Partial<ObsidianGitSettings>
    ): ChangeClass {
        let resolved: ChangeClass = "persist-only";
        for (const k of Object.keys(changes) as Array<
            keyof ObsidianGitSettings
        >) {
            const c = SETTINGS_CHANGE_CLASS[k] ?? "persist-only";
            if (c === "reload-sync") return "reload-sync"; // early exit; highest severity
            if (c === "redraw-only") resolved = "redraw-only";
        }
        return resolved;
    }
}
