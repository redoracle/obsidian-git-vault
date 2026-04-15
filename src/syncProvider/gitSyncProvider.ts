import type ObsidianGit from "../main";
import { splitRemoteBranch } from "../utils";
import type {
    ConflictResolution,
    SyncBranchSelection,
    SyncFileMetadata,
    SyncProvider,
    SyncResult,
    SyncStatus,
} from "./syncProvider";
import { getSyncProviderCapabilities } from "./providerRegistry";
import { getGitRepoFingerprint } from "./repoIdentity";
import { syncAuditLog } from "./syncAuditLog";

function deriveSyncResult(
    hasError: boolean,
    hasConflict: boolean,
    hasPending: boolean,
    hasSynced: boolean
): NonNullable<SyncFileMetadata["lastSyncResult"]> {
    if (hasError) {
        return "error";
    }
    if (hasConflict) {
        return "conflict";
    }
    if (hasPending || !hasSynced) {
        return "idle";
    }
    return "ok";
}

/**
 * GitSyncProvider
 *
 * Adapts the existing {@link GitManager} (SimpleGit / IsomorphicGit) to the
 * common {@link SyncProvider} interface.  All Git-specific logic lives in the
 * gitManager layer; this class is a thin translation shim.
 */
export class GitSyncProvider implements SyncProvider {
    constructor(private readonly plugin: ObsidianGit) {}

    private audit(event: string, details?: Record<string, unknown>): void {
        syncAuditLog("provider.git", event, details);
    }

    async getBranchSelection(): Promise<SyncBranchSelection> {
        const info = await this.plugin.gitManager.branchInfo();
        return {
            branches: info.branches ?? [],
            current: info.current ?? "",
        };
    }

    async switchBranch(branch: string): Promise<void> {
        await this.plugin.gitManager.checkout(branch);
        await this.persistGitRepoFingerprint();
    }

    private async persistGitRepoFingerprint(): Promise<void> {
        try {
            const branchInfo = await this.plugin.gitManager.branchInfo();
            const branch = branchInfo.current;
            const tracking = branchInfo.tracking;
            const [remoteFromTracking] = tracking
                ? splitRemoteBranch(tracking)
                : [];
            const remoteName =
                remoteFromTracking ??
                (await this.plugin.gitManager.getRemotes()).first();

            if (!remoteName || !branch) {
                return;
            }

            const remoteUrl =
                await this.plugin.gitManager.getRemoteUrl(remoteName);
            const fingerprint = getGitRepoFingerprint(remoteUrl, branch);
            if (!fingerprint) {
                return;
            }

            this.plugin.settings.lastSyncedRepoFingerprint = fingerprint;
            await this.plugin.saveSettings();
        } catch (err) {
            // Sync should still succeed when repo identity cannot be derived.
            console.debug(
                "[SyncPro] Failed to persist git repo fingerprint (sync continues):",
                err
            );
        }
    }

    async init(): Promise<void> {
        this.audit("init:start");
        try {
            await this.plugin.gitManager.checkRequirements();
            this.audit("init:success");
        } catch (error) {
            this.audit("init:failure", {
                error:
                    error instanceof Error
                        ? {
                              message: error.message,
                              stack: error.stack,
                          }
                        : { message: String(error) },
            });
            throw error;
        }
    }

    async sync(): Promise<SyncResult> {
        this.audit("sync:start");
        return new Promise<SyncResult>((resolve) => {
            void this.plugin.promiseQueue.addTask(
                async () => {
                    try {
                        this.audit("sync:commit-and-sync:start");
                        await this.plugin.commitAndSync({
                            fromAutoBackup: false,
                        });
                        await this.persistGitRepoFingerprint();
                        this.audit("sync:commit-and-sync:success");
                        return { success: true as const };
                    } catch (error) {
                        this.audit("sync:commit-and-sync:failure", {
                            error,
                        });
                        return {
                            success: false as const,
                            error:
                                error instanceof Error
                                    ? error
                                    : new Error(String(error)),
                        };
                    }
                },
                (taskResult) => {
                    void (async () => {
                        if (!taskResult?.success) {
                            const message =
                                taskResult?.error?.message ??
                                "Sync failed before git status could be refreshed";
                            resolve({
                                filesChanged: 0,
                                conflicts: [],
                                message,
                                success: false,
                            });
                            return;
                        }

                        try {
                            const status =
                                await this.plugin.gitManager.status();
                            const conflicts = status.conflicted ?? [];
                            this.audit("sync:status", {
                                changed: status.changed.length,
                                conflicts: conflicts.length,
                            });
                            resolve({
                                filesChanged: status.changed.length,
                                conflicts: conflicts.map((path) => ({
                                    path,
                                    // Content is not retrieved here; callers that need
                                    // the raw text should use app.vault.read() after
                                    // receiving this SyncResult.  The conflict markers
                                    // (<<<<<<<, =======, >>>>>>>) are present in the
                                    // working-tree file and can be read via vault.read().
                                    localContent: "",
                                    remoteContent: "",
                                })),
                                message:
                                    conflicts.length > 0
                                        ? `Sync completed with ${conflicts.length} conflict(s)`
                                        : "Sync completed successfully",
                                success: conflicts.length === 0,
                            });
                        } catch (error) {
                            this.audit("sync:status-failure", {
                                error,
                            });
                            const message =
                                error instanceof Error
                                    ? error.message
                                    : "Sync completed but git status refresh failed";
                            resolve({
                                filesChanged: 0,
                                conflicts: [],
                                message,
                                success: false,
                            });
                        }
                    })();
                }
            );
        });
    }

