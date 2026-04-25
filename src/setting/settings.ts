import type {
    App,
    TextComponent,
    DropdownComponent,
    Debouncer,
} from "obsidian";
import {
    debounce,
    Platform,
    PluginSettingTab,
    Setting,
    TextAreaComponent,
} from "obsidian";
import { DEFAULT_SETTINGS } from "src/constants";
import type ObsidianGit from "src/main";
import type { IPluginContext } from "src/pluginContext";
import { ConflictHistoryModal } from "src/syncProvider/conflictHistory";
import type { ObsidianGitSettings } from "src/types";
import { splitRemoteBranch } from "src/utils";
import { SettingsPersistenceService } from "./controller/settingsPersistenceService";
import { TargetChangeController } from "./controller/targetChangeController";
import { RepoBindingService } from "./policy/repoBindingService";
import { ProviderBootstrapPolicy } from "./policy/providerBootstrapPolicy";
import { ApiRemoteTargetWorkflow } from "./policy/apiRemoteTargetWorkflow";
import { ProviderCredentialStore } from "./infra/providerCredentialStore";
import { GitHubApiClient } from "./infra/githubApiClient";
import { GitLabApiClient } from "./infra/gitlabApiClient";
import { GiteaApiClient } from "./infra/giteaApiClient";
import { renderHistorySection } from "./sections/ui/historySection";
import { renderSourceControlSection } from "./sections/ui/sourceControlSection";
import { renderAppearanceSection } from "./sections/ui/appearanceSection";
import { renderCommitAuthorSection } from "./sections/ui/commitAuthorSection";
import { renderGitBackendSection } from "./sections/ui/gitBackendSection";
import { renderGitHubProviderSection } from "./sections/ui/githubProviderSection";
import { renderGitLabProviderSection } from "./sections/ui/gitlabProviderSection";
import { renderGiteaProviderSection } from "./sections/ui/giteaProviderSection";
import { renderApiProviderSection } from "./sections/ui/apiProviderSection";
import { renderSyncBehaviorSection } from "./sections/ui/syncBehaviorSection";
import { renderAutomaticSection } from "./sections/ui/automaticSection";
import { renderCommitMessageSection } from "./sections/ui/commitMessageSection";
import { renderPullSection } from "./sections/ui/pullSection";
import { renderLineAuthorSection } from "./sections/ui/lineAuthorSection";
import { renderAdvancedSection } from "./sections/ui/advancedSection";
import type {
    AppearanceSectionContext,
    CommitAuthorSectionContext,
    GitHubProviderSectionContext,
    GiteaProviderSectionContext,
    GitLabProviderSectionContext,
    HistorySectionContext,
    ProviderSectionContext,
    SourceControlSectionContext,
} from "./sections/renderContext";

// Minimal GitHub API types used in this settings UI. Kept narrow to avoid
// importing or depending on a large external type package.
interface GitHubUser {
    login?: string;
}

type SubmoduleCapableGitManager = {
    addSubmodule(url: string, submodulePath: string): Promise<void>;
};

function isSubmoduleCapableGitManager(
    value: unknown
): value is SubmoduleCapableGitManager {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as { addSubmodule?: unknown };
    return typeof candidate.addSubmodule === "function";
}

export class ObsidianGitSettingsTab extends PluginSettingTab {
    /** Persists the search query across display() re-renders. */
    private _settingsSearchQuery = "";
    /**
     * Stored as the narrow {@link IPluginContext} interface so that extracted
     * service modules and unit tests can depend on the interface, not the
     * concrete `ObsidianGit` class.  The constructor still accepts `ObsidianGit`
     * so Obsidian's `super(app, plugin)` call compiles.
     */
    private plugin!: IPluginContext;
    /** Serialises save → reload → redraw sequences across concurrent UI callbacks. */
    private _persistence!: SettingsPersistenceService;
    private _repoBinding!: RepoBindingService;
    private _bootstrapPolicy!: ProviderBootstrapPolicy;
    private _apiRemoteTargetWorkflow!: ApiRemoteTargetWorkflow;
    private _credentialStore!: ProviderCredentialStore;
    private _ghClient!: GitHubApiClient;
    private _gitlabClient!: GitLabApiClient;
    private _giteaClient!: GiteaApiClient;
    private _settingsSearchDebouncer?: Debouncer<[string], void>;
    private _pendingApiTargetPromptTimer?: number;
    private _activeApiTargetPromptFingerprint: string | null = null;
    private _lastAutoPromptedApiFingerprint: string | null = null;
    constructor(app: App, plugin: ObsidianGit) {
        super(app, plugin);
        // ObsidianGit satisfies IPluginContext structurally.
        this.plugin = plugin;
        this._persistence = new SettingsPersistenceService(
            plugin,
            () => this.reloadSyncManager(),
            () => this.refreshDisplayWithDelay()
        );
        // Wire extracted service instances.
        this._repoBinding = new RepoBindingService(
            plugin,
            () => this.concretePlugin,
            () => this.reloadSyncManager(),
            () => this.refreshDisplayWithDelay()
        );
        this._bootstrapPolicy = new ProviderBootstrapPolicy(
            plugin,
            () => this.concretePlugin,
            this._repoBinding,
            () => this.reloadSyncManager()
        );
        this._apiRemoteTargetWorkflow = new ApiRemoteTargetWorkflow(
            plugin,
            () => this.concretePlugin,
            this._repoBinding,
            () => this.runProviderBootstrapOrSync(),
            () => this.importActiveApiRepoAsDedicatedVault(),
            () => this.resetEncryptionBindingForCurrentRepo()
        );
        this._credentialStore = new ProviderCredentialStore(
            plugin.providerSecrets,
            plugin.localStorage
        );
        const showNotice = (message: string, duration?: number): void => {
            this.concretePlugin.showNotice(message, duration);
        };
        this._ghClient = new GitHubApiClient(
            () => this.plugin.providerSecrets.getToken("github") ?? "",
            showNotice
        );
        this._gitlabClient = new GitLabApiClient(
            () => this.plugin.settings.gitlabBaseUrl,
            () => this.plugin.providerSecrets.getToken("gitlab") ?? "",
            showNotice
        );
        this._giteaClient = new GiteaApiClient(
            () => this.plugin.settings.giteaBaseUrl,
            () => this.plugin.providerSecrets.getToken("gitea") ?? "",
            showNotice
        );
    }

