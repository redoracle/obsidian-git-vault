import { requireApiVersion } from "obsidian";
import type ObsidianGit from "../main";
import type { SyncProviderSetting } from "../types";
import type { ISecretsBackend } from "../setting/infra/providerCredentialStore";

type SecretBackedProvider = Exclude<SyncProviderSetting, "git">;

const SECRET_SUFFIX: Record<SecretBackedProvider, string> = {
    github: "github-pat",
    gitlab: "gitlab-pat",
    gitea: "gitea-pat",
};

const ENCRYPTION_PASSPHRASE_SECRET_ID = "api-encryption-passphrase";
const GIT_HTTP_USERNAME_SECRET_ID = "git-http-username";
const GIT_HTTP_PASSWORD_SECRET_ID = "git-http-password";

export class ProviderSecrets implements ISecretsBackend {
    private readonly legacyPrefixes = [
        "git-vault:",
        "obsidian-git-vault:",
        "obsidian-git:",
    ];
    private readonly legacySecretPluginIds = [
        "obsidian-git-vault",
        "obsidian-git",
    ];

    constructor(private readonly plugin: ObsidianGit) {}

    isSupported(): boolean {
        return requireApiVersion("1.11.4");
    }

    private makeSecretId(suffix: string): string {
        // Obsidian secretStorage requires lowercase letters, numbers, and dashes only (max 64 chars).
        return `${this.plugin.manifest.id}-${suffix}`;
    }

    private normalizeSecret(secret: string | null): string | null {
        return secret && secret.length > 0 ? secret : null;
    }

    private getSecretWithLegacyFallback(suffix: string): string | null {
        const currentSecretId = this.makeSecretId(suffix);
        const current = this.normalizeSecret(
            this.plugin.app.secretStorage.getSecret(currentSecretId)
        );
        if (current) {
            return current;
        }

        let migrated: string | null = null;
        let foundLegacy = false;
        for (const legacyPluginId of this.legacySecretPluginIds) {
            const legacySecretId = `${legacyPluginId}-${suffix}`;
            const legacy = this.normalizeSecret(
                this.plugin.app.secretStorage.getSecret(legacySecretId)
            );
            if (!migrated && legacy) {
                migrated = legacy;
            }
            foundLegacy ||= legacy != null;
        }
        if (foundLegacy) {
            for (const legacyPluginId of this.legacySecretPluginIds) {
                const legacySecretId = `${legacyPluginId}-${suffix}`;
                this.plugin.app.secretStorage.setSecret(legacySecretId, "");
            }
        }
        if (migrated) {
            this.plugin.app.secretStorage.setSecret(currentSecretId, migrated);
        }
        return migrated;
    }

    getToken(provider: SecretBackedProvider): string | null {
        if (!this.isSupported()) {
            return null;
        }
        return this.getSecretWithLegacyFallback(SECRET_SUFFIX[provider]);
    }

    setToken(provider: SecretBackedProvider, token: string | null): void {
        if (!this.isSupported()) {
            return;
        }
        this.plugin.app.secretStorage.setSecret(
            this.makeSecretId(SECRET_SUFFIX[provider]),
            token && token.length > 0 ? token : ""
        );
    }

    getGitHttpUsername(): string | null {
        if (!this.isSupported()) {
            return null;
        }
        return this.getSecretWithLegacyFallback(GIT_HTTP_USERNAME_SECRET_ID);
    }

    setGitHttpUsername(username: string | null): void {
        if (!this.isSupported()) {
            return;
        }
        this.plugin.app.secretStorage.setSecret(
            this.makeSecretId(GIT_HTTP_USERNAME_SECRET_ID),
            username && username.length > 0 ? username : ""
        );
    }

    getGitHttpPassword(): string | null {
        if (!this.isSupported()) {
            return null;
        }
        return this.getSecretWithLegacyFallback(GIT_HTTP_PASSWORD_SECRET_ID);
    }

