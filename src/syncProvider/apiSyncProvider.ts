import type ObsidianGit from "../main";
import { Platform, TFile, TFolder } from "obsidian";
import { fileIsBinary } from "../utils";
import {
    DECRYPTION_FAILED_ERROR_CODE,
    computePassphraseFingerprint,
    decryptContent,
    encryptContent,
    hasEncryptedEnvelopePrefix,
    isEncryptedEnvelope,
    passphraseFingerprintMatches,
} from "./apiEncryption";
import { EncryptionError } from "./encryption";
import type { ApiForgeClient, ApiMutation, ApiRemoteItem } from "./apiClient";
import { computeGitBlobSha } from "./apiClient";
import {
    compileExcludePatterns,
    isPathExcludedByCompiledPatterns,
} from "./excludeMatcher";
import {
    isPathInTrackedDirectory,
    normalizeTrackedDirectory,
    toRemoteScopedPath,
    toVaultScopedPath,
} from "./pathScope";
import {
    encryptionFingerprintsMatch,
    fingerprintsMatch,
    getApiRepoFingerprint,
    normalizeRepoFingerprint,
} from "./repoIdentity";
import type {
    Conflict,
    ConflictResolution,
    SyncBranchSelection,
    SyncFileMetadata,
    SyncProvider,
    SyncResult,
    SyncStatus,
} from "./syncProvider";
import { syncAuditLog } from "./syncAuditLog";

type LocalFileEntry = {
    vaultPath: string;
    remotePath: string;
    content: string | Uint8Array;
    mtime: number;
    isBinary: boolean;
    plainHash: string;
};

type RemoteContentResult =
    | { ok: true; content: string | Uint8Array }
    | { ok: false; error: unknown };

type RemoteComparisonResult =
    | { ok: true; equal: boolean; remoteContent?: string | Uint8Array }
    | { ok: false; error: unknown };

/**
 * Returns true when the Obsidian vault API threw an error indicating the file
 * already exists on disk but is not yet reflected in the in-memory index.
 * Treated as a recoverable condition: the caller should retry with modify.
 */
function isFileAlreadyExistsError(error: unknown): boolean {
    // Check by error message (backwards compatible)
    if (
        error instanceof Error &&
        error.message.toLowerCase().includes("already exists")
    ) {
        console.debug(
            "[Git Vault] fallback: checking 'already exists' in error.message",
            error
        );
        return true;
    }
    // Additional robust checks across platforms/locales
    // Node.js errno-based check
    if (typeof error === "object" && error !== null) {
        const maybeErr = error as { code?: unknown; name?: unknown };
        if (typeof maybeErr.code === "string" && maybeErr.code === "EEXIST") {
            console.debug("[Git Vault] detected EEXIST error code");
            return true;
        }
        const name = typeof maybeErr.name === "string" ? maybeErr.name : null;
        if (name === "FileExistsError" || name === "AlreadyExistsError") {
            console.debug(
                "[Git Vault] detected FileExistsError/AlreadyExistsError"
            );
            return true;
        }
    }
    // Fallback
    return false;
}

export class ApiSyncProvider implements SyncProvider {
    /**
     * Cache for compiled exclude patterns to avoid recompiling on every access.
     */
    private _cachedCompiledExcludePatterns: RegExp[] | undefined;
    private _cachedExcludePatternsKey: string | undefined;
    private readonly localFileLoadConcurrency = 8;
    private readonly remoteTreeCacheTtlMs = 5_000;
    private cachedRemoteTree?: {
        fetchedAt: number;
        tree: Map<string, ApiRemoteItem>;
    };

    constructor(
        private readonly plugin: ObsidianGit,
        private readonly client: ApiForgeClient
    ) {}

    private audit(event: string, details?: Record<string, unknown>): void {
        syncAuditLog(`provider.${this.client.provider}`, event, details);
    }

    // ── Repo identity fingerprinting ──────────────────────────────────────

    /**
     * Returns an opaque string that uniquely identifies the current sync
     * target (provider + owner/project + repo + branch).  Used to detect
     * when the user has changed the target repo between syncs so we can
     * apply safeguards against cross-repo contamination.
     */
    private computeRepoFingerprint(): string {
        const fingerprint = getApiRepoFingerprint(
            this.plugin.settings,
            this.client.provider
        );
        if (fingerprint) {
            return fingerprint;
        }
        throw new Error(
            `computeRepoFingerprint: unknown API provider or incomplete target: ${String(
                this.client.provider
            )}`
        );
    }

    private getConfiguredBranch(): string {
        const s = this.plugin.settings;
        switch (this.client.provider) {
            case "github":
                return s.githubBranch || "main";
            case "gitlab":
                return s.gitlabBranch || "main";
            case "gitea":
                return s.giteaBranch || "main";
            default:
                return "main";
        }
    }

    private setConfiguredBranch(branch: string): void {
        switch (this.client.provider) {
            case "github":
                this.plugin.settings.githubBranch = branch;
                break;
            case "gitlab":
                this.plugin.settings.gitlabBranch = branch;
                break;
            case "gitea":
                this.plugin.settings.giteaBranch = branch;
                break;
        }
    }

    private async autoDetectDefaultBranch(): Promise<void> {
        const repoFingerprintPrefix = (fingerprint: string): string => {
            const separatorIndex = fingerprint.lastIndexOf("@");
            return separatorIndex === -1
                ? fingerprint
                : fingerprint.slice(0, separatorIndex);
        };

        const storedFingerprint = normalizeRepoFingerprint(
            this.plugin.settings.lastSyncedRepoFingerprint
        );
        const currentFingerprint = normalizeRepoFingerprint(
            this.computeRepoFingerprint()
        );
        // When the repo fingerprint is the same as last sync the user has
        // explicitly chosen or already verified their branch — do not override.
        if (
            storedFingerprint &&
            currentFingerprint &&
            repoFingerprintPrefix(storedFingerprint) ===
                repoFingerprintPrefix(currentFingerprint)
        ) {
            return;
        }

        // Repo is new or has changed: always try to detect the default branch
        // so placeholder values like "main" OR legacy values like "master" do
        // not cause 404 errors against repos that use a different default.
        const currentBranch = this.getConfiguredBranch();
        if (currentBranch && currentBranch !== "main") {
            return;
        }
        const defaultBranch = await this.client.getDefaultBranch();
        if (!defaultBranch || defaultBranch === currentBranch) {
            return;
        }

        this.setConfiguredBranch(defaultBranch);
        await this.plugin.saveSettings();
        this.plugin.log?.(
            `autoDetectDefaultBranch: detected remote default branch "${defaultBranch}" (was "${currentBranch || "unset"}").`
        );
    }

    /**
     * Returns true when the active repo differs from the last repo that
     * completed a successful sync.  An empty stored fingerprint (first ever
     * sync) is NOT treated as a mismatch so the initial sync is bidirectional.
     */
    private isRepoChanged(): boolean {
        const stored = this.plugin.settings.lastSyncedRepoFingerprint ?? "";
        if (!stored) return false; // first-ever sync — bidirectional is fine
        return !fingerprintsMatch(stored, this.computeRepoFingerprint());
    }

