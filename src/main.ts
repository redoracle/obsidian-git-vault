import { Errors } from "isomorphic-git";
import { promises as fsPromises } from "fs";
import * as path from "path";
import type { Debouncer, Menu, TAbstractFile, WorkspaceLeaf } from "obsidian";
import {
    debounce,
    FileSystemAdapter,
    Platform,
    Plugin,
    requireApiVersion,
    setIcon,
    TFile,
} from "obsidian";
import { pluginRef } from "src/pluginGlobalRef";
import { PromiseQueue } from "src/promiseQueue";
import { VaultBootstrapService } from "src/runtime/vaultBootstrapService";
import { ProviderSecrets } from "src/security/providerSecrets";
import { ObsidianGitSettingsTab } from "src/setting/settings";
import { StatusBar } from "src/statusBar";
import { VaultEncryptionService } from "src/encryption/vaultEncryptionService";
import { registerExplorerEncryptionIndicator } from "src/ui/explorer/encryptionIndicator";
import { SettingsMigrationService } from "src/setting/settingsMigrationService";
import { warnOnSettingsInconsistency } from "src/setting/settingsValidator";
import type { NotifOptions } from "src/notification/notificationService";
import AutomaticsManager from "./automaticsManager";
import { addCommmands } from "./commands";
import {
    DEFAULT_SETTINGS,
    DIFF_VIEW_CONFIG,
    HISTORY_VIEW_CONFIG,
    SYNC_METADATA_VIEW_CONFIG,
    SOURCE_CONTROL_VIEW_CONFIG,
    SPLIT_DIFF_VIEW_CONFIG,
} from "./constants";
import type { GitManager } from "./gitManager/gitManager";
import { IsomorphicGit } from "./gitManager/isomorphicGit";
import type { SimpleGit } from "./gitManager/simpleGit";
import { LocalStorageSettings } from "./setting/localStorageSettings";
import { providerRegistry } from "src/syncProvider/providerRegistry";
import { SyncManager } from "./syncProvider/syncManager";
import { SyncStateManager } from "./syncProvider/syncState";
import type { SyncState } from "./syncProvider/syncState";
import Tools from "./tools";
import type {
    FileStatusResult,
    ObsidianGitSettings,
    PluginState,
    Status,
} from "./types";
import {
    CurrentGitAction,
    mergeSettingsByPriority,
    NoNetworkError,
} from "./types";
import DiffView from "./ui/diff/diffView";
import SplitDiffView from "./ui/diff/splitDiffView";
import HistoryView from "./ui/history/historyView";
import GitView from "./ui/sourceControl/sourceControl";
import SyncMetadataView from "./ui/syncMetadata/syncMetadataView";
import { BranchStatusBar } from "./ui/statusBar/branchStatusBar";
import {
    convertPathToAbsoluteGitignoreRule,
    formatRemoteUrl,
    spawnAsync,
    sanitizeUrl,
} from "./utils";
import {
    getPausedAutomaticsResumeDelay,
    requiresLocalGitRepo,
} from "./startup";
import { HunkActions } from "./editor/signs/hunkActions";
import { EditorIntegration } from "./editor/editorIntegration";
import { RuntimeOrchestrator } from "./runtime/runtimeOrchestrator";
import { NotificationService } from "./notification/notificationService";
import type { INoticeFactory } from "./notification/notificationService";
import {
    BottomCenterNoticePresenter,
    type INoticeHandle,
    type INoticePresenter,
} from "./notification/noticePresenter";
import { SyncManifestStore } from "./syncProvider/syncManifestStore";
import { createRuntimeServices } from "./runtime/runtimeServiceFactory";
import { VaultBootstrapModal } from "./ui/modals/vaultBootstrapModal";
import { GeneralModal } from "./ui/modals/generalModal";
import { SetupProgressModal } from "./ui/modals/setupProgressModal";

import type {
    IBranchRemoteService,
    ICloneRepoOptions,
    ICommitAndSyncArgs,
    ICommitArgs,
    ICreateRepoOptions,
    IConflictCoordinator,
    IFileMenuService,
    IGitOperationsService,
    IWorkspaceSelectionSync,
} from "./runtime/runtimeServices";

// Exposed constant for the pending vault sync window (milliseconds)
export const PENDING_VAULT_SYNC_WINDOW_MS = 5 * 60 * 1000;

export default class ObsidianGit extends Plugin {
    gitManager!: GitManager;
    automaticsManager: AutomaticsManager = new AutomaticsManager(this);
    tools = new Tools(this);
    /** Optional structured logger for low-verbosity debug output. */
    logger?: { debug: (msg: unknown) => void };
    localStorage = new LocalStorageSettings(this);
    providerSecrets: ProviderSecrets = new ProviderSecrets(this);
    syncManifestStore: SyncManifestStore = new SyncManifestStore(
        this.app,
        this.manifest.id
    );
    settings!: ObsidianGitSettings;
    settingsTab?: ObsidianGitSettingsTab;
    statusBar?: StatusBar;
    branchBar?: BranchStatusBar;

    /** Centralised runtime sync state (provider-agnostic). */
    syncState = new SyncStateManager();
    /** High-level sync coordinator; manages provider selection, triggers, conflicts. */
    syncManager = new SyncManager(this);
    /** Runtime phase state machine — single truth for boot/sync/reload/unload. */
    readonly _orchestrator: RuntimeOrchestrator = new RuntimeOrchestrator();
    /** Lazy-initialised notification service see {@link notifSvc}. */
    private _notifSvc: NotificationService | null = null;
    private _noticePresenter: INoticePresenter | null = null;
    private vaultBootstrap!: VaultBootstrapService;
    private bootstrapOnboardingShown = false;
    private branchRemote!: IBranchRemoteService;
    private gitOperations!: IGitOperationsService;
    private conflictCoordinator!: IConflictCoordinator;
    private workspaceSelectionSync!: IWorkspaceSelectionSync;
    private fileMenuService!: IFileMenuService;

    state: PluginState = {
        gitAction: CurrentGitAction.idle,
        offlineMode: false,
    };
    lastPulledFiles: FileStatusResult[] = [];
    gitReady = false;
    promiseQueue: PromiseQueue = new PromiseQueue(this);

    cachedStatus: Status | undefined;
    // Used to store the path of the file that is currently shown in the diff view.
    lastDiffViewState: Record<string, unknown> | undefined;
    intervalsToClear: number[] = [];
    private pauseAutomaticsResumeTimeout: number | null = null;
    private vaultChangeEffectsSuppressionDepth = 0;
    /** True while a branch switch operation is in progress. */
    isBranchSwitchInProgress = false;
    editorIntegration: EditorIntegration = new EditorIntegration(this);
    hunkActions = new HunkActions(this);
    syncRibbonEl?: HTMLElement;
    syncStateUnsubscribe?: () => void;
    private branchWorkflowHintsShown = new Set<string>();
    /** Prevents onExternalSettingsChange from triggering reloadSettings while init() is running. */
    private _initInProgress = false;
    // Initialized in onload() once this.app.vault is available.
    private vaultEncryption!: VaultEncryptionService;
    private settingsMigration!: SettingsMigrationService;
    private get gitHttpUsernameSecretId(): string {
        return `${this.manifest.id}-git-http-username`;
    }
    private get gitHttpPasswordSecretId(): string {
        return `${this.manifest.id}-git-http-password`;
    }

