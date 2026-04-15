import type { IPluginContext } from "src/pluginContext";
import type ObsidianGit from "src/main";
import {
    encryptionFingerprintsMatch,
    fingerprintsMatch,
    getApiRepoFingerprint,
    getGitRepoFingerprint,
} from "src/syncProvider/repoIdentity";
import {
    computeLegacyPassphraseFingerprint,
    computePassphraseFingerprint,
} from "src/syncProvider/apiEncryption";
import { splitRemoteBranch } from "src/utils";
import { GeneralModal } from "src/ui/modals/generalModal";

/**
 * Constant that acts as a sentinel fingerprint, signalling that the next sync
 * must take the "pull rebaseline" path before any push can occur.
 */
export const REBASELINE_REQUIRED = "__sync-pro:rebaseline-required__";

/**
 * Domain service handling all fingerprint- and encryption-binding logic that
 * ties a sync repo identity to the local device settings.
 *
 * Previously spread across multiple private methods of `ObsidianGitSettingsTab`.
 * Extracted here so that:
 *  - The logic is unit-testable without mounting the Obsidian plugin shell.
 *  - Settings tab concerns (display, debouncing) are cleanly separated from
 *    domain concerns (what constitutes a "repo change", when rebaseline is
 *    needed).
 *
 * Constructor injects:
 *  - `plugin` — the narrow `IPluginContext` interface (settings + save + notice)
 *  - `getConcretePlugin` — a thunk returning the concrete `ObsidianGit` shell,
 *    needed only by `GeneralModal` in `resetEncryptionBindingForCurrentRepo`.
 *    Kept separate so unit tests never have to construct the full plugin.
 *  - `reloadSyncManager` — async callback to trigger sync manager reload
 *  - `onRedraw` — callback to trigger settings tab redraw
 */
export class RepoBindingService {
    constructor(
        private readonly plugin: IPluginContext,
        private readonly getConcretePlugin: () => ObsidianGit,
        private readonly reloadSyncManager: () => Promise<void>,
        private readonly onRedraw: () => void
    ) {}

    /**
     * Mark that a rebaseline is required by setting `lastSyncedRepoFingerprint`
     * to the sentinel value and clearing the external manifest store, then
     * persisting.
     */
    async markSyncBaselineRequired(): Promise<void> {
        this.plugin.settings.lastSyncedRepoFingerprint = REBASELINE_REQUIRED;
        this.plugin.settings.lastSyncManifestIsSummary = false;
        await this.plugin.syncManifestStore.clearSyncManifest();
        await this.plugin.saveSettings();
    }

    getCurrentRepoEncryptionBindingState(): {
        currentRepoFingerprint: string | null;
        storedRepoFingerprint: string;
        storedPassphraseFingerprint: string;
        appliesToCurrentRepo: boolean;
    } {
        const currentRepoFingerprint = this.computeActiveApiRepoFingerprint();
        const storedRepoFingerprint =
            this.plugin.settings.apiEncryptionPassphraseRepoFingerprint ?? "";
        const storedPassphraseFingerprint =
            this.plugin.settings.apiEncryptionPassphraseFingerprint ?? "";

        return {
            currentRepoFingerprint,
            storedRepoFingerprint,
            storedPassphraseFingerprint,
            appliesToCurrentRepo:
                !!currentRepoFingerprint &&
                !!storedRepoFingerprint &&
                !!storedPassphraseFingerprint &&
                encryptionFingerprintsMatch(
                    storedRepoFingerprint,
                    currentRepoFingerprint
                ),
        };
    }

    /**
     * Public wrapper around {@link getActiveApiRepoFingerprint} so callers can
     * depend on a stable method name while the repo-fingerprint derivation
     * logic stays centralized in the private helper.
     */
    computeActiveApiRepoFingerprint(): string | null {
        return this.getActiveApiRepoFingerprint();
    }

    async validateEncryptionPassphraseForCurrentRepo(
        passphrase: string,
        options?: { treatAsEnabled?: boolean }
    ): Promise<string | null> {
        const encryptionEnabled =
            options?.treatAsEnabled ??
            this.plugin.settings.apiEncryptionEnabled;
        if (!encryptionEnabled) return null;
        if (!passphrase) {
            return "Git Vault: Cannot clear the encryption passphrase while encrypted API sync is enabled.";
        }

        const currentRepoFingerprint = this.computeActiveApiRepoFingerprint();
        const storedRepoFingerprint =
            this.plugin.settings.apiEncryptionPassphraseRepoFingerprint ?? "";
        const storedPassphraseFingerprint =
            this.plugin.settings.apiEncryptionPassphraseFingerprint ?? "";

        if (
            !currentRepoFingerprint ||
            !storedRepoFingerprint ||
            !storedPassphraseFingerprint ||
            !encryptionFingerprintsMatch(
                storedRepoFingerprint,
                currentRepoFingerprint
            )
        ) {
            return null;
        }

        const currentFingerprint =
            await computePassphraseFingerprint(passphrase);
        if (currentFingerprint === storedPassphraseFingerprint) {
            return null;
        }

        const legacyFingerprint =
            await computeLegacyPassphraseFingerprint(passphrase);
        if (legacyFingerprint === storedPassphraseFingerprint) {
            await this.persistCurrentPassphraseFingerprint(currentFingerprint);
            return null;
        }

        return 'Git Vault: This repo was previously synced with a different encryption passphrase on this device. Automatic passphrase rotation is not supported. Re-enter the original passphrase, or use "Forget encryption binding" from Remote actions only if you intentionally reset the remote and want to start over.';
    }