    /** Persist the current repo identity and manifest in one settings write. */
    private async saveRepoState(
        manifest: Iterable<string>,
        isSummary = false,
        sample: Iterable<string> = []
    ): Promise<void> {
        this.plugin.settings.lastSyncedRepoFingerprint =
            this.computeRepoFingerprint();

        const manifestArray = [...manifest];
        const threshold =
            this.plugin.settings.apiSyncManifestThreshold ?? 20000;
        const sampleSize =
            this.plugin.settings.apiSyncManifestSampleSize ?? 1000;

        if (!isSummary && manifestArray.length > threshold) {
            const sampleManifest: string[] = [];
            const step = Math.max(
                1,
                Math.floor(manifestArray.length / sampleSize)
            );
            for (
                let i = 0;
                i < manifestArray.length && sampleManifest.length < sampleSize;
                i += step
            ) {
                sampleManifest.push(manifestArray[i]);
            }

            this.plugin.log?.(
                `saveRepoState: manifest size ${manifestArray.length} exceeds threshold ${threshold}; storing sampled summary (${sampleManifest.length} entries) externally.`
            );
            this.plugin.settings.lastSyncManifestIsSummary = true;
            await this.plugin.syncManifestStore.saveSyncManifest(
                manifestArray,
                sampleManifest
            );
            await this.plugin.saveSettings();
            return;
        }

        this.plugin.settings.lastSyncManifestIsSummary = isSummary;
        await this.plugin.syncManifestStore.saveSyncManifest(
            manifestArray,
            sample
        );

        await this.plugin.saveSettings();
    }

    /**
     * Persist the repo fingerprint AND the sync manifest in one save.
     *
     * The manifest is the definitive set of remote paths that are in scope
     * after a completed sync.  It is computed from:
     *   - All current local files (they have been confirmed to exist on both sides)
     *   - Plus any files downloaded from remote (pendingLocalWrites)
     *   - Minus any files deleted via delete mutations
     */
    private async saveRepoFingerprintAndManifest(
        localFiles: Map<string, LocalFileEntry>,
        mutations: ApiMutation[],
        pendingLocalWrites: Array<{
            vaultPath: string;
            content: string | Uint8Array;
        }>
    ): Promise<void> {
        // Start from current local remote-paths (files that are tracked locally).
        const newManifest = new Set<string>(localFiles.keys());

        // Add paths that were downloaded from remote during this sync.
        for (const write of pendingLocalWrites) {
            const remotePath = toRemoteScopedPath(
                write.vaultPath,
                this.trackedDirectory
            );
            newManifest.add(remotePath);
        }

        // Remove paths that were deleted from remote during this sync.
        for (const mutation of mutations) {
            if (mutation.kind === "delete") {
                newManifest.delete(mutation.path);
            }
        }

        await this.saveRepoState(newManifest);
    }

    /**
     * Save the manifest after a push() so that the next sync knows which
     * remote paths were in scope (and can correctly identify local deletions).
     */
    private async savePushManifest(
        localFiles: Map<string, LocalFileEntry>
    ): Promise<void> {
        // After a push, remote mirrors local exactly (within scope).
        await this.saveRepoState(localFiles.keys());
    }

    private get trackedDirectory(): string {
        return normalizeTrackedDirectory(
            this.plugin.settings.trackedDirectory ?? ""
        );
    }

    private get excludePatterns(): string[] {
        return this.plugin.settings.syncExcludePaths ?? [];
    }

    private get compiledExcludePatterns(): RegExp[] {
        // Use a stringified key to detect changes in the excludePatterns array
        const key = JSON.stringify(this.excludePatterns);
        if (this._cachedExcludePatternsKey !== key) {
            this._cachedCompiledExcludePatterns = compileExcludePatterns(
                this.excludePatterns
            );
            this._cachedExcludePatternsKey = key;
        }
        return this._cachedCompiledExcludePatterns!;
    }

    private get encryptionEnabled(): boolean {
        return this.plugin.settings.apiEncryptionEnabled;
    }

    private invalidateRemoteTreeCache(): void {
        this.cachedRemoteTree = undefined;
    }

    private async getRemoteTreeCached(): Promise<Map<string, ApiRemoteItem>> {
        const now = Date.now();
        if (
            this.cachedRemoteTree &&
            now - this.cachedRemoteTree.fetchedAt < this.remoteTreeCacheTtlMs
        ) {
            return this.cachedRemoteTree.tree;
        }

        const tree = await this.client.listRemoteFiles();
        this.cachedRemoteTree = {
            fetchedAt: now,
            tree,
        };
        return tree;
    }

    getCapabilities() {
        return this.client.capabilities;
    }

    async getBranchSelection(): Promise<SyncBranchSelection> {
        const current = this.getConfiguredBranch();
        const clientWithBranches = this.client as {
            listBranches?: () => Promise<unknown>;
        };
        const branchResponse =
            typeof clientWithBranches.listBranches === "function"
                ? await clientWithBranches.listBranches()
                : [];
        const branches = Array.isArray(branchResponse)
            ? branchResponse.filter(
                  (branch): branch is string => typeof branch === "string"
              )
            : [];
        const branchSet = new Set<string>(branches);
        if (current) {
            branchSet.add(current);
        }
        return {
            current,
            branches: [...branchSet],
        };
    }

    async switchBranch(branch: string): Promise<void> {
        const trimmedBranch = branch.trim();
        if (!trimmedBranch) {
            throw new Error("Branch name is required.");
        }
        if (trimmedBranch === this.getConfiguredBranch()) {
            return;
        }

        this.setConfiguredBranch(trimmedBranch);
        this.invalidateRemoteTreeCache();
        await this.plugin.saveSettings();
        await this.plugin.syncManager.reload();
    }

    async checkoutBranchSnapshot(): Promise<number> {
        const encryptionReady = await this.checkBranchSnapshotEncryptionReady();
        this.invalidateRemoteTreeCache();

        this.audit("branch-snapshot:start", {
            trackedDirectory: this.trackedDirectory,
            encryptionReady,
        });

        // Wrap the core logic in a try/catch to audit failures with context
        const scopedRemotePaths = new Set<string>();
        const skippedRemotePaths = new Set<string>();
        let filesChanged = 0;
        try {
            const remoteTree = await this.getRemoteTreeCached();
            const localFiles = await this.getLocalFiles();

            for (const [remotePath, remoteItem] of remoteTree) {
                if (!this.isRemotePathScoped(remotePath)) {
                    continue;
                }

                const local = localFiles.get(remotePath);
                const comparison = local
                    ? await this.tryCompareRemoteContent(local, remoteItem)
                    : {
                          ok: true as const,
                          equal: false,
                          remoteContent: undefined,
                      };

                if (!comparison.ok) {
                    skippedRemotePaths.add(remotePath);
                    this.audit("branch-snapshot:file-skip", {
                        remotePath,
                        reason: this.getErrorMessage(comparison.error),
                    });
                    continue;
                }

                if (comparison.equal) {
                    scopedRemotePaths.add(remotePath);
                    continue;
                }

                const remoteContent =
                    comparison.remoteContent === undefined
                        ? await this.tryGetRemotePlainContent(remotePath)
                        : {
                              ok: true as const,
                              content: comparison.remoteContent,
                          };

                if (!remoteContent.ok) {
                    skippedRemotePaths.add(remotePath);
                    this.audit("branch-snapshot:file-skip", {
                        remotePath,
                        reason: this.getErrorMessage(remoteContent.error),
                    });
                    continue;
                }

                await this.writeVaultFile(
                    toVaultScopedPath(remotePath, this.trackedDirectory),
                    remoteContent.content
                );
                scopedRemotePaths.add(remotePath);
                filesChanged++;
            }

            for (const [remotePath, local] of localFiles) {
                if (
                    scopedRemotePaths.has(remotePath) ||
                    skippedRemotePaths.has(remotePath)
                ) {
                    continue;
                }

                const localFile = this.plugin.app.vault.getFileByPath(
                    local.vaultPath
                );
                if (!localFile) {
                    continue;
                }

                await this.plugin.app.vault.delete(localFile);
                await this.pruneEmptyParentFolders(local.vaultPath);
                filesChanged++;
            }

            await this.saveRepoState(scopedRemotePaths);
            if (encryptionReady && skippedRemotePaths.size === 0) {
                await this.persistEncryptionBinding();
            }
            if (skippedRemotePaths.size > 0) {
                this.plugin.showNotice(
                    `Git Vault: branch switched, but ${skippedRemotePaths.size} remote file(s) could not be decrypted with this device's passphrase.`,
                    9000
                );
            }

            this.audit("branch-snapshot:success", {
                filesChanged,
                manifestEntries: scopedRemotePaths.size,
                skippedRemoteFiles: skippedRemotePaths.size,
            });

            return filesChanged;
        } catch (error) {
            const serializedError =
                error instanceof Error
                    ? { message: error.message, stack: error.stack }
                    : { message: String(error) };
            this.audit("branch-snapshot:failure", {
                error: serializedError,
                filesChanged,
                manifestEntries: scopedRemotePaths.size,
                skippedRemoteFiles: skippedRemotePaths.size,
            });
            throw error;
        }
    }

