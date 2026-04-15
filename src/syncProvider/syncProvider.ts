/**
 * Core abstraction layer for Obsidian Git Vault.
 *
 * All sync backends (Git, GitHub API) implement this interface, which allows
 * the UI and automation layer to be completely decoupled from the underlying
 * sync mechanism.
 */

// ─── Result & Status types ────────────────────────────────────────────────────

export interface SyncResult {
    /** Number of files that changed during the sync. */
    filesChanged: number;
    /** Any conflicts detected during the sync. */
    conflicts: Conflict[];
    /** Human-readable summary message. */
    message: string;
    /** Whether the sync completed without a fatal error. */
    success: boolean;
}

export interface SyncStatus {
    /** Whether there are local modifications not yet synced. */
    hasChanges: boolean;
    /** Whether unresolved merge conflicts exist. */
    hasConflicts: boolean;
    /** Unix-ms timestamp of the last successful sync, or null if never synced. */
    lastSyncTime: number | null;
    /** Count of files with pending changes. */
    pendingFiles: number;
    /** Which backend is currently active. */
    provider: SyncProviderType;
    /** Whether the device appears to have network connectivity. */
    online: boolean;
}

// ─── File & Conflict types ────────────────────────────────────────────────────

export type SyncProviderType = "git" | "github" | "gitlab" | "gitea";

export interface SyncProviderCapabilities {
    /**
     * Whether the provider can write changes in a single atomic batch.
     * Set this to `true` when the backend can commit a whole sync atomically.
     */
    supportsAtomicBatchWrites: boolean;
    /**
     * Whether the provider can expose commit history for remote files.
     * Set this to `true` only when history lookups are supported and useful.
     */
    supportsRemoteCommitHistory: boolean;
    /**
     * Whether the provider can return metadata on a per-file basis.
     * Set this to `true` when the backend can resolve file-level metadata efficiently.
     */
    supportsPerFileMetadata: boolean;
    /**
     * Whether the provider supports encrypted sync payloads.
     * Set this to `true` when the backend stores or transports encrypted content.
     */
    supportsEncryptedSync: boolean;
    /**
     * Whether the provider can exclude paths during sync.
     * Set this to `true` when the backend supports selective path scoping.
     */
    supportsExcludePaths: boolean;
    /**
     * Whether the provider can scope sync to a tracked subdirectory.
     * Set this to `true` when the backend supports syncing only a repo/root subtree.
     */
    supportsTrackedDirectoryScoping: boolean;
    /**
     * Whether the provider can generate browseable remote file URLs.
     * Set this to `true` when the backend exposes stable per-file links.
     */
    supportsRemoteFileUrls: boolean;
    /**
     * Whether the provider supports importing into a dedicated vault.
     * Set this to `true` when the backend can bootstrap a fresh local vault from remote data.
     */
    supportsDedicatedVaultImport: boolean;
    /**
     * Whether the provider can determine the default branch automatically.
     * Set this to `true` when the backend can resolve the branch without user input.
     */
    supportsDefaultBranchAutoDetection: boolean;
}

export interface SyncFileMetadata {
    path: string;
    inScope: boolean;
    excluded: boolean;
    provider: SyncProviderType;
    remotePath?: string;
    localHash?: string;
    remoteRevision?: string;
    lastSyncTime?: number | null;
    lastSyncResult?: "idle" | "ok" | "error" | "conflict";
    encrypted?: boolean;
    /**
     * Optional short code describing an encryption readiness problem on this
     * device for the current provider/repo. When present the UI may show a
     * subtle hint (e.g. "passphrase required" or "passphrase mismatched").
     */
    encryptionProblem?:
        | "passphrase-required"
        | "passphrase-mismatched"
        | "other"
        | null;
    remoteUrl?: string;
    remoteHistoryUrl?: string;
}

export type FileChangeType = "added" | "modified" | "deleted";

export interface FileChange {
    /** Vault-relative path. */
    path: string;
    type: FileChangeType;
    /** Populated for text files that need comparison. */
    content?: string;
    /** Last-modified timestamp (ms since epoch) of the local file. */
    localModTime?: number;
}