    private readonly rebaselineRequiredFingerprint =
        "__sync-pro:rebaseline-required__";

    /**
     * Mark that a rebaseline is required by setting `lastSyncedRepoFingerprint`
     * and clearing the external sync manifest store, then persist the change
     * via `this.plugin.saveSettings()` so callers don't need to remember to
     * save.
     */
    private markSyncBaselineRequired(): Promise<void> {
        return this._repoBinding.markSyncBaselineRequired();
    }

    private getCurrentRepoEncryptionBindingState(): {
        currentRepoFingerprint: string | null;
        storedRepoFingerprint: string;
        storedPassphraseFingerprint: string;
        appliesToCurrentRepo: boolean;
    } {
        return this._repoBinding.getCurrentRepoEncryptionBindingState();
    }

    private validateEncryptionPassphraseForCurrentRepo(
        passphrase: string,
        options?: { treatAsEnabled?: boolean }
    ): Promise<string | null> {
        return this._repoBinding.validateEncryptionPassphraseForCurrentRepo(
            passphrase,
            options
        );
    }

    private resetEncryptionBindingForCurrentRepo(): Promise<void> {
        return this._repoBinding.resetEncryptionBindingForCurrentRepo();
    }

    private requestGitHubApi<T = unknown>(path: string): Promise<T | null> {
        return this._ghClient.request<T>(path);
    }
    private setDropdownOptions(
        dd: DropdownComponent | undefined,
        options: Record<string, string>,
        selected?: string
    ): string {
        const normalizedSelected =
            selected && Object.prototype.hasOwnProperty.call(options, selected)
                ? selected
                : "";
        if (!dd) return normalizedSelected;
        // If the underlying select element exists, replace its options to
        // avoid duplications; otherwise fall back to the component API.
        if (dd.selectEl instanceof HTMLSelectElement) {
            const select = dd.selectEl;
            select.innerHTML = "";
            for (const [value, label] of Object.entries(options)) {
                const opt = document.createElement("option");
                opt.value = value;
                opt.text = label;
                select.appendChild(opt);
            }
            dd.setValue(normalizedSelected);
            return normalizedSelected;
        }
        // Type guard for removeAllOptions
        type DropdownWithRemoveAll = DropdownComponent & {
            removeAllOptions?: () => void;
        };
        const ddWithRemoveAll = dd as DropdownWithRemoveAll;
        if (typeof ddWithRemoveAll.removeAllOptions === "function") {
            ddWithRemoveAll.removeAllOptions();
        }
        dd.addOptions(options);
        dd.setValue(normalizedSelected);
        return normalizedSelected;
    }

    private fetchGitHubRepos(owner: string): Promise<Record<string, string>> {
        return this._ghClient.fetchRepos(owner);
    }

    private fetchGitHubBranches(
        owner: string,
        repo: string
    ): Promise<Record<string, string>> {
        return this._ghClient.fetchBranches(owner, repo);
    }

    private fetchGitLabProjects(): Promise<Record<string, string>> {
        return this._gitlabClient.fetchProjects();
    }

    private fetchGitLabBranches(
        projectId: string
    ): Promise<Record<string, string>> {
        return this._gitlabClient.fetchBranches(projectId);
    }

    private requestGitLabUser(): Promise<{
        username?: string;
        name?: string;
    } | null> {
        return this._gitlabClient.requestUser();
    }

    private fetchGiteaRepos(owner: string): Promise<Record<string, string>> {
        return this._giteaClient.fetchRepos(owner);
    }

