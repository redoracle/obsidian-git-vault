import { requestUrl, type RequestUrlParam } from "obsidian";
import { buildBranchOptions, buildOptionsFromNames } from "../settingsHelpers";

interface GiteaRepo {
    name?: string;
    owner?: {
        login?: string;
        username?: string;
    };
}

interface GiteaUser {
    login?: string;
    fullName?: string;
}

// Helper to extract non-empty, trimmed repo names from a list of repos
function extractRepoNames(repos: GiteaRepo[]): string[] {
    if (!repos || !Array.isArray(repos)) return [];
    return repos
        .map((r) => r.name?.trim() ?? "")
        .filter((name) => name.length > 0);
}

function normalizeGiteaBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (!trimmed) {
        return "";
    }
    return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

function repoOwnerMatches(repo: GiteaRepo, owner: string): boolean {
    return repo.owner?.login === owner || repo.owner?.username === owner;
}

export class GiteaApiClient {
    constructor(
        private readonly getBaseUrl: () => string,
        private readonly getToken: () => string,
        private readonly showNotice: (
            message: string,
            duration?: number
        ) => void
    ) {}

    private async request<T = unknown>(
        path: string,
        options?: { silent404?: boolean }
    ): Promise<T | null> {
        const baseUrl = normalizeGiteaBaseUrl(this.getBaseUrl());
        if (!baseUrl) {
            return null;
        }

        const token = this.getToken().trim();
        const headers: Record<string, string> = token
            ? {
                  Authorization: `token ${token}`,
                  Accept: "application/json",
              }
            : { Accept: "application/json" };

        try {
            const res = await requestUrl({
                url: `${baseUrl}${path}`,
                method: "GET",
                headers,
                throw: false,
                timeout: 15000,
            } as RequestUrlParam);

            if (res.status === 200) {
                return res.json as T;
            }
            if (res.status === 401) {
                this.showNotice(
                    "Gitea API: Invalid or expired token. Please check your token.",
                    8000
                );
                return null;
            }
            if (res.status === 403) {
                this.showNotice(
                    "Gitea API: Access forbidden. Check your token scopes and permissions.",
                    8000
                );
                return null;
            }
            if (res.status === 404) {
                if (options?.silent404) {
                    return null;
                }
                this.showNotice(
                    "Gitea API: Resource not found. Check server URL, owner, repository, or branch.",
                    8000
                );
                return null;
            }
            if (res.status >= 400) {
                this.showNotice(`Gitea API error: ${res.status}`, 8000);
                return null;
            }
            return null;
        } catch (error) {
            this.showNotice(
                `Gitea API request failed: ${error instanceof Error ? error.message : String(error)}`,
                8000
            );
            return null;
        }
    }

    async fetchRepos(owner: string): Promise<Record<string, string>> {
        if (!owner) return { "": "Enter owner first" };

        const token = this.getToken().trim();
        if (token) {
            const json = await this.request<GiteaRepo[]>(
                "/user/repos?limit=100"
            );
            if (json && Array.isArray(json) && json.length > 0) {
                const filtered = json.filter((repo) =>
                    repoOwnerMatches(repo, owner)
                );
                if (filtered.length > 0) {
                    const names = extractRepoNames(filtered);
                    if (names.length > 0) {
                        return buildOptionsFromNames(
                            names,
                            "Select repository"
                        );
                    }
                }
            }
        }

        const publicRepos = await this.request<GiteaRepo[]>(
            `/users/${encodeURIComponent(owner)}/repos?limit=100`,
            { silent404: true }
        );
        if (
            publicRepos &&
            Array.isArray(publicRepos) &&
            publicRepos.length > 0
        ) {
            const names = extractRepoNames(publicRepos);
            if (names.length > 0) {
                return buildOptionsFromNames(names, "Select repository");
            }
        }

        const orgRepos = await this.request<GiteaRepo[]>(
            `/orgs/${encodeURIComponent(owner)}/repos?limit=100`,
            { silent404: true }
        );
        if (orgRepos && Array.isArray(orgRepos) && orgRepos.length > 0) {
            const names = extractRepoNames(orgRepos);
            if (names.length > 0) {
                return buildOptionsFromNames(names, "Select repository");
            }
        }

        return { "": "No repositories found (check owner/org name and token)" };
    }

    async fetchBranches(
        owner: string,
        repo: string
    ): Promise<Record<string, string>> {
        if (!owner || !repo) return { "": "Select a repository first" };
        const json = await this.request<{ name: string }[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?limit=100`
        );
        if (json && Array.isArray(json) && json.length > 0) {
            return buildBranchOptions(json);
        }
        return { "": "No branches found" };
    }

    async requestUser(): Promise<GiteaUser | null> {
        const user = await this.request<{
            login?: string;
            full_name?: string;
        }>("/user");
        return user
            ? {
                  login: user.login,
                  fullName: user.full_name,
              }
            : null;
    }

    async fetchUser(): Promise<GiteaUser | null> {
        return this.requestUser();
    }
}
