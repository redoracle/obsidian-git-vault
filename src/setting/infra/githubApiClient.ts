import { requestUrl } from "obsidian";
import { redactSensitiveText } from "../../security/logRedaction";
import { nextGitHubPagePath } from "./githubPagination";
import type { RequestUrlParam } from "obsidian";
import {
    buildBranchOptions,
    buildOptionsFromNames,
    filterReposByOwner,
} from "../settingsHelpers";
import type { CreateRepoResult } from "../sections/renderContext";

// Minimal GitHub API types — kept narrow to avoid depending on a large external
// type package.
interface GitHubRepo {
    name: string;
    owner?: { login?: string };
}

/**
 * Thin HTTP client for the GitHub REST API.
 *
 * Receives a token getter so it never holds a reference to `ProviderSecrets`
 * or the plugin shell — keeps the class unit-testable by injecting a stub.
 *
 * All error cases surface as user-visible `Notice` calls (matching the
 * behaviour that was previously inline in `settings.ts`) and return `null`
 * so callers can distinguish "request failed" from "empty result set".
 */
export class GitHubApiClient {
    constructor(
        private readonly getToken: () => string,
        private readonly showNotice: (
            message: string,
            duration?: number
        ) => void
    ) {}

    /**
     * Issue a single authenticated GET against the GitHub API.
     * Returns the parsed JSON on HTTP 200 or `null` on any error.
     */
    async request<T = unknown>(path: string): Promise<T | null> {
        const response = await this.requestWithResponse<T>(path);
        return response?.json ?? null;
    }

    private async requestWithResponse<T = unknown>(
        path: string
    ): Promise<{
        json: T | null;
        headers: Record<string, string>;
    } | null> {
        const token = this.getToken();
        const headers: Record<string, string> = token
            ? { Authorization: `Bearer ${token}` }
            : {};
        try {
            const res = await requestUrl({
                url: `https://api.github.com${path}`,
                method: "GET",
                headers,
                throw: false,
                timeout: 15000,
            } as RequestUrlParam);

            if (res.status === 200) {
                return {
                    json: res.json as unknown as T,
                    headers: res.headers ?? {},
                };
            }
            if (res.status === 401) {
                this.showNotice(
                    "GitHub API: Invalid or expired token. Please check your token.",
                    8000
                );
                return null;
            }
            if (res.status === 403) {
                if (res.headers["x-ratelimit-remaining"] === "0") {
                    this.showNotice(
                        "GitHub API: Rate limit exceeded. Try again later or use a different token.",
                        8000
                    );
                } else {
                    this.showNotice(
                        "GitHub API: Access forbidden. Check your token scopes and permissions.",
                        8000
                    );
                }
                return null;
            }
            if (res.status === 404) {
                this.showNotice(
                    "GitHub API: Resource not found. Check owner, repo, or branch name.",
                    8000
                );
                return null;
            }
            if (res.status === 429) {
                this.showNotice(
                    "GitHub API: Too many requests. Please wait and try again.",
                    8000
                );
                return null;
            }
            if (res.status >= 400) {
                this.showNotice(`GitHub API error: ${res.status}`, 8000);
                return null;
            }
            return null;
        } catch (err) {
            this.showNotice(
                `GitHub API request failed: ${redactSensitiveText(redactSensitiveText(err instanceof Error ? err.message : String(err)))}`,
                8000
            );
            return null;
        }
    }

    private async requestAllPages<T = unknown>(
        path: string
    ): Promise<T[] | null> {
        const items: T[] = [];
        const visited = new Set<string>();
        const maxPages = 100;
        let nextPath: string | null = path;

        while (nextPath) {
            if (visited.has(nextPath) || visited.size >= maxPages) {
                this.showNotice(
                    "GitHub API: Pagination stopped (repeated or excessive page link).",
                    8000
                );
                return null;
            }
            visited.add(nextPath);
            const response = await this.requestWithResponse<T[]>(nextPath);
            if (!response || !Array.isArray(response.json)) {
                return null;
            }

            items.push(...response.json);
            if (response.json.length === 0) {
                break;
            }
            try {
                nextPath = nextGitHubPagePath(response.headers.link ?? "");
            } catch {
                this.showNotice(
                    "GitHub API: Rejected an unsafe pagination link.",
                    8000
                );
                return null;
            }
        }

        return items;
    }

    /**
     * Fetch the list of repositories owned by (or visible to) `owner`.
     *
     * Strategy:
     * 1. If a PAT is present, use the authenticated `/user/repos` endpoint
     *    (returns private repos) and filter by owner.
     * 2. Fall back to the public `/users/:owner/repos` then
     *    `/orgs/:owner/repos` endpoints.
     *
     * Returns a `Record<repoName, label>` suitable for `addOptions()`, or
     * a single-entry record with an error/placeholder message.
     */
    async fetchRepos(owner: string): Promise<Record<string, string>> {
        if (!owner) return { "": "Enter owner first" };

        const token = this.getToken();
        if (token) {
            const json = await this.requestAllPages<GitHubRepo>(
                `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`
            );
            if (json && Array.isArray(json) && json.length > 0) {
                const filtered = filterReposByOwner(json, owner);
                if (filtered.length > 0) {
                    return buildOptionsFromNames(
                        filtered.map((r) => r.name),
                        "Select repository"
                    );
                }
            }
        }

        const endpoints = [
            `/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`,
            `/orgs/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`,
        ];
        for (const ep of endpoints) {
            const json = await this.requestAllPages<GitHubRepo>(ep);
            if (json && Array.isArray(json) && json.length > 0) {
                return buildOptionsFromNames(
                    json.map((r) => r.name),
                    "Select repository"
                );
            }
        }

        return { "": "No repositories found (check owner/org name and token)" };
    }

