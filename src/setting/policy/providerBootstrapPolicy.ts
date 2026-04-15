import * as fsPromises from "fs/promises";
import * as path from "path";
import { FileSystemAdapter, Platform } from "obsidian";
import type { IPluginContext } from "src/pluginContext";
import type ObsidianGit from "src/main";
import { VaultBootstrapService } from "src/runtime/vaultBootstrapService";
import type { RepoBindingService } from "./repoBindingService";
import {
    buildActiveApiProvider,
    getSuggestedApiVaultName,
} from "../infra/providerFactory";
import { GeneralModal } from "src/ui/modals/generalModal";
import { SetupProgressModal } from "src/ui/modals/setupProgressModal";
import { VaultBootstrapModal } from "src/ui/modals/vaultBootstrapModal";

/**
 * Policy orchestrator for provider bootstrap actions (first-sync pull,
 * dedicated vault import, symlink detection).
 *
 * Previously implemented as a cluster of private methods inside
 * `ObsidianGitSettingsTab`. Extracted here so that:
 *  - The orchestration logic is unit-testable in isolation.
 *  - `ObsidianGitSettingsTab` can delegate instead of owning the logic.
 *
 * Constructor injects:
 *  - `plugin` — narrow `IPluginContext` for settings and notice
 *  - `getConcretePlugin` — thunk for `ObsidianGit` (needed by modal + providers)
 *  - `repoBinding` — `RepoBindingService` (fingerprint & bootstrap decision)
 *  - `reloadSyncManager` — async callback to reload the sync manager
 */
export class ProviderBootstrapPolicy {
    constructor(
        private readonly plugin: IPluginContext,
        private readonly getConcretePlugin: () => ObsidianGit,
        private readonly repoBinding: RepoBindingService,
        private readonly reloadSyncManager: () => Promise<void>
    ) {}

    /**
     * Detect whether any Obsidian config paths are behind a symlink.
     * Symlinked config paths can cause plugin state or workspace files to
     * behave unpredictably during sync bootstrap on macOS.
     *
     * Returns a human-readable warning string, or `null` if none detected.
     */
    async detectObsidianSymlinkIssue(): Promise<string | null> {
        if (!Platform.isDesktopApp) return null;

        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return null;

        const configRoot = path.join(
            adapter.getBasePath(),
            this.plugin.app.vault.configDir
        );
        const pathsToCheck = [
            configRoot,
            path.join(configRoot, "plugins"),
            path.join(configRoot, "themes"),
            path.join(configRoot, "snippets"),
            path.join(configRoot, "workspace.json"),
        ];

        for (const candidate of pathsToCheck) {
            try {
                const stat = await fsPromises.lstat(candidate);
                if (stat.isSymbolicLink()) {
                    return `Obsidian config path is symlinked: ${candidate}. This can cause plugin state, hot-reload, or workspace files to behave unpredictably during sync bootstrap.`;
                }
            } catch (err) {
                if (
                    !(err instanceof Error) ||
                    (err as NodeJS.ErrnoException).code !== "ENOENT"
                ) {
                    console.debug(
                        "[Git Vault] lstat failed for candidate path:",
                        candidate,
                        err instanceof Error ? err.message : err
                    );
                }
                // ENOENT is expected — path doesn't exist yet; continue.
            }
        }

        return null;
    }

    /**
     * Run a provider-aware sync after checking whether a bootstrap pull is
     * required first.  Surfaces symlink warnings to the user before proceeding.
     */
    async runProviderBootstrapOrSync(): Promise<void> {
        const symlinkIssue = await this.detectObsidianSymlinkIssue();
        if (symlinkIssue) {
            this.plugin.makeSyncNotice(symlinkIssue, 9000);
            return;
        }

        const bootstrapService = new VaultBootstrapService(
            this.getConcretePlugin()
        );
        const vaultId =
            this.plugin.app.vault.adapter instanceof FileSystemAdapter
                ? path.resolve(this.plugin.app.vault.adapter.getBasePath())
                : this.plugin.app.vault.getName();

        await bootstrapService
            .ensureSensitiveCurrentVaultGitignore()
            .catch(async (error) => {
                console.warn(
                    "[Git Vault] Failed to harden the current vault .gitignore:",
                    error
                );
                await bootstrapService.recordHardeningFailure(vaultId, error);
                this.plugin.makeSyncNotice(
                    "Git Vault: could not harden the current vault .gitignore. Sensitive files may not be excluded.",
                    9000
                );
            });

        await this.reloadSyncManager();
        if (this.plugin.syncManager == null) {
            console.error(
                "[Git Vault] syncManager failed to initialize; aborting sync."
            );
            return;
        }

        const shouldBootstrap =
            await this.repoBinding.shouldBootstrapApiProvider();
        if (shouldBootstrap) {
            this.plugin.makeSyncNotice(
                "Git Vault: no matching local baseline found for this remote. Pulling remote contents first.",
                6000
            );
            await this.plugin.syncManager.pullNow();
            return;
        }

        await this.plugin.syncManager.syncNow();
    }

