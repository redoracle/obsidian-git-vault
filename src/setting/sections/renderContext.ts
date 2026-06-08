import type {
    DropdownComponent,
    TextAreaComponent,
    TextComponent,
} from "obsidian";
import type { IPluginContext } from "src/pluginContext";
import type { ObsidianGitSettings, ShowAuthorInHistoryView } from "src/types";

export type SetNonDefaultValue = (args: {
    settingsProperty: keyof ObsidianGitSettings;
    text: TextComponent | TextAreaComponent;
}) => void;

export type SetDropdownOptions = (
    dd: DropdownComponent | undefined,
    options: Record<string, string>,
    selected?: string
) => string;

/**
 * Result returned by provider `createRepo` helpers when a repository is
 * successfully created. Contains both snake_case and camelCase variants
 * for `default_branch`/`defaultBranch` and `html_url`/`htmlUrl` so callers
 * can access whichever form is present without casting to `any`.
 */
export interface CreateRepoResult {
    name: string;
    htmlUrl: string;
    html_url?: string;
    defaultBranch?: string;
    default_branch?: string;
}

interface BaseSettingsSectionContext {
    containerEl: HTMLElement;
    plugin: IPluginContext;
}

export interface HistorySectionContext extends BaseSettingsSectionContext {
    refreshPlugin: () => Promise<void>;
}

export interface SourceControlSectionContext
    extends BaseSettingsSectionContext {
    setNonDefaultValue: SetNonDefaultValue;
    updateRefreshDebouncer: (this: void) => void;
}

export interface AppearanceSectionContext extends BaseSettingsSectionContext {
    refreshDisplayWithDelay: (timeout?: number) => void;
}

export interface CommitAuthorSectionContext extends BaseSettingsSectionContext {
    gitReady: boolean;
    getConfig: (key: string) => Promise<string | undefined>;
    setConfig: (key: string, value: string | undefined) => Promise<void>;
}

export interface ProviderSectionContext extends BaseSettingsSectionContext {
    settings: ObsidianGitSettings;
    getToken: () => string;
    setToken: (token: string | null) => void;
    persistAndReloadSync: () => Promise<void>;
    reloadSyncManager: () => Promise<void>;
    scheduleApiRemoteTargetPrompt: () => void;
    runApiRemoteTargetWorkflow: () => Promise<void>;
    setDropdownOptions: SetDropdownOptions;
    /**
     * Whether the vault has already been linked to a sync target (i.e. the
     * lastSyncedRepoFingerprint is non-empty). When true, repo/branch changes
     * should be confirmed before being persisted.
     */
    isVaultLinked: boolean;
    /**
     * Persist a repo+branch target change, optionally showing a confirmation
     * modal if the vault is already linked. Returns true when the change was
     * committed, false when the user cancelled.
     */
    confirmTargetChange: (repo: string, branch: string) => Promise<boolean>;
}

export interface GitHubProviderSectionContext extends ProviderSectionContext {
    requestUser: () => Promise<{ login?: string } | null>;
    fetchRepos: (owner: string) => Promise<Record<string, string>>;
    fetchBranches: (
        owner: string,
        repo: string
    ) => Promise<Record<string, string>>;
    /**
     * Create a new private GitHub repository for `owner`.
     * Uses `/user/repos` for personal accounts and `/orgs/{owner}/repos` for
     * organisations.  Returns `CreateRepoResult` on success, `null` on error.
     */
    createRepo: (
        owner: string,
        repoName: string
    ) => Promise<CreateRepoResult | null>;
    showNotice: (message: string, timeout?: number) => void;
}

export interface GitLabProviderSectionContext extends ProviderSectionContext {
    requestUser: () => Promise<{ username?: string; name?: string } | null>;
    fetchProjects: () => Promise<Record<string, string>>;
    fetchBranches: (projectId: string) => Promise<Record<string, string>>;
    /**
     * Fetch project metadata (including `default_branch`) for a project.
     */
    getProject: (projectId: string) => Promise<{
        default_branch?: string;
        path_with_namespace?: string;
    } | null>;
    /**
     * Create a new private GitLab project.
     * Returns `{ pathWithNamespace, webUrl }` on success, `null` on error.
     */
    createProject: (
        name: string
    ) => Promise<{ pathWithNamespace: string; webUrl: string } | null>;
    showNotice: (message: string, timeout?: number) => void;
}

export interface GiteaProviderSectionContext extends ProviderSectionContext {
    requestUser: () => Promise<{ login?: string; fullName?: string } | null>;
    fetchRepos: (owner: string) => Promise<Record<string, string>>;
    fetchBranches: (
        owner: string,
        repo: string
    ) => Promise<Record<string, string>>;
    /**
     * Create a new private repository under the authenticated Gitea user.
     * Returns `{ name, htmlUrl }` on success, `null` on error.
     */
    createRepo: (repoName: string) => Promise<CreateRepoResult | null>;
    showNotice: (message: string, timeout?: number) => void;
}

// Consolidated re-exports for section renderer types.
export type { ShowAuthorInHistoryView };
