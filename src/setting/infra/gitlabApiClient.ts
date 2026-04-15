import { requestUrl, type RequestUrlParam } from "obsidian";
import { buildBranchOptions } from "../settingsHelpers";

interface GitLabProject {
    id?: number;
    path_with_namespace?: string;
    name_with_namespace?: string;
    name?: string;
}

function normalizeGitLabProjectId(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    try {
        return decodeURIComponent(trimmed);
    } catch {
        return trimmed;
    }
}

function normalizeGitLabBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim() || "https://gitlab.com/api/v4";
    const cleaned = trimmed.replace(/\/+$/, "");
    return cleaned.endsWith("/api/v4") ? cleaned : `${cleaned}/api/v4`;
}

export class GitLabApiClient {
    constructor(
        private readonly getBaseUrl: () => string,
        private readonly getToken: () => string,
        private readonly showNotice: (
            message: string,
            duration?: number
        ) => void
    ) {}

    private async request<T = unknown>(path: string): Promise<T | null> {
        const token = this.getToken().trim();
        const headers: Record<string, string> = token
            ? { "PRIVATE-TOKEN": token }
            : {};
        try {
            const res = await requestUrl({
                url: `${normalizeGitLabBaseUrl(this.getBaseUrl())}${path}`,
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
                    "GitLab API: Invalid or expired token. Please check your token.",
                    8000
                );
                return null;
            }
            if (res.status === 403) {
                this.showNotice(
                    "GitLab API: Access forbidden. Check your token scopes and permissions.",
                    8000
                );
                return null;
            }
            if (res.status === 404) {
                this.showNotice(
                    "GitLab API: Resource not found. Check base URL, project, or branch.",
                    8000
                );
                return null;
            }
            if (res.status >= 400) {
                this.showNotice(`GitLab API error: ${res.status}`, 8000);
                return null;
            }
            return null;
        } catch (error) {
            this.showNotice(
                `GitLab API request failed: ${error instanceof Error ? error.message : String(error)}`,
                8000
            );
            return null;
        }
    }

    async fetchProjects(): Promise<Record<string, string>> {
        const token = this.getToken().trim();
        if (!token) return { "": "Enter token first" };

        const json = await this.request<GitLabProject[]>(
            "/projects?simple=true&membership=true&per_page=100&order_by=last_activity_at&sort=desc"
        );
        if (!json || !Array.isArray(json) || json.length === 0) {
            return { "": "No projects found" };
        }

        const options: Record<string, string> = { "": "Select project" };
        for (const project of json) {
            const path = normalizeGitLabProjectId(
                project.path_with_namespace?.trim() ?? ""
            );
            const id =
                path && path.length > 0
                    ? path
                    : project.id != null
                      ? String(project.id)
                      : "";
            const label = path || project.name?.trim() || "";
            if (!id || !label) continue;
            options[id] = label;
        }

        return Object.keys(options).length > 1
            ? options
            : { "": "No projects found" };
    }

    async fetchBranches(projectId: string): Promise<Record<string, string>> {
        const normalizedProjectId = normalizeGitLabProjectId(projectId);
        if (!normalizedProjectId) return { "": "Select a project first" };
        const json = await this.request<{ name: string }[]>(
            `/projects/${encodeURIComponent(normalizedProjectId)}/repository/branches?per_page=100`
        );
        if (json && Array.isArray(json) && json.length > 0) {
            return buildBranchOptions(json);
        }
        return { "": "No branches found" };
    }

    async requestUser(): Promise<{ username?: string; name?: string } | null> {
        return this.request<{ username?: string; name?: string }>("/user");
    }
}
