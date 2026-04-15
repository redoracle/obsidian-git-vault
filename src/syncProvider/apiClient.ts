import { requestUrl, type RequestUrlParam } from "obsidian";
import { fileIsBinary } from "../utils";
import type {
    SyncProviderCapabilities,
    SyncProviderType,
} from "./syncProvider";
import { getSyncProviderCapabilities } from "./providerRegistry";

export interface ApiRemoteItem {
    path: string;
    revision?: string;
    size?: number;
    remoteUrl?: string;
    remoteHistoryUrl?: string;
}

export type ApiMutation =
    | {
          kind: "create" | "update";
          path: string;
          content: string | Uint8Array;
          previousRevision?: string;
      }
    | {
          kind: "delete";
          path: string;
          previousRevision?: string;
      };

export interface ApiForgeClient {
    readonly provider: Exclude<SyncProviderType, "git">;
    readonly capabilities: SyncProviderCapabilities;
    init(): Promise<void>;
    getDefaultBranch(): Promise<string | undefined>;
    listBranches(): Promise<string[]>;
    listRemoteFiles(): Promise<Map<string, ApiRemoteItem>>;
    downloadFile(path: string): Promise<string | Uint8Array>;
    /**
     * Optional lightweight header fetch that requests only the first `bytes`
     * of a remote file. Implementations may return `null` when header-only
     * fetch is not supported.
     */
    downloadFileHeader?: (
        path: string,
        bytes?: number
    ) => Promise<Uint8Array | null>;
    commitMutations(mutations: ApiMutation[], message: string): Promise<number>;
    getRemoteUrl(path: string): string | undefined;
    getRemoteHistoryUrl(path: string): string | undefined;
}

type RequestKind = "json" | "text" | "bytes";

type ApiError = Error & { status: number };

function normalizeUrlPart(value: string): string {
    return value.replace(/\/+$/, "");
}

function toBytes(content: string | Uint8Array): Uint8Array {
    return typeof content === "string"
        ? Buffer.from(content, "utf8")
        : Buffer.from(content);
}

function createConcurrencyLimiter(
    limit: number
): <T>(task: () => Promise<T>) => Promise<T> {
    if (limit < 1) {
        throw new Error("Concurrency limit must be at least 1.");
    }

    let activeCount = 0;
    const pendingTasks: Array<() => void> = [];

    const scheduleNext = (): void => {
        if (activeCount >= limit) {
            return;
        }
        const nextTask = pendingTasks.shift();
        if (!nextTask) {
            return;
        }
        nextTask();
    };

    return async <T>(task: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const run = (): void => {
                activeCount++;
                task()
                    .then(resolve, reject)
                    .finally(() => {
                        activeCount--;
                        scheduleNext();
                    });
            };

            if (activeCount < limit) {
                run();
                return;
            }

            pendingTasks.push(run);
        });
}

export async function computeGitBlobSha(
    content: string | Uint8Array
): Promise<string> {
    const bytes = toBytes(content);
    const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
    const payload = Buffer.concat([header, bytes]);
    // NOTE: Git object IDs (blob/tree/commit) historically use SHA-1.
    // This function intentionally computes the Git-style blob OID using
    // SHA-1 for compatibility with Git hosting APIs (they return SHA-1
    // hashes for blob revisions).  Although SHA-1 is considered weak for
    // cryptographic purposes, using it here is necessary to interoperate
    // with existing Git protocols. Do NOT use this for general-purpose
    // cryptographic integrity checks; prefer SHA-256 or stronger there.
    //
    // nosemgrep: javascript.node-stdlib.cryptography.crypto-weak-algorithm.crypto-weak-algorithm
    const digest = await globalThis.crypto.subtle.digest("SHA-1", payload);
    return Buffer.from(digest).toString("hex");
}

abstract class ApiClientBase implements ApiForgeClient {
    readonly maxRetries = 4;

    abstract readonly provider: Exclude<SyncProviderType, "git">;
    abstract readonly capabilities: SyncProviderCapabilities;

