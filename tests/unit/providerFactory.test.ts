import { describe, it, expect } from "vitest";
import {
    buildActiveApiProvider,
    getSuggestedApiVaultName,
} from "../../src/setting/infra/providerFactory";
import type { ObsidianGitSettings } from "../../src/types";
import { DEFAULT_SETTINGS } from "../../src/constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSettings(
    patch: Partial<ObsidianGitSettings>
): ObsidianGitSettings {
    return { ...DEFAULT_SETTINGS, ...patch };
}

// ---------------------------------------------------------------------------
// buildActiveApiProvider
// ---------------------------------------------------------------------------
describe("buildActiveApiProvider", () => {
    it('returns null for provider "git"', () => {
        const plugin = {
            settings: makeSettings({ activeSyncProvider: "git" }),
        };
        expect(buildActiveApiProvider(plugin)).toBeNull();
    });

    const makeStubPlugin = (patch: Partial<ObsidianGitSettings>) => ({
        settings: makeSettings(patch),
        providerSecrets: { getToken: (_: string) => "" },
        localStorage: { getUsername: () => null, getPassword: () => null },
        app: {},
    });

    it('returns a GitHubApiSyncProvider for "github"', () => {
        const provider = buildActiveApiProvider(makeStubPlugin({ activeSyncProvider: "github" }));
        expect(provider).not.toBeNull();
        expect(provider?.constructor?.name).toBe("GitHubApiSyncProvider");
    });

    it('returns a GitLabApiSyncProvider for "gitlab"', () => {
        const provider = buildActiveApiProvider(makeStubPlugin({ activeSyncProvider: "gitlab" }));
        expect(provider).not.toBeNull();
        expect(provider?.constructor?.name).toBe("GitLabApiSyncProvider");
    });

    it('returns a GiteaApiSyncProvider for "gitea"', () => {
        const provider = buildActiveApiProvider(makeStubPlugin({ activeSyncProvider: "gitea" }));
        expect(provider).not.toBeNull();
        expect(provider?.constructor?.name).toBe("GiteaApiSyncProvider");
    });
});

// ---------------------------------------------------------------------------
// getSuggestedApiVaultName
// ---------------------------------------------------------------------------
describe("getSuggestedApiVaultName", () => {
    it('extracts the final path segment for "github" repo names', () => {
        const settings = makeSettings({
            activeSyncProvider: "github",
            githubRepo: "my-group%2Fmy-notes",
        });
        expect(getSuggestedApiVaultName(settings)).toBe("my-notes");
    });

    it('returns "imported-vault" when githubRepo is blank', () => {
        const settings = makeSettings({
            activeSyncProvider: "github",
            githubRepo: "  ",
        });
        expect(getSuggestedApiVaultName(settings)).toBe("imported-vault");
    });

    it('returns "imported-vault" when githubRepo decodes to an empty final segment', () => {
        const settings = makeSettings({
            activeSyncProvider: "github",
            githubRepo: "group/   ",
        });
        expect(getSuggestedApiVaultName(settings)).toBe("imported-vault");
    });

    it('extracts the final path segment for "gitlab" project IDs', () => {
        const settings = makeSettings({
            activeSyncProvider: "gitlab",
            gitlabProjectId: "my-group%2Fmy-notes",
        });
        expect(getSuggestedApiVaultName(settings)).toBe("my-notes");
    });

    it('returns "imported-vault" when gitlabProjectId is blank', () => {
        const settings = makeSettings({
            activeSyncProvider: "gitlab",
            gitlabProjectId: "",
        });
        expect(getSuggestedApiVaultName(settings)).toBe("imported-vault");
    });

    it('extracts the final path segment for "gitea" repo names', () => {
        const settings = makeSettings({
            activeSyncProvider: "gitea",
            giteaRepo: "forge%2Fvault-repo",
        });
        expect(getSuggestedApiVaultName(settings)).toBe("vault-repo");
    });

    it('returns "imported-vault" for provider "git"', () => {
        const settings = makeSettings({ activeSyncProvider: "git" });
        expect(getSuggestedApiVaultName(settings)).toBe("imported-vault");
    });
});
