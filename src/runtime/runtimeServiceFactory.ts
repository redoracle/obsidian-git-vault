import type { App, TFile } from "obsidian";
import type Tools from "src/tools";
import type { LocalStorageSettings } from "src/setting/localStorageSettings";
import type {
    FileStatusResult,
    ObsidianGitSettings,
    PluginState,
    Status,
} from "src/types";
import type { BranchStatusBar } from "src/ui/statusBar/branchStatusBar";
import type { GitManager } from "src/gitManager/gitManager";
import type { INoticeHandle } from "src/notification/noticePresenter";
import { BranchRemoteService } from "./branchRemoteService";
import { ConflictCoordinator } from "./conflictCoordinator";
import { FileMenuService } from "./fileMenuService";
import { GitOperationsService } from "./gitOperationsService";
import { RuntimeInteractionService } from "./runtimeUiAdapters";
import type {
    IBranchRemoteService,
    IConflictCoordinator,
    IFileMenuService,
    IGitOperationsService,
    ITaskQueue,
    IWorkspaceSelectionSync,
} from "./runtimeServices";
import { WorkspaceSelectionSync } from "./workspaceSelectionSync";

export interface IRuntimeServiceFactoryHost {
    app: App;
    tools: Tools;
    localStorage: LocalStorageSettings;
    promiseQueue: ITaskQueue;

    getState(): PluginState;
    setPluginState(patch: Partial<PluginState>): void;
    displayMessage(
        message: string,
        timeout?: number,
        opts?: { isNoChanges: boolean }
    ): void;
    displayError(error: unknown, timeout?: number): void;
    log(...data: unknown[]): void;
    showNotice(message: string, timeout?: number): INoticeHandle;

    getSettings(): ObsidianGitSettings;
    getGitManager(): GitManager;
    getBranchBar(): BranchStatusBar | undefined;
    getLastPulledFiles(): FileStatusResult[];
    setLastPulledFiles(files: FileStatusResult[]): void;
    getCachedStatus(): Status | undefined;
    getGitReady(): boolean;
    getUseSimpleGit(): boolean;

    updateCachedStatus(): Promise<Status>;
    ensureInitialized(): Promise<boolean>;
    notifyIfNonDefaultTrackingBranch(): Promise<void>;
    refreshWorkspace(): void;
    saveSettings(): Promise<void>;
    reinitializePluginAfterRepoChange(): Promise<void>;
    ensureSensitiveVaultGitignore(): Promise<void>;

    getLastDiffViewState(): Record<string, unknown> | undefined;
    setLastDiffViewState(state: Record<string, unknown> | undefined): void;

    /** Return whether the active provider supports remote file history lookups. */
    getSupportsRemoteFileHistory(): boolean;
    /** Optional: open the remote provider's file-history view for `file`. */
    openRemoteFileHistory?: (file: TFile) => Promise<void>;

    addFileToGitignore(filePath: string, isFolder?: boolean): Promise<void>;
    encryptSingleFile(file: TFile): Promise<boolean>;
    decryptSingleFile(file: TFile): Promise<boolean>;
    stageFile(file: TFile): Promise<boolean>;
    unstageFile(file: TFile): Promise<boolean>;
}

export interface IRuntimeServicesBundle {
    branchRemote: IBranchRemoteService;
    gitOperations: IGitOperationsService;
    conflictCoordinator: IConflictCoordinator;
    workspaceSelectionSync: IWorkspaceSelectionSync;
    fileMenuService: IFileMenuService;
}