    protected abstract get baseApiUrl(): string;
    protected abstract get token(): string;
    protected abstract get defaultHeaders(): Record<string, string>;

    abstract init(): Promise<void>;
    abstract getDefaultBranch(): Promise<string | undefined>;
    abstract listBranches(): Promise<string[]>;
    abstract listRemoteFiles(): Promise<Map<string, ApiRemoteItem>>;
    abstract downloadFile(path: string): Promise<string | Uint8Array>;
    abstract commitMutations(
        mutations: ApiMutation[],
        message: string
    ): Promise<number>;
    abstract getRemoteUrl(path: string): string | undefined;
    abstract getRemoteHistoryUrl(path: string): string | undefined;

    protected encodePathSegments(filePath: string): string {
        return filePath
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
    }

    protected getHeader(
        headers: Record<string, string> | undefined,
        name: string
    ): string | undefined {
        if (!headers) {
            return undefined;
        }
        const target = name.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === target) {
                return value;
            }
        }
        return undefined;
    }

    protected createApiError(
        method: string,
        url: string,
        status: number,
        text: string
    ): ApiError {
        // Decode the URL for readability – the raw URL contains %20 etc. for
        // file paths with spaces which is correct for HTTP but ugly in notices.
        let displayUrl = url;
        try {
            displayUrl = decodeURIComponent(url);
        } catch {
            // keep raw URL if decoding fails
        }
        const error = new Error(
            `${this.provider} API ${method} ${displayUrl} failed: ${status} ${text.slice(0, 300)}`
        ) as ApiError;
        error.status = status;
        return error;
    }

    protected parseRetryDelayMs(
        headers: Record<string, string> | undefined,
        status: number,
        text: string,
        attempt: number
    ): number | null {
        const retryAfter = this.getHeader(headers, "retry-after");
        if (retryAfter) {
            const seconds = Number(retryAfter);
            if (!Number.isNaN(seconds)) {
                return Math.max(0, seconds * 1000);
            }
        }

        const remaining = this.getHeader(headers, "x-ratelimit-remaining");
        const reset = this.getHeader(headers, "x-ratelimit-reset");
        if (status === 403 && remaining === "0" && reset) {
            const resetAt = Number(reset) * 1000;
            if (!Number.isNaN(resetAt)) {
                return Math.max(0, resetAt - Date.now()) + 1000;
            }
        }

        const lowerText = text.toLowerCase();
        if (
            status === 429 ||
            (status === 403 && lowerText.includes("rate limit")) ||
            status >= 500
        ) {
            return Math.min(60_000, 1000 * 2 ** attempt);
        }

        return null;
    }

    protected async request<T>(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        kind: RequestKind,
        body?: unknown,
        extraHeaders?: Record<string, string>
    ): Promise<T> {
        const url = `${normalizeUrlPart(this.baseApiUrl)}${path}`;

        for (let attempt = 0; ; attempt++) {
            const params: RequestUrlParam = {
                url,
                method,
                headers: {
                    ...this.defaultHeaders,
                    ...extraHeaders,
                },
                throw: false,
            };

            if (body !== undefined) {
                params.body = JSON.stringify(body);
                params.headers = {
                    ...params.headers,
                    "Content-Type": "application/json",
                };
            }

            const res = await requestUrl(params);
            if (res.status < 400) {
                if (kind === "bytes") {
                    if (res.arrayBuffer) {
                        return new Uint8Array(res.arrayBuffer) as T;
                    }
                    return Buffer.from(res.text ?? "", "utf8") as T;
                }
                if (kind === "text") {
                    return (res.text ?? "") as T;
                }
                if (!res.text) {
                    throw new Error(
                        `Unexpected empty response body from ${method} ${url} (HTTP ${res.status})`
                    );
                }
                return res.json as T;
            }

            const delay = this.parseRetryDelayMs(
                res.headers,
                res.status,
                res.text,
                attempt
            );
            if (delay !== null && attempt < this.maxRetries) {
                await new Promise((resolve) =>
                    window.setTimeout(resolve, delay)
                );
                continue;
            }

            throw this.createApiError(method, url, res.status, res.text);
        }
    }

    protected async requestJson<T>(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>
    ): Promise<T> {
        return this.request<T>(method, path, "json", body, extraHeaders);
    }

    protected async requestText(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>
    ): Promise<string> {
        return this.request<string>(method, path, "text", body, extraHeaders);
    }

    protected async requestBytes(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        body?: unknown,
        extraHeaders?: Record<string, string>
    ): Promise<Uint8Array> {
        return this.request<Uint8Array>(
            method,
            path,
            "bytes",
            body,
            extraHeaders
        );
    }
}