    /**
     * Debouncer for the refresh of the git status for the source control view after file changes.
     */
    debRefresh!: Debouncer<[], void>;

    setPluginState(state: Partial<PluginState>): void {
        const changed = (Object.keys(state) as Array<keyof PluginState>).some(
            (k) => this.state[k] !== (state as PluginState)[k]
        );
        this.state = Object.assign(this.state, state);
        if (changed) {
            this.statusBar?.display();
        }
    }

    get isInitInProgress(): boolean {
        return this._initInProgress;
    }

    private refreshWorkspace = (): void => {
        this.app.workspace.trigger("obsidian-git:refresh");
    };

    private getLastDiffViewState = (): Record<string, unknown> | undefined => {
        return this.lastDiffViewState;
    };

    private setLastDiffViewState = (
        state: Record<string, unknown> | undefined
    ): void => {
        this.lastDiffViewState = state;
    };

    private ensureInitialized = (): Promise<boolean> => {
        return this.isAllInitialized();
    };

    async runWithSuppressedVaultChangeEffects<T>(
        operation: () => Promise<T>
    ): Promise<T> {
        this.vaultChangeEffectsSuppressionDepth++;
        try {
            return await operation();
        } finally {
            this.vaultChangeEffectsSuppressionDepth = Math.max(
                0,
                this.vaultChangeEffectsSuppressionDepth - 1
            );
        }
    }

    areVaultChangeEffectsSuppressed(): boolean {
        return this.vaultChangeEffectsSuppressionDepth > 0;
    }

    clearPausedAutomaticsResumeTimer(): void {
        if (this.pauseAutomaticsResumeTimeout !== null) {
            window.clearTimeout(this.pauseAutomaticsResumeTimeout);
            this.pauseAutomaticsResumeTimeout = null;
        }
    }

