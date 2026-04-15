import {
    debounce,
    Platform,
    TFile,
    type Debouncer,
    type EventRef,
} from "obsidian";
import type ObsidianGit from "../main";
import { ConflictHistoryManager } from "./conflictHistory";
import {
    compileExcludePatterns,
    isPathExcludedByCompiledPatterns,
} from "./excludeMatcher";
import { GiteaApiSyncProvider } from "./giteaApiSyncProvider";
import { GitHubApiSyncProvider } from "./githubApiSyncProvider";
import { GitLabApiSyncProvider } from "./gitlabApiSyncProvider";
import { GitSyncProvider } from "./gitSyncProvider";
import { isPathInTrackedDirectory, toRemoteScopedPath } from "./pathScope";
import { syncAuditLog } from "./syncAuditLog";
import type {
    SyncBranchSelection,
    Conflict,
    ConflictResolution,
    FileChangeType,
    SyncFileMetadata,
    SyncProvider,
    SyncProviderCapabilities,
} from "./syncProvider";
import { hasSnapshotCapability } from "./syncProvider";
import type { SyncErrorCode, SyncStateManager } from "./syncState";

type EventRefEntry = {
    ref: EventRef;
    source: "vault" | "workspace";
};

/**
 * SyncManager
 *
 * Top-level coordinator for Obsidian Git Vault's hybrid engine.
 *
 * Responsibilities:
 *   1. Select the active SyncProvider based on plugin settings + platform.
 *   2. Expose a single `triggerSync()` entry-point used by UI and automation.
 *   3. Manage smart-sync event listeners (file-change, network, idle, close).
 *   4. Route conflicts to the ConflictModal or apply the configured auto-strategy.
 *   5. Update SyncStateManager throughout the lifecycle.
 */
export class SyncManager {
    private static readonly INFO_NOTICE_TIMEOUT = 5_000;
    private static readonly ERROR_NOTICE_TIMEOUT = 10_000;
    private static readonly SYNCING_NOTICE_TIMEOUT = 2_000;
    private provider: SyncProvider | null = null;
    private fileChangeDebouncer: Debouncer<[], void> | undefined;
    private vaultEventRefs: EventRefEntry[] = [];
    private networkCheckInterval: number | undefined;
    private idleTimeoutId: number | undefined;
    private idleActivityListeners: Array<
        [string, EventListenerOrEventListenerObject]
    > = [];
    private currentSyncSessionId = crypto.randomUUID();
    private conflictHistory: ConflictHistoryManager;
    private compiledExcludePatterns = compileExcludePatterns([]);
    private cachedBranchSelections = new Map<string, SyncBranchSelection>();

    constructor(private readonly plugin: ObsidianGit) {
        this.conflictHistory = new ConflictHistoryManager(plugin);
    }

    private get state(): SyncStateManager {
        return this.plugin.syncState;
    }

    private audit(event: string, details?: Record<string, unknown>): void {
        syncAuditLog("manager", event, {
            provider: this.plugin.settings.activeSyncProvider,
            ...details,
        });
    }

