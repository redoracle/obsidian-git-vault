import { redactSensitiveText } from "../../security/logRedaction";
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

export function safeToString(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    if (typeof value === "number") return value.toString();
    if (typeof value === "boolean") return value.toString();
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol") return value.toString();
    try {
        const json = JSON.stringify(value);
        return typeof json === "string" && json !== ""
            ? json
            : "(unserializable)";
    } catch {
        return "(unserializable)";
    }
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
                `GitLab API request failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
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

    /**
     * Fetch a project's metadata from the GitLab API.
     * Returns the parsed JSON on HTTP 200 or `null` on any error.
     */
    async getProject(projectId: string): Promise<{
        default_branch?: string;
        path_with_namespace?: string;
    } | null> {
        if (!projectId) return null;
        // `request` already handles errors and returns `null` on failure,
        // so simply return its result to keep the declared null-on-error
        // contract and avoid double-catching/logging here.
        return await this.request<{
            default_branch?: string;
            path_with_namespace?: string;
        }>(`/projects/${encodeURIComponent(projectId)}`);
    }
    /**
     * Create a new private GitLab project.
     *
     * Returns `{ pathWithNamespace, webUrl }` on success or `null` on any
     * error (a user-visible notice is shown in every failure path).
     */
    async createProject(
        name: string
    ): Promise<{ pathWithNamespace: string; webUrl: string } | null> {
        const token = this.getToken().trim();
        if (!token) {
            this.showNotice("No GitLab token — enter a token first.", 5000);
            return null;
        }
        const trimmedName = name?.trim() ?? "";
        if (!trimmedName) {
            this.showNotice("Project name cannot be empty.", 5000);
            return null;
        }
        const baseUrl = normalizeGitLabBaseUrl(this.getBaseUrl());

        try {
            const res = await requestUrl({
                url: `${baseUrl}/projects`,
                method: "POST",
                headers: {
                    "PRIVATE-TOKEN": token,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    name: trimmedName,
                    visibility: "private",
                    initialize_with_readme: false,
                }),
                throw: false,
                timeout: 15000,
            } as RequestUrlParam);

            if (res.status === 201) {
                const json = res.json as unknown;
                if (!json || typeof json !== "object") {
                    // Surface a user-facing notice and return null for
                    // consistency with other provider clients.
                    this.showNotice(
                        "GitLab: Unexpected empty response creating project.",
                        6000
                    );
                    console.error(
                        "GitLab createProject: unexpected empty response (status 201)",
                        res.status
                    );
                    return null;
                }

                const maybe = json as {
                    path_with_namespace?: unknown;
                    web_url?: unknown;
                };
                const pathWithNamespace =
                    typeof maybe.path_with_namespace === "string"
                        ? maybe.path_with_namespace.trim()
                        : "";
                const webUrl =
                    typeof maybe.web_url === "string"
                        ? maybe.web_url.trim()
                        : "";

                if (!pathWithNamespace || !webUrl) {
                    this.showNotice(
                        "GitLab: Unexpected response when creating project (missing path or web URL).",
                        6000
                    );
                    console.error(
                        "GitLab createProject: missing fields in 201 response",
                        "missing project fields"
                    );
                    return null;
                }

                return { pathWithNamespace, webUrl };
            }
            if (res.status === 400) {
                const json = res.json as { message?: unknown } | null;
                let detail = "Invalid request";
                const msg = json?.message;
                if (msg && typeof msg === "object" && !Array.isArray(msg)) {
                    // message is an object mapping keys to values which may be
                    // arrays of values or single values. Handle arrays and
                    // objects consistently: for array elements, stringify
                    // objects when possible, otherwise fall back to a
                    // placeholder; primitives are stringified.
                    detail = Object.entries(msg as Record<string, unknown>)
                        .map(([k, v]) => {
                            if (Array.isArray(v)) {
                                const items = (v as unknown[])
                                    .map((el) => safeToString(el))
                                    .join(", ");
                                return `${k}: ${items}`;
                            }
                            if (typeof v === "string") {
                                return `${k}: ${v}`;
                            }
                            return `${k}: ${safeToString(v)}`;
                        })
                        .join("; ");
                } else if (Array.isArray(msg)) {
                    detail = (msg as unknown[])
                        .map((v) => safeToString(v))
                        .join(", ");
                } else if (typeof msg === "string") {
                    detail = msg;
                } else if (msg != null) {
                    try {
                        detail = JSON.stringify(msg);
                    } catch {
                        detail = "(unable to parse error details)";
                    }
                }
                this.showNotice(
                    `GitLab: Cannot create project — ${redactSensitiveText(detail)}`,
                    7000
                );
                return null;
            }
            if (res.status === 401) {
                this.showNotice("GitLab: Token is invalid or expired.", 6000);
                return null;
            }
            if (res.status === 403) {
                this.showNotice(
                    "GitLab: Insufficient permissions to create a project. Ensure the token has the 'api' scope.",
                    8000
                );
                return null;
            }
            if (res.status === 409) {
                // Project already exists (conflict)
                // Try to include a helpful identifier (prefer server-returned path_with_namespace if present).
                const maybe = res.json as unknown;
                let identifier = name;
                if (maybe && typeof maybe === "object") {
                    const m = maybe as {
                        path_with_namespace?: unknown;
                        path?: unknown;
                        name?: unknown;
                    };
                    if (
                        typeof m.path_with_namespace === "string" &&
                        m.path_with_namespace.trim()
                    ) {
                        identifier = m.path_with_namespace.trim();
                    } else if (typeof m.path === "string" && m.path.trim()) {
                        identifier = m.path.trim();
                    } else if (typeof m.name === "string" && m.name.trim()) {
                        identifier = m.name.trim();
                    }
                }
                this.showNotice(
                    `GitLab: Project already exists — cannot create project '${redactSensitiveText(identifier)}'.`,
                    6000
                );
                console.error("GitLab createProject: project already exists");
                return null;
            }
            this.showNotice(
                `GitLab: Unexpected response ${res.status} while creating project.`,
                6000
            );
            return null;
        } catch (err) {
            let errMsg: string;
            if (err instanceof Error) {
                errMsg = err.message;
            } else if (err !== null && typeof err === "object") {
                try {
                    const json = JSON.stringify(err);
                    errMsg =
                        json && json !== "{}"
                            ? json
                            : "(unable to parse error details)";
                } catch {
                    errMsg = "(unable to parse error details)";
                }
            } else {
                errMsg = String(err);
            }
            this.showNotice(
                `GitLab: Failed to create project — ${redactSensitiveText(errMsg)}`,
                6000
            );
            return null;
        }
    }
}
