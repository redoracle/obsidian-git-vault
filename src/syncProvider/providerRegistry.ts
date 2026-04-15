/**
 * ProviderRegistry
 *
 * The single authoritative place where each supported sync provider declares
 * its capabilities, platform availability, and display metadata.
 *
 * Before this module existed, every feature that needed to know "does this
 * provider require a PAT?" or "is this provider available on mobile?" wrote
 * its own `switch (activeSyncProvider)` statement. That pattern was repeated
 * in settings.ts, main.ts, syncManager.ts, and commands.
 *
 * With the registry, capabilities are declared once in the descriptor and all
 * consumers query the descriptor instead of maintaining their own branches.
 *
 * @module
 */

import type { SyncProviderSetting } from "../types";
import type {
    SyncProviderCapabilities,
    SyncProviderType,
} from "./syncProvider";

// ─── Descriptor ───────────────────────────────────────────────────────────────

/**
 * Immutable description of a sync provider's capabilities and constraints.
 * Add new flags here, not in consumer-side switch statements.
 */
export interface ProviderDescriptor extends SyncProviderCapabilities {
    /** The canonical setting value, e.g. `"github"`. */
    readonly type: SyncProviderSetting;

    /** Display label used in dropdowns and headings. */
    readonly displayName: string;

    /** Whether the provider can run on mobile (no native git required). */
    readonly availableOnMobile: boolean;

    /** Whether the provider can run on desktop. */
    readonly availableOnDesktop: boolean;

    /**
     * Whether the provider requires a Personal Access Token / API key.
     * If `true`, the settings tab should render a token input field.
     */
    readonly requiresPersonalAccessToken: boolean;

    /**
     * Whether the provider needs a local git repository on disk.
     * `true` only for the `"git"` provider.
     */
    readonly requiresLocalGitRepo: boolean;

    /**
     * Whether the provider communicates over HTTP/API (not native git).
     * Used to decide when API-sync-specific sections should be shown.
     */
    readonly isApiProvider: boolean;

    /**
     * Whether the line-authoring gutter feature is available for this provider.
     * Requires native git and is therefore desktop-with-git only.
     */
    readonly supportsLineAuthoring: boolean;

    /**
     * How reliably the provider can generate browseable per-file remote URLs.
     *
     * - `"unsupported"`: the current app does not expose remote file URLs.
     * - `"supported"`: remote file URLs are available for normal configurations.
     * - `"requires-namespace-path"`: remote URLs work only when the provider is
     *   configured with a human-readable namespace/path identifier rather than
     *   an opaque numeric project ID.
     */
    readonly remoteFileUrlMode:
        | "unsupported"
        | "supported"
        | "requires-namespace-path";

    /**
     * Bootstrap strategy taken when the local vault has no matching fingerprint
     * for the remote.
     *  - `"pull-first"` – pull remote contents before any push.
     *  - `"clone"`      – full clone (native git only).
     *  - `"none"`       – no special bootstrap needed.
     */
    readonly bootstrapStrategy: "pull-first" | "clone" | "none";
}

type ProviderDescriptorInput = Omit<
    ProviderDescriptor,
    "supportsRemoteFileUrls"
>;

function createProviderDescriptor(
    descriptor: ProviderDescriptorInput
): ProviderDescriptor {
    return {
        ...descriptor,
        supportsRemoteFileUrls: descriptor.remoteFileUrlMode !== "unsupported",
    };
}

// ─── Descriptor definitions ───────────────────────────────────────────────────

const GIT_DESCRIPTOR: ProviderDescriptor = createProviderDescriptor({
    type: "git",
    displayName: "Git",
    availableOnMobile: false,
    availableOnDesktop: true,
    requiresPersonalAccessToken: false,
    requiresLocalGitRepo: true,
    isApiProvider: false,
    supportsAtomicBatchWrites: true,
    supportsRemoteCommitHistory: true,
    supportsPerFileMetadata: true,
    supportsEncryptedSync: false,
    supportsExcludePaths: false,
    supportsTrackedDirectoryScoping: false,
    supportsDedicatedVaultImport: false,
    supportsDefaultBranchAutoDetection: false,
    supportsLineAuthoring: true,
    remoteFileUrlMode: "unsupported",
    bootstrapStrategy: "clone",
});

