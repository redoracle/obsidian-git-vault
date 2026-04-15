import { describe, it, expect, vi } from "vitest";
import {
    RepoBindingService,
    REBASELINE_REQUIRED,
} from "../../src/setting/policy/repoBindingService";
import { DEFAULT_SETTINGS } from "../../src/constants";
import type { ObsidianGitSettings } from "../../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSettings(
    patch: Partial<ObsidianGitSettings> = {}
): ObsidianGitSettings {
    return { ...DEFAULT_SETTINGS, ...patch };
}

function makePlugin(settingsPatch: Partial<ObsidianGitSettings> = {}) {
    const settings = makeSettings(settingsPatch);
    const syncManifestStore = {
        data: { manifest: [] as string[], sample: [] as string[] },
        saveSyncManifest: vi.fn().mockResolvedValue(undefined),
        clearSyncManifest: vi.fn().mockResolvedValue(undefined),
        getSyncManifest: vi.fn().mockResolvedValue([]),
        loadSyncManifestSample: vi.fn().mockResolvedValue([]),
    };
    return {
        settings,
        syncManifestStore,
        saveSettings: vi.fn().mockResolvedValue(undefined),
        makeSyncNotice: vi.fn(),
        app: { vault: { adapter: {}, configDir: ".obsidian" } },
    };
}

function makeConcretePlugin() {
    return {
        gitReady: false,
        gitManager: {
            branchInfo: vi.fn().mockResolvedValue({ current: null, tracking: null, branches: [] }),
            getRemotes: vi.fn().mockResolvedValue([]),
            getRemoteUrl: vi.fn().mockResolvedValue(undefined),
        },
    };
}

function makeService(
    settingsPatch: Partial<ObsidianGitSettings> = {},
    concretePatch: Partial<ReturnType<typeof makeConcretePlugin>> = {}
) {
    const plugin = makePlugin(settingsPatch);
    const concreteBase = makeConcretePlugin();
    const concrete = { ...concreteBase, ...concretePatch };
    const reloadSyncManager = vi.fn().mockResolvedValue(undefined);
    const onRedraw = vi.fn();
    const service = new RepoBindingService(
        plugin as never,
        () => concrete as never,
        reloadSyncManager,
        onRedraw
    );
    return { service, plugin, concrete, reloadSyncManager, onRedraw };
}

// ---------------------------------------------------------------------------
// markSyncBaselineRequired
// ---------------------------------------------------------------------------
describe("RepoBindingService.markSyncBaselineRequired", () => {
    it("sets lastSyncedRepoFingerprint to the sentinel constant", async () => {
        const { service, plugin } = makeService();
        await service.markSyncBaselineRequired();
        expect(plugin.settings.lastSyncedRepoFingerprint).toBe(
            REBASELINE_REQUIRED
        );
    });

    it("clears the sync manifests", async () => {
        const { service, plugin } = makeService();
        await service.markSyncBaselineRequired();
        expect(plugin.syncManifestStore.clearSyncManifest).toHaveBeenCalledOnce();
        expect(plugin.settings.lastSyncManifestIsSummary).toBe(false);
    });

    it("calls saveSettings after mutating", async () => {
        const { service, plugin } = makeService();
        await service.markSyncBaselineRequired();
        expect(plugin.saveSettings).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// computeActiveApiRepoFingerprint
// ---------------------------------------------------------------------------
describe("RepoBindingService.computeActiveApiRepoFingerprint", () => {
    it('returns null when activeSyncProvider is "git"', () => {
        const { service } = makeService({ activeSyncProvider: "git" });
        expect(service.computeActiveApiRepoFingerprint()).toBeNull();
    });

    it('returns a string for "github" provider with an owner+repo', () => {
        const { service } = makeService({
            activeSyncProvider: "github",
            githubOwner: "alice",
            githubRepo: "notes",
        });
        const fp = service.computeActiveApiRepoFingerprint();
        expect(fp).toBeTruthy();
        expect(typeof fp).toBe("string");
    });
});

// ---------------------------------------------------------------------------
// getCurrentRepoEncryptionBindingState
// ---------------------------------------------------------------------------
describe("RepoBindingService.getCurrentRepoEncryptionBindingState", () => {
    it("appliesToCurrentRepo is false when there are no stored fingerprints", () => {
        const { service } = makeService({
            activeSyncProvider: "github",
            githubOwner: "alice",
            githubRepo: "notes",
            apiEncryptionPassphraseRepoFingerprint: "",
            apiEncryptionPassphraseFingerprint: "",
        });
        const state = service.getCurrentRepoEncryptionBindingState();
        expect(state.appliesToCurrentRepo).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// shouldBootstrapApiProvider
// ---------------------------------------------------------------------------
describe("RepoBindingService.shouldBootstrapApiProvider", () => {
    it('returns false when activeSyncProvider is "git"', async () => {
        const { service } = makeService({ activeSyncProvider: "git" });
        expect(await service.shouldBootstrapApiProvider()).toBe(false);
    });

    it("returns false when the fingerprint matches the last synced fingerprint", async () => {
        // Build a real fingerprint from the settings, then store it as "last synced"
        const { service, plugin } = makeService({
            activeSyncProvider: "github",
            githubOwner: "alice",
            githubRepo: "notes",
        });
        const fp = service.computeActiveApiRepoFingerprint()!;
        plugin.settings.lastSyncedRepoFingerprint = fp;
        expect(await service.shouldBootstrapApiProvider()).toBe(false);
    });

    it("returns true when fingerprint differs from last synced AND git is not ready", async () => {
        const { service } = makeService({
            activeSyncProvider: "github",
            githubOwner: "alice",
            githubRepo: "notes",
            lastSyncedRepoFingerprint: "different-fingerprint",
        });
        // git is not ready → local fingerprint is null → should bootstrap
        expect(await service.shouldBootstrapApiProvider()).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// getCurrentGitRepoFingerprint
// ---------------------------------------------------------------------------
describe("RepoBindingService.getCurrentGitRepoFingerprint", () => {
    it("returns null when git is not ready", async () => {
        const { service } = makeService({}, { gitReady: false });
        expect(await service.getCurrentGitRepoFingerprint()).toBeNull();
    });

    it("returns null when branchInfo throws", async () => {
        const { service } = makeService(
            {},
            {
                gitReady: true,
                gitManager: {
                    branchInfo: vi.fn().mockRejectedValue(new Error("no head")),
                    getRemotes: vi.fn().mockResolvedValue([]),
                    getRemoteUrl: vi.fn().mockResolvedValue(undefined),
                },
            }
        );
        expect(await service.getCurrentGitRepoFingerprint()).toBeNull();
    });

    it("returns a string when git is ready with a remote", async () => {
        const { service } = makeService(
            {},
            {
                gitReady: true,
                gitManager: {
                    branchInfo: vi.fn().mockResolvedValue({
                        current: "main",
                        tracking: "origin/main",
                        branches: ["main"],
                    }),
                    getRemotes: vi.fn().mockResolvedValue(["origin"]),
                    getRemoteUrl: vi
                        .fn()
                        .mockResolvedValue(
                            "https://github.com/alice/notes.git"
                        ),
                },
            }
        );
        const fp = await service.getCurrentGitRepoFingerprint();
        expect(typeof fp).toBe("string");
        expect(fp).toBeTruthy();
    });
});
