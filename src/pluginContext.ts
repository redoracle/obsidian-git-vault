import type { App } from "obsidian";
import type { INoticeHandle } from "src/notification/noticePresenter";
import type { ObsidianGitSettings, SyncProviderSetting } from "src/types";
import type { ISyncManifestStore } from "src/syncProvider/syncManifestStore";

// ── Sub-interfaces ────────────────────────────────────────────────────────────
//
// These narrow contracts let service modules (controller/, policy/, infra/)
// express their real dependencies instead of importing the concrete plugin class.
// Unit tests can then inject plain stubs without the Obsidian runtime.

/** Minimum sync-manager surface needed by settings and service modules. */
export interface ISyncManagerContext {
    reload(): Promise<void>;
    syncNow(): Promise<void>;
    pullNow(): Promise<void>;
}

/** Minimum secret-storage surface needed by settings and service modules. */
export interface IProviderSecretsContext {
    isSupported(): boolean;
    getToken(provider: Exclude<SyncProviderSetting, "git">): string | null;
    setToken(
        provider: Exclude<SyncProviderSetting, "git">,
        token: string | null
    ): void;
    getEncryptionPassphrase(): string | null;
    setEncryptionPassphrase(passphrase: string | null): void;
}

/** Minimum editor-integration surface needed by settings and service modules. */
export interface IEditorIntegrationContext {
    activateLineAuthoring(): void;
    /** Correctly spelled primary method for deactivating line authoring. */
    deactivateLineAuthoring(): void;
    /** @deprecated Use {@link deactivateLineAuthoring} instead. */
    deactiveLineAuthoring?(): void;
    refreshSignsSettings(): void;
    lineAuthoringFeature: { refreshLineAuthorViews(): void };
}

// ── Primary interface ─────────────────────────────────────────────────────────

/**
 * Narrow interface representing the plugin context that settings modules,
 * service layers, and extracted policy/infra classes depend on.
 *
 * Declared separately from `ObsidianGit` so that:
 * - Unit tests can inject a plain stub without requiring the Obsidian runtime.
 * - Extracted modules under `setting/controller/`, `setting/policy/`, and
 *   `setting/infra/` import only this interface, never the concrete class.
 *
 * `ObsidianGit` satisfies this interface structurally; an explicit
 * `implements IPluginContext` annotation can be added once all members have
 * been verified compatible.
 */
export interface IPluginContext {
    /** Obsidian application context (vault, workspace, etc.). */
    readonly app: App;
    /** Plugin manifest — used for version strings. */
    readonly manifest: { readonly version: string };
    /** Mutable plugin settings object. */
    settings: ObsidianGitSettings;
    /**
     * Persist the current settings to disk.
     */
    saveSettings(): Promise<void>;
    /** Show a dismissible toast via the plugin notice center. */
    makeSyncNotice(msg: string, timeout?: number): void;
    /** True while an `init()` / `reload()` cycle is running. */
    readonly isInitInProgress: boolean;
    /** True when running on desktop with the native-git (simple-git) provider. */
    readonly useSimpleGit: boolean;
    /** True while the plugin considers Git initialized and ready for UI actions. */
    gitReady: boolean;
    /**
     * Active sync manager. May be absent (`undefined`) or explicitly cleared
     * to `null` during early startup before the first `init()` completes.
     * Callers should use a nullish check when accessing it.
     */
    syncManager?: ISyncManagerContext | null;
    /** Secret-storage adapter. */
    providerSecrets: IProviderSecretsContext;
    /** Editor-integration adapter (line authoring, diff signs). */
    editorIntegration: IEditorIntegrationContext;
    /** File-backed manifest store used by API sync providers. */
    syncManifestStore: ISyncManifestStore;
    /** Recomputes the status-bar debouncer after settings changes. */
    setRefreshDebouncer(): void;
    /** Refreshes the plugin views and status asynchronously. */
    refresh(): Promise<void>;
    /** Shows a dismissible notice and returns a handle for manual cleanup. */
    showNotice(message: string, timeout?: number): INoticeHandle;
}