    private showNotice(
        message: string,
        timeout: number = SyncManager.INFO_NOTICE_TIMEOUT
    ): void {
        this.plugin.makeSyncNotice(message, timeout);
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private refreshCompiledPatterns(): void {
        this.compiledExcludePatterns = compileExcludePatterns(
            this.plugin.settings?.syncExcludePaths ?? []
        );
    }

    private getBranchSelectionCacheKey(): string {
        const settings = this.plugin.settings;
        switch (settings.activeSyncProvider) {
            case "github":
                return `github:${settings.githubOwner ?? ""}:${settings.githubRepo ?? ""}`;
            case "gitlab":
                return `gitlab:${settings.gitlabBaseUrl ?? ""}:${settings.gitlabProjectId ?? ""}`;
            case "gitea":
                return `gitea:${settings.giteaBaseUrl ?? ""}:${settings.giteaOwner ?? ""}:${settings.giteaRepo ?? ""}`;
            case "git":
            default:
                return "git";
        }
    }

    private getConfiguredBranchFallback(): string {
        const settings = this.plugin.settings;
        switch (settings.activeSyncProvider) {
            case "github":
                return settings.githubBranch || "";
            case "gitlab":
                return settings.gitlabBranch || "";
            case "gitea":
                return settings.giteaBranch || "";
            case "git":
            default:
                return "";
        }
    }

    private normalizeBranchSelection(
        selection: SyncBranchSelection,
        currentOverride?: string
    ): SyncBranchSelection {
        const current = currentOverride ?? selection.current ?? "";
        const branchSet = new Set<string>(selection.branches ?? []);
        if (current) {
            branchSet.add(current);
        }
        return {
            current,
            branches: [...branchSet],
        };
    }

    private getCachedBranchSelectionFallback(): SyncBranchSelection {
        const cached = this.cachedBranchSelections.get(
            this.getBranchSelectionCacheKey()
        );
        return this.normalizeBranchSelection(
            cached ?? { branches: [], current: "" },
            this.getConfiguredBranchFallback()
        );
    }

    private shouldTrackPendingPath(vaultPath: string): boolean {
        const trackedDirectory = this.plugin.settings?.trackedDirectory ?? "";
        if (!isPathInTrackedDirectory(vaultPath, trackedDirectory)) {
            return false;
        }

        const remotePath = toRemoteScopedPath(vaultPath, trackedDirectory);
        return !isPathExcludedByCompiledPatterns(
            remotePath,
            this.compiledExcludePatterns
        );
    }

    private trackPendingChange(vaultPath: string, type: FileChangeType): void {
        if (!this.shouldTrackPendingPath(vaultPath)) {
            this.state.removePendingChange(vaultPath);
            return;
        }

        this.state.addPendingChange({ path: vaultPath, type });
    }

    private async initialiseProvider(
        mode: "init" | "reload"
    ): Promise<boolean> {
        const provider = this.buildProvider();
        this.audit("provider.initialise:start", {
            mode,
            providerClass: provider.constructor.name,
        });

        try {
            await provider.init();
            this.provider = provider;
            this.state.setProvider(this.plugin.settings.activeSyncProvider);
            this.audit("provider.initialise:success", {
                mode,
                providerClass: provider.constructor.name,
            });
            return true;
        } catch (error) {
            this.provider = null;
            const message = this.getErrorMessage(error);
            this.state.markSyncError(message);
            this.audit("provider.initialise:failure", {
                mode,
                providerClass: provider.constructor.name,
                message,
            });
            this.showNotice(
                `Git Vault: provider ${mode} failed – ${message}`,
                SyncManager.ERROR_NOTICE_TIMEOUT
            );
            return false;
        }
    }

    // ── Initialisation ────────────────────────────────────────────────────

    async init(): Promise<void> {
        this.refreshCompiledPatterns();
        if (!(await this.initialiseProvider("init"))) {
            return;
        }

        // Clear any persisted conflicts after the provider is initialised so
        // stale conflict entries from a previous session are not shown on startup.
        // This mirrors `reload()` which calls `this.state.clearConflicts()` when
        // the provider is rebuilt. Call sequence here is:
        // init() -> this.provider.init() -> this.state.clearConflicts() -> registerSmartTriggers()
        this.state.clearConflicts();

        this.registerSmartTriggers();

        // Prefetch branch selection on startup so UI controls (status bar
        // and any later-opened branch dropdowns) display up-to-date lists
        // immediately after Obsidian opens. Cache warmed here avoids a
        // stale/no-op branch list when the source-control view is mounted
        // later in the session.
        try {
            await this.refreshBranchSelection();
            // Update the branch status bar if present so the label reflects
            // the freshly-fetched branch info on boot.
            await this.plugin.branchBar?.display().catch(() => {});
            // Notify any UI consumers (e.g. the source-control view) that
            // branch selection has been refreshed so they can re-query and
            // update their controls on initial boot.
            try {
                this.plugin.app.workspace.trigger("obsidian-git:refreshed");
            } catch {
                // Best-effort only; ignore if workspace is not ready.
            }
        } catch (err) {
            // Non-fatal: log and continue. UI will refresh on-demand later.
            this.plugin.log(
                "[Git Vault] Failed to prefetch branch selection on init:",
                err
            );
        }
    }

    /** Tear down all listeners and timers. */
    unload(): void {
        this.clearSmartTriggers();
    }

    /** Rebuild the provider and re-register triggers (e.g. after settings change). */
    async reload(): Promise<void> {
        // Invalidate cached branch selections on reload to avoid stale data
        this.cachedBranchSelections.clear();
        this.clearSmartTriggers();
        this.refreshCompiledPatterns();
        // Clear any conflicts that were surfaced for the previous repo/branch so
        // stale entries never appear in the UI after a settings change.
        this.state.clearConflicts();
        if (!(await this.initialiseProvider("reload"))) {
            return;
        }
        this.registerSmartTriggers();
    }

    // ── Provider selection ────────────────────────────────────────────────

    private buildProvider(): SyncProvider {
        const setting = this.plugin.settings.activeSyncProvider;

        switch (setting) {
            case "git":
                return this.buildGitProvider();
            case "github":
                return this.buildGitHubProvider();
            case "gitlab":
                return this.buildGitLabProvider();
            case "gitea":
                return this.buildGiteaProvider();
        }

        return Platform.isMobileApp
            ? this.buildGitHubProvider()
            : this.buildGitProvider();
    }

    private buildGitProvider(): SyncProvider {
        return new GitSyncProvider(this.plugin);
    }

    private buildGitHubProvider(): SyncProvider {
        return new GitHubApiSyncProvider(this.plugin);
    }

    private buildGitLabProvider(): SyncProvider {
        return new GitLabApiSyncProvider(this.plugin);
    }

    private buildGiteaProvider(): SyncProvider {
        return new GiteaApiSyncProvider(this.plugin);
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Single entry-point called by main.ts's vault-change handler for all
     * file modify/create/delete/rename events.
     *
     * Activates the SyncManager's own file-change debouncer (when
     * `syncOnFileChange` is enabled).  The git-automatics path
     * (`autoBackupAfterFileChange`) is handled by AutomaticsManager directly
     * from the same vault-change handler in main.ts, keeping each
     * manager self-contained.
     */
    notifyFileChange(): void {
        this.fileChangeDebouncer?.();
    }

    /**
     * Trigger a full bidirectional sync.
     * Enqueues via PromiseQueue so concurrent calls are safely serialised.
     */
    triggerSync(reason: string = "manual"): void {
        this.audit("sync.enqueue", { reason });
        void this.plugin.promiseQueue.addTask(async () => {
            await this.runSync();
        });
    }

    async syncNow(): Promise<void> {
        this.audit("sync.direct-requested");
        return new Promise((resolve, reject) => {
            try {
                void this.plugin.promiseQueue.addTask(
                    async () => {
                        try {
                            await this.runSync();
                            resolve();
                        } catch (err) {
                            reject(
                                err instanceof Error
                                    ? err
                                    : new Error(String(err))
                            );
                        }
                    },
                    () => resolve()
                );
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    getCapabilities(): SyncProviderCapabilities {
        return (
            this.provider?.getCapabilities() ?? {
                supportsAtomicBatchWrites: false,
                supportsRemoteCommitHistory: false,
                supportsPerFileMetadata: false,
                supportsEncryptedSync: false,
                supportsExcludePaths: false,
                supportsTrackedDirectoryScoping: false,
                supportsRemoteFileUrls: false,
                supportsDedicatedVaultImport: false,
                supportsDefaultBranchAutoDetection: false,
            }
        );
    }

    async getFileMetadata(path: string): Promise<SyncFileMetadata | null> {
        if (!this.provider) {
            return null;
        }
        return this.provider.getFileMetadata(path);
    }

    async getBranchSelection(): Promise<SyncBranchSelection> {
        if (!this.provider) {
            return this.getCachedBranchSelectionFallback();
        }
        const cacheKey = this.getBranchSelectionCacheKey();
        const cached = this.cachedBranchSelections.get(cacheKey);

        try {
            const selection = this.normalizeBranchSelection(
                await this.provider.getBranchSelection()
            );
            const shouldReuseCachedBranches =
                cached != null &&
                cached.branches.length > selection.branches.length &&
                selection.branches.length <= 1 &&
                selection.current.length > 0;

            if (shouldReuseCachedBranches) {
                return this.normalizeBranchSelection(cached, selection.current);
            }

            if (selection.branches.length > 0) {
                this.cachedBranchSelections.set(cacheKey, selection);
            }
            return selection;
        } catch (error) {
            const fallback = this.getCachedBranchSelectionFallback();
            if (fallback.branches.length > 0) {
                console.debug(
                    "[Git Vault] Falling back to cached branch selection after refresh failure:",
                    error
                );
                return fallback;
            }
            throw error;
        }
    }

    async refreshBranchSelection(): Promise<SyncBranchSelection> {
        this.cachedBranchSelections.delete(this.getBranchSelectionCacheKey());
        return this.getBranchSelection();
    }

    private async confirmApiBranchReplacement(
        branch: string
    ): Promise<boolean> {
        const state = this.state.getState();
        const pendingCount = state.pendingChanges.length;
        const conflictCount = state.conflicts.length;

        if (pendingCount === 0 && conflictCount === 0) {
            return true;
        }

        const replaceLabel = `Switch to "${branch}" and replace local files`;
        const detailParts = [
            pendingCount > 0 ? `${pendingCount} pending local change(s)` : null,
            conflictCount > 0
                ? `${conflictCount} unresolved conflict(s)`
                : null,
        ].filter((part): part is string => part != null);
        const { GeneralModal } = await import("../ui/modals/generalModal");
        const choice = await new GeneralModal(this.plugin, {
            options: ["Cancel", replaceLabel],
            onlySelection: true,
            placeholder: `${detailParts.join(" and ")} in the tracked scope will be replaced by the selected branch snapshot.`,
        }).openAndGetResult();

        return choice === replaceLabel;
    }

    private async rollbackApiBranchSwitch(
        previousBranch: string,
        attemptedBranch: string,
        originalError: unknown
    ): Promise<void> {
        this.audit("branch-switch:rollback:start", {
            attemptedBranch,
            previousBranch,
            message: this.getErrorMessage(originalError),
        });
        try {
            await this.provider?.switchBranch(previousBranch);
            this.audit("branch-switch:rollback:success", {
                attemptedBranch,
                previousBranch,
            });
        } catch (rollbackError) {
            this.audit("branch-switch:rollback:failure", {
                attemptedBranch,
                previousBranch,
                message: this.getErrorMessage(rollbackError),
            });
            this.plugin.log(
                "[Git Vault] Failed to roll back API branch selection after snapshot checkout failure:",
                rollbackError
            );
        }
    }

    async switchBranch(branch: string): Promise<boolean> {
        if (!this.provider) {
            throw new Error("Sync provider is not initialized yet.");
        }
        const providerType = this.plugin.settings.activeSyncProvider;
        let previousApiBranch = "";
        if (providerType !== "git") {
            previousApiBranch = this.getConfiguredBranchFallback();
            if (!previousApiBranch) {
                previousApiBranch = await this.provider
                    .getBranchSelection()
                    .then((selection) => selection.current)
                    .catch(() => "");
            }
        }
        if (
            providerType !== "git" &&
            !(await this.confirmApiBranchReplacement(branch))
        ) {
            this.audit("branch-switch:cancelled", {
                branch,
                provider: providerType,
            });
            return false;
        }

        this.audit("branch-switch:start", {
            branch,
            provider: providerType,
        });

        // Expose an explicit flag so other subsystems / UI can observe when
        // a branch switch is in progress. This complements the existing
        // vault-change-effects suppression mechanism.
        this.plugin.isBranchSwitchInProgress = true;
        try {
            try {
                await this.plugin.runWithSuppressedVaultChangeEffects(
                    async () => {
                        await this.provider!.switchBranch(branch);

                        if (providerType === "git") {
                            return;
                        }
                        const snapshotProvider = this.provider as SyncProvider;
                        if (!hasSnapshotCapability(snapshotProvider)) {
                            return;
                        }

                        this.audit("branch-switch:apply-snapshot", {
                            branch,
                            provider: providerType,
                        });
                        this.state.markSyncStart();
                        try {
                            const filesChanged =
                                await snapshotProvider.checkoutBranchSnapshot();
                            this.state.clearConflicts();
                            this.state.clearPendingChanges();
                            this.state.markSyncSuccess(filesChanged);
                        } catch (error) {
                            const message = this.getErrorMessage(error);
                            this.state.markSyncError(message);
                            throw error;
                        }
                    }
                );
            } catch (error) {
                if (
                    providerType !== "git" &&
                    previousApiBranch &&
                    previousApiBranch !== branch
                ) {
                    await this.rollbackApiBranchSwitch(
                        previousApiBranch,
                        branch,
                        error
                    );
                }
                throw error;
            }
        } finally {
            this.plugin.isBranchSwitchInProgress = false;
        }

        this.audit("branch-switch:success", {
            branch,
            provider: providerType,
        });

        return true;
    }

    async getConflictHistory() {
        return this.conflictHistory.listEntries();
    }

    /** Trigger pull-only. */
    triggerPull(reason: string = "manual"): void {
        this.audit("pull.enqueue", { reason });
        void this.plugin.promiseQueue.addTask(async () => {
            await this.runPull();
        });
    }

    async pullNow(): Promise<void> {
        this.audit("pull.direct-requested");
        return new Promise((resolve, reject) => {
            try {
                void this.plugin.promiseQueue.addTask(
                    async () => {
                        try {
                            await this.runPull();
                            resolve();
                        } catch (err) {
                            reject(
                                err instanceof Error
                                    ? err
                                    : new Error(String(err))
                            );
                        }
                    },
                    () => resolve()
                );
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    /** Trigger push-only. */
    triggerPush(reason: string = "manual"): void {
        this.audit("push.enqueue", { reason });
        void this.plugin.promiseQueue.addTask(async () => {
            if (!this.provider) return;
            this.state.markSyncStart();
            this.audit("push:start", {
                pendingChanges: this.state.getState().pendingChanges.length,
            });
            try {
                await this.provider.push();
                this.state.markSyncSuccess();
                this.state.clearPendingChanges();
                this.audit("push:success");
                this.showNotice("Git Vault: push completed");
            } catch (e) {
                const msg = this.getErrorMessage(e);
                const errorCode = this.classifySyncErrorCode(msg);
                this.state.markSyncError(msg, errorCode);
                this.audit("push:failure", {
                    message: msg,
                    errorCode,
                });
                this.showSyncFailureNotice("push", msg, errorCode);
            }
        });
    }

    /** Open the visual conflict resolver for the given conflicts. */
    openConflictResolver(conflicts: Conflict[]): void {
        if (conflicts.length === 0) return;
        // Lazy import to avoid circular dependency at module load time
        import("../ui/modals/conflictModal")
            .then(({ ConflictModal }) => {
                new ConflictModal(
                    this.plugin,
                    conflicts,
                    (resolutions: ConflictResolution[]) => {
                        void this.plugin.promiseQueue.addTask(() =>
                            this.applyConflictResolutions(resolutions)
                        );
                    }
                ).open();
            })
            .catch((error: unknown) => {
                const msg = this.getErrorMessage(error);
                this.state.markSyncError(msg);
                console.error(
                    "Git Vault: failed to load conflict modal",
                    error
                );
                this.showNotice(
                    `Git Vault: failed to open conflict resolver – ${msg}`,
                    SyncManager.ERROR_NOTICE_TIMEOUT
                );
            });
    }

    // ── Core sync execution ───────────────────────────────────────────────

    private async runSync(): Promise<void> {
        if (!this.provider) {
            this.audit("sync:skipped", {
                reason: "no-provider",
            });
            this.showNotice(
                "Git Vault: no provider initialised",
                SyncManager.ERROR_NOTICE_TIMEOUT
            );
            return;
        }

        this.currentSyncSessionId = crypto.randomUUID();
        this.state.markSyncStart();
        this.audit("sync:start", {
            sessionId: this.currentSyncSessionId,
            pendingChanges: this.state.getState().pendingChanges.length,
            conflictStrategy: this.plugin.settings.conflictResolutionStrategy,
        });
        this.showNotice(
            "Git Vault: syncing…",
            SyncManager.SYNCING_NOTICE_TIMEOUT
        );

        try {
            const result = await this.provider.sync();
            const hasConflicts = (result.conflicts?.length ?? 0) > 0;
            this.audit("sync:provider-result", {
                sessionId: this.currentSyncSessionId,
                success: result.success,
                filesChanged: result.filesChanged,
                conflictCount: result.conflicts?.length ?? 0,
                message: result.message,
            });

            if (result.success) {
                this.state.markSyncSuccess(result.filesChanged);
                this.state.clearPendingChanges();
            } else {
                const errorCode = this.classifySyncErrorCode(result.message);
                this.state.markSyncError(result.message, errorCode);
                this.showSyncFailureNotice("sync", result.message, errorCode);

                if (!hasConflicts) {
                    return;
                }
            }

            if (hasConflicts) {
                this.state.setConflicts(result.conflicts);

                const strategy =
                    this.plugin.settings.conflictResolutionStrategy;
                const mustOpenResolver = result.conflicts.some(
                    (conflict) => conflict.requiresManualResolution
                );

                if (strategy === "manual" || mustOpenResolver) {
                    this.audit("sync:conflicts-manual", {
                        sessionId: this.currentSyncSessionId,
                        conflictCount: result.conflicts.length,
                    });
                    this.openConflictResolver(result.conflicts);
                    return;
                } else {
                    // Auto-resolve
                    const resolutions: ConflictResolution[] =
                        result.conflicts.map((c) => ({
                            path: c.path,
                            strategy:
                                strategy === "last-write-wins" ||
                                strategy === "always-local" ||
                                strategy === "always-remote"
                                    ? strategy
                                    : "last-write-wins",
                        }));
                    this.audit("sync:conflicts-auto", {
                        sessionId: this.currentSyncSessionId,
                        conflictCount: result.conflicts.length,
                        strategy,
                    });
                    await this.applyConflictResolutions(resolutions);
                    return;
                }
            } else {
                this.state.clearConflicts();
            }

            // Only emit a final notice when there were actual changes.
            const finalChanged = result.filesChanged ?? 0;
            this.audit("sync:complete", {
                sessionId: this.currentSyncSessionId,
                filesChanged: finalChanged,
            });
            if (finalChanged > 0) {
                const msg = `Git Vault: ${finalChanged} file(s) synced`;
                this.showNotice(msg);
            }
        } catch (e) {
            const msg = this.getErrorMessage(e);
            const errorCode = this.classifySyncErrorCode(msg);
            this.state.markSyncError(msg, errorCode);
            this.audit("sync:failure", {
                sessionId: this.currentSyncSessionId,
                message: msg,
                errorCode,
            });
            this.showSyncFailureNotice("sync", msg, errorCode);
        }
    }

    private async runPull(): Promise<void> {
        if (!this.provider) {
            this.audit("pull:skipped", {
                reason: "no-provider",
            });
            this.showNotice(
                "Git Vault: no provider initialised",
                SyncManager.ERROR_NOTICE_TIMEOUT
            );
            return;
        }
        this.state.markSyncStart();
        this.audit("pull:start", {
            pendingChanges: this.state.getState().pendingChanges.length,
        });
        try {
            await this.provider.pull();
            this.state.markSyncSuccess();
            this.state.clearPendingChanges();
            this.audit("pull:success");
            this.showNotice("Git Vault: pull completed");
        } catch (e) {
            const msg = this.getErrorMessage(e);
            const errorCode = this.classifySyncErrorCode(msg);
            this.state.markSyncError(msg, errorCode);
            this.audit("pull:failure", {
                message: msg,
                errorCode,
            });
            this.showSyncFailureNotice("pull", msg, errorCode);
        }
    }

    private async applyConflictResolutions(
        resolutions: ConflictResolution[]
    ): Promise<void> {
        if (!this.provider) return;
        const conflicts = [...this.state.getState().conflicts];
        const providerType = this.plugin.settings.activeSyncProvider;
        this.state.markSyncStart();
        this.audit("conflicts.resolve:start", {
            sessionId: this.currentSyncSessionId,
            conflictCount: conflicts.length,
            resolutionCount: resolutions.length,
            strategies: [...new Set(resolutions.map((r) => r.strategy))],
        });
        try {
            await this.provider.resolveConflicts(resolutions);
            await this.conflictHistory.appendEntries(
                await this.conflictHistory.buildEntries({
                    conflicts,
                    resolutions,
                    provider: this.state.getState().provider,
                    automatic: resolutions.every(
                        (resolution) => resolution.strategy !== "manual"
                    ),
                    encrypted: this.plugin.settings.apiEncryptionEnabled,
                    syncSessionId: this.currentSyncSessionId,
                })
            );
            // For non-Git providers we clear the in-memory state immediately
            // after applying resolutions. For Git (local) providers we postpone
            // clearing until after the commit (and push if enabled) completes
            // successfully to avoid losing unresolved state if commit/push fails.
            if (providerType !== "git") {
                this.state.clearConflicts();
                this.state.clearPendingChanges();
            } else {
                const committed = await this.plugin.commit({
                    fromAutoBackup: false,
                    commitMessage: "Resolve merge conflicts",
                    onlyStaged: true,
                });

                if (!committed) {
                    throw new Error(
                        "Conflict resolutions were applied, but the merge commit did not complete."
                    );
                }

                if (!this.plugin.settings.disablePush) {
                    const pushed = await this.plugin.push();
                    if (!pushed) {
                        throw new Error(
                            "Conflict resolutions were committed locally, but the push did not complete."
                        );
                    }
                }

                // Commit (and push) succeeded — now clear persisted conflict/pending state
                this.state.clearConflicts();
                this.state.clearPendingChanges();
            }

            const uniqueFilesChanged = new Set(resolutions.map((r) => r.path))
                .size;
            this.state.markSyncSuccess(uniqueFilesChanged);
            this.audit("conflicts.resolve:success", {
                sessionId: this.currentSyncSessionId,
                resolutionCount: resolutions.length,
                provider: providerType,
            });
            this.showNotice(
                `Git Vault: ${resolutions.length} conflict(s) resolved`
            );
        } catch (e) {
            const msg = this.getErrorMessage(e);
            const errorCode = this.classifySyncErrorCode(msg);
            this.state.markSyncError(msg, errorCode);
            this.audit("conflicts.resolve:failure", {
                sessionId: this.currentSyncSessionId,
                message: msg,
                errorCode,
            });
            this.showSyncFailureNotice("conflict resolution", msg, errorCode);
        }
    }

    // Some providers report a bare "already exists" message when the remote
    // state already matches local state, so we normalize only that exact
    // no-op message. More specific "already exists" errors still need to
    // surface because they often indicate a real path conflict.
    private classifySyncErrorCode(message: string): SyncErrorCode | null {
        return /^already exists\.?$/i.test(message.trim())
            ? "ALREADY_EXISTS"
            : null;
    }

    private showSyncFailureNotice(
        action: string,
        message: string,
        errorCode: SyncErrorCode | null
    ): void {
        if (errorCode === "ALREADY_EXISTS") {
            this.showNotice("Git Vault: already up to date");
            return;
        }

        this.showNotice(
            `Git Vault: ${action} failed – ${message}`,
            SyncManager.ERROR_NOTICE_TIMEOUT
        );
    }

    // ── Smart sync triggers ───────────────────────────────────────────────

    private registerSmartTriggers(): void {
        const s = this.plugin.settings;
        const { workspace } = this.plugin.app;

        // For API providers, track vault changes so the UI can display a live
        // "pending changes" count without waiting for the next sync.
        if (s.activeSyncProvider !== "git") {
            this.vaultEventRefs.push({
                ref: this.plugin.app.vault.on("modify", (file) => {
                    if (file instanceof TFile) {
                        this.trackPendingChange(file.path, "modified");
                    }
                }),
                source: "vault",
            });
            this.vaultEventRefs.push({
                ref: this.plugin.app.vault.on("create", (file) => {
                    if (file instanceof TFile) {
                        this.trackPendingChange(file.path, "added");
                    }
                }),
                source: "vault",
            });
            this.vaultEventRefs.push({
                ref: this.plugin.app.vault.on("delete", (file) => {
                    if (file instanceof TFile) {
                        this.trackPendingChange(file.path, "deleted");
                    }
                }),
                source: "vault",
            });
            this.vaultEventRefs.push({
                ref: this.plugin.app.vault.on("rename", (file, oldPath) => {
                    if (!(file instanceof TFile)) {
                        return;
                    }

                    this.trackPendingChange(oldPath, "deleted");
                    this.trackPendingChange(file.path, "added");
                }),
                source: "vault",
            });
        }

        // File-change trigger — the debouncer is created here but vault
        // events are routed in via `notifyFileChange()` which is called from
        // main.ts's permanent vault-change handler.  Keeping vault registration
        // in one place (main.ts) prevents duplicate listeners after a reload.
        if (s.syncOnFileChange) {
            this.fileChangeDebouncer = debounce(
                () => {
                    this.audit("trigger.file-change", {
                        debounceMs: s.syncOnFileChangeDebounce,
                    });
                    this.triggerSync("file-change");
                },
                s.syncOnFileChangeDebounce,
                true
            );
        }

        // On-close trigger
        if (s.syncOnClose) {
            this.vaultEventRefs.push({
                ref: workspace.on("quit", () => {
                    // The quit event is synchronous; triggerSync() enqueues an
                    // async task that may not finish before the process exits.
                    // Notify the user so they are aware sync may be incomplete.
                    const { pendingChanges } = this.state.getState();
                    this.triggerSync("close");
                    if (pendingChanges.length > 0) {
                        this.showNotice(
                            "Git Vault: background sync triggered on close. If the app exits before it completes, changes will sync on next launch.",
                            6000
                        );
                    }
                }),
                source: "workspace",
            });
        }

        // Network reconnect polling (simple interval check)
        if (s.syncOnNetworkReconnect) {
            let wasOffline = !navigator.onLine;
            this.networkCheckInterval = window.setInterval(() => {
                const isOffline = !navigator.onLine;
                this.state.setOnline(!isOffline);
                if (wasOffline && !isOffline) {
                    this.triggerSync("network-reconnect");
                }
                wasOffline = isOffline;
            }, 5000);
        }

        // Idle trigger
        if (s.syncOnIdleMinutes > 0) {
            const idleMs = s.syncOnIdleMinutes * 60_000;
            const resetIdle = () => {
                window.clearTimeout(this.idleTimeoutId);
                this.idleTimeoutId = window.setTimeout(
                    () => this.triggerSync("idle"),
                    idleMs
                );
            };

            const events: Array<keyof DocumentEventMap> = [
                "keydown",
                "mousedown",
                "touchstart",
            ];
            for (const evt of events) {
                const listener =
                    resetIdle as EventListenerOrEventListenerObject;
                document.addEventListener(evt, listener, { passive: true });
                this.idleActivityListeners.push([evt, listener]);
            }
            resetIdle();
        }
    }

    private clearSmartTriggers(): void {
        this.fileChangeDebouncer?.cancel();
        this.fileChangeDebouncer = undefined;

        // Remove vault / workspace event refs
        for (const { ref, source } of this.vaultEventRefs) {
            if (source === "vault") {
                this.plugin.app.vault.offref(ref);
            } else {
                this.plugin.app.workspace.offref(ref);
            }
        }
        this.vaultEventRefs = [];

        // Network interval
        window.clearInterval(this.networkCheckInterval);
        this.networkCheckInterval = undefined;

        // Idle timer + activity listeners
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = undefined;
        for (const [evt, listener] of this.idleActivityListeners) {
            document.removeEventListener(evt, listener);
        }
        this.idleActivityListeners = [];
    }
}