    private fetchGiteaBranches(
        owner: string,
        repo: string
    ): Promise<Record<string, string>> {
        return this._giteaClient.fetchBranches(owner, repo);
    }

    private requestGiteaUser(): Promise<{
        login?: string;
        fullName?: string;
    } | null> {
        return this._giteaClient.requestUser();
    }

    private getStoredGitHttpUsername(): string {
        return this._credentialStore.getUsername();
    }

    private setStoredGitHttpUsername(username: string): void {
        this._credentialStore.setUsername(username);
        this._credentialStore.migrateToSecretStorage();
    }

    private getStoredGitHttpPassword(): string {
        return this._credentialStore.getPassword();
    }

    private setStoredGitHttpPassword(password: string): void {
        this._credentialStore.setPassword(password);
        this._credentialStore.migrateToSecretStorage();
    }

    private detectObsidianSymlinkIssue(): Promise<string | null> {
        return this._bootstrapPolicy.detectObsidianSymlinkIssue();
    }

    private runProviderBootstrapOrSync(): Promise<void> {
        return this._bootstrapPolicy.runProviderBootstrapOrSync();
    }

    private importActiveApiRepoAsDedicatedVault(): Promise<void> {
        return this._bootstrapPolicy.importActiveApiRepoAsDedicatedVault();
    }

    private runApiRemoteTargetWorkflow(): Promise<void> {
        return this._apiRemoteTargetWorkflow.run();
    }

    private isMissingHeadError(error: unknown): boolean {
        return (
            error instanceof Error &&
            error.message.toLowerCase().includes("could not find head")
        );
    }

    private async getGitSyncSettingsState(plugin: ObsidianGit): Promise<{
        repoReady: boolean;
        headReady: boolean;
        currentBranch?: string;
        tracking?: string;
        branches: string[];
        remotes: string[];
        remoteName: string;
        remoteUrl: string;
    }> {
        const remotes = plugin.gitReady
            ? await plugin.gitManager.getRemotes().catch(() => [])
            : [];

        let currentBranch: string | undefined;
        let tracking: string | undefined;
        let branches: string[] = [];
        let headReady = false;

        if (plugin.gitReady) {
            try {
                const info = await plugin.gitManager.branchInfo();
                currentBranch = info.current;
                tracking = info.tracking;
                branches = info.branches ?? [];
                headReady = true;
            } catch (error) {
                if (!this.isMissingHeadError(error)) {
                    throw error;
                }
            }
        }

        const [trackingRemote] = tracking ? splitRemoteBranch(tracking) : [];
        const remoteName = trackingRemote ?? remotes[0] ?? "origin";
        const remoteUrl =
            plugin.gitReady && remoteName
                ? (await plugin.gitManager
                      .getRemoteUrl(remoteName)
                      .catch(() => undefined)) ?? ""
                : "";

        return {
            repoReady: plugin.gitReady,
            headReady,
            currentBranch,
            tracking,
            branches,
            remotes,
            remoteName,
            remoteUrl,
        };
    }

    icon = "git-pull-request";

    private get settings() {
        return this.plugin.settings;
    }

    private get concretePlugin(): ObsidianGit {
        return this.plugin as unknown as ObsidianGit;
    }

    onClose(): void {
        this._settingsSearchDebouncer?.cancel();
        if (this._pendingApiTargetPromptTimer !== undefined) {
            window.clearTimeout(this._pendingApiTargetPromptTimer);
            this._pendingApiTargetPromptTimer = undefined;
        }
    }

    private isSettingsTabVisible(): boolean {
        const container = this.containerEl;
        return (
            document.body.contains(container) && container.offsetParent !== null
        );
    }

