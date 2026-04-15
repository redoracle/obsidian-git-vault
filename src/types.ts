import type { LineAuthorSettings } from "src/editor/lineAuthor/model";

type WorkspaceEventCallback = {
    bivarianceHack(...data: unknown[]): unknown;
}["bivarianceHack"];

export interface ObsidianGitSettings {
    commitMessage: string;
    autoCommitMessage: string;
    commitMessageScript: string;
    commitDateFormat: string;
    /**
     * Interval to either automatically commit-and-sync or just commit
     */
    autoSaveInterval: number;
    autoPushInterval: number;
    autoPullInterval: number;
    autoPullOnBoot: boolean;
    autoCommitOnlyStaged: boolean;
    syncMethod: SyncMethod;
    mergeStrategy: MergeStrategy;
    /**
     * Whether to push on commit-and-sync
     */
    disablePush: boolean;
    /**
     * Whether to pull on commit-and-sync
     */
    pullBeforePush: boolean;
    /**
     * Whether messages from {@link ObsidianGit.displayMessage} should be shown
     */
    disablePopups: boolean;
    /**
     * Whether messages from {@link ObsidianGit.displayError} should be shown
     */
    showErrorNotices: boolean;
    disablePopupsForNoChanges: boolean;
    listChangedFilesInMessageBody: boolean;
    showStatusBar: boolean;
    updateSubmodules: boolean;
    submoduleRecurseCheckout: boolean;
    /**
     * @deprecated Using `localstorage` instead
     */
    gitPath?: string;
    customMessageOnAutoBackup: boolean;
    autoBackupAfterFileChange: boolean;
    treeStructure: boolean;
    /**
     * @deprecated Using `localstorage` instead
     */
    username?: string;
    differentIntervalCommitAndPush: boolean;
    changedFilesInStatusBar: boolean;

    /**
     * @deprecated Migrated to `syncMethod = 'merge'`
     */
    mergeOnPull?: boolean;
    refreshSourceControl: boolean;
    basePath: string;
    showedMobileNotice: boolean;
    refreshSourceControlTimer: number;
    showBranchStatusBar: boolean;
    lineAuthor: LineAuthorSettings;
    setLastSaveToLastCommit: boolean;
    gitDir: string;
    showFileMenu: boolean;
    /** Show small lock indicator next to encrypted files in the explorer */
    showExplorerEncryptionIndicator?: boolean;
    authorInHistoryView: ShowAuthorInHistoryView;
    dateInHistoryView: boolean;
    diffStyle: "git_unified" | "split";
    hunks: {
        hunkCommands: boolean;
        showSigns: boolean;
        statusBar: "disabled" | "colored" | "monochrome";
    };

    // ── Hybrid Git Vault settings ──────────────────────────────────────────

    /**
     * UI complexity mode.
     *   simple   – single "Sync" button, no Git terminology exposed.
     *   advanced – full Git staging/commit/diff/branch UI (existing behaviour).
     */
    syncMode: SyncUXMode;

    /**
     * Active sync backend.
     *   git     – CLI Git / isomorphic-git (existing behaviour).
     *   github  – GitHub REST API.
     *   gitlab  – GitLab REST API.
     *   gitea   – Gitea / Forgejo-style REST API.
     */
    activeSyncProvider: SyncProviderSetting;

    // ── API backend settings ───────────────────────────────────────────────

    /**
     * GitHub personal access token.
     * This legacy synced field may still be populated while migrating older
     * installs, but the token should now live in Obsidian secret storage
     * instead of plugin settings.
     * TODO(sync-security): evaluate desktop keychain support and per-session
     * prompts on mobile on top of secretStorage.
     */
    githubToken: string;
    /** GitHub account/org that owns the target repository. */
    githubOwner: string;
    /** Name of the target GitHub repository. */
    githubRepo: string;
    /** Branch to sync against (defaults to "main"). */
    githubBranch: string;

    /** Base URL for GitLab.com or a self-managed GitLab instance. */
    gitlabBaseUrl: string;
    /** Numeric project id or namespace/project path, e.g. group/repo. */
    gitlabProjectId: string;
    /** Branch to sync against on GitLab (defaults to "main"). */
    gitlabBranch: string;

    /** Base URL for a Gitea or Forgejo instance. */
    giteaBaseUrl: string;
    /** Owner/namespace of the target repository. */
    giteaOwner: string;
    /** Repository name. */
    giteaRepo: string;
    /** Branch to sync against on Gitea/Forgejo (defaults to "main"). */
    giteaBranch: string;

