/**
 * SettingsMigrationService
 *
 * Responsible for: migrating legacy settings fields, tokens, and aliases from
 * older versions of obsidian-git / obsidian-git-vault to the current schema,
 * and for loading settings data from legacy plugin data.json files on first
 * startup.
 *
 * Extracted from: ObsidianGit.migrateSettings / ObsidianGit.loadLegacySettingsData
 * (src/main.ts lines 570–972).
 *
 * Does NOT own: current settings persistence (saveSettings), secret storage
 * schema for new credentials, or provider runtime state.
 */

import { normalizePath, type App } from "obsidian";
import type { LocalStorageSettings } from "src/setting/localStorageSettings";
import type { ProviderSecrets } from "src/security/providerSecrets";
import type { ObsidianGitSettings } from "src/types";

export class SettingsMigrationService {
    constructor(
        private readonly app: App,
        private readonly providerSecrets: ProviderSecrets,
        private readonly localStorage: LocalStorageSettings,
        private readonly gitHttpUsernameSecretId: string,
        private readonly gitHttpPasswordSecretId: string,
        private readonly saveSettings: () => Promise<void>
    ) {}

    async migrate(settings: ObsidianGitSettings): Promise<void> {
        const providerSecrets = this.providerSecrets;
        providerSecrets.migrateLegacyGitHubToken([
            settings.githubToken,
            this.localStorage.getLegacyGitHubToken(),
        ]);
        providerSecrets.clearLegacyGitHubTokenCopies();
        const legacyGitHttpUsername = this.localStorage.getUsername()?.trim();
        const legacyGitHttpPassword = this.localStorage.getPassword()?.trim();
        if (providerSecrets.isSupported()) {
            const currentGitHttpUsername = this.app.secretStorage.getSecret(
                this.gitHttpUsernameSecretId
            );
            const currentGitHttpPassword = this.app.secretStorage.getSecret(
                this.gitHttpPasswordSecretId
            );
            if (!currentGitHttpUsername && legacyGitHttpUsername) {
                this.app.secretStorage.setSecret(
                    this.gitHttpUsernameSecretId,
                    legacyGitHttpUsername
                );
            }
            if (!currentGitHttpPassword && legacyGitHttpPassword) {
                this.app.secretStorage.setSecret(
                    this.gitHttpPasswordSecretId,
                    legacyGitHttpPassword
                );
            }
        }
        providerSecrets.clearLegacyGitHttpCredentialCopies();
        let needsMigrationSave = false;
        if ((settings.activeSyncProvider as string) === "gitless") {
            settings.activeSyncProvider = "github";
            needsMigrationSave = true;
        }
        if (settings.mergeOnPull != undefined) {
            settings.syncMethod = settings.mergeOnPull ? "merge" : "rebase";
            settings.mergeOnPull = undefined;
            needsMigrationSave = true;
        }
        if (settings.autoCommitMessage === undefined) {
            settings.autoCommitMessage = settings.commitMessage;
            needsMigrationSave = true;
        }
        if (settings.gitPath != undefined) {
            this.localStorage.setGitPath(settings.gitPath);
            settings.gitPath = undefined;
            needsMigrationSave = true;
        }
        if (settings.username != undefined) {
            if (providerSecrets.isSupported()) {
                this.app.secretStorage.setSecret(
                    this.gitHttpUsernameSecretId,
                    settings.username
                );
            } else {
                this.localStorage.setUsername(settings.username);
            }
            settings.username = undefined;
            needsMigrationSave = true;
        }
        if (settings.githubToken) {
            settings.githubToken = "";
            needsMigrationSave = true;
        }
        // Consume the one-shot bootstrap token written when a dedicated vault
        // was cloned via "import as dedicated vault".  data.json is gitignored
        // for the new vault, so this value never reaches the remote.  We move
        // it into secretStorage once (if no credential is already stored) and
        // immediately clear the field so it does not persist in settings.
        if (settings.bootstrapProviderToken) {
            const provider = settings.activeSyncProvider;
            if (
                provider === "github" ||
                provider === "gitlab" ||
                provider === "gitea"
            ) {
                if (!providerSecrets.getToken(provider)) {
                    providerSecrets.setToken(
                        provider,
                        settings.bootstrapProviderToken
                    );
                }
            }
            settings.bootstrapProviderToken = undefined;
            needsMigrationSave = true;
        }
        if (needsMigrationSave) {
            await this.saveSettings();
        }
    }

    /**
     * Attempts to load settings from legacy plugin data.json files so that
     * users upgrading from older plugin IDs do not lose their configuration.
     */
    async loadLegacyData(): Promise<ObsidianGitSettings | null> {
        const legacyPluginIds = ["obsidian-git-vault", "obsidian-git"];
        for (const pluginId of legacyPluginIds) {
            const legacyPath = normalizePath(
                `${this.app.vault.configDir}/plugins/${pluginId}/data.json`
            );
            try {
                const exists = await this.app.vault.adapter.exists(legacyPath);
                if (!exists) {
                    continue;
                }
                const raw = await this.app.vault.adapter.read(legacyPath);
                return JSON.parse(raw) as ObsidianGitSettings;
            } catch (err: unknown) {
                console.debug(
                    "[ObsidianGit] failed to read/parse legacy settings",
                    { legacyPath, err }
                );
                continue;
            }
        }
        return null;
    }
}