    display(): void {
        const { containerEl } = this;
        const concretePlugin = this.concretePlugin;
        const plugin = concretePlugin;
        const settingsPlugin = this.plugin;
        const gitReady = concretePlugin.gitReady;
        const activeProvider = plugin.settings.activeSyncProvider;
        const usingGitBackend = activeProvider === "git";
        const baseSettingsSectionContext =
            this.createBaseSettingsSectionContext();

        containerEl.empty();

        this._settingsSearchDebouncer?.cancel();
        this._settingsSearchDebouncer = debounce(
            (value: string) => {
                this._settingsSearchQuery = value;
                this._applySettingsFilter(containerEl, value);
            },
            125,
            false
        );

        // ── Search bar ──────────────────────────────────────────────────────
        const searchWrap = containerEl.createDiv(
            "obsidian-git-settings-search"
        );
        const searchInput = searchWrap.createEl("input", {
            type: "text",
            placeholder: "Search settings…",
            cls: "obsidian-git-settings-search-input",
        });
        searchInput.value = this._settingsSearchQuery;

        searchInput.addEventListener("input", () => {
            this._settingsSearchDebouncer?.(searchInput.value);
        });

        new Setting(containerEl)
            .setName("Sync setup")
            .setDesc(
                "Choose the interface mode, sync backend, and provider connection for this vault."
            )
            .setHeading();
        new Setting(containerEl)
            .setName("Interface mode")
            .setDesc(
                "Simple: one-button Sync panel with no Git terminology. Advanced: full Git staging/commit/diff UI."
            )
            .addDropdown((dd) => {
                dd.addOptions({ simple: "Simple", advanced: "Advanced" });
                dd.setValue(plugin.settings.syncMode);
                dd.onChange(async (v) => {
                    plugin.settings.syncMode =
                        v as ObsidianGitSettings["syncMode"];
                    await plugin.saveSettings();
                    plugin.app.workspace.trigger(
                        "obsidian-git:sync-mode-changed",
                        plugin.settings.syncMode
                    );
                });
            });

        new Setting(containerEl)
            .setName("Sync backend")
            .setDesc(
                "Git uses the local repository. The API backends sync directly against GitHub, GitLab, or Gitea/Forgejo without requiring Git on the device."
            )
            .addDropdown((dd) => {
                dd.addOptions({
                    git: "Git",
                    github: "GitHub API",
                    gitlab: "GitLab API",
                    gitea: "Gitea / Forgejo API",
                });
                dd.setValue(plugin.settings.activeSyncProvider);
                dd.onChange(async (v) => {
                    await this._persistence.commit(
                        "activeSyncProvider",
                        v as ObsidianGitSettings["activeSyncProvider"]
                    );
                    plugin.app.workspace.trigger(
                        "obsidian-git:sync-provider-changed",
                        v as ObsidianGitSettings["activeSyncProvider"]
                    );
                });
            });

        if (activeProvider === "git") {
            renderGitBackendSection({
                containerEl,
                plugin,
                refreshDisplayWithDelay: () => this.refreshDisplayWithDelay(),
                reloadSyncManager: () => this.reloadSyncManager(),
                getGitSyncSettingsState: (currentPlugin: ObsidianGit) =>
                    this.getGitSyncSettingsState(currentPlugin),
                setDropdownOptions: (dd, options, selected) =>
                    this.setDropdownOptions(dd, options, selected),
                getStoredGitHttpUsername: () => this.getStoredGitHttpUsername(),
                setStoredGitHttpUsername: (username: string) =>
                    this.setStoredGitHttpUsername(username),
                getStoredGitHttpPassword: () => this.getStoredGitHttpPassword(),
                setStoredGitHttpPassword: (password: string) =>
                    this.setStoredGitHttpPassword(password),
            });
        }

        if (activeProvider === "github") {
            const githubProviderContext: GitHubProviderSectionContext = {
                ...this.createProviderSectionContext("github"),
                requestUser: () => this.requestGitHubApi<GitHubUser>("/user"),
                fetchRepos: (owner: string) => this.fetchGitHubRepos(owner),
                fetchBranches: (owner: string, repo: string) =>
                    this.fetchGitHubBranches(owner, repo),
                createRepo: async (owner: string, repoName: string) => {
                    const user =
                        await this.requestGitHubApi<GitHubUser>("/user");
                    const authenticatedLogin = user?.login ?? owner;

                    // If the user lookup failed (null) or returned a different
                    // login than the owner parameter, emit a clear warning so
                    // callers/users are not confused when the repo is created
                    // under `owner` rather than the authenticated account.
                    const login =
                        typeof user?.login === "string"
                            ? user.login.trim()
                            : "";
                    if (!login || login !== owner) {
                        const msg =
                            user == null
                                ? `Warning: GitHub authenticated user lookup (/user) failed; proceeding using owner="${owner}" for repo creation.`
                                : !login
                                  ? `Warning: authenticated GitHub login is missing; proceeding using owner="${owner}" for repo creation.`
                                  : `Warning: authenticated GitHub login "${login}" differs from requested owner "${owner}"; proceeding using owner for repo creation.`;
                        const logger = this.concretePlugin?.logger as
                            | Record<string, unknown>
                            | undefined;
                        if (logger && typeof logger.warn === "function") {
                            (logger.warn as (...args: unknown[]) => void)(msg);
                        } else if (
                            logger &&
                            typeof logger.debug === "function"
                        ) {
                            (logger.debug as (...args: unknown[]) => void)(msg);
                        } else {
                            console.warn(msg);
                        }
                    }

                    return this._ghClient.createRepo(
                        owner,
                        repoName,
                        authenticatedLogin
                    );
                },
                setDropdownOptions: (dd, options, selected) =>
                    this.setDropdownOptions(dd, options, selected),
                showNotice: (message: string, timeout?: number) =>
                    plugin.showNotice(message, timeout),
            };
            renderGitHubProviderSection(githubProviderContext);
        }

        if (activeProvider === "gitlab") {
            const gitLabProviderContext: GitLabProviderSectionContext = {
                ...this.createProviderSectionContext("gitlab"),
                requestUser: () => this.requestGitLabUser(),
                fetchProjects: () => this.fetchGitLabProjects(),
                fetchBranches: (projectId: string) =>
                    this.fetchGitLabBranches(projectId),
                getProject: (projectId: string) =>
                    this._gitlabClient.getProject(projectId),
                createProject: (name: string) =>
                    this._gitlabClient.createProject(name),
                setDropdownOptions: (dd, options, selected) =>
                    this.setDropdownOptions(dd, options, selected),
                showNotice: (message: string, timeout?: number) =>
                    plugin.showNotice(message, timeout),
            };
            renderGitLabProviderSection(gitLabProviderContext);
        }

        if (activeProvider === "gitea") {
            const giteaProviderContext: GiteaProviderSectionContext = {
                ...this.createProviderSectionContext("gitea"),
                requestUser: () => this.requestGiteaUser(),
                fetchRepos: (owner: string) => this.fetchGiteaRepos(owner),
                fetchBranches: (owner: string, repo: string) =>
                    this.fetchGiteaBranches(owner, repo),
                createRepo: (repoName: string) =>
                    this._giteaClient.createRepo(repoName),
                setDropdownOptions: (dd, options, selected) =>
                    this.setDropdownOptions(dd, options, selected),
                showNotice: (message: string, timeout?: number) =>
                    plugin.showNotice(message, timeout),
            };
            renderGiteaProviderSection(giteaProviderContext);
        }

        if (!usingGitBackend) {
            renderApiProviderSection({
                containerEl,
                plugin,
                runApiRemoteTargetWorkflow: () =>
                    this.runApiRemoteTargetWorkflow(),
                markSyncBaselineRequired: () => this.markSyncBaselineRequired(),
                reloadSyncManager: () => this.reloadSyncManager(),
                validateEncryptionPassphraseForCurrentRepo: (
                    passphrase: string,
                    options?: { treatAsEnabled?: boolean }
                ) =>
                    this.validateEncryptionPassphraseForCurrentRepo(
                        passphrase,
                        options
                    ),
                persistAndReloadSyncAndRedraw: () =>
                    this.persistAndReloadSyncAndRedraw(),
            });
        }

        renderSyncBehaviorSection({
            containerEl,
            plugin,
            openConflictHistory: async () => {
                new ConflictHistoryModal(
                    plugin,
                    await plugin.syncManager.getConflictHistory()
                ).open();
            },
            persistAndReloadSyncAndRedraw: () =>
                this.persistAndReloadSyncAndRedraw(),
            persistAndReloadSync: () =>
                this._persistence.persistAndReloadSync(),
        });

        if (usingGitBackend && gitReady) {
            new Setting(containerEl)
                .setName("Git workflow")
                .setDesc(
                    "Configure Git-specific pull, commit, history, and file-authoring behaviour."
                )
                .setHeading();

            renderPullSection({
                containerEl,
                plugin: concretePlugin,
                refreshDisplayWithDelay: () => this.refreshDisplayWithDelay(),
            });

            renderAutomaticSection({
                containerEl,
                plugin: concretePlugin,
                mayDisableSetting: (setting: Setting, disable: boolean) =>
                    this.mayDisableSetting(setting, disable),
                setNonDefaultValue: (args: {
                    settingsProperty: keyof ObsidianGitSettings;
                    text: TextComponent | TextAreaComponent;
                }) => this.setNonDefaultValue(args),
                refreshDisplayWithDelay: () => this.refreshDisplayWithDelay(),
            });

            renderCommitMessageSection({
                containerEl,
                plugin: concretePlugin,
                setNonDefaultValue: (args: {
                    settingsProperty: keyof ObsidianGitSettings;
                    text: TextComponent | TextAreaComponent;
                }) => this.setNonDefaultValue(args),
            });

            const commitAuthorSectionContext: CommitAuthorSectionContext = {
                ...baseSettingsSectionContext,
                gitReady: concretePlugin.gitReady,
                getConfig: (key: string) =>
                    concretePlugin.gitManager.getConfig(key),
                setConfig: (key: string, value: string | undefined) =>
                    concretePlugin.gitManager.setConfig(key, value),
            };
            void renderCommitAuthorSection(commitAuthorSectionContext).catch(
                (error: unknown) => {
                    console.error(
                        "Failed to render commit author section in renderCommitAuthorSection",
                        { error, commitAuthorSectionContext }
                    );
                    concretePlugin.displayError(
                        "Failed to render commit author section"
                    );
                }
            );

            const sourceControlSectionContext: SourceControlSectionContext = {
                ...baseSettingsSectionContext,
                setNonDefaultValue: (args: {
                    settingsProperty: keyof ObsidianGitSettings;
                    text: TextComponent | TextAreaComponent;
                }) => this.setNonDefaultValue(args),
                updateRefreshDebouncer: () =>
                    settingsPlugin.setRefreshDebouncer(),
            };
            renderSourceControlSection(sourceControlSectionContext);

            const historySectionContext: HistorySectionContext = {
                ...baseSettingsSectionContext,
                refreshPlugin: () => settingsPlugin.refresh(),
            };
            renderHistorySection(historySectionContext);

            renderLineAuthorSection({
                containerEl,
                plugin: concretePlugin,
                configureLineAuthorShowStatus: (show: boolean) =>
                    this.configureLineAuthorShowStatus(show),
                lineAuthorSettingHandler: (key, value) =>
                    this.lineAuthorSettingHandler(key, value),
                refreshDisplayWithDelay: () => this.refreshDisplayWithDelay(),
            });
        }

        const appearanceSectionContext: AppearanceSectionContext = {
            ...baseSettingsSectionContext,
            refreshDisplayWithDelay: (timeout?: number) =>
                this.refreshDisplayWithDelay(timeout),
        };
        renderAppearanceSection(appearanceSectionContext);

        renderAdvancedSection({
            containerEl,
            plugin,
            reloadSyncManager: () => this.reloadSyncManager(),
        });

        // Re-apply an active search query after every re-render.
        if (this._settingsSearchQuery) {
            this._applySettingsFilter(containerEl, this._settingsSearchQuery);
        }
    }