    syncPausedAutomaticsResumeTimer(resumeMessage?: string): void {
        this.clearPausedAutomaticsResumeTimer();

        if (!this.localStorage.getPausedAutomatics()) {
            return;
        }

        const delay = getPausedAutomaticsResumeDelay(
            this.localStorage.getPausedUntil()
        );
        if (delay === null) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            if (this.pauseAutomaticsResumeTimeout !== timeoutId) {
                return;
            }

            this.pauseAutomaticsResumeTimeout = null;
            if (this.localStorage.getPausedAutomatics()) {
                return;
            }

            if (this.settings.activeSyncProvider === "git" && this.gitReady) {
                this.automaticsManager.reload("commit", "push", "pull");
            }

            if (resumeMessage) {
                this.showNotice(resumeMessage);
            }
        }, delay);

        this.pauseAutomaticsResumeTimeout = timeoutId;
    }

    private wireRuntimeServices(): void {
        const runtimeServices = createRuntimeServices({
            app: this.app,
            tools: this.tools,
            localStorage: this.localStorage,
            promiseQueue: this.promiseQueue,
            getState: () => this.state,
            setPluginState: (patch: Partial<PluginState>) =>
                this.setPluginState(patch),
            displayMessage: (
                message: string,
                timeout?: number,
                opts?: { isNoChanges: boolean }
            ) => this.displayMessage(message, timeout, opts),
            displayError: (error: unknown, timeout?: number) =>
                this.displayError(error, timeout),
            log: (...data: unknown[]) => this.log(...data),
            showNotice: (message: string, timeout?: number): INoticeHandle =>
                this.showNotice(message, timeout),
            getSettings: (): ObsidianGitSettings => this.settings,
            getGitManager: (): GitManager => this.gitManager,
            getBranchBar: (): BranchStatusBar | undefined => this.branchBar,
            getLastPulledFiles: (): FileStatusResult[] => this.lastPulledFiles,
            setLastPulledFiles: (files: FileStatusResult[]): void => {
                this.lastPulledFiles = files;
            },
            getCachedStatus: (): Status | undefined => this.cachedStatus,
            getGitReady: (): boolean => this.gitReady,
            getUseSimpleGit: (): boolean => this.useSimpleGit,
            getSupportsRemoteFileHistory: (): boolean =>
                this.supportsRemoteFileHistory(),
            updateCachedStatus: () => this.updateCachedStatus(),
            ensureInitialized: this.ensureInitialized,
            notifyIfNonDefaultTrackingBranch: () =>
                this.notifyIfNonDefaultTrackingBranch(),
            refreshWorkspace: this.refreshWorkspace,
            saveSettings: () => this.saveSettings(),
            reinitializePluginAfterRepoChange: () =>
                this.init({ fromReload: true }),
            ensureSensitiveVaultGitignore: () =>
                this.ensureSensitiveVaultGitignore(),
            getLastDiffViewState: this.getLastDiffViewState,
            setLastDiffViewState: this.setLastDiffViewState,
            openRemoteFileHistory: (file: TFile) =>
                this.openRemoteFileHistory(file),
            addFileToGitignore: (filePath: string, isFolder?: boolean) =>
                this.addFileToGitignore(filePath, isFolder),
            encryptSingleFile: (file: TFile) => this.encryptSingleFile(file),
            decryptSingleFile: (file: TFile) => this.decryptSingleFile(file),
            stageFile: (file: TFile) => this.stageFile(file),
            unstageFile: (file: TFile) => this.unstageFile(file),
        });

        this.conflictCoordinator = runtimeServices.conflictCoordinator;
        this.branchRemote = runtimeServices.branchRemote;
        this.gitOperations = runtimeServices.gitOperations;
        this.workspaceSelectionSync = runtimeServices.workspaceSelectionSync;
        this.fileMenuService = runtimeServices.fileMenuService;
    }

    private supportsRemoteFileHistory(): boolean {
        const descriptor = providerRegistry.describe(
            this.settings.activeSyncProvider
        );
        if (
            !descriptor.isApiProvider ||
            !descriptor.supportsRemoteCommitHistory
        ) {
            return false;
        }

        switch (this.settings.activeSyncProvider) {
            case "github":
                return Boolean(
                    this.settings.githubOwner &&
                        this.settings.githubRepo &&
                        this.settings.githubBranch
                );
            case "gitlab":
                // Reject purely-numeric GitLab project IDs here because the
                // plugin's remote-history URL construction and history browsing
                // expect a namespace/project string (for example
                // "group/subgroup/project") rather than a numeric project ID.
                // Numeric IDs cannot be used to reliably build the web history
                // URL, so require a non-numeric project identifier.
                return Boolean(
                    this.settings.gitlabProjectId &&
                        !/^\d+$/.test(this.settings.gitlabProjectId.trim()) &&
                        this.settings.gitlabBranch
                );
            case "gitea":
                return Boolean(
                    this.settings.giteaBaseUrl &&
                        this.settings.giteaOwner &&
                        this.settings.giteaRepo &&
                        this.settings.giteaBranch
                );
            case "git":
                return false;
        }
    }

    private async openRemoteFileHistory(file: TFile): Promise<void> {
        const metadata = await this.syncManager.getFileMetadata(file.path);
        const historyUrl =
            metadata &&
            "remoteHistoryUrl" in metadata &&
            typeof metadata.remoteHistoryUrl === "string"
                ? metadata.remoteHistoryUrl
                : undefined;
        if (!historyUrl) {
            this.showNotice(
                "File history is not available for this file on the active remote.",
                6000
            );
            return;
        }
        window.open(historyUrl);
    }

    async notifyIfNonDefaultTrackingBranch(): Promise<void> {
        if (!this.useSimpleGit) return;
        const context = await (
            this.gitManager as SimpleGit
        ).getNonDefaultTrackingContext();
        if (!context) return;

        const key = `${context.remote}:${context.currentBranch}:${context.remoteDefaultBranch}`;
        if (this.branchWorkflowHintsShown.has(key)) return;
        this.branchWorkflowHintsShown.add(key);

        this.showNotice(
            `Branch "${context.currentBranch}" tracks "${context.trackingBranch}", while remote default is "${context.remote}/${context.remoteDefaultBranch}". Compare/PR prompts on the hosting UI are expected. Switch to "${context.remoteDefaultBranch}" (or set upstream to "${context.remote}/${context.remoteDefaultBranch}") for direct default-branch sync.`,
            12000
        );
    }

    async updateCachedStatus(): Promise<Status> {
        this.app.workspace.trigger("obsidian-git:loading-status");
        this.cachedStatus = await this.gitManager.status();
        // Mirror into SyncStateManager so API consumers can read it without
        // coupling to the plugin instance.
        this.syncState.updateCachedGitStatus(this.cachedStatus);
        if (this.cachedStatus.conflicted.length > 0) {
            this.localStorage.setConflict(true);
            await this.branchBar?.display();
        } else {
            this.localStorage.setConflict(false);
            await this.branchBar?.display();
        }

        this.app.workspace.trigger(
            "obsidian-git:status-changed",
            this.cachedStatus
        );
        return this.cachedStatus;
    }

    async refresh() {
        if (!this.gitReady) return;

        const gitViews = this.app.workspace.getLeavesOfType(
            SOURCE_CONTROL_VIEW_CONFIG.type
        );
        const historyViews = this.app.workspace.getLeavesOfType(
            HISTORY_VIEW_CONFIG.type
        );

        if (
            this.settings.changedFilesInStatusBar ||
            gitViews.some((leaf) => !(leaf.isDeferred ?? false)) ||
            historyViews.some((leaf) => !(leaf.isDeferred ?? false))
        ) {
            await this.updateCachedStatus().catch((e: unknown) =>
                this.displayError(e)
            );
        }

        this.app.workspace.trigger("obsidian-git:refreshed");

        // We don't put a line authoring refresh here, as it would force a re-loading
        // of the line authoring feature - which would lead to a jumpy editor-view in the
        // ui after every rename event.
    }

    async onload() {
        console.log(
            "loading " +
                this.manifest.name +
                " plugin: v" +
                this.manifest.version
        );

        pluginRef.plugin = this;
        this.vaultEncryption = new VaultEncryptionService(
            this.app.vault,
            this.providerSecrets,
            (message, duration) => this.showNotice(message, duration)
        );
        this.settingsMigration = new SettingsMigrationService(
            this.app,
            this.providerSecrets,
            this.localStorage,
            this.gitHttpUsernameSecretId,
            this.gitHttpPasswordSecretId,
            () => this.saveSettings()
        );
        this.vaultBootstrap = new VaultBootstrapService(this);

        this.localStorage.migrate();
        await this.loadSettings();
        await this.migrateSettings();
        this.wireRuntimeServices();

        if (!requireApiVersion("1.11.4")) {
            this.displayError(
                "Obsidian Git Vault requires Obsidian 1.11.4 or newer for secure token storage."
            );
            return;
        }

        this.settingsTab = new ObsidianGitSettingsTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        if (!this.localStorage.getPluginDisabled()) {
            this.registerStuff();

            this.app.workspace.onLayoutReady(() => {
                this.registerVaultChangeHandlers();
                this.init({ fromReload: false }).catch((e) =>
                    this.displayError(e)
                );
            });
        }
    }

    onExternalSettingsChange() {
        if (this._initInProgress) return;
        this.reloadSettings().catch((e: unknown) => this.displayError(e));
    }

    /** Reloads the settings from disk and applies them by unloading the plugin
     * and initializing it again.
     */
    async reloadSettings(): Promise<void> {
        const previousSettings = JSON.stringify(this.settings);

        await this.loadSettings();

        const newSettings = JSON.stringify(this.settings);

        // Only reload plugin if the settings have actually changed
        if (previousSettings !== newSettings) {
            this.log("Reloading settings");

            this.unloadPlugin();

            await this.init({ fromReload: true });

            this.app.workspace
                .getLeavesOfType(SOURCE_CONTROL_VIEW_CONFIG.type)
                .forEach((leaf) => {
                    if (!(leaf.isDeferred ?? false))
                        return (leaf.view as GitView).reload();
                });

            this.app.workspace
                .getLeavesOfType(HISTORY_VIEW_CONFIG.type)
                .forEach((leaf) => {
                    if (!(leaf.isDeferred ?? false))
                        return (leaf.view as HistoryView).reload();
                });
        }
    }

    /** This method only registers events, views, commands and more.
     *
     * This only needs to be called once since the registered events are
     * unregistered when the plugin is unloaded.
     *
     * This mustn't depend on the plugin's settings.
     */
    registerStuff(): void {
        this.registerEvent(
            this.app.workspace.on("obsidian-git:refresh", () => {
                this.refresh().catch((e: unknown) => this.displayError(e));
            })
        );
        this.registerEvent(
            this.app.workspace.on("obsidian-git:head-change", () => {
                void this.branchBar?.display().catch(console.error);
            })
        );

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file, source) => {
                this.handleFileMenu(menu, file, source, "file-menu");
            })
        );

        this.registerEvent(
            this.app.workspace.on("obsidian-git:menu", (menu, path, source) => {
                this.handleFileMenu(menu, path, source, "obsidian-git:menu");
            })
        );

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                this.workspaceSelectionSync.onActiveLeafChange(leaf);
            })
        );

        this.registerView(SOURCE_CONTROL_VIEW_CONFIG.type, (leaf) => {
            return new GitView(leaf, this);
        });

        this.registerView(HISTORY_VIEW_CONFIG.type, (leaf) => {
            return new HistoryView(leaf, this);
        });

        this.registerView(DIFF_VIEW_CONFIG.type, (leaf) => {
            return new DiffView(leaf, this);
        });

        this.registerView(SPLIT_DIFF_VIEW_CONFIG.type, (leaf) => {
            return new SplitDiffView(leaf, this);
        });
        this.registerView(SYNC_METADATA_VIEW_CONFIG.type, (leaf) => {
            return new SyncMetadataView(leaf, this);
        });
        // Register UI helpers that decorate Obsidian's explorer with encryption indicators
        registerExplorerEncryptionIndicator(this);
        this.syncRibbonEl = this.addRibbonIcon(
            "git-pull-request",
            "Open Git source control",
            async () => {
                const leafs = this.app.workspace.getLeavesOfType(
                    SOURCE_CONTROL_VIEW_CONFIG.type
                );
                let leaf: WorkspaceLeaf;
                if (leafs.length === 0) {
                    leaf =
                        this.app.workspace.getRightLeaf(false) ??
                        this.app.workspace.getLeaf();
                    await leaf.setViewState({
                        type: SOURCE_CONTROL_VIEW_CONFIG.type,
                    });
                } else {
                    leaf = leafs.first()!;
                }
                await this.app.workspace.revealLeaf(leaf);
            }
        );
        this.syncStateUnsubscribe = this.syncState.subscribe((state) => {
            this.updateSyncRibbon(state);
        });
        this.updateSyncRibbon(this.syncState.getState());

        this.registerHoverLinkSource(SOURCE_CONTROL_VIEW_CONFIG.type, {
            display: "Git View",
            defaultMod: true,
        });

        this.editorIntegration.onLoadPlugin();

        this.setRefreshDebouncer();

        addCommmands(this);
    }

    private registerVaultChangeHandlers(): void {
        const handleVaultChange = () => {
            if (this.areVaultChangeEffectsSuppressed()) {
                return;
            }
            this.debRefresh();
            if (this.settings.autoBackupAfterFileChange) {
                // Git automatics path (autoBackupAfterFileChange debouncer).
                this.automaticsManager.handleFileChange();
            }
            if (this.settings.syncOnFileChange) {
                // Provider-agnostic smart-sync path (syncOnFileChange debouncer).
                this.syncManager.notifyFileChange();
            }
        };

        this.registerEvent(this.app.vault.on("modify", handleVaultChange));
        this.registerEvent(this.app.vault.on("delete", handleVaultChange));
        this.registerEvent(this.app.vault.on("create", handleVaultChange));
        this.registerEvent(this.app.vault.on("rename", handleVaultChange));
    }

    setRefreshDebouncer(): void {
        this.debRefresh?.cancel();
        this.debRefresh = debounce(
            () => {
                if (this.settings.refreshSourceControl) {
                    this.refresh().catch(console.error);
                }
            },
            this.settings.refreshSourceControlTimer,
            true
        );
    }

    async addFileToGitignore(
        filePath: string,
        isFolder?: boolean
    ): Promise<void> {
        const gitRelativePath = this.gitManager.getRelativeRepoPath(
            filePath,
            true
        );
        // Define an absolute rule that can apply only for this item.
        const gitignoreRule = convertPathToAbsoluteGitignoreRule({
            isFolder,
            gitRelativePath,
        });
        await this.app.vault.adapter.append(
            this.gitManager.getRelativeVaultPath(".gitignore"),
            "\n" + gitignoreRule
        );
        this.app.workspace.trigger("obsidian-git:refresh");
    }

    handleFileMenu(
        menu: Menu,
        file: TAbstractFile | string,
        source: string,
        type: "file-menu" | "obsidian-git:menu"
    ): void {
        this.fileMenuService.handleFileMenu(menu, file, source, type);
    }

    async migrateSettings(): Promise<void> {
        await this.settingsMigration.migrate(this.settings);
    }

    unloadPlugin() {
        this.gitReady = false;
        this._orchestrator.dispatch({ type: "unload" });

        this.syncManager.unload();
        this.editorIntegration.onUnloadPlugin();
        this.automaticsManager.unload();
        this.branchBar?.remove();
        this.statusBar?.remove();
        this.statusBar = undefined;
        this.branchBar = undefined;
        this.gitManager.unload();
        this.promiseQueue.clear();
        this._noticePresenter?.dispose();
        this._noticePresenter = null;
        this._notifSvc = null;
        this.clearPausedAutomaticsResumeTimer();

        for (const interval of this.intervalsToClear) {
            window.clearInterval(interval);
        }
        this.intervalsToClear = [];

        this.debRefresh.cancel();
    }

    onunload() {
        this.unloadPlugin();
        this.syncStateUnsubscribe?.();
        this.syncStateUnsubscribe = undefined;

        console.log("unloading " + this.manifest.name + " plugin");
    }

    async loadSettings() {
        // At first startup, `data` is `null` because data.json does not exist.
        let data = (await this.loadData()) as
            | (ObsidianGitSettings & {
                  lastSyncManifest?: string[];
                  lastSyncManifestSample?: string[];
              })
            | null;
        if (data == null) {
            data = await this.settingsMigration.loadLegacyData();
        }
        //Check for existing settings
        if (data == undefined) {
            data = <ObsidianGitSettings>{ showedMobileNotice: true };
        }

        const legacyManifest = data.lastSyncManifest;
        const legacyManifestSample = data.lastSyncManifestSample;
        if (legacyManifest || legacyManifestSample) {
            await this.syncManifestStore.saveSyncManifest(
                legacyManifest ?? [],
                legacyManifestSample ?? []
            );
        }

        const {
            lastSyncManifest: _legacyManifest,
            lastSyncManifestSample: _legacyManifestSample,
            ...cleanData
        } = data;
        this.settings = mergeSettingsByPriority(DEFAULT_SETTINGS, cleanData);

        if (legacyManifest || legacyManifestSample) {
            await this.saveSettings();
        }
    }

    async saveSettings() {
        if (this.settings.githubToken) {
            this.settings.githubToken = "";
        }
        this.providerSecrets.clearLegacyGitHubTokenCopies();
        await this.saveData({ ...this.settings, githubToken: "" });
    }

    private updateSyncRibbon(state: SyncState): void {
        if (!this.syncRibbonEl) {
            return;
        }
        const providerLabel =
            providerRegistry.describe(state.provider)?.displayName ?? "Sync";
        const icon = state.isSyncing
            ? "refresh-ccw"
            : state.lastError
              ? "alert-circle"
              : state.conflicts.length > 0
                ? "git-merge"
                : !state.isOnline
                  ? "wifi-off"
                  : "git-pull-request";
        const label = state.isSyncing
            ? `Syncing via ${providerLabel}`
            : state.lastError
              ? `Sync error via ${providerLabel}: ${state.lastError}`
              : state.conflicts.length > 0
                ? `${state.conflicts.length} conflict(s) via ${providerLabel}`
                : !state.isOnline
                  ? `${providerLabel} sync offline`
                  : `${providerLabel} sync ready`;
        setIcon(this.syncRibbonEl, icon);
        this.syncRibbonEl.setAttribute("aria-label", label);
        this.syncRibbonEl.setAttribute("title", label);
    }

    get useSimpleGit(): boolean {
        return (
            Platform.isDesktopApp && this.settings.activeSyncProvider === "git"
        );
    }

    private async maybeShowVaultBootstrapOnboarding(): Promise<void> {
        if (
            this.bootstrapOnboardingShown ||
            !this.settings.vaultBootstrapPending
        ) {
            return;
        }

        this.bootstrapOnboardingShown = true;
        this.settings.vaultBootstrapPending = false;
        await this.saveSettings().catch((error) => {
            console.warn(
                "[Git Vault] Failed to clear vaultBootstrapPending:",
                error
            );
        });

        if (
            this.settings.activeSyncProvider === "git" &&
            !this.settings.apiEncryptionEnabled
        ) {
            return;
        }

        const providerLabel =
            providerRegistry.describe(this.settings.activeSyncProvider)
                ?.displayName ?? "Git Vault";
        new VaultBootstrapModal(this.app, {
            mode: "onboarding",
            providerLabel,
            onOpenSettings: () => this.openSyncSettings(),
        }).open();
    }

    private async maybeConsumePendingVaultSyncRequest(): Promise<void> {
        const adapter = this.app.vault.adapter as {
            getBasePath?: () => string;
            basePath?: string;
        };
        const basePath =
            typeof adapter.getBasePath === "function"
                ? adapter.getBasePath()
                : typeof adapter.basePath === "string"
                  ? adapter.basePath
                  : null;
        if (!basePath) {
            return;
        }

        // Pending vault sync window (ms). Exposed for configurability and testing.
        const pending = this.localStorage.takePendingVaultSyncRequestForPath(
            path.resolve(basePath),
            PENDING_VAULT_SYNC_WINDOW_MS
        );
        if (!pending) {
            return;
        }

        if (this.settings.lastSyncedRepoFingerprint !== pending.fingerprint) {
            this.showNotice(
                "Git Vault skipped the queued vault update because the opened vault no longer matches that remote.",
                8000
            );
            return;
        }

        this.showNotice(
            "Git Vault is updating the linked vault that was just opened."
        );
        await this.syncManager
            .syncNow()
            .catch((e: unknown) => this.displayError(e));
    }

    private openSyncSettings(): void {
        // openSyncSettings uses Obsidian's internal, undocumented app.setting API.
        // The type assertion and optional chaining below are a best-effort way to
        // access it safely, but upstream changes may still break this path.
        const settingsHost = this.app as typeof this.app & {
            setting?: {
                open(): void;
                openTabById?: (id: string) => void;
            };
        };
        settingsHost.setting?.open();
        settingsHost.setting?.openTabById?.(this.manifest.id);
    }

    async init({ fromReload = false }): Promise<void> {
        if (this._initInProgress) return;
        this._initInProgress = true;
        try {
            await this._init({ fromReload });
        } finally {
            this._initInProgress = false;
        }
    }

    private async _init({ fromReload = false }): Promise<void> {
        // Signal reload start so orchestrator observers can block operations.
        if (fromReload) {
            this._orchestrator.dispatch({ type: "reload-started" });
        }
        warnOnSettingsInconsistency(this.settings, (...args) =>
            this.log(...args)
        );

        if (this.settings.showStatusBar && !this.statusBar) {
            const statusBarEl = this.addStatusBarItem();
            this.statusBar = new StatusBar(statusBarEl, this);
            this.intervalsToClear.push(
                window.setInterval(() => this.statusBar?.display(), 1000)
            );
        }

        try {
            if (this.useSimpleGit) {
                const { SimpleGit } = await import("./gitManager/simpleGit");
                const gitManager = new SimpleGit(this);
                await gitManager.setGitInstance();
                this.gitManager = gitManager;
            } else {
                this.gitManager = new IsomorphicGit(this);
            }

            const result = await this.gitManager.checkRequirements();
            const pausedAutomatics = this.localStorage.getPausedAutomatics();
            this.syncPausedAutomaticsResumeTimer(
                "Automatic routines resumed after scheduled pause."
            );
            const localGitRepoRequired = requiresLocalGitRepo(
                this.settings.activeSyncProvider
            );
            switch (result) {
                case "missing-git":
                    if (!localGitRepoRequired) {
                        await this.syncManager
                            .init()
                            .catch((e: unknown) => this.displayError(e));
                        await this.maybeShowVaultBootstrapOnboarding();
                        await this.maybeConsumePendingVaultSyncRequest();
                        if (pausedAutomatics) {
                            this.showNotice(
                                "Automatic routines are currently paused."
                            );
                        }
                        this._orchestrator.dispatch(
                            fromReload
                                ? {
                                      type: "reload-finished",
                                      gitAvailable: false,
                                      isSimpleGit: false,
                                  }
                                : {
                                      type: "boot-succeeded",
                                      gitAvailable: false,
                                      isSimpleGit: false,
                                  }
                        );
                        break;
                    }
                    this.displayError(
                        `Cannot run git command. Trying to run: '${this.localStorage.getGitPath() || "git"}' .`
                    );
                    break;
                case "missing-repo":
                    if (!localGitRepoRequired) {
                        await this.syncManager
                            .init()
                            .catch((e: unknown) => this.displayError(e));
                        await this.maybeShowVaultBootstrapOnboarding();
                        await this.maybeConsumePendingVaultSyncRequest();
                        if (pausedAutomatics) {
                            this.showNotice(
                                "Automatic routines are currently paused."
                            );
                        }
                        this._orchestrator.dispatch(
                            fromReload
                                ? {
                                      type: "reload-finished",
                                      gitAvailable: false,
                                      isSimpleGit: false,
                                  }
                                : {
                                      type: "boot-succeeded",
                                      gitAvailable: false,
                                      isSimpleGit: false,
                                  }
                        );
                        break;
                    }
                    this.showNotice(
                        "Can't find a valid git repository. Please create one via the given command or clone an existing repo.",
                        10000
                    );
                    break;
                case "valid":
                    // Enable git-specific features only when git is the active provider.
                    if (this.settings.activeSyncProvider === "git") {
                        this.gitReady = true;
                        // Inform the orchestrator that we are now ready.
                        this._orchestrator.dispatch(
                            fromReload
                                ? {
                                      type: "reload-finished",
                                      gitAvailable: true,
                                      isSimpleGit: this.useSimpleGit,
                                  }
                                : {
                                      type: "boot-succeeded",
                                      gitAvailable: true,
                                      isSimpleGit: this.useSimpleGit,
                                  }
                        );
                        this.setPluginState({
                            gitAction: CurrentGitAction.idle,
                        });

                        if (
                            Platform.isDesktop &&
                            this.settings.showBranchStatusBar &&
                            !this.branchBar
                        ) {
                            const branchStatusBarEl = this.addStatusBarItem();
                            this.branchBar = new BranchStatusBar(
                                branchStatusBarEl,
                                this
                            );
                            this.intervalsToClear.push(
                                window.setInterval(
                                    () =>
                                        void this.branchBar
                                            ?.display()
                                            .catch(console.error),
                                    60000
                                )
                            );
                        }
                        await this.branchBar?.display();

                        this.editorIntegration.onReady();

                        // One-time onboarding hint for editor hunk signs
                        try {
                            const onboardKey =
                                this.manifest.id + ":hunkSignsOnboardShown";
                            const shown = this.app.loadLocalStorage(onboardKey);
                            if (!shown && !this.settings.hunks?.showSigns) {
                                this.showNotice(
                                    "Editor hunk signs are available — run the 'Toggle editor hunk signs' command or enable them in Settings → Git → Sync behavior.",
                                    12000
                                );
                                this.app.saveLocalStorage(onboardKey, "true");
                            }
                        } catch (e) {
                            console.warn(
                                "Error while showing hunk signs onboarding",
                                e
                            );
                        }

                        this.app.workspace.trigger("obsidian-git:refresh");
                        /// Among other things, this notifies the history view that git is ready
                        this.app.workspace.trigger("obsidian-git:head-change");

                        if (
                            !fromReload &&
                            this.settings.autoPullOnBoot &&
                            !pausedAutomatics
                        ) {
                            window.setTimeout(() => {
                                if (this._orchestrator.phase !== "ready") {
                                    return;
                                }
                                void this.promiseQueue.addTask(() =>
                                    this.pullChangesFromRemote()
                                );
                            }, 0);
                        }

                        if (!pausedAutomatics) {
                            await this.automaticsManager.init();
                        }

                        if (pausedAutomatics) {
                            this.showNotice(
                                "Automatic routines are currently paused."
                            );
                        }
                    }

                    // Initialise the provider-agnostic sync layer (runs for all providers)
                    await this.syncManager.init();
                    await this.maybeShowVaultBootstrapOnboarding();
                    await this.maybeConsumePendingVaultSyncRequest();

                    break;
                default:
                    this.log(
                        "Something weird happened. The 'checkRequirements' result is " +
                            /* eslint-disable-next-line @typescript-eslint/restrict-plus-operands */
                            result
                    );
            }
        } catch (error) {
            this.displayError(error);
            console.error(error);
            // Move orchestrator to degraded so observers know init failed.
            const reason =
                error instanceof Error ? error.message : String(error);
            this._orchestrator.dispatch(
                fromReload
                    ? { type: "reload-failed", reason }
                    : { type: "boot-failed", reason }
            );
        }
    }

    async createNewRepo(options?: ICreateRepoOptions) {
        await this.ensureGitManagerForSetup();
        return this.gitOperations.createNewRepo(options);
    }

    async cloneNewRepo(options?: string | ICloneRepoOptions) {
        const cloneOptions: ICloneRepoOptions =
            typeof options === "string"
                ? { remoteUrl: options }
                : options ?? {};
        if (cloneOptions.target === "dedicated-vault") {
            return this.cloneGitRepoAsDedicatedVault(cloneOptions.remoteUrl);
        }

        await this.ensureGitManagerForSetup();
        return this.gitOperations.cloneNewRepo(cloneOptions);
    }

    private async ensureGitManagerForSetup(): Promise<void> {
        // Explicit runtime check for an already-initialized gitManager.
        // Use `!= null` to cover both `undefined` and `null` values.
        if (this.gitManager != null) {
            return;
        }

        if (this.useSimpleGit) {
            const { SimpleGit } = await import("./gitManager/simpleGit");
            const gitManager = new SimpleGit(this);
            await gitManager.setGitInstance(true);
            this.gitManager = gitManager;
            return;
        }

        this.gitManager = new IsomorphicGit(this);
    }

    private getSuggestedGitVaultName(remoteUrl: string): string {
        const trimmedUrl = remoteUrl.trim();
        const repoName = (() => {
            try {
                const parsedUrl = new URL(trimmedUrl);
                return parsedUrl.pathname.split("/").filter(Boolean).pop();
            } catch {
                return trimmedUrl
                    .split(/[:/\\]/u)
                    .filter(Boolean)
                    .pop();
            }
        })();
        const withoutSuffix = (repoName ?? "cloned-vault").replace(
            /\.git$/iu,
            ""
        );
        return this.normalizeVaultName(withoutSuffix);
    }

    private normalizeVaultName(name: string): string {
        const cleaned = name
            .replace(/[^A-Za-z0-9._-]+/gu, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 255);
        return cleaned || "cloned-vault";
    }

    private async cloneGitRepoAsDedicatedVault(
        remoteUrl?: string
    ): Promise<void> {
        if (!Platform.isDesktopApp) {
            this.showNotice(
                "Git Vault: cloning Git into a separate vault is only available on desktop.",
                7000
            );
            return;
        }

        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            this.showNotice(
                "Git Vault: this platform does not expose a desktop filesystem adapter for dedicated vault clone.",
                7000
            );
            return;
        }

        const url =
            remoteUrl?.trim() ||
            (await new GeneralModal(this, {
                placeholder: "Enter remote URL",
            }).openAndGetResult());
        if (!url) return;

        const currentVaultPath = path.resolve(adapter.getBasePath());
        const parentDir = path.dirname(currentVaultPath);
        // Build a safe suggested path: sanitize the suggested vault name to a single basename
        const rawSuggestedName = this.getSuggestedGitVaultName(url);
        let suggestedName = this.normalizeVaultName(rawSuggestedName);

        // Ensure suggestedName is a single basename and contains only safe characters
        suggestedName = path.basename(suggestedName);
        const isSafeSegment = (seg: string) =>
            /^[A-Za-z0-9._-]{1,255}$/.test(seg);
        if (!isSafeSegment(suggestedName)) {
            // Fallback to a deterministic, safe name when normalization produced unsafe characters
            suggestedName = `cloned-vault-${Date.now().toString(36)}`;
        }

        // Helper: validate segments and resolve a canonical path inside `base`.
        // Returns `null` when segments are unsafe or resolution would escape `base`.
        const safeJoinWithin = (
            base: string,
            ...segs: string[]
        ): string | null => {
            for (const s of segs) {
                if (!s || s.includes("\0")) return null;
                if (s === "." || s === ".." || !isSafeSegment(s)) return null;
            }

            // Build the candidate path by concatenating the base and validated
            // segments. Because each segment is guaranteed to not contain any
            // separators or special tokens ('.', '..'), this concatenation cannot
            // produce a path that escapes `base` via traversal tokens.
            const joined = segs.join(path.sep);
            let candidate = base;
            if (!candidate.endsWith(path.sep)) candidate = candidate + path.sep;
            candidate = path.normalize(candidate + joined);

            const rel = path.relative(base, candidate);
            if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
            return candidate;
        };
        const safeResolveAbsolute = (absolutePath: string): string | null => {
            const parsed = path.parse(absolutePath);
            const relativePortion = absolutePath.slice(parsed.root.length);
            const segs = relativePortion
                .split(path.sep)
                .filter((s) => s.length > 0);
            for (const s of segs) {
                if (!s || s.includes("\0")) return null;
                if (s === "." || s === ".." || !isSafeSegment(s)) return null;
            }
            return path.resolve(parsed.root, ...segs);
        };

        const suggestedPath =
            safeJoinWithin(parentDir, suggestedName) ||
            path.resolve(parentDir, `cloned-vault-${Date.now().toString(36)}`);
        const requestedPath = await new GeneralModal(this, {
            placeholder:
                "Choose a folder for the cloned vault (absolute path or sibling name)",
            initialValue: suggestedPath,
        }).openAndGetResult();
        if (!requestedPath) return;

        // Basic input hygiene
        if (requestedPath.includes("\0")) {
            this.showNotice(
                "Git Vault: invalid characters in target path.",
                7000
            );
            return;
        }

        // Normalize and split relative user input into segments **before**
        // constructing any filesystem path. Absolute paths are validated and
        // resolved from their own filesystem root so the modal's absolute-path
        // affordance is honored.
        const requestedPathNormalized = path.normalize(requestedPath);
        const requestedPathIsAbsolute = path.isAbsolute(
            requestedPathNormalized
        );

        // Remove leading/trailing separators and split into path segments.
        const rawSegments = requestedPathNormalized
            .split(path.sep)
            .filter((s) => s.length > 0);

        const candidatePath = requestedPathIsAbsolute
            ? safeResolveAbsolute(requestedPathNormalized)
            : safeJoinWithin(parentDir, ...rawSegments);
        if (!candidatePath) {
            this.showNotice(
                "Git Vault: target path contains invalid or unsafe path segments.",
                7000
            );
            return;
        }

        // Canonical target directory (validated and ensured to be inside parentDir)
        const targetDir = candidatePath;

        // Sanitize: relative targets are constrained to the open vault's parent;
        // absolute targets were validated from their own root above.
        if (
            !requestedPathIsAbsolute &&
            !(
                targetDir === parentDir ||
                targetDir.startsWith(parentDir + path.sep)
            )
        ) {
            this.showNotice(
                "Git Vault: invalid vault target path. Please select a location inside the project directory.",
                7000
            );
            return;
        }

        if (
            targetDir === currentVaultPath ||
            targetDir.startsWith(`${currentVaultPath}${path.sep}`) ||
            currentVaultPath.startsWith(`${targetDir}${path.sep}`)
        ) {
            this.showNotice(
                "Git Vault: separate vault clone must target a directory outside the currently open vault.",
                7000
            );
            return;
        }

        try {
            const stat = await fsPromises.stat(targetDir);
            if (stat.isDirectory()) {
                const entries = await fsPromises.readdir(targetDir);
                if (entries.length > 0) {
                    this.showNotice(
                        "Git Vault: target directory already exists and is not empty.",
                        7000
                    );
                    return;
                }
            } else {
                this.showNotice(
                    "Git Vault: target path exists and is not a directory.",
                    7000
                );
                return;
            }
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                (error as NodeJS.ErrnoException).code !== "ENOENT"
            ) {
                throw error;
            }
            await fsPromises.mkdir(path.dirname(targetDir), {
                recursive: true,
            });
        }

        const depth = await new GeneralModal(this, {
            placeholder: "Specify depth of clone. Leave empty for full clone.",
            allowEmpty: true,
        }).openAndGetResult();
        if (depth === undefined) {
            this.showNotice("Aborted clone");
            return;
        }

        let depthInt: number | undefined;
        if (depth !== "") {
            depthInt = parseInt(depth, 10);
            if (isNaN(depthInt) || depthInt <= 0) {
                this.showNotice("Invalid depth. Aborting clone.");
                return;
            }
        }

        const progressModal = new SetupProgressModal(
            this.app,
            "Cloning Git vault"
        );
        progressModal.open();

        try {
            progressModal.setStatus("Cloning repo...");
            const args = ["clone"];
            if (depthInt) {
                args.push("--depth", `${depthInt}`);
            }
            args.push(formatRemoteUrl(url), targetDir);
            const result = await spawnAsync(
                this.localStorage.getGitPath() || "git",
                args,
                { cwd: parentDir }
            );
            if (result.error || result.code !== 0) {
                const rawStdErr = result.stderr ?? "";
                const rawErrMsg = result.error?.message ?? "";
                const sanitizedStdErr = sanitizeUrl(rawStdErr).trim();
                const sanitizedErrMsg = sanitizeUrl(rawErrMsg).trim();
                if (sanitizedStdErr || sanitizedErrMsg) {
                    throw new Error(sanitizedStdErr || sanitizedErrMsg);
                }
                throw new Error(`git clone exited with code ${result.code}`);
            }

            const bootstrapService = new VaultBootstrapService(this);
            const bootstrapResult =
                await bootstrapService.bootstrapDedicatedVault(
                    targetDir,
                    (message) => progressModal.setStatus(message)
                );

            progressModal.close();
            new VaultBootstrapModal(this.app, {
                mode: "success",
                vaultPath: bootstrapResult.vaultPath,
                registeredInSwitcher: bootstrapResult.registeredInSwitcher,
                onOpenVault: () =>
                    bootstrapService.openVault(bootstrapResult.vaultPath),
            }).open();
            this.showNotice(`Cloned Git repo into ${targetDir}.`, 7000);
        } catch (error) {
            const rawMessage =
                error instanceof Error ? error.message : String(error);
            const message = sanitizeUrl(rawMessage);
            console.error(
                "[Git Vault] Git dedicated vault clone failed:",
                message
            );
            progressModal.markFailed(`Git Vault: clone failed - ${message}`);
            this.showNotice(`Git Vault: clone failed - ${message}`, 9000);
        }
    }

    async ensureSensitiveVaultGitignore(): Promise<void> {
        await this.vaultBootstrap.ensureSensitiveCurrentVaultGitignore();
    }

    /**
     * Returns whether the git manager is ready without triggering any
     * side-effecting re-initialisation.  Commands should simply return early
     * when this is `false` rather than attempting to re-init mid-flight.
     */
    isAllInitialized(): Promise<boolean> {
        return Promise.resolve(
            this.gitReady && !this._initInProgress && this.gitManager != null
        );
    }

    ///Used for command
    async pullChangesFromRemote(): Promise<void> {
        return this.gitOperations.pullChangesFromRemote();
    }

    async commitAndSync(args: ICommitAndSyncArgs): Promise<void> {
        return this.gitOperations.commitAndSync(args);
    }

    async commit(args: ICommitArgs): Promise<boolean> {
        return this.gitOperations.commit(args);
    }

    async push(): Promise<boolean> {
        return this.gitOperations.push();
    }

    async pull(): Promise<
        | { success: true; filesChanged: number }
        | { success: false; reason?: string }
    > {
        return this.gitOperations.pull();
    }

    async fetch(): Promise<void> {
        return this.gitOperations.fetch();
    }

    async mayDeleteConflictFile(): Promise<void> {
        return this.conflictCoordinator.mayDeleteConflictFile();
    }

    async stageFile(file: TFile): Promise<boolean> {
        return this.gitOperations.stageFile(file);
    }

    async unstageFile(file: TFile): Promise<boolean> {
        return this.gitOperations.unstageFile(file);
    }

    async switchBranch(): Promise<string | undefined> {
        // Busy guard: reject if a sync or git operation is already running.
        if (
            this.state.gitAction !== CurrentGitAction.idle ||
            this.syncState.getState().isSyncing
        ) {
            this.displayError(
                "Branch switching is not available while another operation is running."
            );
            return;
        }

        const selection = await this.syncManager.getBranchSelection();
        if (selection.branches.length === 0) {
            this.displayError("No branches are available yet.");
            return;
        }

        const { BranchModal } = await import("./ui/modals/branchModal");
        const selectedBranch = await new BranchModal(
            { app: this.app },
            selection.branches
        ).openAndGetResult();
        if (
            selectedBranch === undefined ||
            selectedBranch === selection.current
        ) {
            return selectedBranch;
        }

        const switched = await this.syncManager.switchBranch(selectedBranch);
        if (!switched) {
            return;
        }

        if (this.settings.activeSyncProvider === "git") {
            this.displayMessage(`Switched to ${selectedBranch}`);
            await this.notifyIfNonDefaultTrackingBranch();
        } else {
            this.displayMessage(
                `Switched sync target to "${selectedBranch}" and updated the local vault.`
            );
        }

        this.refreshWorkspace();
        await this.branchBar?.display();
        return selectedBranch;
    }

    async switchRemoteBranch(): Promise<string | undefined> {
        return this.branchRemote.switchRemoteBranch();
    }

    async createBranch(): Promise<string | undefined> {
        return this.branchRemote.createBranch();
    }

    async deleteBranch(): Promise<string | undefined> {
        return this.branchRemote.deleteBranch();
    }

    async remotesAreSet(): Promise<boolean> {
        return this.branchRemote.remotesAreSet();
    }

    async setUpstreamBranch(): Promise<boolean> {
        return this.branchRemote.setUpstreamBranch();
    }

    async discardAll(path?: string) {
        return this.gitOperations.discardAll(path);
    }

    async handleConflict(conflicted?: string[]): Promise<void> {
        return this.conflictCoordinator.handleConflict(conflicted);
    }

    async editRemotes(): Promise<string | undefined> {
        return this.branchRemote.editRemotes();
    }

    async selectRemoteBranch(): Promise<string | undefined> {
        return this.branchRemote.selectRemoteBranch();
    }

    async removeRemote() {
        return this.branchRemote.removeRemote();
    }

    onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        this.workspaceSelectionSync.onActiveLeafChange(leaf);
    }

    handleNoNetworkError(error: NoNetworkError): void {
        this.conflictCoordinator.handleNoNetworkError(error);
    }

    // region: displaying / formatting messages

    /**
     * Encrypt a single vault file in-place using the stored passphrase.
     */
    async encryptSingleFile(file: TFile): Promise<boolean> {
        return this.vaultEncryption.encryptFile(file);
    }

    /**
     * Decrypt a single vault file in-place using the stored passphrase.
     */
    async decryptSingleFile(file: TFile): Promise<boolean> {
        return this.vaultEncryption.decryptFile(file);
    }

    showNotice(message: string, timeout?: number): INoticeHandle {
        return this.noticePresenter.show(message, timeout);
    }

    makeSyncNotice(msg: string, timeout?: number): void {
        this.notifSvc.info(msg, { timeout, forceToast: true });
    }

    displayMessage(
        message: string,
        timeout: number = 4 * 1000,
        opts: Pick<NotifOptions, "isNoChanges"> = {}
    ): void {
        this.notifSvc.info(message, { timeout, ...opts });
    }

    displayError(data: unknown, timeout: number = 10 * 1000): void {
        // isomorphic-git cancellation — show brief "Aborted" toast and exit.
        if (data instanceof Errors.UserCanceledError) {
            this.notifSvc.info("Aborted", { timeout: 5_000, forceToast: true });
            return;
        }
        this.setPluginState({ gitAction: CurrentGitAction.idle });
        this.notifSvc.error(data, { timeout });
    }

    log(...data: unknown[]) {
        console.log("%s:", this.manifest.id, ...data);
    }

    /**
     * Lazy getter for the notification service.
     * Safe to call at any point after field initialization; settings are read
     * lazily through closures so no ordering dependency on `loadSettings()`.
     */
    private get notifSvc(): NotificationService {
        if (!this._notifSvc) {
            this._notifSvc = new NotificationService(
                this._makeNoticeFactory(),
                this._makeNotificationHost()
            );
        }
        return this._notifSvc;
    }

    private get noticePresenter(): INoticePresenter {
        if (!this._noticePresenter) {
            this._noticePresenter = new BottomCenterNoticePresenter(this.app);
        }
        return this._noticePresenter;
    }

    private _makeNoticeFactory(): INoticeFactory {
        return {
            create: (message, duration) =>
                this.noticePresenter.show(message, duration),
        };
    }

    private _makeNotificationHost() {
        // Arrow functions capture `this` so no `self` alias is needed.
        const getSettings = () => this.settings;
        const getStatusBar = () => this.statusBar;
        const pluginId = this.manifest.id;
        return {
            get disablePopups() {
                return getSettings()?.disablePopups ?? false;
            },
            get disablePopupsForNoChanges() {
                return getSettings()?.disablePopupsForNoChanges ?? false;
            },
            get showErrorNotices() {
                return getSettings()?.showErrorNotices ?? true;
            },
            get statusBar() {
                return getStatusBar();
            },
            pluginId,
        };
    }
}