    /**
     * Optional vault-relative folder to sync in API mode.
     * Files inside this directory map to the repository root; files outside are ignored.
     */
    trackedDirectory?: string;
    /**
     * Vault-relative `.gitignore`-style rules that apply only to API backends.
     * Excluded files remain local-only and are omitted from remote diffing.
     */
    syncExcludePaths: string[];
    /**
     * Encrypt API-backed file contents before upload.
     * File and folder names stay plaintext; only file payloads are encrypted.
     */
    apiEncryptionEnabled: boolean;
    /**
     * Hash of the passphrase that was last used successfully with encrypted
     * API sync for a specific repo target. Used to detect unsupported
     * passphrase changes on the same remote.
     */
    apiEncryptionPassphraseFingerprint: string;
    /**
     * Repo fingerprint associated with apiEncryptionPassphraseFingerprint.
     * Empty means no encrypted-sync binding has been established yet.
     */
    apiEncryptionPassphraseRepoFingerprint: string;

    // ── Conflict resolution ───────────────────────────────────────────────

    /**
     * Default strategy for handling sync conflicts.
     *   last-write-wins  – prefer the side with the most recent modification.
     *   always-local     – local file always wins.
     *   always-remote    – remote file always wins.
     *   manual           – present a visual diff and require user decision.
     */
    conflictResolutionStrategy: ConflictResolutionStrategySetting;

    // ── Smart sync triggers ───────────────────────────────────────────────

    /** Trigger an automatic sync when the vault detects file-change events. */
    syncOnFileChange: boolean;
    /** Debounce interval (ms) applied to syncOnFileChange triggers. */
    syncOnFileChangeDebounce: number;
    /** Trigger a sync when Obsidian is about to close/quit. */
    syncOnClose: boolean;
    /** Trigger a sync when the device regains network connectivity. */
    syncOnNetworkReconnect: boolean;
    /** Trigger a sync after this many minutes of keyboard/mouse idle (-1 = off). */
    syncOnIdleMinutes: number;

    /**
     * Opaque identifier of the last repo that completed a successful sync.
     * Format: "<provider>:<owner>/<repo>@<branch>" (e.g. "github:alice/notes@main").
     * Used to detect when the user has switched repos so the first sync is
     * pull-only, preventing local files from a previous repo being pushed
     * to the newly configured one.
     */
    lastSyncedRepoFingerprint: string;
    /**
     * When true, the next sync uses the externally stored manifest sample
     * instead of loading the full manifest list.
     */
    lastSyncManifestIsSummary?: boolean;
    /**
     * Threshold (number of entries) above which the plugin will store a
     * sampled manifest summary instead of the full array. Make this tunable
     * so installations can adjust for large vaults.
     */
    apiSyncManifestThreshold?: number;
    /**
     * Size of the sampled manifest to store when falling back to summary mode.
     */
    apiSyncManifestSampleSize?: number;
    /**
     * Target false-positive rate used when building Bloom filters for large
     * manifests.
     * Must be a number between 0 and 1 (exclusive).
     * Typical values are around 0.01.
     * Lower values reduce false positives but increase memory usage.
     */
    apiSyncManifestBloomFpRate?: number;

    /**
     * Set for freshly bootstrapped dedicated vaults so the first launch can
     * guide the user through local credential setup without persisting
     * secrets in the cloned repository.
     */
    vaultBootstrapPending?: boolean;

    /**
     * Records the most recent failure to harden the current vault's
     * .gitignore so the UI or diagnostics can surface it later.
     */
    vaultBootstrapHardeningFailure?: {
        vaultId: string;
        message: string;
        at: number;
    } | null;

    /**
     * One-shot bootstrap token written into `data.json` (which is gitignored)
     * when a dedicated vault is cloned.  On the very first launch of the new
     * vault, `SettingsMigrationService.migrate()` moves this value into
     * Obsidian `secretStorage` for the active provider and then clears it so
     * it is never committed to the remote repository.
     */
    bootstrapProviderToken?: string;
}

/**
 * Ensures, that nested values objects are correctly merged.
 */
export function mergeSettingsByPriority(
    low: Omit<ObsidianGitSettings, "autoCommitMessage">,
    high: ObsidianGitSettings
): ObsidianGitSettings {
    const lineAuthor = Object.assign({}, low.lineAuthor, high.lineAuthor);
    return Object.assign({}, low, high, { lineAuthor });
}

export type SyncMethod = "rebase" | "merge" | "reset";

export type MergeStrategy = "none" | "ours" | "theirs";

export type ShowAuthorInHistoryView = "full" | "initials" | "hide";

/** Which sync backend is active. */
export type SyncProviderSetting = "git" | "github" | "gitlab" | "gitea";