    mayDisableSetting(setting: Setting, disable: boolean) {
        if (disable) {
            setting.setDisabled(disable);
            setting.setClass("obsidian-git-disabled");
        }
    }

    public configureLineAuthorShowStatus(show: boolean) {
        this.settings.lineAuthor.show = show;
        void this.plugin.saveSettings();

        if (show) this.plugin.editorIntegration.activateLineAuthoring();
        else this.plugin.editorIntegration.deactivateLineAuthoring?.();
    }

    /**
     * Persists the setting {@link key} with value {@link value} and
     * refreshes the line author info views.
     */
    public async lineAuthorSettingHandler<
        K extends keyof ObsidianGitSettings["lineAuthor"],
    >(key: K, value: ObsidianGitSettings["lineAuthor"][K]): Promise<void> {
        this.settings.lineAuthor[key] = value;
        // Keep lastShown* in sync so context-menu items always reflect the most
        // recent non-hidden display choice — previously done in beforeSaveSettings().
        const la = this.settings.lineAuthor;
        if (la.authorDisplay !== "hide") {
            la.lastShownAuthorDisplay = la.authorDisplay;
        }
        if (la.dateTimeFormatOptions !== "hide") {
            la.lastShownDateTimeFormatOptions = la.dateTimeFormatOptions;
        }
        await this.plugin.saveSettings();
        this.plugin.editorIntegration.lineAuthoringFeature.refreshLineAuthorViews();
    }