    async pull(): Promise<void> {
        this.audit("pull:start");
        try {
            await this.plugin.gitManager.pull();
            await this.persistGitRepoFingerprint();
            this.audit("pull:success");
        } catch (error) {
            this.audit("pull:failure", { error });
            throw error;
        }
    }

    async push(): Promise<void> {
        this.audit("push:start");
        try {
            await this.plugin.gitManager.push();
            await this.persistGitRepoFingerprint();
            this.audit("push:success");
        } catch (error) {
            this.audit("push:failure", { error });
            throw error;
        }
    }

    async resolveConflicts(resolutions: ConflictResolution[]): Promise<void> {
        this.audit("conflicts.resolve:start", {
            resolutionCount: resolutions.length,
            strategies: [...new Set(resolutions.map((r) => r.strategy))],
        });
        const { app, gitManager } = this.plugin;
        try {
            for (const resolution of resolutions) {
                if (resolution.strategy === "always-local") {
                    // Stage the local version as-is
                    await gitManager.stage(resolution.path, true);
                } else if (resolution.strategy === "last-write-wins") {
                    // "last-write-wins" here means "prefer-local-if-modified":
                    // we compare the local file's mtime against the last successful
                    // sync timestamp.  We do NOT compare against the remote file's
                    // mtime (which is unavailable via plain Git).  If the local
                    // file was touched after the last sync it is kept; otherwise
                    // the remote version wins.
                    const localFile = app.vault.getFileByPath(resolution.path);
                    if (!localFile) {
                        throw new Error(
                            `Cannot apply last-write-wins resolution: file not found for ${resolution.path}`
                        );
                    }
                    const lastSync =
                        this.plugin.syncState?.getState()?.lastSyncTime ?? null;
                    const localMtime = localFile.stat.mtime;
                    // If no sync history, prefer local; otherwise compare timestamps
                    if (lastSync === null || localMtime > lastSync) {
                        await gitManager.stage(resolution.path, true);
                    } else {
                        await gitManager.discard(resolution.path);
                    }
                } else if (resolution.strategy === "always-remote") {
                    // Discard local changes, keep remote
                    await gitManager.discard(resolution.path);
                } else if (resolution.strategy === "manual") {
                    // Write the manually merged content and stage it
                    if (typeof resolution.manualContent !== "string") {
                        throw new Error(
                            `Cannot apply manual conflict resolution for ${resolution.path}: manualContent is missing or invalid`
                        );
                    }
                    const file = app.vault.getFileByPath(resolution.path);
                    if (!file) {
                        throw new Error(
                            `Cannot apply manual conflict resolution: file not found for ${resolution.path}`
                        );
                    }
                    await app.vault.modify(file, resolution.manualContent);
                    await gitManager.stage(resolution.path, true);
                } else {
                    throw new Error(
                        `Unsupported conflict resolution strategy for ${resolution.path}`
                    );
                }
            }
        } catch (error) {
            this.audit("conflicts.resolve:failure", {
                resolutionCount: resolutions.length,
                error: error instanceof Error ? error.stack : String(error),
            });
            throw error;
        }
        this.audit("conflicts.resolve:success", {
            resolutionCount: resolutions.length,
        });
    }

    async getStatus(): Promise<SyncStatus> {
        try {
            const status = await this.plugin.gitManager.status();
            return {
                hasChanges: status.changed.length > 0,
                hasConflicts: (status.conflicted ?? []).length > 0,
                lastSyncTime: null, // sourced from SyncStateManager
                pendingFiles: status.changed.length,
                provider: "git",
                online: !this.plugin.state.offlineMode,
            };
        } catch {
            return {
                hasChanges: false,
                hasConflicts: false,
                lastSyncTime: null,
                pendingFiles: 0,
                provider: "git",
                online: false,
            };
        }
    }

    getCapabilities() {
        return getSyncProviderCapabilities("git");
    }

    async getFileMetadata(path: string): Promise<SyncFileMetadata> {
        const remotePath = this.plugin.gitManager.getRelativeRepoPath(
            path,
            true
        );
        const status = await this.plugin.gitManager
            .status()
            .catch(() => undefined);
        const state = this.plugin.syncState.getState();
        const hasConflict = state.conflicts.some(
            (conflict) => conflict.path === path
        );
        const hasPending =
            status?.changed.some((file) => file.vaultPath === path) ?? false;

        return {
            path,
            inScope: true,
            excluded: false,
            provider: "git",
            remotePath,
            lastSyncTime: state.lastSyncTime,
            lastSyncResult: deriveSyncResult(
                Boolean(state.lastError),
                hasConflict,
                hasPending,
                Boolean(state.lastSyncTime)
            ),
        };
    }
}