    setGitHttpPassword(password: string | null): void {
        if (!this.isSupported()) {
            return;
        }
        this.plugin.app.secretStorage.setSecret(
            this.makeSecretId(GIT_HTTP_PASSWORD_SECRET_ID),
            password && password.length > 0 ? password : ""
        );
    }

    getEncryptionPassphrase(): string | null {
        if (!this.isSupported()) {
            return null;
        }
        return this.getSecretWithLegacyFallback(
            ENCRYPTION_PASSPHRASE_SECRET_ID
        );
    }

    setEncryptionPassphrase(passphrase: string | null): void {
        if (!this.isSupported()) {
            return;
        }
        this.plugin.app.secretStorage.setSecret(
            this.makeSecretId(ENCRYPTION_PASSPHRASE_SECRET_ID),
            passphrase && passphrase.length > 0 ? passphrase : ""
        );
    }

    migrateLegacyGitHubToken(sources: Array<string | null | undefined>): void {
        if (!this.isSupported()) {
            return;
        }
        const current = this.getToken("github");
        if (current && current.length > 0) {
            this.clearLegacyGitHubTokenCopies();
            return;
        }

        for (const source of sources) {
            const token = source?.trim();
            if (token) {
                this.setToken("github", token);
                this.clearLegacyGitHubTokenCopies();
                return;
            }
        }

        for (const prefix of this.legacyPrefixes) {
            const legacy = this.plugin.app.loadLocalStorage(
                prefix + "githubToken"
            );
            if (legacy && legacy.trim().length > 0) {
                this.setToken("github", legacy.trim());
                this.clearLegacyGitHubTokenCopies();
                return;
            }
        }
    }

    clearLegacyGitHubTokenCopies(): void {
        // Clear both the Obsidian-managed local storage entry and any raw
        // browser localStorage fallback written by older installs or manual
        // migrations. The helper may transform keys internally, while the raw
        // removeItem call covers direct legacy entries with the same prefix.
        for (const prefix of this.legacyPrefixes) {
            this.plugin.app.saveLocalStorage(prefix + "githubToken", "");
            localStorage.removeItem(prefix + "githubToken");
        }
    }

    /**
     * Migrate legacy Git HTTP credentials into secret storage.
     *
     * Callers must supply explicit `sources` for the username and password,
     * unlike {@link migrateLegacyGitHubToken}, which inspects localStorage on
     * its own. Each source value is treated as optional, trimmed before use,
     * and only written when the corresponding stored value is currently null.
     *
     * On a successful migration, this method calls
     * {@link getGitHttpUsername}, {@link getGitHttpPassword},
     * {@link setGitHttpUsername}, {@link setGitHttpPassword}, and
     * {@link clearLegacyGitHttpCredentialCopies} so legacy raw copies are
     * removed after the first stored values are populated.
     */
    migrateLegacyGitHttpCredentials(sources: {
        username?: string | null;
        password?: string | null;
    }): void {
        if (!this.isSupported()) {
            return;
        }

        const currentUsername = this.getGitHttpUsername();
        const currentPassword = this.getGitHttpPassword();
        let migrated = false;

        if (currentUsername == null && sources.username?.trim()) {
            this.setGitHttpUsername(sources.username.trim());
            migrated = true;
        }
        if (currentPassword == null && sources.password?.trim()) {
            this.setGitHttpPassword(sources.password.trim());
            migrated = true;
        }

        if (currentUsername != null || currentPassword != null || migrated) {
            this.clearLegacyGitHttpCredentialCopies();
        }
    }

    clearLegacyGitHttpCredentialCopies(): void {
        for (const prefix of this.legacyPrefixes) {
            this.plugin.app.saveLocalStorage(prefix + "username", "");
            this.plugin.app.saveLocalStorage(prefix + "password", "");
            localStorage.removeItem(prefix + "username");
            localStorage.removeItem(prefix + "password");
        }
    }
}