    async resetEncryptionBindingForCurrentRepo(): Promise<void> {
        const binding = this.getCurrentRepoEncryptionBindingState();
        if (!binding.appliesToCurrentRepo) {
            this.plugin.makeSyncNotice(
                "Git Vault: there is no stored encryption binding for the currently selected API repo on this device.",
                7000
            );
            return;
        }

        const expectedConfirmation = "FORGET ENCRYPTION BINDING";
        const confirmation = await new GeneralModal(this.getConcretePlugin(), {
            placeholder: `Type ${expectedConfirmation} to confirm`,
            allowEmpty: false,
        }).openAndGetResult();
        if (confirmation !== expectedConfirmation) {
            this.plugin.makeSyncNotice(
                "Aborted encryption binding reset",
                5000
            );
            return;
        }

        // These setting mutations are persisted indirectly by
        // markSyncBaselineRequired(), which clears the manifest state and then
        // calls saveSettings().
        this.plugin.settings.apiEncryptionEnabled = false;
        this.plugin.settings.apiEncryptionPassphraseFingerprint = "";
        this.plugin.settings.apiEncryptionPassphraseRepoFingerprint = "";
        await this.markSyncBaselineRequired();
        await this.reloadSyncManager();
        this.onRedraw();
        this.plugin.makeSyncNotice(
            "Git Vault: cleared the local encryption binding for this repo and disabled encrypted API sync. Existing encrypted remote files are unchanged. Set the intended passphrase, then re-enable encryption only after the remote has been reset or replaced.",
            12000
        );
    }

    // -------------------------------------------------------------------------
    // Fingerprint helpers
    // -------------------------------------------------------------------------

    private async persistCurrentPassphraseFingerprint(
        currentFingerprint: string
    ): Promise<void> {
        this.plugin.settings.apiEncryptionPassphraseFingerprint =
            currentFingerprint;
        await this.plugin.saveSettings();
    }

    /**
     * Derive the fingerprint for the currently configured API repo (GitHub /
     * GitLab / Gitea).  Returns `null` when the active provider is `"git"` or
     * when settings are incomplete.
     */
    private getActiveApiRepoFingerprint(): string | null {
        const provider = this.plugin.settings.activeSyncProvider;
        if (provider === "git") return null;
        return getApiRepoFingerprint(this.plugin.settings, provider);
    }

    /**
     * Derive the fingerprint for the locally checked-out git repo (remote URL +
     * branch).  Returns `null` when git is not ready or the repo has no
     * configured remote/branch.
     */
    async getCurrentGitRepoFingerprint(): Promise<string | null> {
        const plugin = this.getConcretePlugin();
        if (!plugin.gitReady) return null;

        const branchInfo = await plugin.gitManager
            .branchInfo()
            .catch(() => null);
        if (!branchInfo) return null;

        const branch = branchInfo.current;
        const tracking = branchInfo.tracking;
        const [remoteFromTracking] = tracking
            ? splitRemoteBranch(tracking)
            : [];
        const remoteName =
            remoteFromTracking ??
            (await plugin.gitManager.getRemotes().catch(() => [])).first();
        if (!remoteName || !branch) return null;

        const remoteUrl = await plugin.gitManager
            .getRemoteUrl(remoteName)
            .catch(() => undefined);
        return getGitRepoFingerprint(remoteUrl, branch);
    }

    /**
     * Should the API provider bootstrap a fresh pull before syncing?
     *
     * Returns `true` when the currently configured API repo fingerprint
     * diverges from both the last-synced fingerprint AND the local git repo
     * fingerprint (meaning this is a genuinely new remote).
     */
    async shouldBootstrapApiProvider(): Promise<boolean> {
        const currentFingerprint = this.getActiveApiRepoFingerprint();
        if (!currentFingerprint) return false;

        const lastFingerprint = this.plugin.settings.lastSyncedRepoFingerprint;
        if (fingerprintsMatch(lastFingerprint, currentFingerprint)) {
            return false;
        }

        const localGitFingerprint = await this.getCurrentGitRepoFingerprint();
        if (fingerprintsMatch(localGitFingerprint, currentFingerprint)) {
            return false;
        }

        return true;
    }
}