    /**
     * Sets the value in the textbox for a given setting only if the saved value differs from the default value.
     * If the saved value is the default value, it probably wasn't defined by the user, so it's better to display it as a placeholder.
     */
    private setNonDefaultValue({
        settingsProperty,
        text,
    }: {
        settingsProperty: keyof ObsidianGitSettings;
        text: TextComponent | TextAreaComponent;
    }): void {
        const storedValue = this.plugin.settings[settingsProperty];
        const defaultValue = DEFAULT_SETTINGS[settingsProperty];

        if (defaultValue !== storedValue) {
            // Doesn't add "" to saved strings
            if (
                typeof storedValue === "string" ||
                typeof storedValue === "number" ||
                typeof storedValue === "boolean"
            ) {
                text.setValue(String(storedValue));
            } else {
                text.setValue(JSON.stringify(storedValue));
            }
        }
    }

    /**
     * Shows/hides setting items in {@link root} based on the search {@link query}.
     * Headings are hidden only when all of their section's items are hidden.
     */
    private _applySettingsFilter(root: HTMLElement, query: string): void {
        const q = query.trim().toLowerCase();
        const items = root.querySelectorAll<HTMLElement>(".setting-item");
        items.forEach((item) => {
            if (item.closest(".obsidian-git-settings-search")) return;
            if (!q) {
                item.style.display = "";
                return;
            }
            const name =
                item
                    .querySelector(".setting-item-name")
                    ?.textContent?.toLowerCase() ?? "";
            const isHeading = item.classList.contains("setting-item-heading");
            const visible = isHeading || name.includes(q);
            item.style.display = visible ? "" : "none";
        });
        // Hide headings whose entire section is hidden.
        const allItems = Array.from(
            root.querySelectorAll<HTMLElement>(".setting-item")
        ).filter((el) => !el.closest(".obsidian-git-settings-search"));
        for (let i = 0; i < allItems.length; i++) {
            const el = allItems[i];
            if (!el.classList.contains("setting-item-heading")) continue;
            let hasVisible = false;
            for (let j = i + 1; j < allItems.length; j++) {
                if (allItems[j].classList.contains("setting-item-heading"))
                    break;
                if (allItems[j].style.display !== "none") {
                    hasVisible = true;
                    break;
                }
            }
            el.style.display = !q || hasVisible ? "" : "none";
        }
    }

