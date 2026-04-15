import type { LocalStorageSettings } from "../localStorageSettings";

/**
 * Narrow interface that `ProviderCredentialStore` requires from the secret
 * storage backend.  Matches the subset of `ProviderSecrets` that the store
 * actually uses, so unit tests can inject a plain stub.
 */
export interface ISecretsBackend {
    isSupported(): boolean;
    getGitHttpUsername(): string | null;
    setGitHttpUsername(value: string | null): void;
    getGitHttpPassword(): string | null;
    setGitHttpPassword(value: string | null): void;
    clearLegacyGitHttpCredentialCopies(): void;
}

/**
 * Abstracts credential read/write for the Git-HTTP transport layer.
 *
 * Encapsulates the storage-selection logic (secret storage when supported,
 * otherwise `LocalStorageSettings`) so that the settings tab never needs to
 * reason about where credentials are persisted.
 *
 * This is the **only** module in the settings domain that should access
 * `ProviderSecrets` git-http credential methods directly.
 */
export class ProviderCredentialStore {
    constructor(
        private readonly secrets: ISecretsBackend,
        private readonly localStorage: LocalStorageSettings
    ) {}

    /**
     * Migrates newly stored Git HTTP credentials into secret storage cleanup.
     * Call this after updating username/password; the setters no longer perform
     * legacy-copy cleanup on their own.
     */
    migrateToSecretStorage(): void {
        if (!this.secrets.isSupported()) {
            return;
        }

        this.secrets.clearLegacyGitHttpCredentialCopies();
    }

    getUsername(): string {
        return (
            this.secrets.getGitHttpUsername() ??
            this.localStorage.getUsername() ??
            ""
        );
    }

    setUsername(username: string): void {
        if (this.secrets.isSupported()) {
            this.secrets.setGitHttpUsername(username || null);
            return;
        }
        this.localStorage.setUsername(username);
    }

    getPassword(): string {
        return (
            this.secrets.getGitHttpPassword() ??
            this.localStorage.getPassword() ??
            ""
        );
    }

    setPassword(password: string): void {
        if (this.secrets.isSupported()) {
            this.secrets.setGitHttpPassword(password || null);
            return;
        }
        this.localStorage.setPassword(password);
    }
}