    /**
     * Create a new private repository for `owner`.
     *
     * If `owner` matches the authenticated user's login the repo is created
     * under the user account; otherwise the organisation endpoint is used.
     *
     * Returns `{ name, htmlUrl }` on success or `null` on any error (a
     * user-visible notice is shown in every failure path).
     */
    async createRepo(
        owner: string,
        repoName: string,
        authenticatedLogin: string
    ): Promise<CreateRepoResult | null> {
        const token = this.getToken();
        if (!token) {
            this.showNotice("No GitHub token — enter a token first.", 5000);
            return null;
        }
        const isOrg = owner.toLowerCase() !== authenticatedLogin.toLowerCase();
        const url = isOrg
            ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`
            : "https://api.github.com/user/repos";

        try {
            const res = await requestUrl({
                url,
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    Accept: "application/vnd.github+json",
                },
                body: JSON.stringify({
                    name: repoName,
                    private: true,
                    auto_init: false,
                }),
                throw: false,
                timeout: 15000,
            } as RequestUrlParam);

            if (res.status === 201) {
                const json = res.json as unknown;
                if (!json || typeof json !== "object") {
                    this.showNotice(
                        "GitHub: Unexpected empty response creating repository.",
                        6000
                    );
                    console.error(
                        "GitHub createRepo: unexpected empty response (status 201)",
                        res.status
                    );
                    return null;
                }

                const maybe = json as Record<string, unknown>;
                const name =
                    typeof maybe.name === "string" ? maybe.name.trim() : "";
                const html =
                    typeof maybe.html_url === "string"
                        ? maybe.html_url.trim()
                        : undefined;

                // Prefer server-returned default_branch when present.
                const default_branch =
                    typeof maybe.default_branch === "string"
                        ? maybe.default_branch.trim()
                        : undefined;
                // Prefer the API's snake_case `default_branch` but accept a
                // camelCase `defaultBranch` when present for compatibility
                // with non-standard or older servers.
                const defaultBranch =
                    default_branch ??
                    (typeof maybe.defaultBranch === "string"
                        ? maybe.defaultBranch.trim()
                        : undefined);

                if (!name || !html) {
                    this.showNotice(
                        "GitHub: Unexpected response when creating repository (missing name or html_url).",
                        6000
                    );
                    console.error(
                        "GitHub createRepo: unexpected response shape",
                        "missing repository fields"
                    );
                    return null;
                }

                const result: CreateRepoResult = {
                    name,
                    htmlUrl: html,
                };
                // `html` was validated above; assign the server-returned
                // `html_url` consistently without a redundant typeof check.
                result.html_url = html;
                if (defaultBranch) {
                    result.defaultBranch = defaultBranch;
                    result.default_branch = default_branch ?? defaultBranch;
                }

                return result;
            }
            if (res.status === 422) {
                const json = res.json as {
                    message?: string;
                    errors?: { message?: string }[];
                };
                const detail =
                    json?.errors?.[0]?.message ??
                    json?.message ??
                    "Unknown error";
                this.showNotice(
                    `GitHub: Cannot create repository — ${redactSensitiveText(detail)}`,
                    7000
                );
                return null;
            }
            if (res.status === 401) {
                this.showNotice("GitHub: Token is invalid or expired.", 6000);
                return null;
            }
            if (res.status === 403) {
                this.showNotice(
                    "GitHub: Insufficient token permissions to create a repository. Ensure the token has the 'repo' scope or 'administration' fine-grained permission.",
                    8000
                );
                return null;
            }
            if (res.status === 404) {
                this.showNotice(
                    "GitHub: Account or organization not found — cannot create repository.",
                    6000
                );
                return null;
            }
            this.showNotice(
                `GitHub: Unexpected response ${res.status} while creating repository.`,
                6000
            );
            return null;
        } catch (err) {
            this.showNotice(
                `GitHub: Failed to create repository — ${redactSensitiveText(redactSensitiveText(err instanceof Error ? err.message : String(err)))}`,
                6000
            );
            return null;
        }
    }

    /**
     * Fetch branches for `owner/repo`.
     *
     * Returns a `Record<branchName, label>` suitable for `addOptions()`, or a
     * single-entry placeholder record on error.
     */
    async fetchBranches(
        owner: string,
        repo: string
    ): Promise<Record<string, string>> {
        if (!owner || !repo) return { "": "Select a repository first" };
        const json = await this.requestAllPages<{ name: string }>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`
        );
        if (json && Array.isArray(json) && json.length > 0) {
            return buildBranchOptions(json);
        }
        return { "": "No branches found" };
    }
}