    /**
     * Delays the update of the settings UI.
     * Used when the user toggles one of the settings that control enabled states of other settings. Delaying the update
     * allows most of the toggle animation to run, instead of abruptly jumping between enabled/disabled states.
     */
    private refreshDisplayWithDelay(timeout = 80): void {
        setTimeout(() => this.display(), timeout);
    }

    private createBaseSettingsSectionContext(): Pick<
        HistorySectionContext,
        "containerEl" | "plugin"
    > {
        return {
            containerEl: this.containerEl,
            plugin: this.plugin,
        };
    }

    private createProviderSectionContext(
        provider: "github" | "gitlab" | "gitea"
    ): ProviderSectionContext {
        return {
            ...this.createBaseSettingsSectionContext(),
            settings: this.plugin.settings,
            getToken: () =>
                this.plugin.providerSecrets.getToken(provider) ?? "",
            setToken: (token: string | null) =>
                this.plugin.providerSecrets.setToken(provider, token),
            persistAndReloadSync: () =>
                this._persistence.persistAndReloadSync(),
            reloadSyncManager: () => this.reloadSyncManager(),
            scheduleApiRemoteTargetPrompt: () =>
                this.scheduleApiRemoteTargetPrompt(),
            runApiRemoteTargetWorkflow: () => this.runApiRemoteTargetWorkflow(),
            setDropdownOptions: (dd, options, selected) =>
                this.setDropdownOptions(dd, options, selected),
            isVaultLinked: !!this.plugin.settings.lastSyncedRepoFingerprint,
            confirmTargetChange: (repo: string, branch: string) =>
                this.confirmTargetChange(provider, repo, branch),
        };
    }

    private getProviderRepo(provider: "github" | "gitlab" | "gitea"): string {
        switch (provider) {
            case "github":
                return this.plugin.settings.githubRepo ?? "";
            case "gitlab":
                return this.plugin.settings.gitlabProjectId ?? "";
            case "gitea":
                return this.plugin.settings.giteaRepo ?? "";
            default:
                throw new Error(`Unrecognized provider: ${String(provider)}`);
        }
    }

    private getProviderBranch(provider: "github" | "gitlab" | "gitea"): string {
        switch (provider) {
            case "github":
                return this.plugin.settings.githubBranch ?? "";
            case "gitlab":
                return this.plugin.settings.gitlabBranch ?? "";
            case "gitea":
                return this.plugin.settings.giteaBranch ?? "";
            default:
                throw new Error(`Unrecognized provider: ${String(provider)}`);
        }
    }

    private buildCloneUrl(
        provider: "github" | "gitlab" | "gitea",
        repo: string
    ): string | null {
        switch (provider) {
            case "github": {
                const owner = this.plugin.settings.githubOwner;
                if (!owner || !repo) return null;
                return `https://github.com/${owner}/${repo}.git`;
            }
            case "gitlab": {
                const projectId = repo || this.plugin.settings.gitlabProjectId;
                if (!projectId) return null;
                const baseUrl = (
                    this.plugin.settings.gitlabBaseUrl ||
                    "https://gitlab.com/api/v4"
                )
                    .replace(/\/api\/v4\/?$/, "")
                    .replace(/\/+$/, "");
                return `${baseUrl}/${projectId}.git`;
            }
            case "gitea": {
                const owner = this.plugin.settings.giteaOwner;
                const baseUrl = this.plugin.settings.giteaBaseUrl?.replace(
                    /\/+$/,
                    ""
                );
                if (!baseUrl || !owner || !repo) return null;
                return `${baseUrl}/${owner}/${repo}.git`;
            }
            default:
                return null;
        }
    }