    private async checkBranchSnapshotEncryptionReady(): Promise<boolean> {
        try {
            await this.ensureEncryptionReady();
            return true;
        } catch (error) {
            this.audit("branch-snapshot:encryption-readiness-warning", {
                reason: this.getErrorMessage(error),
            });
            return false;
        }
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private isPassphraseMismatchError(error: unknown): boolean {
        if (typeof error !== "object" || error === null) {
            return false;
        }
        const maybeError = error as { code?: unknown; message?: unknown };
        return (
            maybeError.code === DECRYPTION_FAILED_ERROR_CODE ||
            maybeError.message === "Decryption failed"
        );
    }

    private isPassphraseRequiredError(error: unknown): boolean {
        return this.getErrorMessage(error)
            .toLowerCase()
            .includes("no passphrase is stored");
    }

    private isRecoverableBranchSnapshotContentError(error: unknown): boolean {
        return error instanceof EncryptionError;
    }

    private getEncryptionPassphrase(): string {
        const passphrase =
            this.plugin.providerSecrets.getEncryptionPassphrase();
        if (!passphrase) {
            throw new Error(
                "Encrypted API sync is enabled but no passphrase is stored on this device."
            );
        }
        return passphrase;
    }

    private async ensureEncryptionReady(): Promise<void> {
        if (!this.encryptionEnabled) {
            return;
        }

        // Any encrypted API operation must prove that the passphrase is
        // available before we start mutating local state or writing export
        // files. Mixed repos can contain a combination of plaintext and
        // encrypted files, so waiting until the first encrypted blob is
        // encountered can otherwise produce partial results.
        const passphrase = this.getEncryptionPassphrase();

        const currentRepoFingerprint = this.computeRepoFingerprint();
        const storedRepoFingerprint =
            this.plugin.settings.apiEncryptionPassphraseRepoFingerprint ?? "";
        const storedPassphraseFingerprint =
            this.plugin.settings.apiEncryptionPassphraseFingerprint ?? "";

        if (
            !storedRepoFingerprint ||
            !storedPassphraseFingerprint ||
            !encryptionFingerprintsMatch(
                storedRepoFingerprint,
                currentRepoFingerprint
            )
        ) {
            return;
        }

        if (
            !(await passphraseFingerprintMatches(
                passphrase,
                storedPassphraseFingerprint
            ))
        ) {
            throw new Error(
                'Encrypted API sync for this repo was previously used with a different passphrase on this device. Re-enter the original passphrase for this repo. If you intentionally reset the remote and want to start over, use "Forget binding" in Sync settings. Automatic passphrase rotation is not supported.'
            );
        }
    }

    private async persistEncryptionBinding(): Promise<void> {
        if (!this.encryptionEnabled) {
            return;
        }

        this.plugin.settings.apiEncryptionPassphraseFingerprint =
            await this.computePassphraseFingerprint(
                this.getEncryptionPassphrase()
            );
        this.plugin.settings.apiEncryptionPassphraseRepoFingerprint =
            this.computeRepoFingerprint();
        await this.plugin.saveSettings();
    }

    private async computePassphraseFingerprint(
        passphrase: string
    ): Promise<string> {
        return computePassphraseFingerprint(passphrase);
    }

    private async maybeEncrypt(
        content: string | Uint8Array
    ): Promise<string | Uint8Array> {
        if (!this.encryptionEnabled) {
            return content;
        }
        return encryptContent(content, this.getEncryptionPassphrase());
    }

    private async maybeDecrypt(
        content: string | Uint8Array
    ): Promise<string | Uint8Array> {
        if (!hasEncryptedEnvelopePrefix(content)) {
            return content;
        }
        if (!isEncryptedEnvelope(content)) {
            throw new EncryptionError(
                "other",
                "Invalid encrypted sync envelope."
            );
        }
        if (
            !this.encryptionEnabled &&
            !this.plugin.providerSecrets.getEncryptionPassphrase()
        ) {
            return content;
        }
        try {
            const passphrase = this.getEncryptionPassphrase();
            const decrypted = await decryptContent(content, passphrase);
            return decrypted.content;
        } catch (error) {
            let code: "passphrase-required" | "passphrase-mismatched" | "other";
            if (this.isPassphraseRequiredError(error)) {
                code = "passphrase-required";
            } else if (this.isPassphraseMismatchError(error)) {
                code = "passphrase-mismatched";
            } else {
                code = "other";
            }
            throw new EncryptionError(code, this.getErrorMessage(error));
        }
    }

    private async loadLocalFile(
        filePath: string
    ): Promise<LocalFileEntry | null> {
        if (!isPathInTrackedDirectory(filePath, this.trackedDirectory)) {
            return null;
        }

        const remotePath = toRemoteScopedPath(filePath, this.trackedDirectory);
        if (
            isPathExcludedByCompiledPatterns(
                remotePath,
                this.compiledExcludePatterns
            )
        ) {
            return null;
        }

        const file = this.plugin.app.vault.getFileByPath(filePath);
        if (!file) {
            return null;
        }

        const isBinary = fileIsBinary(filePath);
        const content = isBinary
            ? new Uint8Array(await this.plugin.app.vault.readBinary(file))
            : await this.plugin.app.vault.read(file);

        return {
            vaultPath: filePath,
            remotePath,
            content,
            mtime: file.stat.mtime,
            isBinary,
            plainHash: await computeGitBlobSha(content),
        };
    }

    /**
     * Recursively collect all file paths under `dirPath` via the vault
     * adapter.  Returns vault-relative paths (e.g. ".obsidian/app.json").
     */
    private async listAdapterDir(dirPath: string): Promise<string[]> {
        const adapter = this.plugin.app.vault.adapter;
        const paths: string[] = [];
        const queue: string[] = [dirPath];
        let qi = 0;
        while (qi < queue.length) {
            // Use an index-based queue to preserve FIFO order while avoiding
            // O(n) `shift()` operations on large arrays.
            const current = queue[qi++];
            try {
                const res = await adapter.list(current);
                for (const f of res.files) {
                    paths.push(f);
                }
                for (const sub of res.folders) {
                    queue.push(sub);
                }
            } catch (err) {
                // Directory may not exist or may be inaccessible; skip silently.
                // Log at debug level for troubleshooting without affecting normal operation.
                console.debug(
                    "[Git Vault] listAdapterDir: adapter.list failed for",
                    current,
                    "root",
                    dirPath,
                    err
                );
            }
        }
        return paths;
    }

    /**
     * Load a file that lives inside the vault config dir (.obsidian) via the
     * adapter.  Returns null when excluded or unreadable.
     */
    private async loadAdapterFile(
        vaultPath: string
    ): Promise<LocalFileEntry | null> {
        if (!isPathInTrackedDirectory(vaultPath, this.trackedDirectory)) {
            return null;
        }
        const remotePath = toRemoteScopedPath(vaultPath, this.trackedDirectory);
        if (
            isPathExcludedByCompiledPatterns(
                remotePath,
                this.compiledExcludePatterns
            )
        ) {
            return null;
        }
        const adapter = this.plugin.app.vault.adapter;
        try {
            const isBinary = fileIsBinary(vaultPath);
            let content: string | Uint8Array;
            if (isBinary) {
                const buf = await adapter.readBinary(vaultPath);
                content = new Uint8Array(buf);
            } else {
                content = await adapter.read(vaultPath);
            }
            // Fetch mtime via adapter.stat so last-write-wins conflict
            // resolution treats config files correctly.  Fall back to
            // Date.now() so they always appear "recently modified" rather
            // than appearing stale (mtime=0) which would incorrectly
            // favour the remote copy in a last-write-wins scenario.
            let mtime = Date.now();
            try {
                const s = await adapter.stat(vaultPath);
                if (s && typeof s.mtime === "number") {
                    mtime = s.mtime;
                }
            } catch {
                // stat failed; keep Date.now() fallback so last-write-wins
                // treats the file as recently modified (local wins)
            }
            return {
                vaultPath,
                remotePath,
                content,
                mtime,
                isBinary,
                plainHash: await computeGitBlobSha(content),
            };
        } catch {
            // File may have disappeared between listing and reading; skip.
            return null;
        }
    }

    private async getLocalFiles(): Promise<Map<string, LocalFileEntry>> {
        const files = new Map<string, LocalFileEntry>();

        // 1. Vault-indexed user files (notes, attachments, etc.)
        const vaultFiles = this.plugin.app.vault.getFiles();
        for (
            let index = 0;
            index < vaultFiles.length;
            index += this.localFileLoadConcurrency
        ) {
            const batch = vaultFiles.slice(
                index,
                index + this.localFileLoadConcurrency
            );
            const locals = await Promise.all(
                batch.map((file) => this.loadLocalFile(file.path))
            );
            for (const local of locals) {
                if (local) {
                    files.set(local.remotePath, local);
                }
            }
        }

        // 2. Config dir (.obsidian) — not indexed by vault.getFiles() but
        //    must be included so settings, plugins, and themes are synced.
        const configDir = this.plugin.app.vault.configDir; // e.g. ".obsidian"
        if (configDir) {
            const configPaths = await this.listAdapterDir(configDir);
            for (
                let index = 0;
                index < configPaths.length;
                index += this.localFileLoadConcurrency
            ) {
                const batch = configPaths.slice(
                    index,
                    index + this.localFileLoadConcurrency
                );
                const locals = await Promise.all(
                    batch.map((p) => this.loadAdapterFile(p))
                );
                for (const local of locals) {
                    if (local && !files.has(local.remotePath)) {
                        files.set(local.remotePath, local);
                    }
                }
            }
        }

        return files;
    }

    private async readVaultFileContent(file: TFile): Promise<{
        content: string | Uint8Array;
        isBinary: boolean;
    }> {
        const isBinary = fileIsBinary(file.path);
        return {
            content: isBinary
                ? new Uint8Array(await this.plugin.app.vault.readBinary(file))
                : await this.plugin.app.vault.read(file),
            isBinary,
        };
    }

    private getBlockingAncestorFile(filePath: string): TFile | null {
        const lastSlash = filePath.lastIndexOf("/");
        if (lastSlash < 0) {
            return null;
        }
        const dir = filePath.slice(0, lastSlash);
        const parts = dir.split("/");
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const blocker = this.plugin.app.vault.getFileByPath(current);
            if (blocker) {
                return blocker;
            }
        }
        return null;
    }

