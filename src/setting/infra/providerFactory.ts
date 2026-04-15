import { ApiSyncProvider } from "src/syncProvider/apiSyncProvider";
import { GiteaApiSyncProvider } from "src/syncProvider/giteaApiSyncProvider";
import { GitHubApiSyncProvider } from "src/syncProvider/githubApiSyncProvider";
import { GitLabApiSyncProvider } from "src/syncProvider/gitlabApiSyncProvider";
import type { ObsidianGitSettings } from "src/types";

/**
 * Pure factory helpers that turn current settings into concrete provider
 * objects.  No I/O, no async — safe to call synchronously during display
 * rendering.
 *
 * Extracted from `ObsidianGitSettingsTab` to enable unit-testing provider
 * selection logic without mounting the Obsidian plugin shell.
 *
 * Consumers must supply the full `plugin` shell because each provider
 * constructor requires it.  The factory itself only reads `settings`.
 */

/** Minimal plugin shape the factory needs. */
export interface IProviderFactoryPlugin {
    settings: ObsidianGitSettings;
}

function suggestedVaultNameFromRepository(value: string | undefined): string {
    let decoded = value || "";
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        // Fall back to the raw repository value if it is not valid URI-encoded text.
    }
    const parts = decoded.split("/").filter((part) => part.length > 0);
    return parts[parts.length - 1]?.trim() || "imported-vault";
}

/**
 * Build the concrete `ApiSyncProvider` for the active sync backend.
 * Returns `null` when the provider is `"git"` (no API provider needed).
 */
export function buildActiveApiProvider(
    plugin: IProviderFactoryPlugin
): ApiSyncProvider | null {
    switch (plugin.settings.activeSyncProvider) {
        case "github":
            return new GitHubApiSyncProvider(plugin as never);
        case "gitlab":
            return new GitLabApiSyncProvider(plugin as never);
        case "gitea":
            return new GiteaApiSyncProvider(plugin as never);
        case "git":
            return null;
        default:
            return null;
    }
}

/**
 * Return an appropriate default vault-folder name based on the active provider
 * and its configured repository/project settings.
 */
export function getSuggestedApiVaultName(
    settings: ObsidianGitSettings
): string {
    switch (settings.activeSyncProvider) {
        case "github":
            return suggestedVaultNameFromRepository(settings.githubRepo);
        case "gitlab": {
            return suggestedVaultNameFromRepository(settings.gitlabProjectId);
        }
        case "gitea":
            return suggestedVaultNameFromRepository(settings.giteaRepo);
        case "git":
            return "imported-vault";
        default:
            return "imported-vault";
    }
}