    private async confirmTargetChange(
        provider: "github" | "gitlab" | "gitea",
        proposedRepo: string,
        proposedBranch: string
    ): Promise<boolean> {
        const controller = new TargetChangeController(
            this.plugin.syncState,
            Platform.isMobileApp
        );
        controller.setLastSyncedFingerprint(
            this.plugin.settings.lastSyncedRepoFingerprint
        );

        const currentRepo = this.getProviderRepo(provider);
        const currentBranch = this.getProviderBranch(provider);

        const detection = controller.detectChange(
            provider,
            proposedRepo,
            proposedBranch,
            currentRepo,
            currentBranch
        );

        if (!detection.repoChanged && !detection.branchChanged) {
            return true;
        }

        const validation = controller.validateTransition(detection);

        if (!validation.canProceed) {
            for (const blocker of validation.blockers) {
                this.plugin.showNotice(blocker, 6000);
            }
            return false;
        }

        if (!validation.requiresConfirmation) {
            return true;
        }

        // Show the target change confirmation modal
        try {
            const { TargetChangeModal } = await import(
                "../ui/modals/targetChangeModal"
            );
            const availableActions = controller.availableActions(validation);
            const action = await new TargetChangeModal(
                this.app,
                detection,
                validation,
                availableActions
            ).openAndGetResult();

            if (action === "switch-vault") {
                return true;
            }

            if (action === "clone-dedicated-vault") {
                const url = this.buildCloneUrl(provider, proposedRepo);
                if (url) {
                    this.plugin.showNotice(
                        `Opening clone dialog for ${url}...`,
                        4000
                    );
                    this.plugin.triggerDedicatedVaultClone(url);
                } else {
                    this.plugin.showNotice(
                        "Could not determine remote URL for the selected repository.",
                        5000
                    );
                }
                return false;
            }

            if (action === "create-submodule") {
                const url = this.buildCloneUrl(provider, proposedRepo);
                if (!url) {
                    this.plugin.showNotice(
                        "Could not determine remote URL for the selected repository.",
                        5000
                    );
                    return false;
                }

                const maybeGitManager: unknown = this.plugin.gitManager;
                if (!isSubmoduleCapableGitManager(maybeGitManager)) {
                    this.plugin.showNotice(
                        "Git submodules require git mode. Switch to the git sync provider on desktop to add submodules.",
                        6000
                    );
                    return false;
                }

                const { SubmodulePathModal } = await import(
                    "../ui/modals/submodulePathModal"
                );
                const submodulePath = await new SubmodulePathModal(
                    this.app,
                    proposedRepo
                ).openAndGetResult();
                if (!submodulePath) return false;

                try {
                    await maybeGitManager.addSubmodule(url, submodulePath);
                    this.plugin.showNotice(
                        `Submodule "${proposedRepo}" added at "${submodulePath}". Use source control to commit.`,
                        6000
                    );
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    this.plugin.showNotice(
                        `Failed to add submodule: ${message}`,
                        7000
                    );
                }
                return false;
            }

            return false;
        } catch (error) {
            console.error(
                "[ObsidianGit] Failed to load or open TargetChangeModal:",
                error
            );
            return false;
        }
    }

    private scheduleApiRemoteTargetPrompt(): void {
        if (this._pendingApiTargetPromptTimer !== undefined) {
            window.clearTimeout(this._pendingApiTargetPromptTimer);
        }

        this._pendingApiTargetPromptTimer = window.setTimeout(() => {
            this._pendingApiTargetPromptTimer = undefined;
            void this.maybePromptForCurrentApiTarget();
        }, 150);
    }

    private getCompleteApiTargetFingerprint(): string | null {
        const provider = this.plugin.settings.activeSyncProvider;
        if (provider === "git") {
            return null;
        }

        const hasExplicitBranch = (() => {
            switch (provider) {
                case "github":
                    return Boolean(this.plugin.settings.githubBranch?.trim());
                case "gitlab":
                    return Boolean(this.plugin.settings.gitlabBranch?.trim());
                case "gitea":
                    return Boolean(this.plugin.settings.giteaBranch?.trim());
            }
        })();

        if (!hasExplicitBranch) {
            return null;
        }

        return this._repoBinding.computeActiveApiRepoFingerprint();
    }

    private async maybePromptForCurrentApiTarget(): Promise<void> {
        if (!this.isSettingsTabVisible()) {
            return;
        }

        const fingerprint = this.getCompleteApiTargetFingerprint();
        if (!fingerprint) {
            return;
        }
        if (
            fingerprint === this._lastAutoPromptedApiFingerprint ||
            fingerprint === this._activeApiTargetPromptFingerprint
        ) {
            return;
        }

        this._activeApiTargetPromptFingerprint = fingerprint;
        try {
            if (!this.isSettingsTabVisible()) {
                return;
            }
            await this.runApiRemoteTargetWorkflow();
            this._lastAutoPromptedApiFingerprint = fingerprint;
        } finally {
            if (this._activeApiTargetPromptFingerprint === fingerprint) {
                this._activeApiTargetPromptFingerprint = null;
            }
        }
    }

    // ── Persist helpers (Phase 1-E → Phase 2 delegate) ───────────────────────
    //
    // These methods now delegate to SettingsPersistenceService, which serialises
    // save → reload → redraw sequences through an internal FIFO queue.

    /**
     * Persist settings, then reload the sync manager.
     * Delegates to {@link SettingsPersistenceService} for serialised execution.
     */
    private async persistAndReloadSync(): Promise<void> {
        await this._persistence.persistAndReloadSync();
    }

    /**
     * Persist settings, reload the sync manager, and schedule a display
     * re-render.  Delegates to {@link SettingsPersistenceService}.
     */
    private async persistAndReloadSyncAndRedraw(): Promise<void> {
        await this._persistence.persistAndReloadSyncAndRedraw();
    }

    private async reloadSyncManager(): Promise<void> {
        if (this.plugin.syncManager == null) return;
        if (this.plugin.isInitInProgress) return;
        // reload() handles its own error notice + state update; no need to catch here.
        await this.plugin.syncManager.reload();
    }
}

// ── Pure helpers (exported for unit testing) ──────────────────────────────

export {
    buildOptionsFromNames,
    filterReposByOwner,
    buildBranchOptions,
    parseColoringMaxAgeDuration,
    pickColor,
} from "./settingsHelpers";