interface GitHubTreeItem {
    path: string;
    type: "blob" | "tree";
    sha: string;
    size?: number;
}

interface GitHubTreeResponse {
    tree: GitHubTreeItem[];
    truncated: boolean;
}

interface GitHubRef {
    object: { sha: string };
}

interface GitHubCommitResponse {
    sha: string;
    tree: { sha: string };
}

interface GitHubContentResponse {
    sha: string;
    content: string;
}

interface GitHubRepoResponse {
    default_branch?: string;
}

interface GitHubBranchResponse {
    name?: string;
}

export class GitHubForgeClient extends ApiClientBase {
    readonly provider = "github" as const;
    readonly capabilities: SyncProviderCapabilities =
        getSyncProviderCapabilities("github");
    readonly blobUploadConcurrency = 4;
    private _repoCache: GitHubRepoResponse | undefined;

    constructor(
        private readonly cfg: {
            token: string;
            owner: string;
            repo: string;
            branch: string;
        }
    ) {
        super();
    }

    protected get baseApiUrl(): string {
        return "https://api.github.com";
    }

    protected get token(): string {
        return this.cfg.token;
    }

    protected get defaultHeaders(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
    }

    private encodePath(filePath: string): string {
        return this.encodePathSegments(filePath);
    }

    private encodeRef(ref: string): string {
        return this.encodePath(ref);
    }

    private async getBranchState(): Promise<{
        commitSha: string;
        treeSha: string;
    }> {
        const ref = await this.requestJson<GitHubRef>(
            "GET",
            `/repos/${this.cfg.owner}/${this.cfg.repo}/git/ref/heads/${this.encodeRef(this.cfg.branch)}`
        );
        const commit = await this.requestJson<GitHubCommitResponse>(
            "GET",
            `/repos/${this.cfg.owner}/${this.cfg.repo}/git/commits/${ref.object.sha}`
        );
        return { commitSha: commit.sha, treeSha: commit.tree.sha };
    }

    async init(): Promise<void> {
        if (!this.token) {
            throw new Error("GitHub token is not configured.");
        }
        if (!this.cfg.owner || !this.cfg.repo) {
            throw new Error("GitHub owner/repository is not configured.");
        }
        this._repoCache = await this.requestJson<GitHubRepoResponse>(
            "GET",
            `/repos/${this.cfg.owner}/${this.cfg.repo}`
        );
    }

    async getDefaultBranch(): Promise<string | undefined> {
        if (this._repoCache) {
            return this._repoCache.default_branch;
        }
        const repo = await this.requestJson<GitHubRepoResponse>(
            "GET",
            `/repos/${this.cfg.owner}/${this.cfg.repo}`
        );
        return repo.default_branch;
    }

    async listBranches(): Promise<string[]> {
        const branches: string[] = [];
        let page = 1;

        while (true) {
            const response = await this.requestJson<GitHubBranchResponse[]>(
                "GET",
                `/repos/${this.cfg.owner}/${this.cfg.repo}/branches?per_page=100&page=${page}`
            );
            if (response.length === 0) {
                break;
            }

            for (const branch of response) {
                const name = branch.name?.trim();
                if (name) {
                    branches.push(name);
                }
            }

            if (response.length < 100) {
                break;
            }
            page++;
        }

        return branches;
    }