    private async ensureParentFolder(filePath: string): Promise<void> {
        const lastSlash = filePath.lastIndexOf("/");
        if (lastSlash < 0) {
            return;
        }
        const dir = filePath.slice(0, lastSlash);
        const parts = dir.split("/");
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.plugin.app.vault.getFolderByPath(current)) {
                try {
                    await this.plugin.app.vault.createFolder(current);
                } catch (e) {
                    // Folder may exist on disk but not yet indexed by Obsidian's
                    // in-memory vault cache (e.g. after a pull or first boot).
                    // Only swallow the error when the adapter confirms the path
                    // is actually a folder; a stale file blocking a required
                    // folder must still surface as a conflict.
                    const diskStat =
                        (await this.plugin.app.vault.adapter.stat?.(current)) ??
                        null;
                    const existsOnDisk =
                        (await this.plugin.app.vault.adapter.exists?.(
                            current
                        )) ?? false;
                    if (!this.plugin.app.vault.getFolderByPath(current)) {
                        if (diskStat?.type === "folder") {
                            continue;
                        }
                        if (existsOnDisk) {
                            throw new Error(
                                `Cannot create folder "${current}" because a non-folder path already exists there.`
                            );
                        }
                        throw e;
                    }
                }
            }
        }
    }

    private async pruneEmptyParentFolders(filePath: string): Promise<void> {
        let current = filePath.includes("/")
            ? filePath.slice(0, filePath.lastIndexOf("/"))
            : "";

        while (current) {
            if (current === this.trackedDirectory) {
                return;
            }

            const folder = this.plugin.app.vault.getFolderByPath(current);
            if (!(folder instanceof TFolder) || folder.children.length > 0) {
                return;
            }

            await this.plugin.app.vault.delete(folder);
            current = current.includes("/")
                ? current.slice(0, current.lastIndexOf("/"))
                : "";
        }
    }

    private async writeVaultFile(
        filePath: string,
        content: string | Uint8Array
    ): Promise<void> {
        const existing = this.plugin.app.vault.getFileByPath(filePath);
        const binary = fileIsBinary(filePath) || typeof content !== "string";

        if (!existing) {
            await this.ensureParentFolder(filePath);
            if (binary) {
                const bytes =
                    typeof content === "string"
                        ? Buffer.from(content, "utf8")
                        : Buffer.from(content);
                const buf = new ArrayBuffer(bytes.byteLength);
                new Uint8Array(buf).set(bytes);
                try {
                    await this.plugin.app.vault.createBinary(filePath, buf);
                } catch (createBinaryErr) {
                    if (isFileAlreadyExistsError(createBinaryErr)) {
                        // Vault index was stale: file is on disk but not yet
                        // reflected in Obsidian's in-memory index.  Try the
                        // indexed path first; if still null (e.g. config dir
                        // files like .obsidian/*) fall back to the adapter.
                        const retryFile =
                            this.plugin.app.vault.getFileByPath(filePath);
                        if (retryFile) {
                            await this.plugin.app.vault.modifyBinary(
                                retryFile,
                                buf
                            );
                            return;
                        }
                        // Not in vault index (e.g. .obsidian config files) —
                        // write directly via adapter.
                        await this.plugin.app.vault.adapter.writeBinary(
                            filePath,
                            buf
                        );
                        return;
                    }
                    throw createBinaryErr;
                }
                return;
            }
            try {
                await this.plugin.app.vault.create(filePath, content);
            } catch (createErr) {
                if (isFileAlreadyExistsError(createErr)) {
                    // Same stale-index case as above.
                    const retryFile =
                        this.plugin.app.vault.getFileByPath(filePath);
                    if (retryFile) {
                        await this.plugin.app.vault.modify(retryFile, content);
                        return;
                    }
                    // Not in vault index — write via adapter (e.g. .obsidian/*).
                    // At this point `binary` was false when we attempted to
                    // `create` above, so `content` must be a string. Avoid the
                    // redundant Buffer conversion — the type is already narrowed.
                    const textContent = content;
                    await this.plugin.app.vault.adapter.write(
                        filePath,
                        textContent
                    );
                    return;
                }
                throw createErr;
            }
            return;
        }

        if (binary) {
            const bytes =
                typeof content === "string"
                    ? Buffer.from(content, "utf8")
                    : Buffer.from(content);
            const buf = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(buf).set(bytes);
            await this.plugin.app.vault.modifyBinary(existing, buf);
            return;
        }

        await this.plugin.app.vault.modify(existing, content);
    }

    private async writeDirectoryFile(
        rootDir: string,
        filePath: string,
        content: string | Uint8Array
    ): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodePath = require("path") as typeof import("path");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodeFs = require("fs") as typeof import("fs");
        // The resolved path is validated against realNormalizedRoot before any write.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const normalizedRoot = nodePath.resolve(rootDir);
        // The resolved path is validated against realNormalizedRoot before any write.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const absolutePath = nodePath.resolve(normalizedRoot, filePath);
        const realNormalizedRoot =
            await nodeFs.promises.realpath(normalizedRoot);
        await nodeFs.promises.mkdir(nodePath.dirname(absolutePath), {
            recursive: true,
        });
        const realAbsolutePath = await nodeFs.promises
            .realpath(absolutePath)
            .catch(async (error) => {
                if (
                    !(error instanceof Error) ||
                    !("code" in error) ||
                    (error as NodeJS.ErrnoException).code !== "ENOENT"
                ) {
                    throw error;
                }

                // The parent path is realpathed and later checked with nodePath.relative against realNormalizedRoot.
                // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
                const realParentPath = await nodeFs.promises.realpath(
                    nodePath.dirname(absolutePath)
                );
                // The returned candidate is checked with nodePath.relative against realNormalizedRoot before writing.
                // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
                return nodePath.join(
                    realParentPath, // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
                    nodePath.basename(absolutePath) // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
                );
            });
        const relativePath = nodePath.relative(
            realNormalizedRoot,
            realAbsolutePath
        );
        if (
            relativePath.startsWith("..") ||
            nodePath.isAbsolute(relativePath)
        ) {
            throw new Error(
                `Refusing to write outside root directory: ${filePath}`
            );
        }
        if (typeof content === "string") {
            await nodeFs.promises.writeFile(realAbsolutePath, content, "utf8");
            return;
        }
        await nodeFs.promises.writeFile(realAbsolutePath, Buffer.from(content));
    }

    private isRemotePathScoped(remotePath: string): boolean {
        return !isPathExcludedByCompiledPatterns(
            remotePath,
            this.compiledExcludePatterns
        );
    }

    private async getRemotePlainContent(
        remotePath: string
    ): Promise<string | Uint8Array> {
        return this.maybeDecrypt(await this.client.downloadFile(remotePath));
    }

    private async tryGetRemotePlainContent(
        remotePath: string
    ): Promise<RemoteContentResult> {
        try {
            return {
                ok: true,
                content: await this.getRemotePlainContent(remotePath),
            };
        } catch (error) {
            if (this.isRecoverableBranchSnapshotContentError(error)) {
                return { ok: false, error };
            }
            throw error;
        }
    }

    private async compareRemoteContent(
        local: LocalFileEntry,
        remote: ApiRemoteItem
    ): Promise<{
        equal: boolean;
        remoteContent?: string | Uint8Array;
    }> {
        if (!this.encryptionEnabled && remote.revision) {
            return {
                equal: local.plainHash === remote.revision,
            };
        }

        const remoteContent = await this.getRemotePlainContent(remote.path);
        const remoteHash = await computeGitBlobSha(remoteContent);
        return {
            equal: remoteHash === local.plainHash,
            remoteContent,
        };
    }

    private async tryCompareRemoteContent(
        local: LocalFileEntry,
        remote: ApiRemoteItem
    ): Promise<RemoteComparisonResult> {
        try {
            return {
                ok: true,
                ...(await this.compareRemoteContent(local, remote)),
            };
        } catch (error) {
            if (this.isRecoverableBranchSnapshotContentError(error)) {
                return { ok: false, error };
            }
            throw error;
        }
    }

    private async contentsEqual(
        local: LocalFileEntry,
        remote: ApiRemoteItem
    ): Promise<boolean> {
        return (await this.compareRemoteContent(local, remote)).equal;
    }

    async init(): Promise<void> {
        // Passphrase is validated lazily (on first encrypt/decrypt), not at init time,
        // so switching providers in settings doesn't throw before the user has entered one.
        // encryptionReady is checked in pull(), push(), and sync() before any crypto work.
        this.audit("init:start", {
            trackedDirectory: this.trackedDirectory,
            encryptionEnabled: this.encryptionEnabled,
        });
        await this.client.init();
        await this.autoDetectDefaultBranch();
        this.audit("init:success", {
            trackedDirectory: this.trackedDirectory,
            encryptionEnabled: this.encryptionEnabled,
        });
    }

    async pull(): Promise<void> {
        this.audit("pull:start");
        let filesWritten: number | undefined;
        let manifestEntries: number | undefined;
        try {
            await this.ensureEncryptionReady();
            const result = await this.pullWithCount();
            filesWritten = result.written;
            manifestEntries = result.manifest.length;
            await this.saveRepoState(result.manifest);
            await this.persistEncryptionBinding();
            this.audit("pull:success", {
                filesWritten,
                manifestEntries,
            });
        } catch (error) {
            const errObj =
                error instanceof Error
                    ? { message: error.message, stack: error.stack }
                    : { message: String(error) };
            this.audit("pull:failure", {
                error: errObj,
                filesWritten: filesWritten ?? 0,
                manifestEntries: manifestEntries ?? 0,
            });
            throw error;
        }
    }

    async exportRemoteToDirectory(targetDir: string): Promise<number> {
        if (!Platform.isDesktopApp) {
            throw new Error("Export to directory is not supported on mobile.");
        }
        await this.ensureEncryptionReady();
        const remoteTree = await this.client.listRemoteFiles();

        // Collect scoped paths up front so we can batch them.
        const scopedPaths: string[] = [];
        for (const [remotePath] of remoteTree) {
            if (this.isRemotePathScoped(remotePath)) {
                scopedPaths.push(remotePath);
            }
        }

        let written = 0;
        try {
            for (
                let i = 0;
                i < scopedPaths.length;
                i += this.localFileLoadConcurrency
            ) {
                const batch = scopedPaths.slice(
                    i,
                    i + this.localFileLoadConcurrency
                );
                await Promise.all(
                    batch.map(async (remotePath) => {
                        const outputPath = toVaultScopedPath(
                            remotePath,
                            this.trackedDirectory
                        );
                        await this.writeDirectoryFile(
                            targetDir,
                            outputPath,
                            await this.getRemotePlainContent(remotePath)
                        );
                    })
                );
                written += batch.length;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Export failed after writing ${written} of ${scopedPaths.length} file(s): ${msg}`
            );
        }

        await this.persistEncryptionBinding();
        return written;
    }

    /**
     * Like pull() but returns the number of vault files written so callers
     * (e.g. the repo-identity-change path in sync()) can report an accurate
     * filesChanged count.
     */
    private async pullWithCount(): Promise<{
        written: number;
        manifest: string[];
    }> {
        let written = 0;
        const remoteTree = await this.client.listRemoteFiles();
        const manifest: string[] = [];
        for (const [remotePath, remoteItem] of remoteTree) {
            if (!this.isRemotePathScoped(remotePath)) {
                continue;
            }
            manifest.push(remotePath);

            const vaultPath = toVaultScopedPath(
                remotePath,
                this.trackedDirectory
            );
            // Try vault-indexed lookup first; fall back to adapter for files
            // that live outside the vault index (e.g. .obsidian/**).
            const local =
                (await this.loadLocalFile(vaultPath)) ??
                (await this.loadAdapterFile(vaultPath));
            if (!local) {
                await this.writeVaultFile(
                    vaultPath,
                    await this.getRemotePlainContent(remotePath)
                );
                written++;
                continue;
            }
            const comparison = await this.compareRemoteContent(
                local,
                remoteItem
            );
            if (!comparison.equal) {
                await this.writeVaultFile(
                    vaultPath,
                    comparison.remoteContent ??
                        (await this.getRemotePlainContent(remotePath))
                );
                written++;
            }
        }
        return { written, manifest };
    }

    private async establishRepoChangeBaseline(): Promise<SyncResult> {
        const [localFiles, remoteTree] = await Promise.all([
            this.getLocalFiles(),
            this.client.listRemoteFiles(),
        ]);

        const conflicts: Conflict[] = [];
        const pendingLocalWrites: Array<{
            remotePath: string;
            vaultPath: string;
        }> = [];
        const manifest: string[] = [];
        const recordedConflictPaths = new Set<string>();

        for (const [remotePath, remoteItem] of remoteTree) {
            if (!this.isRemotePathScoped(remotePath)) {
                continue;
            }
            manifest.push(remotePath);

            const local = localFiles.get(remotePath);
            if (!local) {
                pendingLocalWrites.push({
                    remotePath,
                    vaultPath: toVaultScopedPath(
                        remotePath,
                        this.trackedDirectory
                    ),
                });
                continue;
            }

            if (await this.contentsEqual(local, remoteItem)) {
                continue;
            }

            conflicts.push({
                path: local.vaultPath,
                localContent: local.content,
                remoteContent: await this.getRemotePlainContent(remotePath),
                isBinary: local.isBinary,
                requiresManualResolution: true,
            });
            recordedConflictPaths.add(local.vaultPath);
        }

        for (const [remotePath, local] of localFiles) {
            if (
                !this.isRemotePathScoped(remotePath) ||
                remoteTree.has(remotePath)
            ) {
                continue;
            }

            conflicts.push({
                path: local.vaultPath,
                localContent: local.content,
                isBinary: local.isBinary,
                deletedRemote: true,
                requiresManualResolution: true,
            });
            recordedConflictPaths.add(local.vaultPath);
        }

        let written = 0;
        for (const pendingWrite of pendingLocalWrites) {
            const blockingFile = this.getBlockingAncestorFile(
                pendingWrite.vaultPath
            );
            if (blockingFile) {
                if (!recordedConflictPaths.has(blockingFile.path)) {
                    const blocker =
                        await this.readVaultFileContent(blockingFile);
                    conflicts.push({
                        path: blockingFile.path,
                        localContent: blocker.content,
                        isBinary: blocker.isBinary,
                        deletedRemote: true,
                        requiresManualResolution: true,
                    });
                    recordedConflictPaths.add(blockingFile.path);
                }
                continue;
            }
            const content = await this.getRemotePlainContent(
                pendingWrite.remotePath
            );
            await this.writeVaultFile(pendingWrite.vaultPath, content);
            written++;
        }

        await this.saveRepoState(manifest);
        await this.persistEncryptionBinding();

        this.audit("sync:repo-change-baseline", {
            filesWritten: written,
            conflictCount: conflicts.length,
            manifestEntries: manifest.length,
        });

        return {
            filesChanged: written,
            conflicts,
            message:
                conflicts.length > 0
                    ? `Repo changed: pulled the new remote and found ${conflicts.length} stale local file(s) that need review.`
                    : "Repo changed: pulled from new repo. Run Sync again to push local changes.",
            success: conflicts.length === 0,
        };
    }

    async push(): Promise<void> {
        this.audit("push:start");
        let mutationsLength: number = 0;
        let localCount: number = 0;
        const mutations: ApiMutation[] = [];
        let localFiles: Map<string, LocalFileEntry> = new Map();
        try {
            await this.ensureEncryptionReady();
            // Block push when the configured repo differs from the last successful
            // sync target.  Allowing push here would upload files from the old repo
            // into the newly configured one.
            if (this.isRepoChanged()) {
                throw new Error(
                    "Git Vault: Repo has changed — run Sync first to establish a baseline with the new repo before pushing."
                );
            }

            localFiles = await this.getLocalFiles();
            const remoteTree = await this.client.listRemoteFiles();

            for (const [remotePath, local] of localFiles) {
                const remoteItem = remoteTree.get(remotePath);
                if (!remoteItem) {
                    mutations.push({
                        kind: "create",
                        path: remotePath,
                        content: await this.maybeEncrypt(local.content),
                    });
                    continue;
                }
                if (!(await this.contentsEqual(local, remoteItem))) {
                    mutations.push({
                        kind: "update",
                        path: remotePath,
                        previousRevision: remoteItem.revision,
                        content: await this.maybeEncrypt(local.content),
                    });
                }
            }

            for (const [remotePath, remoteItem] of remoteTree) {
                if (!this.isRemotePathScoped(remotePath)) {
                    continue;
                }
                if (!localFiles.has(remotePath)) {
                    mutations.push({
                        kind: "delete",
                        path: remotePath,
                        previousRevision: remoteItem.revision,
                    });
                }
            }

            if (mutations.length > 0) {
                mutationsLength = mutations.length;
                await this.client.commitMutations(
                    mutations,
                    `vault backup: ${new Date().toISOString()}`
                );
                this.invalidateRemoteTreeCache();
            }

            // Always update the manifest after push so the next sync correctly
            // identifies future local deletions vs new remote additions.
            await this.savePushManifest(localFiles);
            await this.persistEncryptionBinding();
            localCount = localFiles.size;
            this.audit("push:success", {
                mutationCount: mutationsLength,
                localFileCount: localCount,
            });
        } catch (error) {
            // Audit and rethrow to preserve existing behavior
            this.audit("push:failure", {
                error:
                    error instanceof Error
                        ? { message: error.message, stack: error.stack }
                        : { message: String(error) },
                mutationCount: mutations.length,
                localFileCount: localFiles.size,
            });
            throw error;
        }
    }

    async sync(): Promise<SyncResult> {
        await this.ensureEncryptionReady();
        // Detect repo identity change.  When the user switches to a different
        // owner/repo/branch we must not push local files that came from the
        // previous repo into the new one.  On a repo change we run pull-only:
        // remote files are applied to the vault, local-only files are left
        // untouched, and the fingerprint is updated so the NEXT sync is fully
        // bidirectional.
        const repoChanged = this.isRepoChanged();
        this.audit("sync:start", {
            repoChanged,
            trackedDirectory: this.trackedDirectory,
            encryptionEnabled: this.encryptionEnabled,
            strategy:
                this.plugin.settings.conflictResolutionStrategy ?? "manual",
        });
        if (repoChanged) {
            const prev = this.plugin.settings.lastSyncedRepoFingerprint;
            const next = this.computeRepoFingerprint();
            console.info(
                `[SyncPro] Repo identity changed: "${prev}" → "${next}". Running pull-only to establish baseline.`
            );
            this.audit("sync:repo-changed", {
                previousFingerprint: prev,
                nextFingerprint: next,
            });
            this.plugin.makeSyncNotice(
                `Git Vault: Target repo changed — pulling from new repo first. ` +
                    `Stale local files will be surfaced for review before anything is pushed.`,
                10000
            );
            return this.establishRepoChangeBaseline();
        }

        const conflicts: Conflict[] = [];
        const mutations: ApiMutation[] = [];
        const pendingLocalWrites: Array<{
            vaultPath: string;
            content: string | Uint8Array;
        }> = [];
        const pendingLocalDeletes: string[] = [];
        // filesChanged is computed at the end from totalChanges; no intermediate increments needed
        const strategy =
            this.plugin.settings.conflictResolutionStrategy ?? "manual";

        // Load the full manifest from the previous successful sync.
        // An empty manifest means first-ever sync — treat all remote-only paths
        // as new remote additions (safe: we don't delete anything on first sync).
        const syncManifest = new Set<string>(
            await this.plugin.syncManifestStore.getSyncManifest()
        );

        const [localFiles, remoteTree] = await Promise.all([
            this.getLocalFiles(),
            this.client.listRemoteFiles(),
        ]);
        this.audit("sync:inventory", {
            localFileCount: localFiles.size,
            remoteFileCount: remoteTree.size,
            manifestEntries: syncManifest.size,
        });
        const remoteOnlyPaths = new Set(
            [...remoteTree.keys()].filter((path) =>
                this.isRemotePathScoped(path)
            )
        );

        for (const [remotePath, local] of localFiles) {
            remoteOnlyPaths.delete(remotePath);
            const remoteItem = remoteTree.get(remotePath);
            if (!remoteItem) {
                const wasInManifest = syncManifest.has(remotePath);
                if (!wasInManifest) {
                    // New local file — push.
                    mutations.push({
                        kind: "create",
                        path: remotePath,
                        content: await this.maybeEncrypt(local.content),
                    });
                    continue;
                }

                // File was synced before but no longer exists remote —
                // it was deleted from the remote side.
                if (strategy === "always-local") {
                    mutations.push({
                        kind: "create",
                        path: remotePath,
                        content: await this.maybeEncrypt(local.content),
                    });
                } else if (strategy === "always-remote") {
                    pendingLocalDeletes.push(local.vaultPath);
                } else if (strategy === "last-write-wins") {
                    const lastSync =
                        this.plugin.syncState.getState().lastSyncTime;
                    if (lastSync === null || local.mtime > lastSync) {
                        mutations.push({
                            kind: "create",
                            path: remotePath,
                            content: await this.maybeEncrypt(local.content),
                        });
                    } else {
                        pendingLocalDeletes.push(local.vaultPath);
                    }
                } else {
                    // manual — surface as conflict
                    conflicts.push({
                        path: local.vaultPath,
                        localContent: local.content,
                        isBinary: local.isBinary,
                        deletedRemote: true,
                        requiresManualResolution: true,
                    });
                }
                continue;
            }

            if (await this.contentsEqual(local, remoteItem)) {
                continue;
            }

            if (strategy === "always-local") {
                mutations.push({
                    kind: "update",
                    path: remotePath,
                    previousRevision: remoteItem.revision,
                    content: await this.maybeEncrypt(local.content),
                });
                continue;
            }

            if (strategy === "always-remote") {
                pendingLocalWrites.push({
                    vaultPath: local.vaultPath,
                    content: await this.getRemotePlainContent(remotePath),
                });
                continue;
            }

            if (strategy === "last-write-wins") {
                const lastSync = this.plugin.syncState.getState().lastSyncTime;
                if (lastSync === null || local.mtime > lastSync) {
                    mutations.push({
                        kind: "update",
                        path: remotePath,
                        previousRevision: remoteItem.revision,
                        content: await this.maybeEncrypt(local.content),
                    });
                } else {
                    pendingLocalWrites.push({
                        vaultPath: local.vaultPath,
                        content: await this.getRemotePlainContent(remotePath),
                    });
                }
                continue;
            }

            conflicts.push({
                path: local.vaultPath,
                localContent: local.content,
                remoteContent: await this.getRemotePlainContent(remotePath),
                isBinary: local.isBinary,
            });
        }

        for (const remotePath of remoteOnlyPaths) {
            // Distinguish between a locally-deleted file and a new remote
            // addition by consulting the manifest from the last successful sync.
            //   • Path IS in manifest  → existed at last sync → deleted locally → push delete.
            //   • Path NOT in manifest → didn't exist at last sync → new remote file → download.
            //
            const wasInManifest = syncManifest.has(remotePath);
            if (wasInManifest) {
                const remoteItem = remoteTree.get(remotePath);
                mutations.push({
                    kind: "delete",
                    path: remotePath,
                    previousRevision: remoteItem?.revision,
                });
            } else {
                const vaultPath = toVaultScopedPath(
                    remotePath,
                    this.trackedDirectory
                );
                pendingLocalWrites.push({
                    vaultPath,
                    content: await this.getRemotePlainContent(remotePath),
                });
            }
        }

        try {
            if (mutations.length > 0) {
                await this.client.commitMutations(
                    mutations,
                    `vault sync: ${new Date().toISOString()}`
                );
                this.invalidateRemoteTreeCache();
            }
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "API sync failed before local writes were applied";
            this.audit("sync:mutation-failure", {
                mutationCount: mutations.length,
                pendingLocalWrites: pendingLocalWrites.length,
                conflictCount: conflicts.length,
                message,
            });
            return {
                filesChanged: 0,
                conflicts,
                message,
                success: false,
            };
        }

        const totalChanges =
            mutations.length +
            pendingLocalWrites.length +
            pendingLocalDeletes.length;

        for (const vaultPath of pendingLocalDeletes) {
            const file = this.plugin.app.vault.getFileByPath(vaultPath);
            if (file) {
                await this.plugin.app.vault.delete(file);
                await this.pruneEmptyParentFolders(vaultPath);
            }
            const remotePath = toRemoteScopedPath(
                vaultPath,
                this.trackedDirectory
            );
            localFiles.delete(remotePath);
        }

        for (const pendingWrite of pendingLocalWrites) {
            await this.writeVaultFile(
                pendingWrite.vaultPath,
                pendingWrite.content
            );
        }

        // Persist the repo identity and sync manifest after a fully successful
        // bidirectional sync.  The manifest is used on the NEXT sync to distinguish
        // locally-deleted files (which need a remote delete mutation) from new
        // remote additions (which need to be downloaded).
        await this.saveRepoFingerprintAndManifest(
            localFiles,
            mutations,
            pendingLocalWrites
        );
        await this.persistEncryptionBinding();

        this.audit("sync:complete", {
            mutationCount: mutations.length,
            downloadedCount: pendingLocalWrites.length,
            deletedCount: pendingLocalDeletes.length,
            conflictCount: conflicts.length,
            totalChanges,
        });

        return {
            filesChanged: totalChanges,
            conflicts,
            message:
                conflicts.length > 0
                    ? `Sync completed with ${conflicts.length} conflict(s) requiring attention`
                    : `Sync completed — ${totalChanges} file(s) changed`,
            success: conflicts.length === 0,
        };
    }

    async resolveConflicts(resolutions: ConflictResolution[]): Promise<void> {
        await this.ensureEncryptionReady();
        this.audit("conflicts.resolve:start", {
            resolutionCount: resolutions.length,
            strategies: [...new Set(resolutions.map((r) => r.strategy))],
        });
        const mutations: ApiMutation[] = [];
        const remoteTree = await this.client.listRemoteFiles();

        for (const resolution of resolutions) {
            const remotePath = toRemoteScopedPath(
                resolution.path,
                this.trackedDirectory
            );
            const local = await this.loadLocalFile(resolution.path);
            const remoteItem = remoteTree.get(remotePath);

            if (resolution.strategy === "always-local") {
                if (!local) {
                    throw new Error(
                        `Cannot keep local version for ${resolution.path}: file not found`
                    );
                }
                mutations.push({
                    kind: remoteItem ? "update" : "create",
                    path: remotePath,
                    previousRevision: remoteItem?.revision,
                    content: await this.maybeEncrypt(local.content),
                });
                continue;
            }

            if (resolution.strategy === "always-remote") {
                if (!remoteItem) {
                    const localFile = this.plugin.app.vault.getFileByPath(
                        resolution.path
                    );
                    if (localFile) {
                        await this.plugin.app.vault.delete(localFile);
                    }
                    continue;
                }
                await this.writeVaultFile(
                    resolution.path,
                    await this.getRemotePlainContent(remotePath)
                );
                continue;
            }

            if (resolution.strategy === "last-write-wins") {
                const file = this.plugin.app.vault.getFileByPath(
                    resolution.path
                );
                if (!file) {
                    throw new Error(
                        `Cannot apply last-write-wins for ${resolution.path}: local file not found`
                    );
                }
                const lastSync = this.plugin.syncState.getState().lastSyncTime;
                if (lastSync === null || file.stat.mtime > lastSync) {
                    const updated = await this.loadLocalFile(resolution.path);
                    if (!updated) {
                        throw new Error(
                            `Cannot keep local version for ${resolution.path}: file not found`
                        );
                    }
                    mutations.push({
                        kind: remoteItem ? "update" : "create",
                        path: remotePath,
                        previousRevision: remoteItem?.revision,
                        content: await this.maybeEncrypt(updated.content),
                    });
                } else if (remoteItem) {
                    await this.writeVaultFile(
                        resolution.path,
                        await this.getRemotePlainContent(remotePath)
                    );
                }
                continue;
            }

            if (resolution.strategy !== "manual") {
                throw new Error(
                    `Unsupported conflict resolution strategy for ${resolution.path}`
                );
            }

            if (
                typeof resolution.manualContent !== "string" &&
                !(resolution.manualContent instanceof Uint8Array)
            ) {
                throw new Error(
                    `Cannot apply manual conflict resolution for ${resolution.path}: manualContent is missing or invalid`
                );
            }

            const manualContent: string | Uint8Array = resolution.manualContent;

            await this.writeVaultFile(resolution.path, manualContent);
            mutations.push({
                kind: remoteItem ? "update" : "create",
                path: remotePath,
                previousRevision: remoteItem?.revision,
                content: await this.maybeEncrypt(manualContent),
            });
        }

        if (mutations.length > 0) {
            await this.client.commitMutations(
                mutations,
                `resolve conflicts: ${new Date().toISOString()}`
            );
            this.invalidateRemoteTreeCache();
            await this.persistEncryptionBinding();
        }
        this.audit("conflicts.resolve:success", {
            resolutionCount: resolutions.length,
            mutationCount: mutations.length,
        });
    }

    async getStatus(): Promise<SyncStatus> {
        try {
            await this.ensureEncryptionReady();
            const [localFiles, remoteTree] = await Promise.all([
                this.getLocalFiles(),
                this.client.listRemoteFiles(),
            ]);
            let pendingFiles = 0;

            for (const [remotePath, local] of localFiles) {
                const remoteItem = remoteTree.get(remotePath);
                if (!remoteItem) {
                    pendingFiles++;
                    continue;
                }
                const comparison = await this.tryCompareRemoteContent(
                    local,
                    remoteItem
                );
                if (!comparison.ok || !comparison.equal) {
                    pendingFiles++;
                }
            }

            for (const remotePath of remoteTree.keys()) {
                if (!this.isRemotePathScoped(remotePath)) {
                    continue;
                }
                if (!localFiles.has(remotePath)) {
                    pendingFiles++;
                }
            }

            const syncState = this.plugin.syncState.getState();
            return {
                hasChanges: pendingFiles > 0,
                hasConflicts: syncState.conflicts.length > 0,
                lastSyncTime: syncState.lastSyncTime,
                pendingFiles,
                provider: this.client.provider,
                online: true,
            };
        } catch (error) {
            console.error("Failed to compute API sync status", error);
            const state = this.plugin.syncState.getState();
            return {
                hasChanges: false,
                hasConflicts: state.conflicts.length > 0,
                lastSyncTime: state.lastSyncTime,
                pendingFiles: 0,
                provider: this.client.provider,
                online: false,
            };
        }
    }

    async getFileMetadata(path: string): Promise<SyncFileMetadata> {
        // For metadata queries we prefer to avoid throwing when the device
        // lacks the encryption passphrase. Gather an optional short code
        // describing an encryption readiness problem so the UI can surface
        // a subtle hint without failing the whole metadata lookup.
        let encryptionProblem: SyncFileMetadata["encryptionProblem"] = null;
        try {
            await this.ensureEncryptionReady();
        } catch (err) {
            // Use a typed EncryptionError with a stable error code if available.
            // This avoids brittle string matching on error messages.
            encryptionProblem =
                err instanceof EncryptionError ? err.code : "other";
            // Do not rethrow: continue with a best-effort metadata probe.
        }
        const inScope = isPathInTrackedDirectory(path, this.trackedDirectory);
        const remotePath = inScope
            ? toRemoteScopedPath(path, this.trackedDirectory)
            : undefined;
        const excluded = remotePath
            ? isPathExcludedByCompiledPatterns(
                  remotePath,
                  this.compiledExcludePatterns
              )
            : false;
        const local =
            inScope && !excluded ? await this.loadLocalFile(path) : null;
        const remote =
            remotePath && !excluded
                ? (await this.getRemoteTreeCached()).get(remotePath)
                : undefined;
        const syncState = this.plugin.syncState.getState();

        // Probe the remote file header (if the client supports it) to
        // determine per-file encryption rather than relying only on the
        // provider-level `apiEncryptionEnabled` flag.
        let remoteEncrypted = false;
        let probeSupported = false;
        if (remotePath && !excluded) {
            const clientWithHeader = this.client as {
                downloadFileHeader?: (
                    p: string,
                    b?: number
                ) => Promise<Uint8Array | null>;
            };
            if (typeof clientWithHeader.downloadFileHeader === "function") {
                probeSupported = true;
                try {
                    const header = await clientWithHeader.downloadFileHeader(
                        remotePath,
                        512
                    );
                    if (header !== null) {
                        remoteEncrypted = isEncryptedEnvelope(header);
                    } else {
                        probeSupported = false;
                    }
                } catch (err: unknown) {
                    probeSupported = false;
                    // Emit a debug-level log for visibility when header probes fail.
                    if (typeof this.plugin.logger?.debug === "function") {
                        this.plugin.logger.debug({
                            msg: "downloadFileHeader probe failed",
                            error: err,
                            path: remotePath,
                        });
                    } else if (
                        typeof console !== "undefined" &&
                        typeof console.debug === "function"
                    ) {
                        console.debug(
                            "[Git Vault] downloadFileHeader probe failed",
                            err,
                            remotePath
                        );
                    }
                }
            }
        }

        const encryptedFlag = probeSupported
            ? remoteEncrypted
            : this.encryptionEnabled;

        // Safely resolve optional client helpers: some client implementations
        // may not provide URL helpers or the typing may be unresolved by the
        // static analyzer. Guard with typeof checks before calling.
        let resolvedRemoteUrl: string | undefined = undefined;
        if (remote?.remoteUrl) {
            resolvedRemoteUrl = remote.remoteUrl;
        } else if (remotePath) {
            const getter: unknown = (this.client as { getRemoteUrl?: unknown })
                .getRemoteUrl;
            if (typeof getter === "function") {
                const fn = getter as (p: string) => unknown;
                const maybe = fn(remotePath);
                if (typeof maybe === "string") {
                    resolvedRemoteUrl = maybe;
                }
            }
        }

        let resolvedRemoteHistoryUrl: string | undefined = undefined;
        // Prefer an explicit, guarded read from the resolved remote item
        // to avoid assigning unknown/unsafe values into the typed result.
        if (remote) {
            const maybeRemoteHistory: unknown = (
                remote as { remoteHistoryUrl?: unknown }
            ).remoteHistoryUrl;
            if (typeof maybeRemoteHistory === "string") {
                resolvedRemoteHistoryUrl = maybeRemoteHistory;
            }
        } else {
            const getter: unknown = (
                this.client as { getRemoteHistoryUrl?: unknown }
            ).getRemoteHistoryUrl;
            if (remotePath && typeof getter === "function") {
                const fn = getter as (p: string) => unknown;
                const maybe = fn(remotePath);
                if (typeof maybe === "string") {
                    resolvedRemoteHistoryUrl = maybe;
                }
            }
        }

        return {
            path,
            inScope,
            excluded,
            provider: this.client.provider,
            remotePath,
            localHash: local?.plainHash,
            remoteRevision: remote?.revision,
            lastSyncTime: syncState.lastSyncTime,
            lastSyncResult: syncState.lastError
                ? "error"
                : syncState.conflicts.some((conflict) => conflict.path === path)
                  ? "conflict"
                  : syncState.lastSyncTime
                    ? "ok"
                    : "idle",
            encrypted: encryptedFlag,
            encryptionProblem,
            remoteUrl: resolvedRemoteUrl,
            remoteHistoryUrl: resolvedRemoteHistoryUrl,
        };
    }
}
