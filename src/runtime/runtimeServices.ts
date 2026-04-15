import type { App, Menu, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import type { GitManager } from "src/gitManager/gitManager";
import type Tools from "src/tools";
import type { LocalStorageSettings } from "src/setting/localStorageSettings";
import type {
    FileStatusResult,
    ObsidianGitSettings,
    PluginState,
    Status,
} from "src/types";
import type { INoticeHandle } from "src/notification/noticePresenter";
import type { NotifOptions } from "src/notification/notificationService";
import type { DiscardResult } from "src/ui/modals/discardModal";
import type { BranchStatusBar } from "src/ui/statusBar/branchStatusBar";

export interface IWorkspaceRefreshHost {
    refreshWorkspace(): void;
}

export interface IPluginStateHost {
    state: PluginState;
    setPluginState(patch: Partial<PluginState>): void;
}

export interface IMessageHost {
    displayMessage(
        message: string,
        timeout?: number,
        opts?: Pick<NotifOptions, "isNoChanges">
    ): void;
    displayError(error: unknown, timeout?: number): void;
    log(...data: unknown[]): void;
    showNotice(message: string, timeout?: number): INoticeHandle;
}

export interface IConflictCoordinatorHost
    extends IPluginStateHost,
        IMessageHost {
    app: App;
    tools: Tools;
    localStorage: LocalStorageSettings;
}

export interface IConflictCoordinator {
    mayDeleteConflictFile(): Promise<void>;
    handleConflict(conflicted?: string[]): Promise<void>;
    handleNoNetworkError(error: Error): void;
}

export interface IBranchRemoteHost
    extends IPluginStateHost,
        IMessageHost,
        IWorkspaceRefreshHost {
    app: App;
    settings: ObsidianGitSettings;
    gitManager: GitManager;
    branchBar?: BranchStatusBar;
    interactions: IRuntimeInteractionService;

    ensureInitialized(): Promise<boolean>;
    notifyIfNonDefaultTrackingBranch(): Promise<void>;
}

export interface IBranchRemoteService {
    switchRemoteBranch(): Promise<string | undefined>;
    createBranch(): Promise<string | undefined>;
    deleteBranch(): Promise<string | undefined>;
    remotesAreSet(): Promise<boolean>;
    setUpstreamBranch(): Promise<boolean>;
    editRemotes(): Promise<string | undefined>;
    selectRemoteBranch(): Promise<string | undefined>;
    removeRemote(): Promise<void>;
}

export interface IGitOperationsHost
    extends IPluginStateHost,
        IMessageHost,
        IWorkspaceRefreshHost {
    app: App;
    settings: ObsidianGitSettings;
    gitManager: GitManager;
    tools: Tools;
    localStorage: LocalStorageSettings;

    lastPulledFiles: FileStatusResult[];
    cachedStatus: Status | undefined;
    updateCachedStatus(): Promise<Status>;
    ensureInitialized(): Promise<boolean>;
    notifyIfNonDefaultTrackingBranch(): Promise<void>;
    useSimpleGit: boolean;

    branchRemote: IBranchRemoteService;
    conflictCoordinator: IConflictCoordinator;
    ensureSensitiveVaultGitignore(): Promise<void>;
}

export interface ICommitArgs {
    fromAutoBackup: boolean;
    requestCustomMessage?: boolean;
    onlyStaged?: boolean;
    commitMessage?: string;
    amend?: boolean;
}

export interface ICommitAndSyncArgs {
    fromAutoBackup: boolean;
    requestCustomMessage?: boolean;
    commitMessage?: string;
    onlyStaged?: boolean;
}

/**
 * Options for `cloneNewRepo`.
 *
 * Passing a string to `cloneNewRepo` is a shorthand for `{ remoteUrl: string }`.
 * When using the shorthand, the `remoteUrl` is required; the `target` field,
 * if omitted, causes the UI to prompt for the clone target directory. Use
 * `target: "current-vault"` to clone directly into the current vault root,
 * or `target: "dedicated-vault"` to clone into a new dedicated vault directory.
 */
export interface ICloneRepoOptions {
    /** Remote repository URL to clone from. */
    remoteUrl?: string;
    /**
     * Where to clone the repository.
     * - `"prompt"` (or `undefined`): the UI will prompt the user for a directory.
     * - `"current-vault"`: clone directly into the current vault root.
     * - `"dedicated-vault"`: clone into a new, dedicated vault directory.
     */
    target?: "prompt" | "current-vault" | "dedicated-vault";
}

export interface ICreateRepoOptions {
    remoteName?: string;
    remoteUrl?: string;
}

export interface IGitOperationsService {
    createNewRepo(options?: ICreateRepoOptions): Promise<boolean>;
    /**
     * Clone a new repository.
     *
     * `options` may be either a string shorthand (treated as `{ remoteUrl: string }`)
     * or a full `ICloneRepoOptions` object. When using the shorthand form the
     * `remoteUrl` is required. If `remoteUrl` is not provided, callers will be
     * prompted for it in the UI. Omitting `target` causes the UI to prompt for
     * the clone directory; use `target: "current-vault"` to clone into the
     * current vault, or `target: "dedicated-vault"` to create/import a new vault.
     */
    cloneNewRepo(options?: string | ICloneRepoOptions): Promise<void>;
    pullChangesFromRemote(): Promise<void>;
    commitAndSync(args: ICommitAndSyncArgs): Promise<void>;
    commit(args: ICommitArgs): Promise<boolean>;
    push(): Promise<boolean>;
    /**
     * Pull changes from the remote.
     *
     * `success: false` means the pull was skipped or failed and `reason` may
     * provide the explanation.
     */
    pull(): Promise<
        | { success: true; filesChanged: number }
        | { success: false; reason?: string }
    >;
    fetch(): Promise<void>;
    stageFile(file: TFile): Promise<boolean>;
    unstageFile(file: TFile): Promise<boolean>;
    discardAll(path?: string): Promise<DiscardResult>;
}

export interface IWorkspaceSelectionSyncHost {
    app: App;
    getLastDiffViewState(): Record<string, unknown> | undefined;
    setLastDiffViewState(state: Record<string, unknown> | undefined): void;
}

export interface ITaskQueue {
    /**
     * Queue a task for serial execution.
     *
     * `onFinished` is invoked after every task completion: it receives the
     * resolved value `T` on success, and `undefined` when the task fails.
     * `onError` controls whether the queue reports the failure (`"report"`) or
     * swallows it (`"swallow"`); in either case, `onFinished(undefined)` is
     * still called for the failed task.
     */
    addTask<T>(
        task: () => Promise<T>,
        onFinished?: (res: T | undefined) => void,
        onError?: "report" | "swallow"
    ): Promise<T | undefined>;
}

export interface IWorkspaceSelectionSync {
    onActiveLeafChange(leaf: WorkspaceLeaf | null): void;
}

export type FileMenuTriggerType = "file-menu" | "obsidian-git:menu";

export interface ITextPromptOptions {
    options?: string[];
    placeholder?: string;
    allowEmpty?: boolean;
    onlySelection?: boolean;
    initialValue?: string;
    obscure?: boolean;
}

export interface IRuntimeInteractionService {
    chooseBranch(branches: string[]): Promise<string | undefined>;
    promptText(options: ITextPromptOptions): Promise<string | undefined>;
    openFileHistory(file: TFile): void;
}

export interface IFileMenuHost extends IMessageHost, IWorkspaceRefreshHost {
    app: App;
    settings: ObsidianGitSettings;
    gitReady: boolean;
    gitManager: GitManager;
    useSimpleGit: boolean;
    promiseQueue: ITaskQueue;
    interactions: IRuntimeInteractionService;

    addFileToGitignore(filePath: string, isFolder?: boolean): Promise<void>;
    encryptSingleFile(file: TFile): Promise<boolean>;
    decryptSingleFile(file: TFile): Promise<boolean>;
    stageFile(file: TFile): Promise<boolean>;
    unstageFile(file: TFile): Promise<boolean>;
    /**
     * Indicates whether the currently-active provider can return remote file
     * history. Callers MUST check this flag before attempting to call
     * `openRemoteFileHistory` — implementations may omit the method entirely.
     */
    readonly supportsRemoteFileHistory?: boolean;

    /**
     * Open the remote provider's file-history view for `file`.
     *
     * This method is optional: callers should check `supportsRemoteFileHistory`
     * and the presence of this function before invoking it.
     */
    openRemoteFileHistory?(file: TFile): Promise<void>;
}

export interface IFileMenuService {
    handleFileMenu(
        menu: Menu,
        file: TAbstractFile | string,
        source: string,
        type: FileMenuTriggerType
    ): void;
}