    async listRemoteFiles(): Promise<Map<string, ApiRemoteItem>> {
        const { treeSha } = await this.getBranchState();
        const tree = await this.requestJson<GitHubTreeResponse>(
            "GET",
            `/repos/${this.cfg.owner}/${this.cfg.repo}/git/trees/${treeSha}?recursive=1`
        );
        if (tree.truncated) {
            throw new Error(
                "GitHub tree response was truncated. The repository is too large for recursive sync."
            );
        }
        const result = new Map<string, ApiRemoteItem>();
        for (const item of tree.tree) {
            if (item.type !== "blob") {
                continue;
            }
            result.set(item.path, {
                path: item.path,
                revision: item.sha,
                size: item.size,
                remoteUrl: this.getRemoteUrl(item.path),
                remoteHistoryUrl: this.getRemoteHistoryUrl(item.path),
            });
        }
        return result;
    }

    async downloadFile(path: string): Promise<string | Uint8Array> {
        const contentsPath = `/repos/${this.cfg.owner}/${this.cfg.repo}/contents/${this.encodePath(path)}?ref=${encodeURIComponent(this.cfg.branch)}`;
        const content = await this.requestJson<GitHubContentResponse>(
            "GET",
            contentsPath
        );
        if (typeof content.content !== "string") {
            // The Contents API omits inline `content` for some blob-like
            // entries, such as symlinks stored in the git tree. Fall back to
            // the raw representation so dedicated-vault export can still
            // materialize those paths instead of failing the whole import.
            const rawContent = await this.requestBytes(
                "GET",
                contentsPath,
                undefined,
                {
                    Accept: "application/vnd.github.raw",
                }
            );
            return fileIsBinary(path)
                ? rawContent
                : Buffer.from(rawContent).toString("utf8");
        }
        const decoded = Buffer.from(
            content.content.replace(/\n/g, ""),
            "base64"
        );
        return fileIsBinary(path)
            ? new Uint8Array(decoded)
            : decoded.toString("utf8");
    }

    async downloadFileHeader(
        path: string,
        bytes = 512
    ): Promise<Uint8Array | null> {
        try {
            const contentsPath = `/repos/${this.cfg.owner}/${this.cfg.repo}/contents/${this.encodePath(path)}?ref=${encodeURIComponent(this.cfg.branch)}`;
            const res = await this.requestBytes(
                "GET",
                contentsPath,
                undefined,
                {
                    Accept: "application/vnd.github.raw",
                    Range: `bytes=0-${bytes - 1}`,
                }
            );
            // If the server ignored the Range header and returned more than
            // the requested bytes, treat this as lack of range support and
            // bail out (return null) so callers can avoid processing a full
            // file download as a header probe.
            if (res.length > bytes) {
                if (
                    typeof console !== "undefined" &&
                    typeof console.debug === "function"
                ) {
                    console.debug(
                        `[Git Vault] downloadFileHeader: server returned ${res.length} bytes (> requested ${bytes}), treating as no-range support for ${contentsPath}`
                    );
                }
                return null;
            }
            return res;
        } catch (_err) {
            return null;
        }
    }

