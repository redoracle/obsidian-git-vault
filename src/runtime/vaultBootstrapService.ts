import { promises as fsPromises } from "fs";
import * as path from "path";
import { FileSystemAdapter } from "obsidian";
import { randomBytes } from "crypto";
import type ObsidianGit from "src/main";
import { DEFAULT_SETTINGS } from "src/constants";
import { PlatformGuard } from "src/platform/platformGuard";
import { getApiRepoFingerprint } from "src/syncProvider/repoIdentity";
import type { ObsidianGitSettings } from "src/types";

const PLUGIN_FILES_TO_COPY = [
    "main.js",
    "manifest.json",
    "styles.css",
] as const;

const SENSITIVE_GITIGNORE_ENTRIES = [
    "# Obsidian Git Vault - sensitive data",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".env",
    "*.token",
    "*.secret",
] as const;

const MAX_KEY_GEN_ATTEMPTS = 100;

type RegisteredVaultEntry = {
    path: string;
    ts: number;
    open: boolean;
};

type ObsidianRegistry = Record<string, unknown> & {
    vaults?: Record<string, RegisteredVaultEntry>;
};

class RegistryParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RegistryParseError";
        Object.setPrototypeOf(this, RegistryParseError.prototype);
        if (typeof Error.captureStackTrace === "function") {
            Error.captureStackTrace(this, RegistryParseError);
        }
    }
}

function isRegisteredVaultEntry(value: unknown): value is RegisteredVaultEntry {
    if (!value || typeof value !== "object") {
        return false;
    }

    const entry = value as Record<string, unknown>;
    return (
        typeof entry.path === "string" &&
        typeof entry.ts === "number" &&
        typeof entry.open === "boolean"
    );
}

function parseObsidianRegistry(raw: string): ObsidianRegistry {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new RegistryParseError(
            "Obsidian registry file must contain a JSON object."
        );
    }

    const registry = parsed as Record<string, unknown>;
    if (registry.vaults == null) {
        return {
            ...registry,
            vaults: {},
        };
    }

    if (
        typeof registry.vaults !== "object" ||
        Array.isArray(registry.vaults) ||
        registry.vaults === null
    ) {
        throw new RegistryParseError(
            "Obsidian registry vaults entry must be an object."
        );
    }

    for (const [key, value] of Object.entries(registry.vaults)) {
        if (typeof key !== "string" || !isRegisteredVaultEntry(value)) {
            throw new RegistryParseError(
                "Obsidian registry vault entries are malformed."
            );
        }
    }

    return {
        ...registry,
        vaults: registry.vaults as Record<string, RegisteredVaultEntry>,
    };
}

export interface DedicatedVaultBootstrapResult {
    vaultPath: string;
    registeredInSwitcher: boolean;
}

function toFsPath(...segments: string[]): string {
    return path.resolve(path.join(...segments));
}

export class VaultBootstrapService {
    constructor(private readonly plugin: ObsidianGit) {}

    async ensureSensitiveCurrentVaultGitignore(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            return;
        }

