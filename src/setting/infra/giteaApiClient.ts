import { redactSensitiveText } from "../../security/logRedaction";
import { requestUrl, type RequestUrlParam } from "obsidian";
import type { CreateRepoResult } from "../sections/renderContext";
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
                `Gitea API request failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
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

    /**
     * Create a new private repository under the authenticated user account.
     *
     * Returns `{ name, htmlUrl }` on success or `null` on any error
     * (a user-visible notice is shown in every failure path).
     */
    async createRepo(repoName: string): Promise<CreateRepoResult | null> {
        const baseUrl = normalizeGiteaBaseUrl(this.getBaseUrl());
        if (!baseUrl) {
            this.showNotice(
                "No Gitea server URL configured — enter a server URL first.",
                5000
            );
            return null;
        }
        const token = this.getToken().trim();
        if (!token) {
            this.showNotice("No Gitea token — enter a token first.", 5000);
            return null;
        }

        const trimmedName = repoName.trim();
        if (!trimmedName) {
            this.showNotice(
                "No repository name provided — enter a repository name first.",
                5000
            );
            return null;
        }

        try {
            const res = await requestUrl({
                url: `${baseUrl}/user/repos`,
                method: "POST",
                headers: {
                    Authorization: `token ${token}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({
                    name: trimmedName,
                    private: true,
                    auto_init: false,
                }),
                throw: false,
                timeout: 15000,
            } as RequestUrlParam);

            if (res.status === 201) {
                const json = res.json as unknown;
                const maybe = json as Record<string, unknown>;
                const name =
                    typeof maybe.name === "string" ? maybe.name.trim() : "";
                const html =
                    typeof maybe.html_url === "string"
                        ? maybe.html_url.trim()
                        : undefined;

                // Prefer the explicit `default_branch` returned by Gitea but
                // accept camelCase variants too.
                const default_branch =
                    typeof maybe.default_branch === "string"
                        ? maybe.default_branch.trim()
                        : undefined;
                const defaultBranch =
                    default_branch ??
                    (typeof maybe.defaultBranch === "string"
                        ? maybe.defaultBranch.trim()
                        : undefined);

                if (!name || !html) {
                    this.showNotice(
                        "Gitea: Repository created but the API returned an unexpected response shape. Refresh repositories manually.",
                        8000
                    );
                    return null;
                }

                // Return both snake_case and camelCase where applicable so
                // callers can use either property without casting.
                const result: CreateRepoResult = {
                    name,
                    htmlUrl: html,
                };
                if (html) result.html_url = html;
                if (defaultBranch) {
                    result.defaultBranch = defaultBranch;
                    result.default_branch = default_branch ?? defaultBranch;
                }

                return result;
            }
            if (res.status === 409) {
                this.showNotice(
                    `Gitea: Repository "${trimmedName}" already exists.`,
                    6000
                );
                return null;
            }
            if (res.status === 401) {
                this.showNotice("Gitea: Token is invalid or expired.", 6000);
                return null;
            }
            if (res.status === 403) {
                this.showNotice(
                    "Gitea: Insufficient permissions to create a repository.",
                    6000
                );
                return null;
            }
            this.showNotice(
                `Gitea: Unexpected response ${res.status} while creating repository.`,
                6000
            );
            return null;
        } catch (err) {
            this.showNotice(
                `Gitea: Failed to create repository — ${redactSensitiveText(err instanceof Error ? err.message : String(err))}`,
                6000
            );
            return null;
        }
    }
}