export function createRuntimeServices(
    host: IRuntimeServiceFactoryHost
): IRuntimeServicesBundle {
    interface SharedHost {
        app: App;
        state: PluginState;
        setPluginState(patch: Partial<PluginState>): void;
        displayMessage(
            message: string,
            timeout?: number,
            opts?: { isNoChanges: boolean }
        ): void;
        displayError(error: unknown, timeout?: number): void;
        log(...data: unknown[]): void;
        showNotice(message: string, timeout?: number): INoticeHandle;
    }

    const sharedHost = {
        app: host.app,
        setPluginState: (patch: Partial<PluginState>) =>
            host.setPluginState(patch),
        displayMessage: (
            message: string,
            timeout?: number,
            opts?: { isNoChanges: boolean }
        ) => host.displayMessage(message, timeout, opts),
        displayError: (error: unknown, timeout?: number) =>
            host.displayError(error, timeout),
        log: (...data: unknown[]) => host.log(...data),
        showNotice: (message: string, timeout?: number): INoticeHandle =>
            host.showNotice(message, timeout),
        get state() {
            return host.getState();
        },
    };

    const createServiceHost = <T extends object>(extra: T): T & SharedHost => {
        const serviceHost = Object.create(sharedHost) as SharedHost;
        Object.defineProperties(
            serviceHost,
            Object.getOwnPropertyDescriptors(extra)
        );
        return serviceHost as T & SharedHost;
    };

    const conflictCoordinator = new ConflictCoordinator(
        createServiceHost({
            tools: host.tools,
            localStorage: host.localStorage,
        })
    );

    const interactions = new RuntimeInteractionService({
        app: host.app,
        get gitManager() {
            return host.getGitManager();
        },
        get useSimpleGit() {
            return host.getUseSimpleGit();
        },
        showNotice: (message: string, timeout?: number) =>
            host.showNotice(message, timeout),
    });

    const branchRemote = new BranchRemoteService(
        createServiceHost({
            get settings() {
                return host.getSettings();
            },
            get gitManager() {
                return host.getGitManager();
            },
            get branchBar() {
                return host.getBranchBar();
            },
            interactions,
            ensureInitialized: () => host.ensureInitialized(),
            notifyIfNonDefaultTrackingBranch: () =>
                host.notifyIfNonDefaultTrackingBranch(),
            refreshWorkspace: () => host.refreshWorkspace(),
        })
    );

    const gitOperations = new GitOperationsService(
        createServiceHost({
            get settings() {
                return host.getSettings();
            },
            get gitManager() {
                return host.getGitManager();
            },
            tools: host.tools,
            localStorage: host.localStorage,
            get lastPulledFiles() {
                return host.getLastPulledFiles();
            },
            set lastPulledFiles(files: FileStatusResult[]) {
                host.setLastPulledFiles(files);
            },
            get cachedStatus() {
                return host.getCachedStatus();
            },
            updateCachedStatus: () => host.updateCachedStatus(),
            ensureInitialized: () => host.ensureInitialized(),
            notifyIfNonDefaultTrackingBranch: () =>
                host.notifyIfNonDefaultTrackingBranch(),
            get useSimpleGit() {
                return host.getUseSimpleGit();
            },
            get branchRemote() {
                return branchRemote;
            },
            get conflictCoordinator() {
                return conflictCoordinator;
            },
            refreshWorkspace: () => host.refreshWorkspace(),
            saveSettings: () => host.saveSettings(),
            reinitializePluginAfterRepoChange: () =>
                host.reinitializePluginAfterRepoChange(),
            ensureSensitiveVaultGitignore: () =>
                host.ensureSensitiveVaultGitignore(),
        })
    );

    const workspaceSelectionSync = new WorkspaceSelectionSync({
        app: host.app,
        getLastDiffViewState: () => host.getLastDiffViewState(),
        setLastDiffViewState: (state: Record<string, unknown> | undefined) =>
            host.setLastDiffViewState(state),
    });

    const fileMenuService = new FileMenuService(
        createServiceHost({
            get settings() {
                return host.getSettings();
            },
            get gitReady() {
                return host.getGitReady();
            },
            get gitManager() {
                return host.getGitManager();
            },
            get useSimpleGit() {
                return host.getUseSimpleGit();
            },
            get supportsRemoteFileHistory() {
                return host.getSupportsRemoteFileHistory();
            },
            get openRemoteFileHistory() {
                return host.openRemoteFileHistory
                    ? (file: TFile) => host.openRemoteFileHistory!(file)
                    : undefined;
            },
            promiseQueue: host.promiseQueue,
            interactions,
            refreshWorkspace: () => host.refreshWorkspace(),
            addFileToGitignore: (filePath: string, isFolder?: boolean) =>
                host.addFileToGitignore(filePath, isFolder),
            encryptSingleFile: (file: TFile) => host.encryptSingleFile(file),
            decryptSingleFile: (file: TFile) => host.decryptSingleFile(file),
            stageFile: (file: TFile) => host.stageFile(file),
            unstageFile: (file: TFile) => host.unstageFile(file),
        })
    );

    return {
        branchRemote,
        gitOperations,
        conflictCoordinator,
        workspaceSelectionSync,
        fileMenuService,
    };
}