    async commitMutations(
        mutations: ApiMutation[],
        message: string
    ): Promise<number> {
        if (mutations.length === 0) {
            return 0;
        }
        const blobShas = new Map<string, string | null>();
        const limit = createConcurrencyLimiter(this.blobUploadConcurrency);
        await Promise.all(
            mutations.map((mutation) =>
                limit(async () => {
                    if (mutation.kind === "delete") {
                        blobShas.set(mutation.path, null);
                        return;
                    }

                    const body =
                        typeof mutation.content === "string"
                            ? {
                                  content: mutation.content,
                                  encoding: "utf-8",
                              }
                            : {
                                  content: Buffer.from(
                                      mutation.content
                                  ).toString("base64"),
                                  encoding: "base64",
                              };
                    const blob = await this.requestJson<{
                        sha: string;
                    }>(
                        "POST",
                        `/repos/${this.cfg.owner}/${this.cfg.repo}/git/blobs`,
                        body
                    );
                    blobShas.set(mutation.path, blob.sha);
                })
            )
        );
        // Multiple mutations need to be committed against the current remote
        // branch head. The remote branch may change between our initial
        // branch-state read and the final ref update; in that case GitHub
        // rejects the ref update with 422 "Update is not a fast forward".
        // To be robust, retry the full commit flow several times, re-reading
        // the branch state on each attempt to pick up the new head.
        // Backoff: exponential with full jitter to avoid thundering-herd when
        // multiple devices sync simultaneously.
        const maxAttempts = 6;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const { commitSha, treeSha } = await this.getBranchState();

            const tree = await this.requestJson<{ sha: string }>(
                "POST",
                `/repos/${this.cfg.owner}/${this.cfg.repo}/git/trees`,
                {
                    base_tree: treeSha,
                    tree: mutations.map((mutation) => ({
                        path: mutation.path,
                        mode: "100644",
                        type: "blob",
                        sha: blobShas.get(mutation.path) ?? null,
                    })),
                }
            );

            const commit = await this.requestJson<GitHubCommitResponse>(
                "POST",
                `/repos/${this.cfg.owner}/${this.cfg.repo}/git/commits`,
                {
                    message,
                    tree: tree.sha,
                    parents: [commitSha],
                }
            );

            try {
                await this.requestJson(
                    "PATCH",
                    `/repos/${this.cfg.owner}/${this.cfg.repo}/git/refs/heads/${this.encodeRef(this.cfg.branch)}`,
                    { sha: commit.sha, force: false }
                );
                return mutations.length;
            } catch (err: unknown) {
                // If GitHub reports a non-fast-forward update, retry the flow a
                // few times to pick up the new remote head. For other errors
                // or if we exhausted retries, rethrow.
                let status: number | undefined;
                if (
                    typeof err === "object" &&
                    err !== null &&
                    "status" in err
                ) {
                    const maybe = (err as Record<string, unknown>).status;
                    if (typeof maybe === "number") {
                        status = maybe;
                    }
                }

                if (status === 422 && attempt < maxAttempts - 1) {
                    // Exponential backoff with full jitter: uniform random
                    // delay in [0, min(30s, 500ms * 2^attempt)].  Full jitter
                    // prevents multiple devices from retrying in lock-step.
                    const cap = Math.min(30_000, 500 * 2 ** attempt);
                    const jitteredDelay = Math.floor(Math.random() * cap);
                    await new Promise((res) =>
                        window.setTimeout(res, jitteredDelay)
                    );
                    continue;
                }
                throw err;
            }
        }

        // If we exit the loop without returning, something unexpected happened.
        throw new Error("Failed to commit mutations after multiple attempts");
    }

    getRemoteUrl(path: string): string | undefined {
        return `https://github.com/${this.cfg.owner}/${this.cfg.repo}/blob/${encodeURIComponent(this.cfg.branch)}/${this.encodePath(path)}`;
    }

    getRemoteHistoryUrl(path: string): string | undefined {
        return `https://github.com/${this.cfg.owner}/${this.cfg.repo}/commits/${encodeURIComponent(this.cfg.branch)}/${this.encodePath(path)}`;
    }
}

interface GitLabTreeItem {
    id: string;
    path: string;
    type: "blob" | "tree";
}

interface GitLabProjectResponse {
    default_branch?: string;
}

interface GitLabBranchResponse {
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

export class GitLabForgeClient extends ApiClientBase {
    readonly provider = "gitlab" as const;
    readonly capabilities: SyncProviderCapabilities =
        getSyncProviderCapabilities("gitlab");
    private _gitlabProject: GitLabProjectResponse | undefined;

    constructor(
        private readonly cfg: {
            token: string;
            baseUrl: string;
            projectId: string;
            branch: string;
        }
    ) {
        super();
    }

    protected get baseApiUrl(): string {
        const base = normalizeUrlPart(
            this.cfg.baseUrl || "https://gitlab.com/api/v4"
        );
        return base.endsWith("/api/v4") ? base : `${base}/api/v4`;
    }

