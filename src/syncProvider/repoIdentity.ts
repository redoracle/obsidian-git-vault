import type { ObsidianGitSettings, SyncProviderSetting } from "../types";

type ApiProvider = Exclude<SyncProviderSetting, "git">;

function stripGitSuffix(value: string): string {
    return value.replace(/\.git$/i, "");
}

function normalizeRepoPath(value: string): string {
    return stripGitSuffix(value.trim().replace(/^\/+|\/+$/g, ""));
}

function normalizeHost(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "");
}

function normalizeBranch(value: string | undefined, fallback = "main"): string {
    const branch = value?.trim();
    return branch && branch.length > 0 ? branch : fallback;
}

function buildRepoFingerprint(
    host: string,
    repoPath: string,
    branch: string
): string {
    return `repo:${normalizeHost(host)}/${normalizeRepoPath(repoPath)}@${branch}`;
}

type ParsedFingerprint = {
    host: string;
    repoPath: string;
    branch: string;
};

function getHostFromUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return url.host;
    } catch {
        return null;
    }
}

function getRepoPathFromUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return normalizeRepoPath(url.pathname);
    } catch {
        return null;
    }
}

export function getApiRepoFingerprint(
    settings: Pick<
        ObsidianGitSettings,
        | "githubOwner"
        | "githubRepo"
        | "githubBranch"
        | "gitlabBaseUrl"
        | "gitlabProjectId"
        | "gitlabBranch"
        | "giteaBaseUrl"
        | "giteaOwner"
        | "giteaRepo"
        | "giteaBranch"
    >,
    provider: ApiProvider
): string | null {
    switch (provider) {
        case "github": {
            if (!settings.githubOwner || !settings.githubRepo) {
                return null;
            }
            return buildRepoFingerprint(
                "github.com",
                `${settings.githubOwner}/${settings.githubRepo}`,
                normalizeBranch(settings.githubBranch)
            );
        }
        case "gitlab": {
            if (!settings.gitlabProjectId) {
                return null;
            }
            const host = getHostFromUrl(
                settings.gitlabBaseUrl || "https://gitlab.com/api/v4"
            );
            if (!host) {
                return null;
            }
            const decodedProjectId = decodeURIComponent(
                settings.gitlabProjectId
            );
            return buildRepoFingerprint(
                host,
                decodedProjectId,
                normalizeBranch(settings.gitlabBranch)
            );
        }
        case "gitea": {
            if (
                !settings.giteaBaseUrl ||
                !settings.giteaOwner ||
                !settings.giteaRepo
            ) {
                return null;
            }
            const host = getHostFromUrl(settings.giteaBaseUrl);
            if (!host) {
                return null;
            }
            return buildRepoFingerprint(
                host,
                `${settings.giteaOwner}/${settings.giteaRepo}`,
                normalizeBranch(settings.giteaBranch)
            );
        }
        default:
            return null;
    }
}

export function getGitRepoFingerprint(
    remoteUrl: string | undefined,
    branch: string | undefined
): string | null {
    if (!remoteUrl || !branch) {
        return null;
    }

    const httpsHost = getHostFromUrl(remoteUrl);
    const httpsPath = getRepoPathFromUrl(remoteUrl);
    if (httpsHost && httpsPath) {
        return buildRepoFingerprint(httpsHost, httpsPath, branch);
    }

    const scpMatch = remoteUrl.match(/^(?:[^@]+@)?([^:]+):(.+?)(?:\.git)?$/);
    if (!scpMatch) {
        return null;
    }

    const [, host, repoPath] = scpMatch;
    return buildRepoFingerprint(host, repoPath, branch);
}

export function normalizeRepoFingerprint(
    fingerprint: string | undefined | null
): string | null {
    const value = fingerprint?.trim();
    if (!value) {
        return null;
    }
    if (value.startsWith("repo:")) {
        // Normalize the hostname to lowercase so comparisons are case-insensitive.
        const rest = value.slice(5); // strip "repo:"
        const slashIndex = rest.indexOf("/");
        if (slashIndex === -1) return null; // malformed
        const host = rest.slice(0, slashIndex).toLowerCase();
        const remainder = rest.slice(slashIndex);
        return `repo:${host}${remainder}`;
    }
    if (value.startsWith("github:")) {
        const [, repoAndBranch] = value.split("github:");
        const atIndex = repoAndBranch.lastIndexOf("@");
        if (atIndex === -1) {
            return null;
        }
        return buildRepoFingerprint(
            "github.com",
            repoAndBranch.slice(0, atIndex),
            repoAndBranch.slice(atIndex + 1)
        );
    }
    return null;
}

function parseNormalizedRepoFingerprint(
    fingerprint: string | undefined | null
): ParsedFingerprint | null {
    const normalized = normalizeRepoFingerprint(fingerprint);
    if (!normalized) {
        return null;
    }

    const rest = normalized.slice(5);
    const slashIndex = rest.indexOf("/");
    if (slashIndex === -1) {
        return null;
    }
    const atIndex = rest.indexOf("@", slashIndex + 1);
    if (atIndex === -1) {
        return null;
    }

    const hostAndPath = rest.slice(0, atIndex);
    const branch = rest.slice(atIndex + 1);

    return {
        host: hostAndPath.slice(0, slashIndex),
        repoPath: hostAndPath.slice(slashIndex + 1),
        branch,
    };
}

export function fingerprintsMatch(
    left: string | undefined | null,
    right: string | undefined | null
): boolean {
    const normalizedLeft = normalizeRepoFingerprint(left);
    const normalizedRight = normalizeRepoFingerprint(right);
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    return normalizedLeft === normalizedRight;
}

export function encryptionFingerprintsMatch(
    left: string | undefined | null,
    right: string | undefined | null
): boolean {
    if (fingerprintsMatch(left, right)) {
        return true;
    }

    const parsedLeft = parseNormalizedRepoFingerprint(left);
    const parsedRight = parseNormalizedRepoFingerprint(right);
    if (!parsedLeft || !parsedRight) {
        return false;
    }

    return (
        parsedLeft.repoPath === parsedRight.repoPath &&
        parsedLeft.branch === parsedRight.branch
    );
}
