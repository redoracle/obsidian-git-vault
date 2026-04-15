import { describe, it, expect } from "vitest";
import {
    ProviderRegistry,
    providerRegistry,
} from "../../src/syncProvider/providerRegistry";
import type { SyncProviderSetting } from "../../src/types";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ProviderRegistry", () => {
    const registry = new ProviderRegistry();

    describe("describe()", () => {
        it("returns the descriptor for each known provider", () => {
            const providers: SyncProviderSetting[] = [
                "git",
                "github",
                "gitlab",
                "gitea",
            ];
            for (const p of providers) {
                expect(() => registry.describe(p)).not.toThrow();
                expect(registry.describe(p).type).toBe(p);
            }
        });

        it("throws for an unknown provider type", () => {
            expect(() =>
                registry.describe("unknown" as SyncProviderSetting)
            ).toThrow(/unknown provider type/);
        });
    });

    describe("git descriptor", () => {
        const d = registry.describe("git");

        it("is desktop-only", () => {
            expect(d.availableOnDesktop).toBe(true);
            expect(d.availableOnMobile).toBe(false);
        });

        it("requires a local git repo", () => {
            expect(d.requiresLocalGitRepo).toBe(true);
        });

        it("is NOT an API provider", () => {
            expect(d.isApiProvider).toBe(false);
        });

        it("does NOT support encrypted sync", () => {
            expect(d.supportsEncryptedSync).toBe(false);
        });

        it("does NOT support tracked-directory API scoping or dedicated API import", () => {
            expect(d.supportsTrackedDirectoryScoping).toBe(false);
            expect(d.supportsDedicatedVaultImport).toBe(false);
        });

        it("does NOT expose sync-metadata remote URLs or API default-branch autodetect", () => {
            expect(d.supportsRemoteFileUrls).toBe(false);
            expect(d.supportsDefaultBranchAutoDetection).toBe(false);
            expect(d.remoteFileUrlMode).toBe("unsupported");
        });

        it("supports line authoring", () => {
            expect(d.supportsLineAuthoring).toBe(true);
        });

        it("uses clone bootstrap strategy", () => {
            expect(d.bootstrapStrategy).toBe("clone");
        });
    });

    describe("github descriptor", () => {
        const d = registry.describe("github");

        it("is available on mobile and desktop", () => {
            expect(d.availableOnMobile).toBe(true);
            expect(d.availableOnDesktop).toBe(true);
        });

        it("requires a PAT", () => {
            expect(d.requiresPersonalAccessToken).toBe(true);
        });

        it("does NOT require a local git repo", () => {
            expect(d.requiresLocalGitRepo).toBe(false);
        });

        it("is an API provider", () => {
            expect(d.isApiProvider).toBe(true);
        });

        it("supports encrypted sync", () => {
            expect(d.supportsEncryptedSync).toBe(true);
        });

        it("supports tracked-directory scoping, metadata remote URLs, and dedicated import", () => {
            expect(d.supportsTrackedDirectoryScoping).toBe(true);
            expect(d.supportsRemoteFileUrls).toBe(true);
            expect(d.supportsDedicatedVaultImport).toBe(true);
            expect(d.remoteFileUrlMode).toBe("supported");
        });

        it("auto-detects the default branch for fresh API targets", () => {
            expect(d.supportsDefaultBranchAutoDetection).toBe(true);
        });

        it("does NOT support line authoring", () => {
            expect(d.supportsLineAuthoring).toBe(false);
        });

        it("supports remote file history links", () => {
            expect(d.supportsRemoteCommitHistory).toBe(true);
        });

        it("uses pull-first bootstrap strategy", () => {
            expect(d.bootstrapStrategy).toBe("pull-first");
        });
    });

    describe("gitlab descriptor", () => {
        const d = registry.describe("gitlab");
        it("is an API provider", () => expect(d.isApiProvider).toBe(true));
        it("supports encryption", () =>
            expect(d.supportsEncryptedSync).toBe(true));
        it("is available on mobile", () =>
            expect(d.availableOnMobile).toBe(true));
        it("supports tracked scoping, remote URLs, dedicated import, and default-branch autodetect", () => {
            expect(d.supportsTrackedDirectoryScoping).toBe(true);
            expect(d.supportsRemoteFileUrls).toBe(true);
            expect(d.supportsDedicatedVaultImport).toBe(true);
            expect(d.supportsDefaultBranchAutoDetection).toBe(true);
            expect(d.remoteFileUrlMode).toBe("requires-namespace-path");
        });
        it("supports remote file history links", () =>
            expect(d.supportsRemoteCommitHistory).toBe(true));
    });

    describe("gitea descriptor", () => {
        const d = registry.describe("gitea");
        it("is an API provider", () => expect(d.isApiProvider).toBe(true));
        it("supports encryption", () =>
            expect(d.supportsEncryptedSync).toBe(true));
        it("supports tracked scoping, remote URLs, dedicated import, and default-branch autodetect", () => {
            expect(d.supportsTrackedDirectoryScoping).toBe(true);
            expect(d.supportsRemoteFileUrls).toBe(true);
            expect(d.supportsDedicatedVaultImport).toBe(true);
            expect(d.supportsDefaultBranchAutoDetection).toBe(true);
            expect(d.remoteFileUrlMode).toBe("supported");
        });
        it("supports remote file history links", () =>
            expect(d.supportsRemoteCommitHistory).toBe(true));
    });

    describe("remote file URL invariant", () => {
        it("derives supportsRemoteFileUrls from remoteFileUrlMode", () => {
            for (const descriptor of registry.allDescriptors()) {
                expect(descriptor.supportsRemoteFileUrls).toBe(
                    descriptor.remoteFileUrlMode !== "unsupported"
                );
            }
        });
    });

    describe("availableFor()", () => {
        it("returns only desktop-available providers for 'desktop'", () => {
            const desktopProviders = registry.availableFor("desktop");
            expect(desktopProviders.map((d) => d.type)).toContain("git");
            expect(desktopProviders.map((d) => d.type)).toContain("github");
        });

        it("returns only mobile-available providers for 'mobile'", () => {
            const mobileProviders = registry.availableFor("mobile");
            expect(mobileProviders.map((d) => d.type)).not.toContain("git");
            expect(mobileProviders.map((d) => d.type)).toContain("github");
            expect(mobileProviders.map((d) => d.type)).toContain("gitlab");
            expect(mobileProviders.map((d) => d.type)).toContain("gitea");
        });
    });

    describe("isApiProvider()", () => {
        it("returns false for git", () =>
            expect(registry.isApiProvider("git")).toBe(false));
        it("returns true for github", () =>
            expect(registry.isApiProvider("github")).toBe(true));
        it("returns true for gitlab", () =>
            expect(registry.isApiProvider("gitlab")).toBe(true));
        it("returns true for gitea", () =>
            expect(registry.isApiProvider("gitea")).toBe(true));
    });

    describe("requiresLocalGitRepo()", () => {
        it("returns true only for git", () => {
            expect(registry.requiresLocalGitRepo("git")).toBe(true);
            expect(registry.requiresLocalGitRepo("github")).toBe(false);
            expect(registry.requiresLocalGitRepo("gitlab")).toBe(false);
            expect(registry.requiresLocalGitRepo("gitea")).toBe(false);
        });
    });

    describe("providerRegistry singleton", () => {
        it("returns the same descriptor instance on repeated describe() calls", () => {
            expect(providerRegistry).toBeInstanceOf(ProviderRegistry);
            const first = providerRegistry.describe("git");
            const second = providerRegistry.describe("git");
            expect(first).toBe(second);
            expect(first.type).toBe("git");
        });
    });
});