    protected get token(): string {
        return this.cfg.token;
    }

    protected get defaultHeaders(): Record<string, string> {
        return {
            "PRIVATE-TOKEN": this.token,
        };
    }

    private get projectId(): string {
        return encodeURIComponent(normalizeGitLabProjectId(this.cfg.projectId));
    }

    private encodePath(filePath: string): string {
        return encodeURIComponent(filePath);
    }

    async init(): Promise<void> {
        if (!this.token) {
            throw new Error("GitLab token is not configured.");
        }
        if (!this.cfg.projectId) {
            throw new Error("GitLab project id/path is not configured.");
        }
        this._gitlabProject = await this.requestJson<GitLabProjectResponse>(
            "GET",
            `/projects/${this.projectId}`
        );
    }

    async getDefaultBranch(): Promise<string | undefined> {
        if (this._gitlabProject) {
            return this._gitlabProject.default_branch;
        }
        const project = await this.requestJson<GitLabProjectResponse>(
            "GET",
            `/projects/${this.projectId}`
        );
        return project.default_branch;
    }

    async listBranches(): Promise<string[]> {
        const branches: string[] = [];
        let page = 1;

        while (true) {
            const response = await this.requestJson<GitLabBranchResponse[]>(
                "GET",
                `/projects/${this.projectId}/repository/branches?per_page=100&page=${page}`
            );
            if (response.length === 0) {
                break;
            }

            for (const branch of response) {
                const name = branch.name?.trim();
                if (name) {
                    branches.push(name);
                }
            }

            if (response.length < 100) {
                break;
            }
            page++;
        }

        return branches;
    }

    async listRemoteFiles(): Promise<Map<string, ApiRemoteItem>> {
        const result = new Map<string, ApiRemoteItem>();
        let page = 1;
        while (true) {
            const items = await this.requestJson<GitLabTreeItem[]>(
                "GET",
                `/projects/${this.projectId}/repository/tree?ref=${encodeURIComponent(this.cfg.branch)}&recursive=true&per_page=1000&page=${page}`
            );
            if (items.length === 0) {
                break;
            }
            for (const item of items) {
                if (item.type !== "blob") {
                    continue;
                }
                result.set(item.path, {
                    path: item.path,
                    revision: item.id,
                    remoteUrl: this.getRemoteUrl(item.path),
                    remoteHistoryUrl: this.getRemoteHistoryUrl(item.path),
                });
            }
            page++;
        }
        return result;
    }

    async downloadFile(path: string): Promise<string | Uint8Array> {
        const bytes = await this.requestBytes(
            "GET",
            `/projects/${this.projectId}/repository/files/${this.encodePath(path)}/raw?ref=${encodeURIComponent(this.cfg.branch)}`
        );
        return fileIsBinary(path) ? bytes : Buffer.from(bytes).toString("utf8");
    }

    async downloadFileHeader(
        path: string,
        bytes = 512
    ): Promise<Uint8Array | null> {
        try {
            const rawPath = `/projects/${this.projectId}/repository/files/${this.encodePath(path)}/raw?ref=${encodeURIComponent(this.cfg.branch)}`;
            const res = await this.requestBytes("GET", rawPath, undefined, {
                Range: `bytes=0-${bytes - 1}`,
            });
            if (res.length > bytes) {
                if (
                    typeof console !== "undefined" &&
                    typeof console.debug === "function"
                ) {
                    console.debug(
                        `[Git Vault] downloadFileHeader: server returned ${res.length} bytes (> requested ${bytes}), treating as no-range support for ${rawPath}`
                    );
                }
                return null;
            }
            return res;
        } catch (_err) {
            return null;
        }
    }

    async commitMutations(
        mutations: ApiMutation[],
        message: string
    ): Promise<number> {
        if (mutations.length === 0) {
            return 0;
        }
        await this.requestJson(
            "POST",
            `/projects/${this.projectId}/repository/commits`,
            {
                branch: this.cfg.branch,
                commit_message: message,
                actions: mutations.map((mutation) => {
                    if (mutation.kind === "delete") {
                        return {
                            action: "delete",
                            file_path: mutation.path,
                        };
                    }
                    return {
                        action: mutation.kind,
                        file_path: mutation.path,
                        content: Buffer.from(
                            toBytes(mutation.content)
                        ).toString("base64"),
                        encoding: "base64",
                    };
                }),
            }
        );
        return mutations.length;
    }

