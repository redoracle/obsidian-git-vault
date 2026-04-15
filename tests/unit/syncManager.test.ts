import { describe, expect, it, vi } from "vitest";
import { SyncManager } from "../../src/syncProvider/syncManager";

function createPlugin() {
    const syncStateSnapshot: {
        conflicts: Array<{ path: string }>;
        pendingChanges: Array<{ path: string }>;
        provider: string;
    } = {
        conflicts: [],
        pendingChanges: [],
        provider: "github",
    };

    return {
        isBranchSwitchInProgress: false,
        settings: {
            activeSyncProvider: "github",
            githubBranch: "main",
            conflictResolutionStrategy: "manual",
            syncOnFileChange: false,
            syncOnFileChangeDebounce: 5000,
            syncOnClose: false,
            syncOnNetworkReconnect: false,
            syncOnIdleMinutes: -1,
            trackedDirectory: "",
            syncExcludePaths: [] as string[],
        },
        makeSyncNotice: vi.fn(),
        promiseQueue: {
            addTask: vi.fn(
                async (task: () => Promise<void>, onFinish?: () => void) => {
                    await task();
                    onFinish?.();
                }
            ),
        },
        runWithSuppressedVaultChangeEffects: vi.fn(
            async <T>(operation: () => Promise<T>) => await operation()
        ),
        syncState: {
            setProvider: vi.fn(),
            markSyncError: vi.fn(),
            markSyncStart: vi.fn(),
            markSyncSuccess: vi.fn(),
            clearConflicts: vi.fn(),
            clearPendingChanges: vi.fn(),
            addPendingChange: vi.fn(),
            removePendingChange: vi.fn(),
            setConflicts: vi.fn(),
            getState: vi.fn(() => syncStateSnapshot),
        },
        commit: vi.fn(() => Promise.resolve(true)),
        push: vi.fn(() => Promise.resolve(true)),
        log: vi.fn(),
        app: {
            vault: {
                on: vi.fn(),
                offref: vi.fn(),
            },
            workspace: {
                on: vi.fn(),
                offref: vi.fn(),
            },
        },
    };
}