        await this.ensureSensitiveGitignoreAtVaultPath(
            path.resolve(adapter.getBasePath())
        );
        await this.clearHardeningFailure();
    }

    async recordHardeningFailure(
        vaultId: string,
        error: unknown
    ): Promise<void> {
        this.plugin.settings.vaultBootstrapHardeningFailure = {
            vaultId,
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
        };
        await this.plugin.saveSettings();
    }

    async clearHardeningFailure(): Promise<void> {
        if (this.plugin.settings.vaultBootstrapHardeningFailure == null) {
            return;
        }

        this.plugin.settings.vaultBootstrapHardeningFailure = null;
        await this.plugin.saveSettings();
    }

    async bootstrapDedicatedVault(
        targetVaultPath: string,
        onStatus?: (message: string) => void
    ): Promise<DedicatedVaultBootstrapResult> {
        // The user intentionally chooses the target vault directory; resolving canonicalizes that destination before writes.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const vaultPath = path.resolve(targetVaultPath);

        onStatus?.("Copying plugin…");
        await this.copyPluginIntoVault(vaultPath);

        onStatus?.("Securing config…");
        await this.writeSanitizedPluginData(vaultPath);
        await this.enablePluginInVault(vaultPath);
        await this.ensureSensitiveGitignoreAtVaultPath(vaultPath);

        onStatus?.("Registering vault…");
        const registeredInSwitcher = await this.registerVault(vaultPath);

        onStatus?.("Finalizing setup…");
        return {
            vaultPath,
            registeredInSwitcher,
        };
    }

    openVault(vaultPath: string): void {
        // obsidian://open?path= opens a *note file* by absolute path, not a vault.
        // obsidian://open?vault= opens a registered vault by its display name
        // (the folder basename), which is what we need after registerVault() has
        // written the new vault into Obsidian's registry.
        // This path is not used for filesystem access here; it is canonicalized to derive the registered vault name.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const normalizedVaultPath = path.resolve(vaultPath);
        const vaultName = path.basename(normalizedVaultPath);
        const deeplink = `obsidian://open?vault=${encodeURIComponent(vaultName)}`;
        window.open(deeplink, "_blank");
    }

    async readRegisteredVaults(): Promise<ObsidianRegistry | null> {
        const registryPath = PlatformGuard.getObsidianConfigPath();
        if (!registryPath) {
            return null;
        }

        try {
            const raw = await fsPromises.readFile(registryPath, "utf8");
            return parseObsidianRegistry(raw);
        } catch (error) {
            const errorCode =
                error instanceof Error && "code" in error
                    ? (error as NodeJS.ErrnoException).code
                    : undefined;
            if (errorCode === "ENOENT") {
                return {};
            }
            if (
                errorCode === "EACCES" ||
                errorCode === "EPERM" ||
                errorCode === "EROFS" ||
                errorCode === "EBUSY"
            ) {
                console.warn(
                    "[Git Vault] Failed to inspect Obsidian registry:",
                    error
                );
                return null;
            }
            if (
                error instanceof SyntaxError ||
                error instanceof RegistryParseError
            ) {
                console.warn(
                    "[Git Vault] Refusing to overwrite malformed Obsidian registry:",
                    error
                );
                return null;
            }
            console.error(
                "[Git Vault] Failed to inspect Obsidian registry:",
                error
            );
            return null;
        }
    }

    private async copyPluginIntoVault(vaultPath: string): Promise<void> {
        const pluginDir = toFsPath(
            vaultPath,
            this.plugin.app.vault.configDir,
            "plugins",
            this.plugin.manifest.id
        );
        try {
            await fsPromises.mkdir(pluginDir, { recursive: true });
        } catch (mkdirError) {
            // On macOS/Linux, mkdir({recursive:true}) still throws EEXIST when
            // the target path is a FILE rather than a directory.  This happens
            // when the remote repo stored the plugin as a flat blob (e.g. an
            // older single-file bundle) and exportRemoteToDirectory wrote it as
            // a regular file.  Remove the stale blob and retry.
            if (
                mkdirError instanceof Error &&
                "code" in mkdirError &&
                (mkdirError as NodeJS.ErrnoException).code === "EEXIST"
            ) {
                await fsPromises.unlink(pluginDir);
                await fsPromises.mkdir(pluginDir, { recursive: true });
            } else {
                throw mkdirError;
            }
        }

        const sourcePluginDir = this.resolveCurrentPluginDir();
        for (const fileName of PLUGIN_FILES_TO_COPY) {
            const sourcePath = toFsPath(sourcePluginDir, fileName);
            const targetPath = toFsPath(pluginDir, fileName);
            try {
                await fsPromises.copyFile(sourcePath, targetPath);
            } catch (error) {
                if (
                    fileName === "styles.css" &&
                    error instanceof Error &&
                    "code" in error &&
                    (error as NodeJS.ErrnoException).code === "ENOENT"
                ) {
                    continue;
                }
                throw new Error(
                    `Failed to copy ${fileName} into the cloned vault: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    }

    private async writeSanitizedPluginData(vaultPath: string): Promise<void> {
        const dataPath = toFsPath(
            vaultPath,
            this.plugin.app.vault.configDir,
            "plugins",
            this.plugin.manifest.id,
            "data.json"
        );
        const settings = this.buildSanitizedSettings();
        await fsPromises.writeFile(
            dataPath,
            JSON.stringify(settings, null, 2),
            "utf8"
        );
    }

    private buildSanitizedSettings(): ObsidianGitSettings {
        const baseSettings = JSON.parse(
            JSON.stringify(DEFAULT_SETTINGS)
        ) as ObsidianGitSettings;
        const activeProvider = this.plugin.settings.activeSyncProvider;
        baseSettings.activeSyncProvider = activeProvider;
        baseSettings.syncMode = this.plugin.settings.syncMode;
        baseSettings.trackedDirectory = this.plugin.settings.trackedDirectory;
        baseSettings.syncExcludePaths = [
            ...this.plugin.settings.syncExcludePaths,
        ];
        baseSettings.apiEncryptionEnabled =
            this.plugin.settings.apiEncryptionEnabled;
        baseSettings.vaultBootstrapPending =
            activeProvider !== "git" ||
            this.plugin.settings.apiEncryptionEnabled;

        switch (activeProvider) {
            case "github":
                baseSettings.githubOwner = this.plugin.settings.githubOwner;
                baseSettings.githubRepo = this.plugin.settings.githubRepo;
                baseSettings.githubBranch = this.plugin.settings.githubBranch;
                break;
            case "gitlab":
                baseSettings.gitlabBaseUrl = this.plugin.settings.gitlabBaseUrl;
                baseSettings.gitlabProjectId =
                    this.plugin.settings.gitlabProjectId;
                baseSettings.gitlabBranch = this.plugin.settings.gitlabBranch;
                break;
            case "gitea":
                baseSettings.giteaBaseUrl = this.plugin.settings.giteaBaseUrl;
                baseSettings.giteaOwner = this.plugin.settings.giteaOwner;
                baseSettings.giteaRepo = this.plugin.settings.giteaRepo;
                baseSettings.giteaBranch = this.plugin.settings.giteaBranch;
                break;
            case "git":
                break;
        }

        baseSettings.lastSyncedRepoFingerprint =
            activeProvider === "git"
                ? this.plugin.settings.lastSyncedRepoFingerprint
                : getApiRepoFingerprint(this.plugin.settings, activeProvider) ??
                  "";

        baseSettings.githubToken = "";
        baseSettings.apiEncryptionPassphraseFingerprint = "";
        baseSettings.apiEncryptionPassphraseRepoFingerprint = "";

        // Carry the provider token into data.json (which is gitignored) so
        // the newly cloned vault can sync immediately without requiring the
        // user to re-enter credentials.  SettingsMigrationService.migrate()
        // transfers this value into Obsidian secretStorage on the first launch
        // of the new vault and then clears it from the settings object.
        if (
            activeProvider === "github" ||
            activeProvider === "gitlab" ||
            activeProvider === "gitea"
        ) {
            const token = this.plugin.providerSecrets.getToken(activeProvider);
            if (token) {
                baseSettings.bootstrapProviderToken = token;
            }
        }

        return baseSettings;
    }

    private async enablePluginInVault(vaultPath: string): Promise<void> {
        const pluginsFilePath = toFsPath(
            vaultPath,
            this.plugin.app.vault.configDir,
            "community-plugins.json"
        );

        let plugins: string[] = [];
        try {
            const raw = await fsPromises.readFile(pluginsFilePath, "utf8");
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) {
                plugins = parsed.filter(
                    (value): value is string => typeof value === "string"
                );
            }
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                (error as NodeJS.ErrnoException).code !== "ENOENT"
            ) {
                console.warn(
                    "[Git Vault] Failed to read community-plugins.json; recreating it:",
                    error
                );
            }
        }

        if (!plugins.includes(this.plugin.manifest.id)) {
            plugins.push(this.plugin.manifest.id);
        }

        await fsPromises.mkdir(path.dirname(pluginsFilePath), {
            recursive: true,
        });
        await fsPromises.writeFile(
            pluginsFilePath,
            JSON.stringify(plugins, null, 2),
            "utf8"
        );
    }

    private async ensureSensitiveGitignoreAtVaultPath(
        vaultPath: string
    ): Promise<void> {
        const gitignorePath = toFsPath(vaultPath, ".gitignore");
        let existing = "";
        try {
            existing = await fsPromises.readFile(gitignorePath, "utf8");
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                (error as NodeJS.ErrnoException).code !== "ENOENT"
            ) {
                throw error;
            }
        }

        const lines = existing.split(/\r?\n/u).map((line) => line.trimEnd());
        const present = new Set(lines.filter((line) => line.length > 0));
        const pluginDataEntries = [
            `.obsidian/plugins/${this.plugin.manifest.id}/data.json`,
            ".obsidian/plugins/obsidian-git-vault/data.json",
        ];
        const additions = [
            ...SENSITIVE_GITIGNORE_ENTRIES,
            ...pluginDataEntries,
        ].filter((entry) => !present.has(entry));
        if (additions.length === 0) {
            return;
        }

        const prefix =
            existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        await fsPromises.writeFile(
            gitignorePath,
            `${existing}${prefix}${additions.join("\n")}\n`,
            "utf8"
        );
    }

    private async registerVault(vaultPath: string): Promise<boolean> {
        const registryPath = PlatformGuard.getObsidianConfigPath();
        if (!registryPath || !PlatformGuard.canWriteGlobalRegistry()) {
            return false;
        }

        const registry = await this.readRegisteredVaults();
        if (!registry) {
            return false;
        }

        // registerVault stores an intentionally selected vault directory; path.resolve canonicalizes registry comparisons.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const normalizedVaultPath = path.resolve(vaultPath);
        const vaults = { ...(registry.vaults ?? {}) };

        for (const [key, entry] of Object.entries(vaults)) {
            if (path.resolve(entry.path) === normalizedVaultPath) {
                vaults[key] = {
                    path: normalizedVaultPath,
                    ts: Date.now(),
                    open: false,
                };
                await this.writeRegistryAtomically(registryPath, {
                    ...registry,
                    vaults,
                });
                return true;
            }
        }

        let key = this.generateVaultKey();
        let attempts = 0;
        while (vaults[key]) {
            attempts += 1;
            if (attempts >= MAX_KEY_GEN_ATTEMPTS) {
                console.error(
                    "[Git Vault] Failed to generate a unique vault registry key after",
                    attempts,
                    "attempt(s); bootstrap registration failed."
                );
                return false;
            }
            key = this.generateVaultKey();
        }

        vaults[key] = {
            path: normalizedVaultPath,
            ts: Date.now(),
            open: false,
        };
        await this.writeRegistryAtomically(registryPath, {
            ...registry,
            vaults,
        });
        return true;
    }

    private async writeRegistryAtomically(
        registryPath: string,
        registry: ObsidianRegistry
    ): Promise<void> {
        await fsPromises.mkdir(path.dirname(registryPath), { recursive: true });
        const tempPath = `${registryPath}.${process.pid}.tmp`;
        await fsPromises.writeFile(
            tempPath,
            JSON.stringify(registry, null, 2),
            "utf8"
        );
        await fsPromises.rename(tempPath, registryPath);
    }

    private generateVaultKey(): string {
        return randomBytes(4).toString("hex");
    }

    private resolveCurrentPluginDir(): string {
        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            throw new Error(
                "This runtime does not expose a desktop file-system adapter for plugin bootstrap."
            );
        }

        const configDir = this.plugin.app.vault.configDir;
        const manifestDir =
            (this.plugin.manifest as { dir?: string }).dir ??
            this.plugin.manifest.id;
        const normalizedManifestDir = manifestDir.replace(/\\/g, "/");
        const pluginRelativePrefix = `${configDir}/plugins/`;
        const pluginDir = path.isAbsolute(normalizedManifestDir)
            ? normalizedManifestDir
            : normalizedManifestDir.startsWith(pluginRelativePrefix)
              ? toFsPath(adapter.getBasePath(), normalizedManifestDir)
              : toFsPath(
                    adapter.getBasePath(),
                    configDir,
                    "plugins",
                    normalizedManifestDir
                );

        return path.resolve(pluginDir);
    }
}