    getRemoteUrl(path: string): string | undefined {
        const webBase = this.getWebBaseForProject();
        if (!webBase) return undefined;
        return `${webBase}/${this.cfg.projectId.replace(/%2F/gi, "/")}/-/blob/${encodeURIComponent(this.cfg.branch)}/${this.encodePathSegments(path)}`;
    }

    getRemoteHistoryUrl(path: string): string | undefined {
        const webBase = this.getWebBaseForProject();
        if (!webBase) return undefined;
        return `${webBase}/${this.cfg.projectId.replace(/%2F/gi, "/")}/-/commits/${encodeURIComponent(this.cfg.branch)}/${this.encodePathSegments(path)}`;
    }

    private getWebBaseForProject(): string | undefined {
        // Numeric-only project IDs can't form a valid web browse URL
        if (/^\d+$/.test(this.cfg.projectId)) return undefined;
        const base = normalizeUrlPart(this.cfg.baseUrl || "https://gitlab.com");
        const webBase = base.replace(/\/api\/v4$/, "");
        return webBase;
    }
}

interface GiteaContentItem {
    type: "file" | "dir";
    path: string;
    sha?: string;
    content?: string;
    encoding?: string;
}

interface GiteaRepoResponse {
    default_branch?: string;
}

interface GiteaBranchResponse {
    name?: string;
}

export class GiteaForgeClient extends ApiClientBase {
    readonly treeTraversalConcurrency = 4;
    readonly provider = "gitea" as const;
    readonly capabilities: SyncProviderCapabilities =
        getSyncProviderCapabilities("gitea");
    private _repoInfo: GiteaRepoResponse | undefined;

    constructor(
        private readonly cfg: {
            token: string;
            baseUrl: string;
            owner: string;
            repo: string;
            branch: string;
        }
    ) {
        super();
    }

    protected get baseApiUrl(): string {
        const base = normalizeUrlPart(this.cfg.baseUrl);
        if (!base) {
            throw new Error("Missing baseUrl in SyncProvider config.");
        }
        return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
    }

    protected get token(): string {
        return this.cfg.token;
    }

    protected get defaultHeaders(): Record<string, string> {
        return {
            Authorization: `token ${this.token}`,
            Accept: "application/json",
        };
    }

    // Note: Gitea URLs use `encodePathSegments` directly; no wrapper
    // `encodePath` is needed here.

    private contentsPath(filePath = ""): string {
        const suffix = filePath ? `/${this.encodePathSegments(filePath)}` : "";
        return `/repos/${this.cfg.owner}/${this.cfg.repo}/contents${suffix}?ref=${encodeURIComponent(this.cfg.branch)}`;
    }

    async init(): Promise<void> {
        if (!this.token) {
            throw new Error("Gitea token is not configured.");
        }
        if (!this.cfg.baseUrl || !this.cfg.owner || !this.cfg.repo) {
            throw new Error(
                "Gitea base URL / owner / repository is not configured."
            );
        }
        this._repoInfo = await this.requestJson<GiteaRepoResponse>(
            "GET",
            `/repos/${this.cfg.owner}/${this.cfg.repo}`
        );
    }

    async getDefaultBranch(): Promise<string | undefined> {
        if (this._repoInfo) {
            return this._repoInfo.default_branch;
        }
        const repo = await this.requestJson<GiteaRepoResponse>(
            "GET",
            `/repos/${this.cfg.owner}/${this.cfg.repo}`
        );
        return repo.default_branch;
    }