const GITHUB_DESCRIPTOR: ProviderDescriptor = createProviderDescriptor({
    type: "github",
    displayName: "GitHub API",
    availableOnMobile: true,
    availableOnDesktop: true,
    requiresPersonalAccessToken: true,
    requiresLocalGitRepo: false,
    isApiProvider: true,
    supportsAtomicBatchWrites: true,
    supportsRemoteCommitHistory: true,
    supportsPerFileMetadata: true,
    supportsEncryptedSync: true,
    supportsExcludePaths: true,
    supportsTrackedDirectoryScoping: true,
    supportsDedicatedVaultImport: true,
    supportsDefaultBranchAutoDetection: true,
    supportsLineAuthoring: false,
    remoteFileUrlMode: "supported",
    bootstrapStrategy: "pull-first",
});

const GITLAB_DESCRIPTOR: ProviderDescriptor = createProviderDescriptor({
    type: "gitlab",
    displayName: "GitLab API",
    availableOnMobile: true,
    availableOnDesktop: true,
    requiresPersonalAccessToken: true,
    requiresLocalGitRepo: false,
    isApiProvider: true,
    supportsAtomicBatchWrites: true,
    supportsRemoteCommitHistory: true,
    supportsPerFileMetadata: true,
    supportsEncryptedSync: true,
    supportsExcludePaths: true,
    supportsTrackedDirectoryScoping: true,
    supportsDedicatedVaultImport: true,
    supportsDefaultBranchAutoDetection: true,
    supportsLineAuthoring: false,
    remoteFileUrlMode: "requires-namespace-path",
    bootstrapStrategy: "pull-first",
});

const GITEA_DESCRIPTOR: ProviderDescriptor = createProviderDescriptor({
    type: "gitea",
    displayName: "Gitea / Forgejo API",
    availableOnMobile: true,
    availableOnDesktop: true,
    requiresPersonalAccessToken: true,
    requiresLocalGitRepo: false,
    isApiProvider: true,
    supportsAtomicBatchWrites: false,
    supportsRemoteCommitHistory: true,
    supportsPerFileMetadata: true,
    supportsEncryptedSync: true,
    supportsExcludePaths: true,
    supportsTrackedDirectoryScoping: true,
    supportsDedicatedVaultImport: true,
    supportsDefaultBranchAutoDetection: true,
    supportsLineAuthoring: false,
    remoteFileUrlMode: "supported",
    bootstrapStrategy: "pull-first",
});

// ─── Registry ─────────────────────────────────────────────────────────────────

const PROVIDER_DESCRIPTORS = {
    git: GIT_DESCRIPTOR,
    github: GITHUB_DESCRIPTOR,
    gitlab: GITLAB_DESCRIPTOR,
    gitea: GITEA_DESCRIPTOR,
} satisfies Record<SyncProviderSetting, ProviderDescriptor>;

export class ProviderRegistry {
    private readonly descriptors: Readonly<
        Record<SyncProviderSetting, ProviderDescriptor>
    > = PROVIDER_DESCRIPTORS;

    /**
     * Return the descriptor for the given provider type.
     * Throws if the type is unknown (prevents silent capability miss).
     */
    describe(type: SyncProviderSetting): ProviderDescriptor {
        const descriptor = this.descriptors[type];
        if (!descriptor) {
            throw new Error(
                `ProviderRegistry: unknown provider type "${type}"`
            );
        }
        return descriptor;
    }

    /**
     * All descriptors available for a given platform.
     * Pass `"mobile"` or `"desktop"` to filter by availability.
     */
    availableFor(platform: "desktop" | "mobile"): ProviderDescriptor[] {
        return Object.values(this.descriptors).filter((descriptor) =>
            platform === "mobile"
                ? descriptor.availableOnMobile
                : descriptor.availableOnDesktop
        );
    }

    /** All registered descriptors regardless of platform. */
    allDescriptors(): ProviderDescriptor[] {
        return Object.values(this.descriptors);
    }

    /**
     * Convenience — returns `true` when the given type is an API-backed
     * provider (GitHub, GitLab, Gitea) rather than native git.
     */
    isApiProvider(type: SyncProviderSetting): boolean {
        return this.describe(type).isApiProvider;
    }

    /**
     * Convenience — returns `true` when the given type requires a local git
     * repository on disk.
     */
    requiresLocalGitRepo(type: SyncProviderSetting): boolean {
        return this.describe(type).requiresLocalGitRepo;
    }
}

/**
 * Plugin-wide singleton instance.
 *
 * Import this wherever a registry is needed instead of constructing a new one.
 * Tests can construct their own `ProviderRegistry` instance independently.
 */
export const providerRegistry = new ProviderRegistry();

export function getSyncProviderCapabilities(
    type: SyncProviderType
): SyncProviderCapabilities {
    return providerRegistry.describe(type);
}