/** UI complexity mode selected by the user. */
export type SyncUXMode = "simple" | "advanced";

/** Conflict auto-resolution strategy. */
export type ConflictResolutionStrategySetting =
    | "last-write-wins"
    | "always-local"
    | "always-remote"
    | "manual";

export interface Author {
    name: string;
    email: string;
}

export interface Status {
    all: FileStatusResult[];
    changed: FileStatusResult[];
    staged: FileStatusResult[];

    /*
     * Only available for `SimpleGit` gitManager
     */
    conflicted: string[];
}

export interface GitTimestamp {
    /**
     * The number of unix seconds since epoch time (UTC).
     */
    epochSeconds: number;
    /**
     * The time zone, in which the commit was originally created.
     * This can be used to reconstruct the local time during creating time.
     */
    tz: string;
}

export interface UserEmail {
    name: string;
    email: string;
}

export interface BlameCommit {
    hash: string;
    author?: UserEmail & GitTimestamp;
    committer?: UserEmail & GitTimestamp;
    previous?: { commitHash?: string; filename: string };
    filename?: string;
    summary: string;
    isZeroCommit: boolean; // true, if hash is 000...000
}

/**
 * See https://git-scm.com/docs/git-blame#_the_porcelain_format
 */
export interface Blame {
    commits: Map<string, BlameCommit>;
    /**
     * hashPerLine[i] is the commit hash where line i originates from
     *
     * The first element is always `undefined`, since line-numbers are 1-based.
     */
    hashPerLine: string[];
    /**
     * originalFileLineNrPerLine[i] contains the original files' line number from where line i
     *
     * The first element is always `undefined`, since line-numbers are 1-based.originated
     */
    originalFileLineNrPerLine: number[];
    /**
     * finalFileLineNrPerLine[i] contains the final files' line number from where line i originated
     *
     * The first element is always `undefined`, since line-numbers are 1-based.
     */
    finalFileLineNrPerLine: number[];
    /**
     * For each line i, which originates from a different commit than it's previous line,
     * groupSizePerStartingLine[i] contains the number of lines until either the next
     * group of lines or EOF is reached.
     */
    groupSizePerStartingLine: Map<number, number>;
}

/**
 * `index` and `working_dir` are each one-character codes, based off the git
 * status short format: git status --short
 * The following is from: https://www.git-scm.com/docs/git-status#_short_format
 *
 * The possible values are:
 * - ' ': unmodified
 * - M  : modified
 * - T  : file type changed
 * - A  : added
 * - D  : deleted
 * - R  : renamed
 * - C  : copied
 * - U  : updated but unmerged
 *
 *  index            working_dir            Meaning
 * ------------------------------------------------------------------------
 *                    [AMD]                 not updated
 *    M               [ MTD]                updated in index
 *    T               [ MTD]                type changed in index
 *    A               [ MTD]                added to index
 *    D                                     deleted from index
 *    R               [ MTD]                renamed in index
 *    C               [ MTD]                copied in index
 * [MTARC]                                  index and work tree match
 * [ MTARC]              M                  work tree changed since index
 * [ MTARC]              T                  type changed in work tree since index
 * [ MTARC]              D                  deleted in work tree
 *                       R                  renamed in work tree
 *                       C                  copied in work tree
 *    D                  D                  unmerged, both deleted
 *    A                  U                  unmerged, added by us
 *    U                  D                  unmerged, deleted by them
 *    U                  A                  unmerged, added by them
 *    D                  U                  unmerged, deleted by us
 *    A                  A                  unmerged, both added
 *    U                  U                  unmerged, both modified
 *    ?                  ?                  untracked
 *    !                  !                  ignored
 *
 *
 * FileStatusResult is based off simple-git's FileStatusResult:
 * https://github.com/steveukx/git-js/blob/a569868d800a0d872e8fb1534bb0dceccff47a4f/typings/response.d.ts#L267
 */
export interface FileStatusResult {
    path: string;
    vaultPath: string;
    from?: string;

    // First digit of the status code of the file, e.g. 'M' = modified.
    // Represents the status of the index if no merge conflicts, otherwise represents
    // status of one side of the merge.
    index: string;
    // Second digit of the status code of the file. Represents status of the working directory
    // if no merge conflicts, otherwise represents status of other side of a merge.
    workingDir: string;
}

export interface PluginState {
    offlineMode: boolean;
    gitAction: CurrentGitAction;
}

export enum CurrentGitAction {
    idle,
    status,
    pull,
    add,
    commit,
    push,
}

export interface LogEntry {
    hash: string;
    date: string;
    message: string;
    refs: string[];
    body: string;
    diff: DiffEntry;
    author: {
        name: string;
        email: string;
    };
}