describe("SyncManager notices", () => {
    it("uses a timed error notice when provider init fails", async () => {
        const plugin = createPlugin();
        const provider = {
            init: vi.fn(() => Promise.reject(new Error("boom"))),
        };
        const manager = new SyncManager(plugin as never);

        (
            manager as unknown as { buildProvider: () => typeof provider }
        ).buildProvider = () => provider;

        // init() no longer re-throws after showing the error notice; it
        // handles the error internally (notice + state) so callers don't
        // produce a second duplicate notification.
        await expect(manager.init()).resolves.toBeUndefined();
        expect(plugin.makeSyncNotice).toHaveBeenCalledWith(
            "Git Vault: provider init failed – boom",
            10_000
        );
    });

    it("uses a timed info notice for successful sync completion", async () => {
        const plugin = createPlugin();
        const provider = {
            sync: vi.fn(() =>
                Promise.resolve({
                    success: true,
                    filesChanged: 0,
                    conflicts: [],
                    message: "",
                })
            ),
        };
        const manager = new SyncManager(plugin as never);

        (manager as unknown as { provider: typeof provider }).provider =
            provider;

        await (
            manager as unknown as { runSync: () => Promise<void> }
        ).runSync();

        // Ensure the initial syncing notice is shown but avoid emitting the
        // final 'already up to date' notice when there are no changes.
        expect(plugin.makeSyncNotice).toHaveBeenCalledWith(
            "Git Vault: syncing…",
            2_000
        );
        // The final 'already up to date' notice should not be emitted in this path.
        expect(plugin.makeSyncNotice).toHaveBeenCalledTimes(1);
        expect(plugin.syncState.clearPendingChanges).toHaveBeenCalled();
    });

    it("tracks only files inside the API sync scope", () => {
        const plugin = createPlugin();
        plugin.settings.trackedDirectory = "provider-tests/github";
        plugin.settings.syncExcludePaths = ["private/**", ".obsidian/**"];
        const manager = new SyncManager(plugin as never);
        const managerWithHelper = manager as unknown as {
            refreshCompiledPatterns: () => void;
            shouldTrackPendingPath: (vaultPath: string) => boolean;
        };

        managerWithHelper.refreshCompiledPatterns();

        expect(
            managerWithHelper.shouldTrackPendingPath(
                "provider-tests/github/note.md"
            )
        ).toBe(true);
        expect(
            managerWithHelper.shouldTrackPendingPath(
                "provider-tests/github/private/secret.md"
            )
        ).toBe(false);
        expect(
            managerWithHelper.shouldTrackPendingPath(
                "provider-tests/github/.obsidian/workspace.json"
            )
        ).toBe(false);
        expect(
            managerWithHelper.shouldTrackPendingPath("outside-scope.md")
        ).toBe(false);
    });

    it("opens the resolver for forced-manual conflicts even with auto strategy", async () => {
        const plugin = createPlugin();
        plugin.settings.conflictResolutionStrategy = "always-remote";
        const provider = {
            sync: vi.fn(() =>
                Promise.resolve({
                    success: false,
                    filesChanged: 1,
                    conflicts: [
                        {
                            path: "stale.md",
                            deletedRemote: true,
                            requiresManualResolution: true,
                        },
                    ],
                    message: "baseline review required",
                })
            ),
        };
        const manager = new SyncManager(plugin as never);
        const openConflictResolver = vi.fn();

        (manager as unknown as { provider: typeof provider }).provider =
            provider;
        (
            manager as unknown as {
                openConflictResolver: typeof openConflictResolver;
            }
        ).openConflictResolver = openConflictResolver;

        await (
            manager as unknown as { runSync: () => Promise<void> }
        ).runSync();

        expect(openConflictResolver).toHaveBeenCalledWith([
            expect.objectContaining({
                path: "stale.md",
                requiresManualResolution: true,
            }),
        ]);
    });

    it("does not treat specific path-conflict errors as already up to date", async () => {
        const plugin = createPlugin();
        const provider = {
            sync: vi.fn(() =>
                Promise.resolve({
                    success: false,
                    filesChanged: 0,
                    conflicts: [],
                    message:
                        'Cannot create folder "folder" because a non-folder path already exists there.',
                })
            ),
        };
        const manager = new SyncManager(plugin as never);

        (manager as unknown as { provider: typeof provider }).provider =
            provider;

        await (
            manager as unknown as { runSync: () => Promise<void> }
        ).runSync();

        expect(plugin.syncState.markSyncError).toHaveBeenCalledWith(
            'Cannot create folder "folder" because a non-folder path already exists there.',
            null
        );
        expect(plugin.makeSyncNotice).toHaveBeenCalledWith(
            'Git Vault: sync failed – Cannot create folder "folder" because a non-folder path already exists there.',
            10_000
        );
        expect(plugin.makeSyncNotice).not.toHaveBeenCalledWith(
            expect.stringContaining("already up to date"),
            expect.anything()
        );
    });

    it("marks conflict resolution as a successful sync for API providers", async () => {
        const plugin = createPlugin();
        const provider = {
            resolveConflicts: vi.fn(() => Promise.resolve()),
        };
        const manager = new SyncManager(plugin as never);
        const buildEntries = vi.fn(() => Promise.resolve([]));
        const appendEntries = vi.fn(() => Promise.resolve());

        plugin.syncState.getState = vi.fn(() => ({
            conflicts: [{ path: "note.md" }],
            pendingChanges: [],
            provider: "github",
        }));

        (manager as unknown as { provider: typeof provider }).provider =
            provider;
        (
            manager as unknown as {
                conflictHistory: {
                    buildEntries: typeof buildEntries;
                    appendEntries: typeof appendEntries;
                };
            }
        ).conflictHistory = {
            buildEntries,
            appendEntries,
        };

        await (
            manager as unknown as {
                applyConflictResolutions: (
                    resolutions: Array<{
                        path: string;
                        strategy: "manual";
                        manualContent: string;
                    }>
                ) => Promise<void>;
            }
        ).applyConflictResolutions([
            {
                path: "note.md",
                strategy: "manual",
                manualContent: "merged",
            },
        ]);

        expect(plugin.syncState.markSyncStart).toHaveBeenCalled();
        expect(plugin.syncState.markSyncSuccess).toHaveBeenCalledWith(1);
        expect(plugin.syncState.clearConflicts).toHaveBeenCalled();
        expect(plugin.syncState.clearPendingChanges).toHaveBeenCalled();
        expect(plugin.commit).not.toHaveBeenCalled();
        expect(plugin.push).not.toHaveBeenCalled();
    });

    it("finishes Git conflict resolution with commit and push", async () => {
        const plugin = createPlugin();
        plugin.settings.activeSyncProvider = "git";
        const provider = {
            resolveConflicts: vi.fn(() => Promise.resolve()),
        };
        const manager = new SyncManager(plugin as never);
        const buildEntries = vi.fn(() => Promise.resolve([]));
        const appendEntries = vi.fn(() => Promise.resolve());

        plugin.syncState.getState = vi.fn(() => ({
            conflicts: [{ path: "note.md" }],
            pendingChanges: [],
            provider: "git",
        }));

        (manager as unknown as { provider: typeof provider }).provider =
            provider;
        (
            manager as unknown as {
                conflictHistory: {
                    buildEntries: typeof buildEntries;
                    appendEntries: typeof appendEntries;
                };
            }
        ).conflictHistory = {
            buildEntries,
            appendEntries,
        };

        await (
            manager as unknown as {
                applyConflictResolutions: (
                    resolutions: Array<{
                        path: string;
                        strategy: "manual";
                        manualContent: string;
                    }>
                ) => Promise<void>;
            }
        ).applyConflictResolutions([
            {
                path: "note.md",
                strategy: "manual",
                manualContent: "merged",
            },
        ]);

        // Ensure a sync start was recorded before commit/push
        expect(plugin.syncState.markSyncStart).toHaveBeenCalled();
        expect(plugin.commit).toHaveBeenCalledWith({
            fromAutoBackup: false,
            commitMessage: "Resolve merge conflicts",
            onlyStaged: true,
        });
        expect(plugin.push).toHaveBeenCalled();
        expect(plugin.syncState.markSyncSuccess).toHaveBeenCalledWith(1);
    });

    it("replaces the local snapshot after switching an API branch", async () => {
        const plugin = createPlugin();
        plugin.settings.activeSyncProvider = "github";
        const provider = {
            switchBranch: vi.fn(() => Promise.resolve()),
            checkoutBranchSnapshot: vi.fn(() => Promise.resolve(7)),
        };
        const manager = new SyncManager(plugin as never);

        (manager as unknown as { provider: typeof provider }).provider =
            provider;

        await expect(manager.switchBranch("release")).resolves.toBe(true);

        expect(provider.switchBranch).toHaveBeenCalledWith("release");
        expect(provider.checkoutBranchSnapshot).toHaveBeenCalledTimes(1);
        expect(plugin.syncState.markSyncStart).toHaveBeenCalled();
        expect(plugin.syncState.markSyncSuccess).toHaveBeenCalledWith(7);
        expect(
            plugin.runWithSuppressedVaultChangeEffects
        ).toHaveBeenCalledTimes(1);
    });

    it("switches a Git branch without hydrating an API snapshot", async () => {
        const plugin = createPlugin();
        plugin.settings.activeSyncProvider = "git";
        const provider = {
            switchBranch: vi.fn(() => Promise.resolve()),
        };
        const manager = new SyncManager(plugin as never);

        (manager as unknown as { provider: typeof provider }).provider =
            provider;

        await expect(manager.switchBranch("release")).resolves.toBe(true);

        expect(provider.switchBranch).toHaveBeenCalledWith("release");
        expect(plugin.syncState.markSyncStart).not.toHaveBeenCalled();
        expect(
            plugin.runWithSuppressedVaultChangeEffects
        ).toHaveBeenCalledTimes(1);
    });

    it("sets isBranchSwitchInProgress during API snapshot application", async () => {
        const plugin = createPlugin();
        plugin.settings.activeSyncProvider = "github";
        let observedFlagDuringCall: boolean | null = null;
        const provider = {
            switchBranch: vi.fn(() => Promise.resolve()),
            checkoutBranchSnapshot: vi.fn(() => {
                // capture the flag value while snapshot is being applied
                observedFlagDuringCall = plugin.isBranchSwitchInProgress;
                return Promise.resolve(3);
            }),
        };
        const manager = new SyncManager(plugin as never);

        (manager as unknown as { provider: typeof provider }).provider =
            provider;

        await expect(manager.switchBranch("feature/x")).resolves.toBe(true);

        expect(observedFlagDuringCall).toBe(true);
        expect(provider.switchBranch).toHaveBeenCalledWith("feature/x");
        expect(provider.checkoutBranchSnapshot).toHaveBeenCalledTimes(1);
    });

    it("rolls back the API branch setting when snapshot checkout fails", async () => {
        const plugin = createPlugin();
        plugin.settings.activeSyncProvider = "github";
        plugin.settings.githubBranch = "main";
        const error = new Error("snapshot failed");
        const provider = {
            switchBranch: vi.fn(() => Promise.resolve()),
            checkoutBranchSnapshot: vi.fn(() => Promise.reject(error)),
        };
        const manager = new SyncManager(plugin as never);

        (manager as unknown as { provider: typeof provider }).provider =
            provider;

        await expect(manager.switchBranch("release")).rejects.toBe(error);

        expect(provider.switchBranch).toHaveBeenNthCalledWith(1, "release");
        expect(provider.switchBranch).toHaveBeenNthCalledWith(2, "main");
        expect(plugin.syncState.markSyncError).toHaveBeenCalledWith(
            "snapshot failed"
        );
        expect(plugin.isBranchSwitchInProgress).toBe(false);
    });
});