export interface Conflict {
    /** Vault-relative path. */
    path: string;
    /** Local version content when present. */
    localContent?: string | Uint8Array;
    /** Remote version content when present. */
    remoteContent?: string | Uint8Array;
    /** Optional common ancestor content (three-way merge). */
    baseContent?: string | Uint8Array;
    /** Whether the conflict represents binary data that cannot be merged as text. */
    isBinary?: boolean;
    /** Whether the file was deleted locally. */
    deletedLocal?: boolean;
    /** Whether the file was deleted remotely. */
    deletedRemote?: boolean;
    /** Whether this conflict must go through the visual resolver. */
    requiresManualResolution?: boolean;
}

export type ConflictStrategy =
    | "last-write-wins" // auto: prefer whichever is newer
    | "always-local" // auto: always keep local
    | "always-remote" // auto: always keep remote
    | "manual"; // require user interaction

export type ConflictResolution =
    | {
          /** Vault-relative path of the conflicted file. */
          path: string;
          /** Resolution strategy chosen for this file. */
          strategy: Exclude<ConflictStrategy, "manual">;
      }
    | {
          /** Vault-relative path of the conflicted file. */
          path: string;
          /** Resolution strategy chosen for this file. */
          strategy: "manual";
          /** Final merged content provided by the user (string for text files, Uint8Array for binary files). */
          manualContent: string | Uint8Array;
      };

export interface SyncBranchSelection {
    /** All selectable branches for the active provider/repository. */
    branches: string[];
    /** The currently configured or checked-out branch. */
    current: string;
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface SyncProvider {
    /** One-time initialisation (e.g. clone repo, verify credentials). */
    init(): Promise<void>;

    /**
     * Full bidirectional sync: pull remote changes, resolve conflicts,
     * then push local changes.
     */
    sync(): Promise<SyncResult>;

    /** Download remote changes into the local vault. */
    pull(): Promise<void>;

    /** Upload local changes to the remote. */
    push(): Promise<void>;

    /**
     * Apply the given resolutions for each conflicted file.
     * Called after the user (or auto-resolver) has decided how to handle each
     * conflict reported by a previous {@link sync} or {@link pull} call.
     */
    resolveConflicts(resolutions: ConflictResolution[]): Promise<void>;

    /** Return a lightweight snapshot of the current sync state. */
    getStatus(): Promise<SyncStatus>;

    /**
     * Provider capability flags used by the UI for guidance.
     *
     * Unlike {@link getStatus} and {@link getFileMetadata}, this is
     * intentionally synchronous because {@link SyncProviderCapabilities}
     * must be static provider metadata and cannot require async work.
     */
    getCapabilities(): SyncProviderCapabilities;

    /** Provider-specific metadata for a vault file, when available. */
    getFileMetadata(path: string): Promise<SyncFileMetadata>;

    /** Return the active branch plus all selectable branches for the provider. */
    getBranchSelection(): Promise<SyncBranchSelection>;

    /** Switch the active branch or sync target branch. */
    switchBranch(branch: string): Promise<void>;

    /**
     * Optional provider-specific branch hydration step.
     *
     * Git providers perform a real checkout during {@link switchBranch}; API
     * providers can implement this hook to replace the local tracked files with
     * the selected branch snapshot without running the normal conflict-based
     * sync path.
     *
     * @returns The number of files that were replaced or hydrated as part of applying
     * the branch snapshot. This mirrors the semantics of {@link SyncResult.filesChanged}
     * and can be used by callers to surface progress or impact.
     */
    checkoutBranchSnapshot?(): Promise<number>;
}

/**
 * A SyncProvider that is capable of applying a branch snapshot via a dedicated
 * checkout operation. Implementers provide checkoutBranchSnapshot to hydrate the
 * local vault with the remote branch snapshot without performing the normal
 * conflict-based sync path.
 */
export interface SnapshotCapableSyncProvider extends SyncProvider {
    checkoutBranchSnapshot(): Promise<number>;
}

/**
 * Type guard to determine if a provider supports branch snapshot checkout.
 */
export function hasSnapshotCapability(
    provider: SyncProvider
): provider is SnapshotCapableSyncProvider {
    return typeof provider.checkoutBranchSnapshot === "function";
}