export interface DiffEntry {
    changed: number;
    files: DiffFile[];
}

export interface DiffFile {
    path: string;
    vaultPath: string;
    fromPath?: string;
    fromVaultPath?: string;
    hash: string;
    status: string;
    binary?: boolean;
}

export interface WalkDifference {
    path: string;
    type: "M" | "A" | "D";
}

export type UnstagedFile = WalkDifference;

export interface BranchInfo {
    current?: string;
    tracking?: string;
    branches: string[];
}

export interface TreeItem<T = DiffFile | FileStatusResult> {
    title: string;
    path: string;
    vaultPath: string;
    data?: T;
    children?: TreeItem<T>[];
}

export type RootTreeItem<T> = TreeItem<T> & { children: TreeItem<T>[] };

export type StatusRootTreeItem = RootTreeItem<FileStatusResult>;

export type HistoryRootTreeItem = RootTreeItem<DiffFile>;

export type DiffViewState = {
    /**
     * The repo relative file path for a.
     * For diffing a renamed file, this is the old path.
     */
    aFile: string;

    /**
     * The git ref to specify which state of that file should be shown.
     * An empty string refers to the index version of a file, so you have to specifically check against undefined.
     */
    aRef: string;

    /**
     * The repo relative file path for b.
     */
    bFile: string;

    /**
     * The git ref to specify which state of that file should be shown.
     * An empty string refers to the index version of a file, so you have to specifically check against undefined.
     * `undefined` stands for the working tree version.
     */
    bRef?: string;
};

export enum FileType {
    staged,
    changed,
    pulled,
}

export class NoNetworkError extends Error {
    constructor(public readonly originalError: string) {
        super("No network connection available");
    }
}

declare module "obsidian" {
    interface App {
        loadLocalStorage(key: string): string | null;
        saveLocalStorage(key: string, value: string | undefined): void;
        openWithDefaultApp(path: string): void;
        getTheme(): "obsidian" | "moonstone";
        viewRegistry: ViewRegistry;
    }
    interface Vault {
        /**
         * PRIVATE API — reads a single key from the vault's app.json config.
         * Used to inspect settings such as `detectedFiles` (show all ext).
         */
        getConfig(key: string): unknown;
        /**
         * PRIVATE API — persists a single key to the vault's app.json config
         * and propagates the change to all consumers (file-explorer etc.).
         */
        setConfig(key: string, value: unknown): void;
    }
    interface View {
        titleEl: HTMLElement;
        inlineTitleEl: HTMLElement;
    }
    interface ViewRegistry {
        /**
         * PRIVATE API
         *
         * Returns the view type for the given extension if available.
         */
        getTypeByExtension(extension: string): string;
    }
    interface Workspace {
        on(
            name: string,
            callback: WorkspaceEventCallback,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when some git action has been completed and plugin has been refreshed
         */
        on(
            name: "obsidian-git:refreshed",
            callback: () => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when some git action has been completed and the plugin should refresh
         */
        on(
            name: "obsidian-git:refresh",
            callback: () => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when the plugin is currently loading a new cached status.
         */
        on(
            name: "obsidian-git:loading-status",
            callback: () => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when the HEAD changed.
         */
        on(
            name: "obsidian-git:head-change",
            callback: () => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when a new cached status is available.
         */
        on(
            name: "obsidian-git:status-changed",
            callback: (status: Status) => void,
            ctx?: unknown
        ): EventRef;
        /**
         * Emitted when the interface mode changes; `mode` is the new Sync UX mode.
         */
        on(
            name: "obsidian-git:sync-mode-changed",
            callback: (mode: SyncUXMode) => void,
            ctx?: unknown
        ): EventRef;

        on(
            name: "obsidian-git:menu",
            callback: (
                menu: Menu,
                path: string,
                source: string,
                leaf?: WorkspaceLeaf
            ) => unknown,
            ctx?: unknown
        ): EventRef;
        trigger(name: string, ...data: unknown[]): void;
        trigger(name: "obsidian-git:refreshed"): void;
        trigger(name: "obsidian-git:refresh"): void;
        trigger(name: "obsidian-git:loading-status"): void;
        trigger(name: "obsidian-git:head-change"): void;
        trigger(name: "obsidian-git:status-changed", status: Status): void;
        trigger(name: "obsidian-git:sync-mode-changed", mode: SyncUXMode): void;
        trigger(
            name: "obsidian-git:menu",
            menu: Menu,
            path: string,
            source: string,
            leaf?: WorkspaceLeaf
        ): void;
    }
}