    async listBranches(): Promise<string[]> {
        const branches: string[] = [];
        let page = 1;

        while (true) {
            const response = await this.requestJson<GiteaBranchResponse[]>(
                "GET",
                `/repos/${this.cfg.owner}/${this.cfg.repo}/branches?limit=100&page=${page}`
            );
            if (response.length === 0) {
                break;
            }

            for (const branch of response) {
                const name = branch.name?.trim();
                if (name) {
                    branches.push(name);
                }
            }

            if (response.length < 100) {
                break;
            }
            page++;
        }

        return branches;
    }

    private async listTree(): Promise<Map<string, ApiRemoteItem>> {
        const result = new Map<string, ApiRemoteItem>();
        const pendingDirectories = [""];

        while (pendingDirectories.length > 0) {
            const batch = pendingDirectories.splice(
                0,
                this.treeTraversalConcurrency
            );
            const responses = await Promise.all(
                batch.map(async (path) => {
                    const response = await this.requestJson<
                        GiteaContentItem[] | GiteaContentItem
                    >("GET", this.contentsPath(path));
                    return Array.isArray(response) ? response : [response];
                })
            );

            for (const items of responses) {
                for (const item of items) {
                    if (item.type === "dir") {
                        pendingDirectories.push(item.path);
                        continue;
                    }
                    result.set(item.path, {
                        path: item.path,
                        revision: item.sha,
                        remoteUrl: this.getRemoteUrl(item.path),
                        remoteHistoryUrl: this.getRemoteHistoryUrl(item.path),
                    });
                }
            }
        }

        return result;
    }

    async listRemoteFiles(): Promise<Map<string, ApiRemoteItem>> {
        return this.listTree();
    }

    async downloadFile(path: string): Promise<string | Uint8Array> {
        const response = await this.requestJson<GiteaContentItem>(
            "GET",
            this.contentsPath(path)
        );
        const decoded = Buffer.from(response.content ?? "", "base64");
        return fileIsBinary(path)
            ? new Uint8Array(decoded)
            : decoded.toString("utf8");
    }

    downloadFileHeader(
        _path: string,
        _bytes = 512
    ): Promise<Uint8Array | null> {
        // Gitea/Forgejo API may not support raw range requests consistently
        // across installations. Fall back to `null` so callers can choose a
        // safe behavior (e.g. assume provider-level encryption) instead of
        // fetching entire file contents.
        return Promise.resolve(null);
    }

    async commitMutations(
        mutations: ApiMutation[],
        message: string
    ): Promise<number> {
        for (const mutation of mutations) {
            const path = `/repos/${this.cfg.owner}/${this.cfg.repo}/contents/${this.encodePathSegments(mutation.path)}`;
            if (mutation.kind === "delete") {
                if (!mutation.previousRevision) {
                    throw new Error(
                        `Cannot delete ${mutation.path} on Gitea without a previous revision sha`
                    );
                }
                await this.requestJson("DELETE", path, {
                    branch: this.cfg.branch,
                    message,
                    sha: mutation.previousRevision,
                });
                continue;
            }
            const body = {
                branch: this.cfg.branch,
                message,
                content: Buffer.from(toBytes(mutation.content)).toString(
                    "base64"
                ),
                sha:
                    mutation.kind === "update"
                        ? mutation.previousRevision
                        : undefined,
            };
            await this.requestJson(
                mutation.kind === "create" ? "POST" : "PUT",
                path,
                body
            );
        }
        return mutations.length;
    }

    getRemoteUrl(path: string): string | undefined {
        const base = normalizeUrlPart(this.cfg.baseUrl);
        if (!base) {
            return undefined;
        }
        return `${base}/${this.cfg.owner}/${this.cfg.repo}/src/branch/${encodeURIComponent(this.cfg.branch)}/${this.encodePathSegments(path)}`;
    }

    getRemoteHistoryUrl(path: string): string | undefined {
        const base = normalizeUrlPart(this.cfg.baseUrl);
        if (!base) {
            return undefined;
        }
        return `${base}/${this.cfg.owner}/${this.cfg.repo}/commits/branch/${encodeURIComponent(this.cfg.branch)}/${this.encodePathSegments(path)}`;
    }
}