    /**
     * Clone the active API remote into a new, standalone Obsidian vault folder
     * on the local filesystem.
     *
     * Only available on desktop.  Prompts the user for a target directory,
     * validates it is outside the current vault, then calls
     * `provider.exportRemoteToDirectory()`.
     */
    async importActiveApiRepoAsDedicatedVault(): Promise<void> {
        if (!Platform.isDesktopApp) {
            this.plugin.makeSyncNotice(
                "Git Vault: dedicated vault import is only available on desktop.",
                6000
            );
            return;
        }

        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            this.plugin.makeSyncNotice(
                "Git Vault: this platform does not expose a desktop filesystem adapter for dedicated vault import.",
                7000
            );
            return;
        }

        const concretePlugin = this.getConcretePlugin();
        const provider = buildActiveApiProvider(concretePlugin);
        if (!provider) {
            this.plugin.makeSyncNotice(
                "Git Vault: select an API backend before importing a dedicated vault.",
                6000
            );
            return;
        }

        try {
            await provider.init();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error("[Git Vault] provider.init failed:", error);
            this.plugin.makeSyncNotice(
                `Git Vault: failed to initialize the active provider – ${msg}`,
                9000
            );
            return;
        }

        if (
            concretePlugin.settings.apiEncryptionEnabled &&
            !concretePlugin.providerSecrets.getEncryptionPassphrase()
        ) {
            this.plugin.makeSyncNotice(
                "Git Vault: this remote uses encrypted API sync. Enter the encryption passphrase on this device before importing or cloning a dedicated vault.",
                9000
            );
            return;
        }

        const currentVaultPath = path.resolve(adapter.getBasePath());
        const parentDir = path.dirname(currentVaultPath);
        const suggestedPath = path.join(
            parentDir,
            getSuggestedApiVaultName(this.plugin.settings)
        );

        const requestedPath = await new GeneralModal(concretePlugin, {
            placeholder:
                "Choose a folder for the imported vault (absolute path or sibling name)",
            initialValue: suggestedPath,
        }).openAndGetResult();
        if (!requestedPath) return;

        const targetDir = path.resolve(
            path.isAbsolute(requestedPath)
                ? requestedPath
                : path.join(parentDir, requestedPath)
        );

        if (
            targetDir === currentVaultPath ||
            targetDir.startsWith(`${currentVaultPath}${path.sep}`) ||
            currentVaultPath.startsWith(`${targetDir}${path.sep}`)
        ) {
            this.plugin.makeSyncNotice(
                "Git Vault: dedicated vault import must target a directory outside the currently open vault.",
                7000
            );
            return;
        }

        try {
            const stat = await fsPromises.stat(targetDir);
            if (stat.isDirectory()) {
                const entries = await fsPromises.readdir(targetDir);
                if (entries.length > 0) {
                    this.plugin.makeSyncNotice(
                        "Git Vault: target directory already exists and is not empty.",
                        7000
                    );
                    return;
                }
            } else {
                this.plugin.makeSyncNotice(
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
            try {
                await fsPromises.mkdir(targetDir, { recursive: true });
            } catch (mkdirError) {
                const msg =
                    mkdirError instanceof Error
                        ? mkdirError.message
                        : String(mkdirError);
                this.plugin.makeSyncNotice(
                    `Git Vault: failed to create target directory – ${msg}`,
                    7000
                );
                return;
            }
        }

        const progressModal = new SetupProgressModal(
            concretePlugin.app,
            "Setting up dedicated vault"
        );
        progressModal.open();

        try {
            progressModal.setStatus("Cloning repo…");
            const written = await provider.exportRemoteToDirectory(targetDir);

            const bootstrapService = new VaultBootstrapService(concretePlugin);
            const result = await bootstrapService.bootstrapDedicatedVault(
                targetDir,
                (message) => progressModal.setStatus(message)
            );

            progressModal.close();
            new VaultBootstrapModal(concretePlugin.app, {
                mode: "success",
                vaultPath: result.vaultPath,
                registeredInSwitcher: result.registeredInSwitcher,
                onOpenVault: () => bootstrapService.openVault(result.vaultPath),
            }).open();
            this.plugin.makeSyncNotice(
                `Git Vault: imported ${written} file(s) into ${targetDir}.`,
                7000
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const failureMsg = `Git Vault: import failed – ${msg}`;
            console.error("[Git Vault] exportRemoteToDirectory failed:", err);
            progressModal.markFailed(failureMsg);
            this.plugin.makeSyncNotice(failureMsg, 9000);
        }
    }
}
