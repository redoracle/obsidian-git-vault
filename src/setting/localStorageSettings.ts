import type { App } from "obsidian";
import type ObsidianGit from "../main";

export type PendingVaultSyncRequest = {
    action: "sync-existing-vault";
    vaultPath: string;
    fingerprint: string;
    requestedAt: number;
};

export class LocalStorageSettings {
    private prefix: string;
    private app: App;
    constructor(private readonly plugin: ObsidianGit) {
        this.prefix = this.plugin.manifest.id + ":";
        this.app = plugin.app;
    }

    migrate(): void {
        const keys = [
            "password",
            "hostname",
            "conflict",
            "lastAutoPull",
            "lastAutoBackup",
            "lastAutoPush",
            "gitPath",
            "pluginDisabled",
            "githubToken",
        ];
        for (const key of keys) {
            const old = localStorage.getItem(this.prefix + key);
            if (
                this.app.loadLocalStorage(this.prefix + key) == null &&
                old != null
            ) {
                if (old != null) {
                    this.app.saveLocalStorage(this.prefix + key, old);
                    localStorage.removeItem(this.prefix + key);
                }
            }
        }
    }

    getPassword(): string | null {
        return this.app.loadLocalStorage(this.prefix + "password");
    }

    setPassword(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "password", value);
    }

    getUsername(): string | null {
        return this.app.loadLocalStorage(this.prefix + "username");
    }

    setUsername(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "username", value);
    }

    getHostname(): string | null {
        return this.app.loadLocalStorage(this.prefix + "hostname");
    }

    setHostname(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "hostname", value);
    }

    getConflict(): boolean {
        return this.app.loadLocalStorage(this.prefix + "conflict") == "true";
    }

    setConflict(value: boolean): void {
        return this.app.saveLocalStorage(this.prefix + "conflict", `${value}`);
    }

    getLastAutoPull(): string | null {
        return this.app.loadLocalStorage(this.prefix + "lastAutoPull");
    }

    setLastAutoPull(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "lastAutoPull", value);
    }

    getLastAutoBackup(): string | null {
        return this.app.loadLocalStorage(this.prefix + "lastAutoBackup");
    }

    setLastAutoBackup(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "lastAutoBackup", value);
    }

    getLastAutoPush(): string | null {
        return this.app.loadLocalStorage(this.prefix + "lastAutoPush");
    }

    setLastAutoPush(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "lastAutoPush", value);
    }

    getGitPath(): string | null {
        return this.app.loadLocalStorage(this.prefix + "gitPath");
    }

    setGitPath(value: string): void {
        return this.app.saveLocalStorage(this.prefix + "gitPath", value);
    }

    getPATHPaths(): string[] {
        return (
            this.app.loadLocalStorage(this.prefix + "PATHPaths")?.split(":") ??
            []
        );
    }

    setPATHPaths(value: string[]): void {
        return this.app.saveLocalStorage(
            this.prefix + "PATHPaths",
            value.join(":")
        );
    }

    getEnvVars(): string[] {
        return JSON.parse(
            this.app.loadLocalStorage(this.prefix + "envVars") ?? "[]"
        ) as string[];
    }

    setEnvVars(value: string[]): void {
        return this.app.saveLocalStorage(
            this.prefix + "envVars",
            JSON.stringify(value)
        );
    }

    getPluginDisabled(): boolean {
        return (
            this.app.loadLocalStorage(this.prefix + "pluginDisabled") == "true"
        );
    }

    setPluginDisabled(value: boolean): void {
        return this.app.saveLocalStorage(
            this.prefix + "pluginDisabled",
            `${value}`
        );
    }

    getGitHubToken(): string | null {
        return this.app.loadLocalStorage(this.prefix + "githubToken");
    }

    setGitHubToken(value: string | null): void {
        if (value === null) {
            this.app.saveLocalStorage(this.prefix + "githubToken", undefined);
        } else {
            this.app.saveLocalStorage(this.prefix + "githubToken", value);
        }
    }

    getLegacyGitHubToken(): string | null {
        const legacyPrefixes = ["obsidian-git-vault:", "obsidian-git:"];
        for (const prefix of legacyPrefixes) {
            const value = this.app.loadLocalStorage(prefix + "githubToken");
            if (value != null && value.length > 0) {
                return value;
            }
        }
        return this.getGitHubToken();
    }

    /**
     * Whether automatic routines are currently paused.
     * New timers should not be started when this is true.
     *
     * If `pausedUntil` is set and has passed, the pause is automatically
     * cleared and this returns `false`, allowing automatics to resume
     * without any user interaction.
     */
    getPausedAutomatics(): boolean {
        // Check time-limited pause first.
        const until = this.getPausedUntil();
        if (until !== null) {
            if (Date.now() >= until) {
                // Pause has expired — clear both fields so subsequent calls
                // are fast without re-reading an expired timestamp.
                this.setPausedUntil(null);
                this.app.saveLocalStorage(
                    this.prefix + "pausedAutomatics",
                    undefined
                );
                return false;
            }
            return true;
        }

        return (
            this.app.loadLocalStorage(this.prefix + "pausedAutomatics") ==
            "true"
        );
    }

    setPausedAutomatics(value: boolean): void {
        // Clear any time-limited pause when explicitly setting the boolean.
        this.setPausedUntil(null);
        return this.app.saveLocalStorage(
            this.prefix + "pausedAutomatics",
            `${value}`
        );
    }

    /**
     * Unix timestamp (ms) at which a timed pause expires, or `null` when
     * no timed pause is active. Set via `setPausedUntil()`.
     */
    getPausedUntil(): number | null {
        const raw = this.app.loadLocalStorage(this.prefix + "pausedUntil");
        if (raw == null) return null;
        const n = Number(raw);
        return isNaN(n) ? null : n;
    }

    /**
     * Starts a timed pause that expires at `untilMs` (Unix ms), or clears
     * the timed pause when `null` is passed.
     *
     * Also sets the `pausedAutomatics` flag so legacy callers of
     * `getPausedAutomatics()` see the correct state immediately.
     */
    setPausedUntil(untilMs: number | null): void {
        if (untilMs === null) {
            this.app.saveLocalStorage(this.prefix + "pausedUntil", undefined);
        } else {
            this.app.saveLocalStorage(
                this.prefix + "pausedUntil",
                String(untilMs)
            );
            // Ensure the boolean flag is consistent for any reader that only
            // checks getPausedAutomatics() without going through getPausedUntil().
            this.app.saveLocalStorage(this.prefix + "pausedAutomatics", "true");
        }
    }

    getPendingVaultSyncRequest(): PendingVaultSyncRequest | null {
        const raw = this.app.loadLocalStorage(
            this.prefix + "pendingVaultSyncRequest"
        );
        if (!raw) {
            return null;
        }

        try {
            const parsed = JSON.parse(raw) as Partial<PendingVaultSyncRequest>;
            if (
                parsed.action !== "sync-existing-vault" ||
                typeof parsed.vaultPath !== "string" ||
                typeof parsed.fingerprint !== "string" ||
                typeof parsed.requestedAt !== "number"
            ) {
                return null;
            }
            return parsed as PendingVaultSyncRequest;
        } catch {
            return null;
        }
    }

    clearPendingVaultSyncRequest(): void {
        this.app.saveLocalStorage(
            this.prefix + "pendingVaultSyncRequest",
            undefined
        );
    }

    setPendingVaultSyncRequest(value: PendingVaultSyncRequest | null): void {
        if (value === null) {
            this.clearPendingVaultSyncRequest();
            return;
        }

        this.app.saveLocalStorage(
            this.prefix + "pendingVaultSyncRequest",
            JSON.stringify(value)
        );
    }

    takePendingVaultSyncRequestForPath(
        vaultPath: string,
        providedMaxAgeMs?: number
    ): PendingVaultSyncRequest | null {
        const pending = this.getPendingVaultSyncRequest();
        if (!pending) {
            return null;
        }

        const maxAgeMs =
            providedMaxAgeMs ?? this.getPendingVaultSyncRequestTTL();
        if (Date.now() - pending.requestedAt > maxAgeMs) {
            this.clearPendingVaultSyncRequest();
            return null;
        }

        if (pending.vaultPath !== vaultPath) {
            return null;
        }
        this.setPendingVaultSyncRequest(null);
        return pending;
    }

    /**
     * TTL (in ms) for pending vault sync requests. Can be extended to be
     * configurable in the future. Default is 5 minutes.
     */
    getPendingVaultSyncRequestTTL(): number {
        return 5 * 60 * 1000;
    }
}
