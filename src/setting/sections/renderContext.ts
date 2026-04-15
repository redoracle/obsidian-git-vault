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
    setDropdownOptions: SetDropdownOptions;
}

export interface GitHubProviderSectionContext extends ProviderSectionContext {
    requestUser: () => Promise<{ login?: string } | null>;
    fetchRepos: (owner: string) => Promise<Record<string, string>>;
    fetchBranches: (
        owner: string,
        repo: string
    ) => Promise<Record<string, string>>;
    showNotice: (message: string, timeout?: number) => void;
}

export interface GitLabProviderSectionContext extends ProviderSectionContext {
    requestUser: () => Promise<{ username?: string; name?: string } | null>;
    fetchProjects: () => Promise<Record<string, string>>;
    fetchBranches: (projectId: string) => Promise<Record<string, string>>;
    showNotice: (message: string, timeout?: number) => void;
}

export interface GiteaProviderSectionContext extends ProviderSectionContext {
    requestUser: () => Promise<{ login?: string; fullName?: string } | null>;
    fetchRepos: (owner: string) => Promise<Record<string, string>>;
    fetchBranches: (
        owner: string,
        repo: string
    ) => Promise<Record<string, string>>;
    showNotice: (message: string, timeout?: number) => void;
}

// Consolidated re-exports for section renderer types.
export type { ShowAuthorInHistoryView };
