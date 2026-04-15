import { requestUrl } from "obsidian";
import type { RequestUrlParam } from "obsidian";
import {
    buildBranchOptions,
    buildOptionsFromNames,
    filterReposByOwner,
} from "../settingsHelpers";

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
                `GitHub API request failed: ${err instanceof Error ? err.message : String(err)}`,
                8000
            );
            return null;
        }
    }

    private parseNextPagePath(linkHeader: string): string | null {
        for (const linkPart of linkHeader.split(",")) {
            const match = linkPart.match(/<([^>]+)>;\s*rel="next"/);
            if (!match) continue;
            try {
                const nextUrl = new URL(match[1]);
                return `${nextUrl.pathname}${nextUrl.search}`;
            } catch {
                return null;
            }
        }
        return null;
    }

    private async requestAllPages<T = unknown>(
        path: string
    ): Promise<T[] | null> {
        const items: T[] = [];
        let nextPath: string | null = path;

        while (nextPath) {
            const response = await this.requestWithResponse<T[]>(nextPath);
            if (!response || !Array.isArray(response.json)) {
                return null;
            }

            items.push(...response.json);
            if (response.json.length === 0) {
                break;
            }

            nextPath = this.parseNextPagePath(response.headers.link ?? "");
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
