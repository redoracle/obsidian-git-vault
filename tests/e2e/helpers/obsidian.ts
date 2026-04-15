import {
    chromium,
    expect,
    type Browser,
    type Locator,
    type Page,
} from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const PLUGIN_ID = "git-vault";
export const PLUGIN_NAME = "Obsidian Git Vault";
export const PROVIDER_LABELS = {
    git: "Git",
    github: "GitHub API",
    gitlab: "GitLab API",
    gitea: "Gitea / Forgejo API",
} as const;

type ProviderKey = keyof typeof PROVIDER_LABELS;

type ProviderRepoConfig = {
    repoUrl: string;
};

type DirectorySnapshotEntry = {
    path: string;
    sha256: string;
    size: number;
};

export type ProviderSecretsFixture = {
    github: ProviderRepoConfig & {
        token: string;
        owner: string;
        repo: string;
        branch: string;
    };
    gitlab: ProviderRepoConfig & {
        token: string;
        baseUrl: string;
        projectId: string;
        branch: string;
    };
    gitea: ProviderRepoConfig & {
        token: string;
        baseUrl: string;
        owner: string;
        repo: string;
        branch: string;
    };
    git: ProviderRepoConfig & {
        remoteName: string;
        branch: string;
    };
};

export type PreparedVault = {
    vaultPath: string;
    userDataDir: string;
    cleanup: () => Promise<void>;
};

export type LaunchedObsidian = {
    browser: Browser;
    page: Page;
    audit: RendererAudit;
    close: () => Promise<void>;
};

type AuditEntry = {
    type: string;
    text: string;
};

type AuditFailureMatchers = {
    allowConsoleWarnings?: RegExp[];
    allowConsoleErrors?: RegExp[];
    allowPageErrors?: RegExp[];
    allowFailedRequests?: RegExp[];
    allowAppLogErrors?: RegExp[];
    allowUnhandledRejections?: RegExp[];
};

const DEFAULT_OBSIDIAN_BIN: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    linux: "/usr/bin/obsidian",
    win32: process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Obsidian", "Obsidian.exe")
        : path.join("C:\\Program Files", "Obsidian", "Obsidian.exe"),
};

// Increased timeouts to reduce flakiness in E2E tests — these values are
// used across plugin initialization, UI interactions, and settings
// operations (e.g. waitForPluginReady, waitForPluginRuntimeReady,
// openSyncProSettings, submitGeneralPrompt).
// `SETTINGS_READY_TIMEOUT` defaults to 20_000ms to avoid masking regressions;
// override via `E2E_SETTINGS_READY_TIMEOUT` (ms) in CI when empirical logs
// show consistent timeouts.
const PLUGIN_READY_TIMEOUT = 60_000;
const SETTINGS_READY_TIMEOUT = (() => {
    const n = Number(process.env.E2E_SETTINGS_READY_TIMEOUT);
    return Number.isFinite(n) && n > 0 ? n : 20_000;
})();

function obsidianConfigDir(userDataDir?: string): string {
    if (userDataDir) {
        return userDataDir;
    }
    switch (process.platform) {
        case "darwin":
            return path.join(
                os.homedir(),
                "Library",
                "Application Support",
                "obsidian"
            );
        case "win32":
            return path.join(process.env.APPDATA ?? os.homedir(), "obsidian");
        default:
            return path.join(os.homedir(), ".config", "obsidian");
    }
}

function obsidianLogPath(userDataDir?: string): string | null {
    if (userDataDir) {
        return path.join(userDataDir, "obsidian.log");
    }
    switch (process.platform) {
        case "darwin":
            return path.join(
                os.homedir(),
                "Library",
                "Application Support",
                "obsidian",
                "obsidian.log"
            );
        case "win32":
            return path.join(
                process.env.APPDATA ?? os.homedir(),
                "obsidian",
                "obsidian.log"
            );
        default:
            return path.join(
                os.homedir(),
                ".config",
                "obsidian",
                "obsidian.log"
            );
    }
}

function ensureVaultRegistered(vaultPath: string, userDataDir?: string): void {
    const configPath = path.join(
        obsidianConfigDir(userDataDir),
        "obsidian.json"
    );
    type VaultEntry = { path: string; ts: number; open: boolean };
    type ObsidianConfig = {
        vaults?: Record<string, VaultEntry>;
        [key: string]: unknown;
    };

    if (!fs.existsSync(configPath)) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ vaults: {} }, null, 4));
    }

    const raw = fs.readFileSync(configPath, "utf8");
    let config: ObsidianConfig;
    try {
        config = JSON.parse(raw) as ObsidianConfig;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid Obsidian config at ${configPath}: ${message}`);
    }
    config.vaults ??= {};

    let updated = false;
    for (const vault of Object.values(config.vaults)) {
        if (typeof vault.open !== "boolean") {
            vault.open = false;
            updated = true;
        }
    }

    const alreadyRegistered = Object.values(config.vaults).some(
        (vault) => vault.path === vaultPath
    );
    if (alreadyRegistered) {
        if (updated) {
            fs.writeFileSync(
                configPath,
                JSON.stringify(config, null, 4),
                "utf8"
            );
        }
        return;
    }

    const id = crypto
        .createHash("sha256")
        .update(vaultPath)
        .digest("hex")
        .slice(0, 16);
    config.vaults[id] = { path: vaultPath, ts: Date.now(), open: false };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), "utf8");
}

export function registerVaultPath(
    vaultPath: string,
    userDataDir?: string
): void {
    ensureVaultRegistered(vaultPath, userDataDir);
}

export function readRegisteredVaultPaths(userDataDir?: string): string[] {
    const configPath = path.join(
        obsidianConfigDir(userDataDir),
        "obsidian.json"
    );
    if (!fs.existsSync(configPath)) {
        return [];
    }

    const raw = fs.readFileSync(configPath, "utf8");
    let parsed: { vaults?: Record<string, { path: string }> };
    try {
        parsed = JSON.parse(raw) as typeof parsed;
    } catch {
        return [];
    }

    return Object.values(parsed.vaults ?? {})
        .map((entry) => entry.path)
        .filter((entry): entry is string => typeof entry === "string");
}

function parseRepoUrl(repoUrl: string): {
    host: string;
    owner: string;
    repo: string;
} {
    const url = new URL(repoUrl);
    const segments = url.pathname.replace(/^\/+/, "").split("/");
    if (segments.length < 2 || !segments[0] || !segments[1]) {
        throw new Error("Invalid repository URL: missing owner or repo");
    }
    const [owner, repoWithGit] = segments;
    const repo = repoWithGit.replace(/\.git$/i, "");
    return { host: url.origin, owner, repo };
}

function normalizeSnapshotPath(relativePath: string): string {
    return relativePath.split(path.sep).join("/");
}

function shouldIgnoreSnapshotPath(
    relativePath: string,
    ignoreRelativePaths: string[]
): boolean {
    const normalizedPath = normalizeSnapshotPath(relativePath);
    return ignoreRelativePaths.some((candidate) => {
        const normalizedCandidate = normalizeSnapshotPath(candidate);
        return (
            normalizedPath === normalizedCandidate ||
            normalizedPath.startsWith(`${normalizedCandidate}/`)
        );
    });
}

async function collectDirectorySnapshot(
    rootPath: string,
    ignoreRelativePaths: string[] = []
): Promise<DirectorySnapshotEntry[]> {
    const entries: DirectorySnapshotEntry[] = [];

    const walk = async (currentPath: string): Promise<void> => {
        const directoryEntries = fs.readdirSync(currentPath, {
            withFileTypes: true,
        });

        for (const entry of directoryEntries) {
            const absolutePath = path.join(currentPath, entry.name);
            const relativePath = normalizeSnapshotPath(
                path.relative(rootPath, absolutePath)
            );

            if (
                relativePath.length === 0 ||
                shouldIgnoreSnapshotPath(relativePath, ignoreRelativePaths)
            ) {
                continue;
            }

            if (entry.isDirectory()) {
                await walk(absolutePath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const hash = crypto.createHash("sha256");
            let size = 0;
            for await (const chunk of fs.createReadStream(absolutePath)) {
                const buffer = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk);
                hash.update(buffer);
                size += buffer.byteLength;
            }
            entries.push({
                path: relativePath,
                sha256: hash.digest("hex"),
                size,
            });
        }
    };

    await walk(rootPath);
    return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function expectDirectoryToMatchGitReference(
    directoryPath: string,
    options: {
        repoUrl: string;
        branch: string;
        ignoreRelativePaths?: string[];
    }
): Promise<void> {
    const referenceClonePath = fs.mkdtempSync(
        path.join(os.tmpdir(), "git-vault-reference-")
    );
    const ignoreRelativePaths = [
        ".git",
        ...(options.ignoreRelativePaths ?? []),
    ];

    try {
        execFileSync(
            "git",
            [
                "clone",
                "--depth",
                "1",
                "--branch",
                options.branch,
                "--single-branch",
                options.repoUrl,
                referenceClonePath,
            ],
            {
                stdio: "ignore",
            }
        );

        const actualSnapshot = await collectDirectorySnapshot(
            directoryPath,
            ignoreRelativePaths
        );
        const referenceSnapshot = await collectDirectorySnapshot(
            referenceClonePath,
            ignoreRelativePaths
        );

        expect(
            actualSnapshot,
            [
                `Expected directory ${directoryPath} to match git reference`,
                `repo=${options.repoUrl}`,
                `branch=${options.branch}`,
            ].join("\n")
        ).toEqual(referenceSnapshot);
    } finally {
        fs.rmSync(referenceClonePath, { recursive: true, force: true });
    }
}

export async function expectVaultToMatchActiveApiRemote(
    page: Page,
    directoryPath: string,
    options: {
        pluginId?: string;
        ignoreRelativePaths?: string[];
    } = {}
): Promise<void> {
    const pluginId = options.pluginId ?? PLUGIN_ID;
    const exportedPath = await page.evaluate(async (activePluginId) => {
        const windowAny = window as typeof window & {
            app?: {
                plugins?: {
                    plugins?: Record<
                        string,
                        {
                            syncManager?: {
                                provider?: {
                                    exportRemoteToDirectory?: (
                                        targetDir: string
                                    ) => Promise<number>;
                                };
                            };
                        }
                    >;
                };
            };
            require?: NodeRequire;
        };
        const plugin = windowAny.app?.plugins?.plugins?.[activePluginId];
        const exportRemoteToDirectory =
            plugin?.syncManager?.provider?.exportRemoteToDirectory;

        if (!exportRemoteToDirectory) {
            throw new Error("Active API provider export is not available.");
        }

        if (typeof windowAny.require !== "function") {
            throw new Error(
                "Node integration is not available in the renderer."
            );
        }

        const os = windowAny.require("os") as typeof import("os");
        const pathModule = windowAny.require("path") as typeof import("path");
        const fsPromises = windowAny.require(
            "fs/promises"
        ) as typeof import("fs/promises");

        const targetDir = await fsPromises.mkdtemp(
            pathModule.join(os.tmpdir(), "git-vault-api-reference-")
        );
        try {
            await exportRemoteToDirectory.call(
                plugin?.syncManager?.provider,
                targetDir
            );
        } catch (error) {
            await fsPromises.rm(targetDir, {
                recursive: true,
                force: true,
            });
            throw error;
        }
        return targetDir;
    }, pluginId);

    const ignoreRelativePaths = [
        ".git",
        ...(options.ignoreRelativePaths ?? []),
    ];

    try {
        const actualSnapshot = await collectDirectorySnapshot(
            directoryPath,
            ignoreRelativePaths
        );
        const referenceSnapshot = await collectDirectorySnapshot(
            exportedPath,
            ignoreRelativePaths
        );

        expect(
            actualSnapshot,
            `Expected directory ${directoryPath} to match the active API remote export`
        ).toEqual(referenceSnapshot);
    } finally {
        fs.rmSync(exportedPath, { recursive: true, force: true });
    }
}

function redactMessage(
    value: string,
    secrets: ProviderSecretsFixture | null
): string {
    let redacted = value;
    const replacements = secrets
        ? [secrets.github.token, secrets.gitlab.token, secrets.gitea.token]
        : [];

    for (const secret of replacements) {
        if (secret) {
            redacted = redacted.split(secret).join("[REDACTED_SECRET]");
        }
    }

    return redacted;
}

function matchesAllowed(
    value: string,
    allowList: RegExp[] | undefined
): boolean {
    return (allowList ?? []).some((pattern) => pattern.test(value));
}

function readFileIfExists(filePath: string): string {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch {
        return "";
    }
}

function readAppLogFromOffset(
    filePath: string | null,
    offset: number
): { nextOffset: number; chunk: string } {
    if (!filePath || !fs.existsSync(filePath)) {
        return { nextOffset: 0, chunk: "" };
    }

    const stat = fs.statSync(filePath);
    if (stat.size <= offset) {
        return { nextOffset: stat.size, chunk: "" };
    }

    const fd = fs.openSync(filePath, "r");
    try {
        const size = stat.size - offset;
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, offset);
        return { nextOffset: stat.size, chunk: buffer.toString("utf8") };
    } finally {
        fs.closeSync(fd);
    }
}

export class RendererAudit {
    private readonly page: Page;
    private readonly secrets: ProviderSecretsFixture | null;
    private readonly logPath: string | null;
    private appLogOffset = 0;
    readonly consoleEntries: AuditEntry[] = [];
    readonly pageErrors: string[] = [];
    readonly failedRequests: string[] = [];
    readonly appLogErrors: string[] = [];
    readonly unhandledRejections: string[] = [];

    constructor(
        page: Page,
        secrets: ProviderSecretsFixture | null,
        userDataDir?: string
    ) {
        this.page = page;
        this.secrets = secrets;
        this.logPath = obsidianLogPath(userDataDir);

        if (this.logPath && fs.existsSync(this.logPath)) {
            this.appLogOffset = fs.statSync(this.logPath).size;
        }

        page.on("console", (message) => {
            this.consoleEntries.push({
                type: message.type(),
                text: redactMessage(message.text(), this.secrets),
            });
        });

        page.on("pageerror", (error) => {
            this.pageErrors.push(
                redactMessage(
                    error instanceof Error
                        ? error.stack ?? error.message
                        : String(error),
                    this.secrets
                )
            );
        });

        page.on("requestfailed", (request) => {
            this.failedRequests.push(
                redactMessage(
                    `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown failure"}`,
                    this.secrets
                )
            );
        });
    }

    private filterEntries(
        entries: string[],
        allowList: RegExp[] | undefined
    ): string[] {
        return entries.filter((entry) => !matchesAllowed(entry, allowList));
    }

    async installUnhandledRejectionHooks(): Promise<void> {
        await this.page.evaluate(() => {
            const stateKey = "__syncProE2eUnhandledRejections";
            const windowAny = window as typeof window & {
                [stateKey]?: string[];
                __syncProE2eRejectionHookInstalled?: boolean;
            };
            if (windowAny.__syncProE2eRejectionHookInstalled) {
                return;
            }
            windowAny[stateKey] = [];
            window.addEventListener("unhandledrejection", (event) => {
                const reason = event.reason as unknown;
                const message =
                    reason instanceof Error
                        ? reason.stack ?? reason.message
                        : String(reason);
                windowAny[stateKey]?.push(message);
            });
            windowAny.__syncProE2eRejectionHookInstalled = true;
        });
    }

    async refresh(): Promise<void> {
        const { nextOffset, chunk } = readAppLogFromOffset(
            this.logPath,
            this.appLogOffset
        );
        this.appLogOffset = nextOffset;
        if (chunk) {
            const lines = chunk
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .filter((line) =>
                    /(error|warn|failed|exception|uncaught)/i.test(line)
                )
                .map((line) => redactMessage(line, this.secrets));
            this.appLogErrors.push(...lines);
        }

        if (!this.page.isClosed()) {
            const unhandledRejections = await this.page.evaluate(() => {
                const windowAny = window as typeof window & {
                    __syncProE2eUnhandledRejections?: string[];
                };
                return [...(windowAny.__syncProE2eUnhandledRejections ?? [])];
            });

            this.unhandledRejections.splice(
                0,
                this.unhandledRejections.length,
                ...unhandledRejections.map((entry) =>
                    redactMessage(entry, this.secrets)
                )
            );
        }
    }

    async reset(): Promise<void> {
        this.consoleEntries.length = 0;
        this.pageErrors.length = 0;
        this.failedRequests.length = 0;
        this.appLogErrors.length = 0;
        this.unhandledRejections.length = 0;

        if (this.logPath && fs.existsSync(this.logPath)) {
            this.appLogOffset = fs.statSync(this.logPath).size;
        }

        if (!this.page.isClosed()) {
            await this.page.evaluate(() => {
                const windowAny = window as typeof window & {
                    __syncProE2eUnhandledRejections?: string[];
                };
                if (windowAny.__syncProE2eUnhandledRejections) {
                    windowAny.__syncProE2eUnhandledRejections.length = 0;
                }
            });
        }
    }

    async assertClean(matchers: AuditFailureMatchers = {}): Promise<void> {
        await this.refresh();

        const consoleWarnings = this.filterEntries(
            this.consoleEntries
                .filter((entry) => entry.type === "warning")
                .map((entry) => entry.text),
            matchers.allowConsoleWarnings
        );

        const consoleErrors = this.filterEntries(
            this.consoleEntries
                .filter((entry) => entry.type === "error")
                .map((entry) => entry.text),
            matchers.allowConsoleErrors
        );

        const pageErrors = this.filterEntries(
            this.pageErrors,
            matchers.allowPageErrors
        );

        const failedRequests = this.filterEntries(
            this.failedRequests,
            matchers.allowFailedRequests
        );

        const appLogErrors = this.filterEntries(
            this.appLogErrors,
            matchers.allowAppLogErrors
        );
        const unhandledRejections = this.filterEntries(
            this.unhandledRejections,
            matchers.allowUnhandledRejections
        );

        expect
            .soft(
                consoleWarnings,
                `Unexpected renderer console warnings:\n${consoleWarnings.join("\n")}`
            )
            .toEqual([]);
        expect
            .soft(
                consoleErrors,
                `Unexpected renderer console errors:\n${consoleErrors.join("\n")}`
            )
            .toEqual([]);
        expect
            .soft(
                pageErrors,
                `Unexpected renderer page errors:\n${pageErrors.join("\n")}`
            )
            .toEqual([]);
        expect
            .soft(
                unhandledRejections,
                `Unexpected unhandled promise rejections:\n${unhandledRejections.join("\n")}`
            )
            .toEqual([]);
        expect
            .soft(
                failedRequests,
                `Unexpected failed page requests:\n${failedRequests.join("\n")}`
            )
            .toEqual([]);
        expect
            .soft(
                appLogErrors,
                `Unexpected Obsidian app log output:\n${appLogErrors.join("\n")}`
            )
            .toEqual([]);
    }

    async assertNoUnexpectedRendererErrors(
        matchers: Pick<
            AuditFailureMatchers,
            | "allowConsoleErrors"
            | "allowPageErrors"
            | "allowUnhandledRejections"
        > = {}
    ): Promise<void> {
        await this.refresh();

        const consoleErrors = this.filterEntries(
            this.consoleEntries
                .filter((entry) => entry.type === "error")
                .map((entry) => entry.text),
            matchers.allowConsoleErrors
        );
        const pageErrors = this.filterEntries(
            this.pageErrors,
            matchers.allowPageErrors
        );
        const unhandledRejections = this.filterEntries(
            this.unhandledRejections,
            matchers.allowUnhandledRejections
        );

        expect
            .soft(
                consoleErrors,
                `Unexpected renderer console errors:\n${consoleErrors.join("\n")}`
            )
            .toEqual([]);
        expect
            .soft(
                pageErrors,
                `Unexpected renderer page errors:\n${pageErrors.join("\n")}`
            )
            .toEqual([]);
        expect
            .soft(
                unhandledRejections,
                `Unexpected unhandled promise rejections:\n${unhandledRejections.join("\n")}`
            )
            .toEqual([]);
    }

    async assertNoUnexpectedWarnings(
        matchers: Pick<AuditFailureMatchers, "allowConsoleWarnings"> = {}
    ): Promise<void> {
        await this.refresh();

        const consoleWarnings = this.filterEntries(
            this.consoleEntries
                .filter((entry) => entry.type === "warning")
                .map((entry) => entry.text),
            matchers.allowConsoleWarnings
        );

        expect
            .soft(
                consoleWarnings,
                `Unexpected renderer console warnings:\n${consoleWarnings.join("\n")}`
            )
            .toEqual([]);
    }

    async assertNoCriticalRequestFailures(
        matchers: Pick<AuditFailureMatchers, "allowFailedRequests"> = {}
    ): Promise<void> {
        await this.refresh();

        const failedRequests = this.filterEntries(
            this.failedRequests,
            matchers.allowFailedRequests
        );

        expect
            .soft(
                failedRequests,
                `Unexpected failed page requests:\n${failedRequests.join("\n")}`
            )
            .toEqual([]);
    }
}

export function readSecretsSafely(
    filePath: string = path.resolve(process.cwd(), "secrets.txt")
): ProviderSecretsFixture {
    if (!fs.existsSync(filePath)) {
        throw new Error(
            `Required local secrets file is missing: ${path.basename(filePath)}`
        );
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const githubToken = raw.match(/\bgh[pousr]_[A-Za-z0-9_]+\b/u)?.[0] ?? "";
    const gitlabToken = raw.match(/\bglpat-[A-Za-z0-9_-]+\b/u)?.[0] ?? "";

    const githubRepoUrl =
        raw.match(/https:\/\/github\.com\/[^\s]+?\.git\b/u)?.[0] ?? "";
    const gitlabRepoUrl =
        raw.match(/https:\/\/gitlab\.com\/[^\s]+?\.git\b/u)?.[0] ?? "";
    const giteaRepoUrl =
        raw.match(/https:\/\/gitea\.com\/[^\s]+?\.git\b/u)?.[0] ?? "";

    // Accepted Gitea token formats in secrets.txt:
    //   - a dedicated marker line followed by the token on the next line
    //   - a direct key/value line such as `GITEA_TOKEN=...` or `gitea_token: ...`
    let giteaToken = "";
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!/gitea/i.test(line)) {
            continue;
        }

        const explicitToken = line.match(/\bGITEA[_-]?TOKEN\b\s*[:=]\s*(\S+)/i);
        if (explicitToken?.[1]) {
            giteaToken = explicitToken[1];
            break;
        }

        const next = lines[index + 1];
        if (next && /^[A-Za-z0-9]{20,}$/u.test(next)) {
            giteaToken = next;
            break;
        }
    }

    const missing: string[] = [];
    if (!githubToken) missing.push("GitHub token");
    if (!gitlabToken) missing.push("GitLab token");
    if (!giteaToken) missing.push("Gitea token");
    if (!githubRepoUrl) missing.push("GitHub repo URL");
    if (!gitlabRepoUrl) missing.push("GitLab repo URL");
    if (!giteaRepoUrl) missing.push("Gitea repo URL");

    if (missing.length > 0) {
        throw new Error(
            `secrets.txt is missing required entries: ${missing.join(", ")}`
        );
    }

    const githubRepo = parseRepoUrl(githubRepoUrl);
    const gitlabRepo = parseRepoUrl(gitlabRepoUrl);
    const giteaRepo = parseRepoUrl(giteaRepoUrl);

    return {
        github: {
            token: githubToken,
            repoUrl: githubRepoUrl,
            owner: githubRepo.owner,
            repo: githubRepo.repo,
            branch: "main",
        },
        gitlab: {
            token: gitlabToken,
            repoUrl: gitlabRepoUrl,
            baseUrl: `${gitlabRepo.host}/api/v4`,
            projectId: `${gitlabRepo.owner}/${gitlabRepo.repo}`,
            branch: "main",
        },
        gitea: {
            token: giteaToken,
            repoUrl: giteaRepoUrl,
            baseUrl: giteaRepo.host,
            owner: giteaRepo.owner,
            repo: giteaRepo.repo,
            branch: "main",
        },
        git: {
            repoUrl: githubRepoUrl,
            remoteName: "origin",
            branch: "main",
        },
    };
}

export function prepareTestVault(
    secrets: ProviderSecretsFixture
): PreparedVault {
    const repoRoot = process.cwd();
    const vaultPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "git-vault-e2e-vault-")
    );
    const userDataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "git-vault-e2e-profile-")
    );
    const obsidianDir = path.join(vaultPath, ".obsidian");
    const pluginDir = path.join(obsidianDir, "plugins");
    const installedPluginDir = path.join(pluginDir, PLUGIN_ID);
    const bundleFiles = ["main.js", "manifest.json", "styles.css"];

    fs.mkdirSync(installedPluginDir, { recursive: true });
    fs.writeFileSync(
        path.join(obsidianDir, "app.json"),
        JSON.stringify({ restrictedMode: false }, null, 2)
    );
    fs.writeFileSync(
        path.join(obsidianDir, "community-plugins.json"),
        JSON.stringify([PLUGIN_ID], null, 2)
    );
    fs.writeFileSync(
        path.join(vaultPath, "README.md"),
        "# Git Vault E2E Vault\n"
    );

    for (const fileName of bundleFiles) {
        const source = path.join(repoRoot, fileName);
        if (!fs.existsSync(source)) {
            throw new Error(
                `Missing built plugin artifact: ${fileName}. Run pnpm run build before the E2E suite.`
            );
        }
        fs.copyFileSync(source, path.join(installedPluginDir, fileName));
    }

    ensureVaultRegistered(vaultPath, userDataDir);

    execFileSync("git", ["init", "-b", secrets.git.branch], { cwd: vaultPath });
    execFileSync("git", ["config", "user.name", "Git Vault E2E"], {
        cwd: vaultPath,
    });
    execFileSync(
        "git",
        ["config", "user.email", "git-vault-e2e@example.invalid"],
        {
            cwd: vaultPath,
        }
    );
    execFileSync("git", ["add", "."], { cwd: vaultPath });
    execFileSync("git", ["commit", "-m", "Initial test vault"], {
        cwd: vaultPath,
    });
    execFileSync(
        "git",
        ["remote", "add", secrets.git.remoteName, secrets.git.repoUrl],
        { cwd: vaultPath }
    );

    return {
        vaultPath,
        userDataDir,
        cleanup: async () => {
            await fs.promises.rm(vaultPath, {
                recursive: true,
                force: true,
            });
            await fs.promises.rm(userDataDir, {
                recursive: true,
                force: true,
            });
        },
    };
}

function ensureValidObsidianAppJson(vaultPath: string): void {
    const appJsonPath = path.join(vaultPath, ".obsidian", "app.json");
    try {
        const raw = fs.readFileSync(appJsonPath, "utf8");
        JSON.parse(raw);
        return;
    } catch {
        fs.mkdirSync(path.dirname(appJsonPath), { recursive: true });
        fs.writeFileSync(
            appJsonPath,
            JSON.stringify({ restrictedMode: false }, null, 2)
        );
    }
}

export async function launchObsidianApp(
    vaultPath: string,
    userDataDir: string,
    secrets: ProviderSecretsFixture | null = null,
    options: { env?: NodeJS.ProcessEnv } = {}
): Promise<LaunchedObsidian> {
    ensureValidObsidianAppJson(vaultPath);
    const executablePath =
        process.env.TEST_OBSIDIAN ??
        DEFAULT_OBSIDIAN_BIN[process.platform] ??
        "Obsidian";
    const deepLink = `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
    const appProcess = spawnObsidianProcess(
        executablePath,
        userDataDir,
        deepLink,
        options.env
    );
    const port = await waitForDevToolsPort(userDataDir);
    const browser = await connectToObsidianRenderer(port);
    const page = await waitForVaultWindow(browser);
    const audit = new RendererAudit(page, secrets, userDataDir);
    let closed = false;
    await audit.installUnhandledRejectionHooks();
    // Ensure any trust prompt during launch is handled; fail fast if not.
    if (!(await trustVaultIfPrompted(page, { waitForPrompt: true }))) {
        throw new Error(
            "Vault trust prompt remained visible after retries during launch"
        );
    }
    await waitForPluginReady(page);
    await page.evaluate((configuredUserDataDir) => {
        process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR = configuredUserDataDir;
    }, userDataDir);
    await waitForPluginRuntimeReady(page);

    return {
        browser,
        page,
        audit,
        close: async () => {
            if (closed) {
                return;
            }
            closed = true;
            await audit.refresh();
            if (!page.isClosed()) {
                await page
                    .close({ runBeforeUnload: true })
                    .catch(() => undefined);
            }
            await Promise.all(
                browser
                    .contexts()
                    .map((context) => context.close().catch(() => undefined))
            );
            await browser.close().catch(() => undefined);
            await terminateObsidianProcess(appProcess);
        },
    };
}

async function waitForProcessExit(
    appProcess: ChildProcess,
    timeoutMs: number
): Promise<boolean> {
    if (appProcess.exitCode !== null) {
        return true;
    }

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(appProcess.exitCode !== null);
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timeout);
            appProcess.removeListener("exit", onExit);
        };

        const onExit = () => {
            cleanup();
            resolve(true);
        };

        appProcess.once("exit", onExit);
    });
}

function spawnObsidianProcess(
    executablePath: string,
    userDataDir: string,
    deepLink: string,
    extraEnv: NodeJS.ProcessEnv = {}
): ChildProcess {
    const activePortFile = path.join(userDataDir, "DevToolsActivePort");
    if (fs.existsSync(activePortFile)) {
        fs.rmSync(activePortFile, { force: true });
    }

    const child = spawn(
        executablePath,
        [
            `--remote-debugging-port=0`,
            `--user-data-dir=${userDataDir}`,
            deepLink,
        ],
        {
            detached: process.platform !== "win32",
            env: {
                ...process.env,
                SYNC_PRO_OBSIDIAN_CONFIG_DIR: userDataDir,
                ...extraEnv,
            },
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

    child.unref();
    return child;
}

async function waitForDevToolsPort(userDataDir: string): Promise<string> {
    const activePortFile = path.join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
        if (fs.existsSync(activePortFile)) {
            const [port] = fs
                .readFileSync(activePortFile, "utf8")
                .split(/\r?\n/)
                .filter((line) => line.length > 0);
            if (port) {
                return port;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
        `Timed out waiting for DevToolsActivePort in ${userDataDir}.`
    );
}

async function connectToObsidianRenderer(port: string): Promise<Browser> {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    let lastError = "unknown error";

    while (Date.now() < deadline) {
        try {
            return await chromium.connectOverCDP(endpoint);
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    throw new Error(
        `Timed out connecting to the Obsidian renderer at ${endpoint}: ${lastError}`
    );
}

async function waitForVaultWindow(browser: Browser): Promise<Page> {
    const deadline = Date.now() + PLUGIN_READY_TIMEOUT;
    let lastWindowSummary = "no windows";

    while (Date.now() < deadline) {
        const windows = browser
            .contexts()
            .flatMap((context) => context.pages());
        if (windows.length > 0) {
            const summaries: string[] = [];
            let bestCandidate: Page | null = null;

            for (const page of windows) {
                try {
                    await page.waitForLoadState("domcontentloaded", {
                        timeout: 5_000,
                    });
                    const summary = await page.evaluate((pluginId) => {
                        const app = (
                            window as typeof window & {
                                app?: {
                                    vault?: { getName?: () => string };
                                    plugins?: {
                                        plugins?: Record<string, unknown>;
                                    };
                                };
                            }
                        ).app;
                        return {
                            title: document.title,
                            hasApp: !!app,
                            vaultName: app?.vault?.getName?.() ?? null,
                            hasPlugin: !!app?.plugins?.plugins?.[pluginId],
                        };
                    }, PLUGIN_ID);

                    summaries.push(
                        JSON.stringify({
                            title: summary.title,
                            vaultName: summary.vaultName,
                            hasPlugin: summary.hasPlugin,
                        })
                    );

                    if (summary.hasPlugin) {
                        return page;
                    }

                    if (summary.hasApp && summary.vaultName) {
                        bestCandidate = page;
                    }
                } catch (error) {
                    summaries.push(
                        JSON.stringify({
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        })
                    );
                }
            }

            if (bestCandidate) {
                return bestCandidate;
            }

            lastWindowSummary = summaries.join("; ");
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
        `Timed out waiting for an Obsidian vault window. Last observed windows: ${lastWindowSummary}`
    );
}

async function trustVaultIfPrompted(
    page: Page,
    options: { waitForPrompt?: boolean } = {}
): Promise<boolean> {
    const waitForPrompt = options.waitForPrompt ?? false;
    const TRUST_TIMEOUT = waitForPrompt ? 4500 : 500; // per-attempt visibility timeout (ms)
    const trustModal = page.locator(".modal.mod-trust-folder").first();

    // Prefer role-based lookup for the trust button (more robust across locales)
    const trustButtonByRole = page
        .getByRole("button", { name: /Trust/i })
        .first();

    const maxAttempts = 3;
    let clicked = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const promptVisible =
                (await trustModal.isVisible().catch(() => false)) ||
                (await trustButtonByRole.isVisible().catch(() => false));

            if (!promptVisible) {
                if (!waitForPrompt) return true;

                await Promise.race([
                    trustModal.waitFor({
                        state: "visible",
                        timeout: TRUST_TIMEOUT,
                    }),
                    trustButtonByRole.waitFor({
                        state: "visible",
                        timeout: TRUST_TIMEOUT,
                    }),
                ]);
            }

            // If we reach here, either the trust button or the modal is visible
            if (await trustButtonByRole.isVisible().catch(() => false)) {
                await trustButtonByRole.click().catch(() => undefined);
            } else {
                const fallback = page
                    .locator("button")
                    .filter({
                        hasText:
                            /Trust author|Trust and enable|Enable plugins|Trust/,
                    })
                    .first();
                if (await fallback.isVisible().catch(() => false)) {
                    await fallback.click().catch(() => undefined);
                } else {
                    // Neither trust button nor fallback visible; try again
                    continue;
                }
            }
            clicked = true;
            break;
        } catch {
            // Timeout for this attempt; wait briefly and retry
            // Use a longer inter-attempt delay to better match previous backoff behavior
            await new Promise((r) => setTimeout(r, 1000));
            continue;
        }
    }

    // After attempts, check whether the modal is still visible.
    const stillVisible = await trustModal.isVisible().catch(() => false);
    if (stillVisible) {
        console.error(
            "trustVaultIfPrompted: trust modal still visible after retries"
        );
        return false;
    }

    // If we clicked the trust button, ensure it has been hidden before returning.
    if (clicked) {
        try {
            await expect(trustModal).toBeHidden({ timeout: 10_000 });
        } catch (err) {
            // If it didn't hide in time, treat as failure.
            console.error(
                "trustVaultIfPrompted: trust modal did not hide after clicking",
                err
            );
            return false;
        }
    }

    return true;
}

async function terminateObsidianProcess(
    appProcess: ChildProcess
): Promise<void> {
    if (appProcess.killed || appProcess.exitCode !== null) {
        return;
    }

    if (globalThis.process.platform === "win32") {
        appProcess.kill();
        await waitForProcessExit(appProcess, 2_000);
        return;
    }

    try {
        if (typeof appProcess.pid === "number") {
            process.kill(-appProcess.pid, "SIGTERM");
        } else {
            appProcess.kill("SIGTERM");
        }
    } catch {
        return;
    }

    if (await waitForProcessExit(appProcess, 2_000)) {
        return;
    }

    if (appProcess.exitCode === null) {
        try {
            if (typeof appProcess.pid === "number") {
                process.kill(-appProcess.pid, "SIGKILL");
            } else {
                appProcess.kill("SIGKILL");
            }
            await waitForProcessExit(appProcess, 2_000);
        } catch {
            // Ignore cleanup failures for already-dead processes.
        }
    }
}

export async function relaunchObsidianApp(
    current: LaunchedObsidian,
    vaultPath: string,
    userDataDir: string,
    secrets: ProviderSecretsFixture | null = null
): Promise<LaunchedObsidian> {
    await current.close();
    return launchObsidianApp(vaultPath, userDataDir, secrets);
}

export async function waitForPluginReady(page: Page): Promise<void> {
    try {
        await page.waitForFunction(
            (pluginId) =>
                !!(
                    window as typeof window & {
                        app?: {
                            plugins?: { plugins?: Record<string, unknown> };
                        };
                    }
                ).app?.plugins?.plugins?.[pluginId],
            PLUGIN_ID,
            { timeout: PLUGIN_READY_TIMEOUT }
        );
    } catch (error) {
        const diagnostics = await page.evaluate(() => {
            const app = (
                window as typeof window & {
                    app?: {
                        vault?: { getName?: () => string };
                        plugins?: {
                            plugins?: Record<string, unknown>;
                            manifests?: Record<string, unknown>;
                        };
                    };
                }
            ).app;
            return {
                title: document.title,
                vaultName: app?.vault?.getName?.() ?? null,
                loadedPluginIds: Object.keys(app?.plugins?.plugins ?? {}),
                manifestIds: Object.keys(app?.plugins?.manifests ?? {}),
            };
        });
        throw new Error(
            `Git Vault plugin did not become ready. ${JSON.stringify(diagnostics)} :: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

export async function waitForPluginRuntimeReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settings?: { activeSyncProvider?: string };
                                    syncManager?: unknown;
                                    gitManager?: unknown;
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.["git-vault"];

            if (!plugin?.syncManager) {
                return false;
            }

            if (plugin.settings?.activeSyncProvider === "git") {
                return !!plugin.gitManager;
            }

            return true;
        },
        { timeout: PLUGIN_READY_TIMEOUT }
    );
}

/**
 * Waits for the plugin's `gitReady` flag to become true.
 * This must be true before opening settings when the Git backend is active,
 * because the "Advanced Git options" section is only rendered after git
 * initialization completes.
 */
export async function waitForGitReady(page: Page): Promise<void> {
    try {
        await page.waitForFunction(
            (pluginId) => {
                const plugin = (
                    window as typeof window & {
                        app?: {
                            plugins?: {
                                plugins?: Record<
                                    string,
                                    { gitReady?: boolean }
                                >;
                            };
                        };
                    }
                ).app?.plugins?.plugins?.[pluginId];
                return !!plugin?.gitReady;
            },
            PLUGIN_ID,
            { timeout: PLUGIN_READY_TIMEOUT }
        );
    } catch (error) {
        // Capture plugin state for diagnostics before re-throwing.
        const state = await page
            .evaluate((pluginId) => {
                const p = (
                    window as typeof window & {
                        app?: {
                            plugins?: {
                                plugins?: Record<
                                    string,
                                    {
                                        gitReady?: boolean;
                                        gitManager?: unknown;
                                        settings?: { activeSyncProvider?: string };
                                    }
                                >;
                            };
                        };
                    }
                ).app?.plugins?.plugins?.[pluginId];
                return p
                    ? {
                          gitReady: p.gitReady,
                          hasGitManager: !!p.gitManager,
                          activeSyncProvider: p.settings?.activeSyncProvider,
                      }
                    : null;
            }, PLUGIN_ID)
            .catch(() => null);
        throw new Error(
            `waitForGitReady timed out. Plugin state: ${JSON.stringify(state)} :: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

export async function openSyncProSettings(page: Page): Promise<void> {
    await page.evaluate((pluginId) => {
        const app = (
            window as typeof window & {
                app?: {
                    setting?: {
                        open?: () => void;
                        openTabById?: (id: string) => void;
                        openSettingTab?: (tab: unknown) => void;
                    };
                    plugins?: {
                        plugins?: Record<
                            string,
                            {
                                manifest?: { id?: string };
                                settingsTab?: {
                                    open?: () => void;
                                    display?: () => void;
                                };
                            }
                        >;
                    };
                };
            }
        ).app;
        const plugin = app?.plugins?.plugins?.[pluginId];
        const setting = app?.setting;

        setting?.open?.();

        if (setting?.openTabById && plugin?.manifest?.id) {
            setting.openTabById(plugin.manifest.id);
            return;
        }
        if (setting?.openSettingTab && plugin?.settingsTab) {
            setting.openSettingTab(plugin.settingsTab);
            return;
        }
        if (plugin?.settingsTab?.open) {
            plugin.settingsTab.open();
            return;
        }
        plugin?.settingsTab?.display?.();
    }, PLUGIN_ID);

    const bootstrapModal = page
        .locator(".modal:visible")
        .filter({ hasText: "Complete secure setup" })
        .last();
    if (await bootstrapModal.isVisible().catch(() => false)) {
        await bootstrapModal
            .getByRole("button", { name: "Later" })
            .click({ force: true });
        await expect(bootstrapModal).toBeHidden({
            timeout: SETTINGS_READY_TIMEOUT,
        });
    }

    const pluginTab = page
        .locator(".vertical-tab-nav-item")
        .filter({ hasText: PLUGIN_NAME });
    if ((await pluginTab.count()) > 0) {
        await pluginTab.first().click();
    }

    await expect(
        page
            .locator(".setting-item-name")
            .filter({ hasText: "Sync backend" })
            .first()
    ).toBeVisible({ timeout: SETTINGS_READY_TIMEOUT });
}

export async function closeSyncProSettings(page: Page): Promise<void> {
    const settingsTab = page.locator(".vertical-tab-nav-item").first();
    const isOpen = await settingsTab.isVisible().catch(() => false);
    if (!isOpen) {
        return;
    }

    await page.evaluate(() => {
        const app = (
            window as typeof window & {
                app?: {
                    setting?: {
                        close?: () => void;
                    };
                };
            }
        ).app;
        app?.setting?.close?.();
    });

    try {
        await expect
            .poll(() => settingsTab.isVisible().catch(() => false), {
                timeout: 5_000,
            })
            .toBe(false);
        return;
    } catch {
        // Fall back to the keyboard path if the settings host did not close.
    }

    await page.keyboard.press("Escape");
    await expect
        .poll(() => settingsTab.isVisible().catch(() => false), {
            timeout: 10_000,
        })
        .toBe(false);
}

export async function openSourceControlView(page: Page): Promise<void> {
    await closeSyncProSettings(page);

    const ribbonLabels = [
        /Open Git source control/i,
        /sync ready/i,
        /Syncing via/i,
        /conflict\(s\)/i,
        /sync offline/i,
        /Sync error/i,
    ];

    for (const label of ribbonLabels) {
        const ribbonButton = page.getByLabel(label).first();
        if (await ribbonButton.isVisible().catch(() => false)) {
            await ribbonButton.click();
            break;
        }

        const titledRibbonButton = page.getByTitle(label).first();
        if (await titledRibbonButton.isVisible().catch(() => false)) {
            await titledRibbonButton.click();
            break;
        }
    }

    const sourceControlToggle = page
        .locator('[aria-label="Source Control"], [title="Source Control"]')
        .first();
    if (await sourceControlToggle.isVisible().catch(() => false)) {
        await sourceControlToggle.click();
    } else {
        const sourceControlLabel = page.getByText("Source Control", {
            exact: true,
        });
        if (
            await sourceControlLabel
                .first()
                .isVisible()
                .catch(() => false)
        ) {
            await sourceControlLabel.first().click();
        }
    }

    await page.evaluate(() => {
        const app = (
            window as typeof window & {
                app?: {
                    commands?: {
                        executeCommandById?: (
                            id: string
                        ) => Promise<void> | void;
                    };
                };
            }
        ).app;
        void app?.commands?.executeCommandById?.("open-git-view");
    });

    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const app = (
                        window as typeof window & {
                            app?: {
                                workspace?: {
                                    getLeavesOfType?: (
                                        type: string
                                    ) => unknown[];
                                };
                            };
                        }
                    ).app;
                    const leafCount =
                        app?.workspace?.getLeavesOfType?.("git-view")?.length ??
                        0;
                    const selectors = [
                        'main[data-type="git-view"]',
                        '[data-git-vault-branch-selector="true"]',
                        ".git-vault-sync-btn",
                        "#backup-btn",
                        "#push",
                    ];
                    const hasVisibleUi = selectors.some((selector) => {
                        const element =
                            document.querySelector<HTMLElement>(selector);
                        return (
                            element != null &&
                            element.offsetParent !== null &&
                            !element.hasAttribute("hidden")
                        );
                    });
                    return leafCount > 0 || hasVisibleUi;
                }),
            {
                timeout: 30_000,
            }
        )
        .toBe(true);
}

export async function setSyncMode(
    page: Page,
    mode: "simple" | "advanced"
): Promise<void> {
    await page.evaluate(
        async ({ pluginId, nextMode }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settings?: { syncMode?: string };
                                    saveSettings?: () => Promise<void>;
                                    app?: {
                                        workspace?: {
                                            trigger?: (
                                                event: string,
                                                value?: unknown
                                            ) => void;
                                        };
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];

            if (!plugin?.settings || !plugin.saveSettings) {
                throw new Error("Git Vault plugin is not available.");
            }

            plugin.settings.syncMode = nextMode;
            await plugin.saveSettings();
            plugin.app?.workspace?.trigger?.(
                "obsidian-git:sync-mode-changed",
                nextMode
            );
        },
        { pluginId: PLUGIN_ID, nextMode: mode }
    );
}

export async function waitForNotice(
    page: Page,
    matcher: string | RegExp,
    timeout = 30_000
): Promise<void> {
    const notice = page.locator(".notice");
    if (typeof matcher === "string") {
        await expect(notice.filter({ hasText: matcher }).first()).toBeVisible({
            timeout,
        });
        return;
    }
    await expect
        .poll(
            async () => {
                const messages = await notice.allInnerTexts();
                return messages.some((message) => matcher.test(message));
            },
            { timeout }
        )
        .toBe(true);
}

export async function submitGeneralPrompt(
    page: Page,
    value: string
): Promise<void> {
    const promptInput = page
        .locator('.prompt input[type="text"], .prompt input[type="password"]')
        .first();
    await expect(promptInput).toBeVisible({ timeout: SETTINGS_READY_TIMEOUT });
    await promptInput.click();
    await promptInput.fill(value);
    await promptInput.press("Enter");
    await expect(promptInput).toBeHidden({ timeout: SETTINGS_READY_TIMEOUT });
}

export async function installWindowOpenSpy(page: Page): Promise<void> {
    await page.evaluate(() => {
        const windowAny = window as typeof window & {
            __syncProOpenedUrls?: string[];
            __syncProOriginalWindowOpen?: typeof window.open;
            __syncProOriginalOpenExternal?: (url: string) => Promise<void>;
        };

        // Intentional reset on every call: each test installs the spy immediately
        // before the action it wants to observe, so starting with an empty array
        // provides per-action isolation without needing a separate clear step.
        windowAny.__syncProOpenedUrls = [];
        if (!windowAny.__syncProOriginalWindowOpen) {
            windowAny.__syncProOriginalWindowOpen = window.open;
        }

        window.open = ((
            url?: string | URL,
            _target?: string,
            _features?: string
        ) => {
            windowAny.__syncProOpenedUrls?.push(String(url ?? ""));
            return null;
        }) as typeof window.open;

        const maybeRequire = (
            globalThis as {
                require?: (moduleName: string) => unknown;
            }
        ).require;
        if (typeof maybeRequire === "function") {
            try {
                const electron = maybeRequire("electron") as {
                    shell?: {
                        openExternal?: (url: string) => Promise<void>;
                    };
                };
                if (
                    electron?.shell &&
                    typeof electron.shell.openExternal === "function" &&
                    !windowAny.__syncProOriginalOpenExternal
                ) {
                    const originalOpenExternal: (url: string) => Promise<void> =
                        electron.shell.openExternal;
                    windowAny.__syncProOriginalOpenExternal = (url: string) =>
                        originalOpenExternal(url);
                    electron.shell.openExternal = (url: string) => {
                        windowAny.__syncProOpenedUrls?.push(String(url));
                        return Promise.resolve();
                    };
                }
            } catch {
                // Non-Electron renderers fall back to the window.open spy.
            }
        }
    });
}

export async function getOpenedWindowUrls(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const windowAny = window as typeof window & {
            __syncProOpenedUrls?: string[];
        };
        return [...(windowAny.__syncProOpenedUrls ?? [])];
    });
}

export async function waitForOpenedWindowUrl(
    page: Page,
    matcher: string | RegExp
): Promise<string> {
    let matchedUrl = "";

    await expect
        .poll(
            async () => {
                const urls = await getOpenedWindowUrls(page);
                matchedUrl =
                    typeof matcher === "string"
                        ? urls.find((url) => url.includes(matcher)) ?? ""
                        : urls.find((url) => matcher.test(url)) ?? "";
                return matchedUrl.length > 0;
            },
            { timeout: 30_000 }
        )
        .toBe(true);

    return matchedUrl;
}

export async function waitForBootstrapSuccessModal(page: Page): Promise<void> {
    await expect(page.locator(".git-vault-bootstrap-modal").first()).toBeVisible(
        { timeout: 120_000 }
    );
    await expect(
        page.getByRole("button", { name: "Open Vault Now" })
    ).toBeVisible({ timeout: SETTINGS_READY_TIMEOUT });
}

export function readPluginData(vaultPath: string): Record<string, unknown> {
    const dataPath = path.join(
        vaultPath,
        ".obsidian",
        "plugins",
        PLUGIN_ID,
        "data.json"
    );
    return JSON.parse(readFileIfExists(dataPath) || "{}") as Record<
        string,
        unknown
    >;
}

export function writePluginData(
    vaultPath: string,
    data: Record<string, unknown>
): void {
    const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
        path.join(pluginDir, "data.json"),
        JSON.stringify(data, null, 2)
    );
}

export async function getStoredProviderToken(
    page: Page,
    provider: Exclude<ProviderKey, "git">
): Promise<string | null> {
    return page.evaluate(
        ({ pluginId, providerName }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    providerSecrets?: {
                                        getToken?: (
                                            provider: string
                                        ) => string | null;
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];
            return plugin?.providerSecrets?.getToken?.(providerName) ?? null;
        },
        { pluginId: PLUGIN_ID, providerName: provider }
    );
}

export async function seedAllProviderConfigs(
    page: Page,
    secrets: ProviderSecretsFixture
): Promise<void> {
    await page.evaluate(
        async ({ pluginId, fixture }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settings: Record<string, unknown>;
                                    providerSecrets: {
                                        setToken: (
                                            provider: string,
                                            token: string | null
                                        ) => void;
                                    };
                                    saveSettings: () => Promise<void>;
                                    syncManager: {
                                        reload: () => Promise<void>;
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];

            if (!plugin) {
                throw new Error("Git Vault plugin is not available.");
            }

            plugin.providerSecrets.setToken("github", fixture.github.token);
            plugin.providerSecrets.setToken("gitlab", fixture.gitlab.token);
            plugin.providerSecrets.setToken("gitea", fixture.gitea.token);

            Object.assign(plugin.settings, {
                githubOwner: fixture.github.owner,
                githubRepo: fixture.github.repo,
                githubBranch: fixture.github.branch,
                gitlabBaseUrl: fixture.gitlab.baseUrl,
                gitlabProjectId: fixture.gitlab.projectId,
                gitlabBranch: fixture.gitlab.branch,
                giteaBaseUrl: fixture.gitea.baseUrl,
                giteaOwner: fixture.gitea.owner,
                giteaRepo: fixture.gitea.repo,
                giteaBranch: fixture.gitea.branch,
            });

            await plugin.saveSettings();
            await plugin.syncManager.reload();
        },
        { pluginId: PLUGIN_ID, fixture: secrets }
    );
}

export class ProviderSettingsPage {
    static readonly CONTROL_SELECTOR =
        'input[type="text"], input[type="password"], textarea, select';

    constructor(private readonly page: Page) {}

    async open(): Promise<void> {
        await openSyncProSettings(this.page);
        // Handle the trust-vault prompt once when opening the settings page
        // so individual wait utilities don't need to call it repeatedly.
        if (!(await trustVaultIfPrompted(this.page))) {
            throw new Error(
                "Vault trust prompt remained visible after retries when opening settings"
            );
        }
    }

    async close(): Promise<void> {
        const settingsModal = this.page
            .locator(".modal.mod-settings:visible")
            .last();
        if (!(await settingsModal.isVisible().catch(() => false))) {
            return;
        }
        const closeButton = settingsModal
            .locator(".modal-close-button")
            .first();
        if (await closeButton.isVisible().catch(() => false)) {
            await closeButton.click({ force: true });
        } else {
            await this.page.keyboard.press("Escape");
        }
        await expect(settingsModal).toBeHidden({
            timeout: SETTINGS_READY_TIMEOUT,
        });
    }

    async saveAndReloadSyncManager(): Promise<void> {
        await this.page.evaluate(async (pluginId) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    saveSettings?: () => Promise<void>;
                                    syncManager?: {
                                        reload?: () => Promise<void>;
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];
            if (!plugin?.saveSettings || !plugin.syncManager?.reload) {
                throw new Error("Git Vault plugin is not available.");
            }
            await plugin.saveSettings();
            await plugin.syncManager.reload();
        }, PLUGIN_ID);
    }

    async disableApiEncryptionForTest(): Promise<void> {
        await this.page.evaluate(async (pluginId) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settings?: {
                                        apiEncryptionEnabled?: boolean;
                                    };
                                    providerSecrets?: {
                                        setEncryptionPassphrase?: (
                                            passphrase: string | null
                                        ) => void;
                                    };
                                    saveSettings?: () => Promise<void>;
                                    syncManager?: {
                                        reload?: () => Promise<void>;
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];
            if (!plugin?.settings || !plugin.saveSettings) {
                throw new Error("Git Vault plugin is not available.");
            }
            plugin.settings.apiEncryptionEnabled = false;
            plugin.providerSecrets?.setEncryptionPassphrase?.(null);
            await plugin.saveSettings();
            await plugin.syncManager?.reload?.();
        }, PLUGIN_ID);
    }

    private settingRows(name: string): Locator {
        const exactName = new RegExp(
            `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
        );
        return this.page.locator(".setting-item").filter({
            has: this.page
                .locator(".setting-item-name")
                .filter({ hasText: exactName }),
        });
    }

    private settingRow(name: string): Locator {
        return this.settingRows(name).filter({ visible: true }).first();
    }

    async expandDetails(summary: string): Promise<void> {
        const escapedSummary = summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const summaryLocator = this.page
            .locator("details > summary")
            .filter({ hasText: new RegExp(`^${escapedSummary}$`) });
        await expect(summaryLocator.first()).toBeVisible();
        await summaryLocator.evaluateAll((summaries) => {
            for (const element of summaries) {
                const details = element.parentElement;
                if (details instanceof HTMLDetailsElement) {
                    details.open = true;
                }
            }
        });
    }

    private async revealSettingIfCollapsed(name: string): Promise<void> {
        await expect(this.settingRows(name).first()).toBeAttached({
            timeout: SETTINGS_READY_TIMEOUT,
        });
        await this.page.evaluate((settingName) => {
            const rows = Array.from(document.querySelectorAll(".setting-item"));
            for (const row of rows) {
                if (
                    row
                        .querySelector(".setting-item-name")
                        ?.textContent?.trim() !== settingName
                ) {
                    continue;
                }
                const details = row.closest("details");
                if (details instanceof HTMLDetailsElement) {
                    details.open = true;
                }
            }
        }, name);
    }

    private isDropdownRefreshing(
        options: Array<{ value: string; label: string; disabled: boolean }>
    ): boolean {
        return options.some(
            (option) =>
                /refreshing|fetching/i.test(option.label) ||
                /refreshing|fetching/i.test(option.value)
        );
    }

    async expectSettingVisible(name: string): Promise<void> {
        await expect(this.settingRow(name)).toBeVisible();
    }

    async expectSettingHidden(name: string): Promise<void> {
        await expect(this.settingRows(name)).toHaveCount(0);
    }

    async expectSettingNotVisible(name: string): Promise<void> {
        await expect(
            this.settingRows(name).filter({ visible: true })
        ).toHaveCount(0);
    }

    async visibleSettingNames(): Promise<string[]> {
        return this.page.locator(".setting-item").evaluateAll((rows) =>
            rows
                .filter(
                    (row) =>
                        row instanceof HTMLElement && row.offsetParent !== null
                )
                .map((row) =>
                    row.querySelector(".setting-item-name")?.textContent?.trim()
                )
                .filter((name): name is string => Boolean(name))
        );
    }

    async controlTagName(name: string): Promise<string> {
        await this.revealSettingIfCollapsed(name);
        const control = this.settingRow(name)
            .locator(ProviderSettingsPage.CONTROL_SELECTOR)
            .first();
        await expect(control).toBeVisible();
        return control.evaluate((element) => element.tagName.toLowerCase());
    }

    async isControlDisabled(name: string): Promise<boolean> {
        await this.revealSettingIfCollapsed(name);
        const control = this.settingRow(name)
            .locator(ProviderSettingsPage.CONTROL_SELECTOR)
            .first();
        await expect(control).toBeVisible();
        return control.evaluate((element) => {
            const maybeDisabled = element as
                | HTMLInputElement
                | HTMLSelectElement
                | HTMLTextAreaElement;
            return maybeDisabled.disabled;
        });
    }

    async dropdownOptions(
        name: string
    ): Promise<Array<{ value: string; label: string; disabled: boolean }>> {
        await this.revealSettingIfCollapsed(name);
        const select = this.settingRow(name).locator("select").first();
        await expect(select).toBeVisible();
        return select.evaluate((element) => {
            const selectElement = element as HTMLSelectElement;
            return Array.from(selectElement.options).map((option) => ({
                value: option.value,
                label: option.label,
                disabled: option.disabled,
            }));
        });
    }

    async waitForDropdownLabel(
        name: string,
        label: string,
        timeout = SETTINGS_READY_TIMEOUT
    ): Promise<void> {
        await this.revealSettingIfCollapsed(name);
        const select = this.settingRow(name).locator("select").first();
        try {
            await expect
                .poll(
                    async () =>
                        select.evaluate((element, optionLabel) => {
                            const selectElement = element as HTMLSelectElement;
                            return Array.from(selectElement.options).some(
                                (option) => option.label === optionLabel
                            );
                        }, label),
                    { timeout }
                )
                .toBe(true);
        } catch (error) {
            throw new Error(
                `Timed out waiting for dropdown "${name}" label "${label}": ${error instanceof Error ? error.message : String(error)}. ${await this.describeDropdownDiagnostics(name)}`
            );
        }
    }

    async selectSyncBackend(provider: ProviderKey): Promise<void> {
        const select = this.settingRow("Sync backend")
            .locator("select")
            .first();
        await expect(select).toBeVisible();
        await select.selectOption({ value: provider });
        await this.waitForSettingsUpdate(provider);
    }

    private async waitForSettingsUpdate(provider: ProviderKey): Promise<void> {
        const expectedLabels: Record<ProviderKey, string> = {
            git: "Remote URL",
            github: "Owner / organization",
            gitlab: "API base URL",
            gitea: "Server URL",
        };

        await this.page.waitForFunction(
            ({ provider: selectedProvider, expectedLabel }) => {
                const rows = Array.from(
                    document.querySelectorAll(".setting-item")
                );
                const backendRow = rows.find((row) => {
                    const name = row
                        .querySelector(".setting-item-name")
                        ?.textContent?.trim();
                    return name === "Sync backend";
                }) as HTMLElement | undefined;
                const backendSelect = backendRow?.querySelector(
                    "select"
                ) as HTMLSelectElement | null;
                const targetRowVisible = rows.some((row) => {
                    const name = row
                        .querySelector(".setting-item-name")
                        ?.textContent?.trim();
                    return (
                        name === expectedLabel &&
                        row instanceof HTMLElement &&
                        row.offsetParent !== null
                    );
                });

                return (
                    backendSelect?.value === selectedProvider &&
                    targetRowVisible
                );
            },
            {
                provider,
                expectedLabel: expectedLabels[provider],
            }
        );
    }

    async selectDropdown(name: string, valueOrLabel: string): Promise<void> {
        await this.revealSettingIfCollapsed(name);
        const select = this.settingRow(name).locator("select").first();
        await expect(select).toBeVisible();
        try {
            await select.selectOption({ value: valueOrLabel });
        } catch {
            await select.selectOption({ label: valueOrLabel });
        }
    }

    async refreshDropdown(name: string): Promise<boolean> {
        await this.revealSettingIfCollapsed(name);
        const buttons = this.settingRow(name).locator(
            "button.clickable-icon, button.extra-setting-button, .extra-setting-button, .extra-settings-button"
        );
        const count = await buttons.count();
        for (let index = 0; index < count; index++) {
            const button = buttons.nth(index);
            if (!(await button.isVisible().catch(() => false))) {
                continue;
            }
            const disabled = await button
                .evaluate((element) => {
                    if (element instanceof HTMLButtonElement) {
                        return element.disabled;
                    }
                    return element.getAttribute("aria-disabled") === "true";
                })
                .catch(() => true);
            if (disabled) {
                continue;
            }
            await button.click();
            return true;
        }
        return false;
    }

    /**
     * Wait until the named dropdown contains the given value.
     * Note: By default we use `SETTINGS_READY_TIMEOUT` to align with other
     * wait utilities (e.g. `waitForDropdownLabel`) to mitigate flakiness from
     * delayed rendering or API responses. Callers may pass a custom timeout
     * as the third parameter when needed.
     */
    async waitForDropdownOption(
        name: string,
        value: string,
        timeout = SETTINGS_READY_TIMEOUT
    ): Promise<void> {
        // Ensure any trust modal is dismissed before checking dropdown options
        if (!(await trustVaultIfPrompted(this.page))) {
            throw new Error(
                `Vault trust prompt remained visible while waiting for dropdown option "${name}"="${value}"`
            );
        }
        await this.revealSettingIfCollapsed(name);
        const select = this.settingRow(name).locator("select").first();
        let refreshRequested = false;
        try {
            await expect
                .poll(
                    async () => {
                        const options = await select.evaluate(
                            (element) => {
                                const selectElement =
                                    element as HTMLSelectElement;
                                return Array.from(selectElement.options).map(
                                    (option) => ({
                                        value: option.value,
                                        label: option.label,
                                        disabled: option.disabled,
                                    })
                                );
                            }
                        );
                        const hasOption = options.some(
                            (option) =>
                                option.value === value || option.label === value
                        );
                        if (!hasOption) {
                            const isRefreshing =
                                this.isDropdownRefreshing(options);
                            if (!isRefreshing && !refreshRequested) {
                                refreshRequested = true;
                                await this.refreshDropdown(name).catch(
                                    () => false
                                );
                            }
                        }
                        return hasOption;
                    },
                    { timeout }
                )
                .toBe(true);
        } catch (error) {
            const currentOptions: Array<{
                value: string;
                label: string;
                disabled: boolean;
            }> = await this.dropdownOptions(name).catch(() => []);
            if (
                currentOptions.some(
                    (option) => option.value === value || option.label === value
                )
            ) {
                return;
            }
            throw new Error(
                `Timed out waiting for dropdown "${name}" option "${value}": ${error instanceof Error ? error.message : String(error)}. ${await this.describeDropdownDiagnostics(name)}`
            );
        }
    }

    private async describeDropdownDiagnostics(name: string): Promise<string> {
        if (this.page.isClosed()) {
            return "Diagnostics unavailable: page is closed.";
        }
        const diagnostics = await this.page.evaluate((dropdownName) => {
            const rows = Array.from(document.querySelectorAll(".setting-item"));
            const rowByName = (settingName: string): Element | undefined =>
                rows.find(
                    (row) =>
                        row
                            .querySelector(".setting-item-name")
                            ?.textContent?.trim() === settingName
                );
            const valueFor = (settingName: string): string => {
                const control = rowByName(settingName)?.querySelector(
                    'input[type="text"], textarea, select'
                );
                if (control instanceof HTMLInputElement) {
                    return control.value;
                }
                if (control instanceof HTMLTextAreaElement) {
                    return control.value;
                }
                if (control instanceof HTMLSelectElement) {
                    return control.value;
                }
                return "";
            };
            const safeUrlHost = (value: string): string => {
                if (!value) {
                    return "";
                }
                try {
                    const url = new URL(value);
                    return url.host;
                } catch {
                    return value.replace(/\/\/.*@/u, "//<redacted>@");
                }
            };
            const visibleSettingNames = rows
                .filter(
                    (row) =>
                        row instanceof HTMLElement && row.offsetParent !== null
                )
                .map((row) =>
                    row.querySelector(".setting-item-name")?.textContent?.trim()
                )
                .filter((settingName): settingName is string =>
                    Boolean(settingName)
                );
            const backendRow = rowByName("Sync backend");
            const backendValue =
                backendRow?.querySelector("select") instanceof HTMLSelectElement
                    ? backendRow.querySelector("select")?.value
                    : "";
            const dropdownRow = rowByName(dropdownName);
            const select = dropdownRow?.querySelector("select");
            const options =
                select instanceof HTMLSelectElement
                    ? Array.from(select.options).map((option) => ({
                          value: option.value,
                          label: option.label,
                          disabled: option.disabled,
                      }))
                    : [];
            const refreshButtons = Array.from(
                dropdownRow?.querySelectorAll(
                    "button.clickable-icon, button.extra-setting-button, .extra-setting-button, .extra-settings-button"
                ) ?? []
            ).map((button) => ({
                ariaLabel: button.getAttribute("aria-label") ?? "",
                title: button.getAttribute("title") ?? "",
                disabled:
                    button instanceof HTMLButtonElement
                        ? button.disabled
                        : button.getAttribute("aria-disabled") === "true",
                visible:
                    button instanceof HTMLElement &&
                    button.offsetParent !== null,
            }));
            const branchSelector = document.querySelector(
                '[data-git-vault-branch-selector="true"]'
            );
            const branchSelectorState =
                branchSelector instanceof HTMLSelectElement
                    ? {
                          state:
                              branchSelector.getAttribute(
                                  "data-git-vault-branch-state"
                              ) ?? "",
                          current:
                              branchSelector.getAttribute(
                                  "data-git-vault-current-branch"
                              ) ?? "",
                          disabled: branchSelector.disabled,
                          options: Array.from(branchSelector.options).map(
                              (option) => ({
                                  value: option.value,
                                  label: option.label,
                                  disabled: option.disabled,
                              })
                          ),
                      }
                    : null;
            return {
                backendValue,
                options,
                refreshButtons,
                branchSelectorState,
                providerContext: {
                    githubOwner: valueFor("Owner / organization"),
                    githubRepo: valueFor("Repository"),
                    gitlabBaseHost: safeUrlHost(valueFor("API base URL")),
                    gitlabProject: valueFor("Project path / ID"),
                    giteaBaseHost: safeUrlHost(valueFor("Server URL")),
                    giteaOwner: valueFor("Owner / namespace"),
                    giteaRepo: valueFor("Repository"),
                },
                visibleSettingNames,
            };
        }, name);

        return `Diagnostics: ${JSON.stringify(diagnostics)}`;
    }

    async dropdownLabels(name: string): Promise<string[]> {
        const options = await this.dropdownOptions(name);
        return options.map((option) => option.label);
    }

    async fillText(
        name: string,
        value: string,
        options: { sensitive?: boolean; blur?: boolean } = {}
    ): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await this.revealSettingIfCollapsed(name);
                const input = this.settingRow(name)
                    .locator('input[type="text"], input[type="password"]')
                    .first();
                await expect(input).toBeVisible();
                await input.click();
                await input.fill(value);
                await input.evaluate((element) => {
                    const inputElement = element as HTMLInputElement;
                    inputElement.dispatchEvent(
                        new Event("input", {
                            bubbles: true,
                            cancelable: true,
                        })
                    );
                    inputElement.dispatchEvent(
                        new Event("change", {
                            bubbles: true,
                            cancelable: true,
                        })
                    );
                });
                if (options.sensitive) {
                    await expect
                        .poll(async () => (await input.inputValue()).length, {
                            timeout: SETTINGS_READY_TIMEOUT,
                        })
                        .toBe(value.length);
                } else {
                    await expect(input).toHaveValue(value);
                }
                if (options.blur !== false) {
                    await input.evaluate((element) => {
                        const inputElement = element as HTMLInputElement;
                        inputElement.blur();
                    });
                }
                return;
            } catch (error) {
                lastError = error;
                if (this.page.isClosed()) {
                    throw error;
                }
                await this.page.waitForTimeout(250);
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error(`Failed to fill setting "${name}".`);
    }

    async inputType(name: string): Promise<string> {
        await this.revealSettingIfCollapsed(name);
        const input = this.settingRow(name)
            .locator('input[type="text"], input[type="password"]')
            .first();
        await expect(input).toBeVisible();
        return input.evaluate((element) => {
            return (element as HTMLInputElement).type;
        });
    }

    async clickExtraButton(name: string, index = 0): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await this.revealSettingIfCollapsed(name);
                const button = this.settingRow(name)
                    .locator(
                        "button.clickable-icon, button.extra-setting-button, .extra-setting-button, .extra-settings-button"
                    )
                    .nth(index);
                await expect(button).toBeVisible();
                await button.click({ force: true });
                return;
            } catch (error) {
                lastError = error;
                if (this.page.isClosed()) {
                    throw error;
                }
                await this.page.waitForTimeout(250);
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(`Failed to click extra button for "${name}".`);
    }

    async fillTextArea(name: string, value: string): Promise<void> {
        await this.revealSettingIfCollapsed(name);
        const textArea = this.settingRow(name).locator("textarea").first();
        await expect(textArea).toBeVisible();
        await textArea.click();
        await textArea.fill(value);
        await expect(textArea).toHaveValue(value);
        await textArea.evaluate((element) => {
            const textAreaElement = element as HTMLTextAreaElement;
            textAreaElement.dispatchEvent(
                new Event("change", { bubbles: true, cancelable: true })
            );
            textAreaElement.blur();
        });
    }

    async clickButton(name: string, buttonText: string): Promise<void> {
        await this.revealSettingIfCollapsed(name);
        const button = this.settingRow(name).getByRole("button", {
            name: buttonText,
        });
        await expect(button).toBeVisible();
        await expect
            .poll(
                () =>
                    button.evaluate((element) => {
                        const htmlButton = element as HTMLButtonElement;
                        return (
                            !htmlButton.disabled &&
                            !htmlButton.classList.contains("mod-loading")
                        );
                    }),
                { timeout: SETTINGS_READY_TIMEOUT }
            )
            .toBe(true);
        await button.click();
    }

    async installNoticeSpy(): Promise<void> {
        await this.page.evaluate((pluginId) => {
            const windowAny = window as Window & {
                app?: {
                    plugins?: {
                        plugins?: Record<
                            string,
                            {
                                showNotice?: (
                                    message: string,
                                    timeout?: number
                                ) => unknown;
                                makeSyncNotice?: (
                                    message: string,
                                    timeout?: number
                                ) => unknown;
                                __syncProE2eNoticeSpyInstalled?: boolean;
                            }
                        >;
                    };
                };
                __syncProNoticeMessages?: string[];
            };
            const plugin = windowAny.app?.plugins?.plugins?.[pluginId];
            if (!plugin) {
                return;
            }
            windowAny.__syncProNoticeMessages = [];

            if (plugin.__syncProE2eNoticeSpyInstalled) {
                return;
            }
            plugin.__syncProE2eNoticeSpyInstalled = true;

            const recordNotice = (message: string): void => {
                windowAny.__syncProNoticeMessages?.push(String(message));
            };

            const originalShowNotice = plugin.showNotice?.bind(plugin) as
                | ((message: string, timeout?: number) => unknown)
                | undefined;
            if (originalShowNotice) {
                const spyShowNotice = ((message: string, timeout?: number) => {
                    recordNotice(message);
                    return originalShowNotice(message, timeout);
                }) as typeof plugin.showNotice;

                Object.defineProperty(plugin, "showNotice", {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: spyShowNotice,
                });
            }

            const originalMakeSyncNotice = plugin.makeSyncNotice?.bind(
                plugin
            ) as ((message: string, timeout?: number) => unknown) | undefined;
            if (originalMakeSyncNotice) {
                const spyMakeSyncNotice = ((
                    message: string,
                    timeout?: number
                ) => {
                    recordNotice(message);
                    return originalMakeSyncNotice(message, timeout);
                }) as typeof plugin.makeSyncNotice;

                Object.defineProperty(plugin, "makeSyncNotice", {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: spyMakeSyncNotice,
                });
            }
        }, PLUGIN_ID);
    }

    async expectNoticeVisible(matcher: string | RegExp): Promise<void> {
        await expect
            .poll(
                async () => {
                    const messages = await this.page.evaluate(() => {
                        const windowAny = window as typeof window & {
                            __syncProNoticeMessages?: string[];
                        };
                        const spyMessages = [
                            ...(windowAny.__syncProNoticeMessages ?? []),
                        ];
                        const visibleNoticeMessages = Array.from(
                            document.querySelectorAll(".notice")
                        )
                            .map((notice) => notice.textContent?.trim() ?? "")
                            .filter((message) => message.length > 0);
                        return [...spyMessages, ...visibleNoticeMessages];
                    });
                    return messages.some((message) =>
                        typeof matcher === "string"
                            ? message.includes(matcher)
                            : matcher.test(message)
                    );
                },
                { timeout: 30_000 }
            )
            .toBe(true);
    }

    remoteActionModal(): Locator {
        return this.page.locator(".git-vault-remote-action-modal").first();
    }

    async waitForRemoteActionModal(): Promise<void> {
        await expect(this.remoteActionModal()).toBeVisible();
    }

    async dismissRemoteActionModalIfVisible(): Promise<void> {
        const remoteActionModal = this.remoteActionModal();
        const cancelButton = remoteActionModal.getByRole("button", {
            name: "Cancel",
        });
        if ((await cancelButton.count()) === 0) {
            return;
        }
        if (
            !(await cancelButton
                .first()
                .isVisible()
                .catch(() => false))
        ) {
            return;
        }
        await cancelButton.first().click();
        await expect(remoteActionModal).toHaveCount(0);
    }

    async chooseRemoteAction(label: string): Promise<void> {
        const remoteActionModal = this.remoteActionModal();
        const isVisible = await remoteActionModal
            .isVisible()
            .catch(() => false);
        if (!isVisible) {
            await this.clickButton("Use selected remote", "Choose action");
            await this.waitForRemoteActionModal();
        }
        await remoteActionModal.getByRole("button", { name: label }).click();
    }

    async inputValue(name: string): Promise<string> {
        await this.revealSettingIfCollapsed(name);
        const input = this.settingRow(name)
            .locator(ProviderSettingsPage.CONTROL_SELECTOR)
            .first();
        await expect(input).toBeVisible();
        const tagName = await input.evaluate((element) => element.tagName);
        if (tagName === "SELECT") {
            return input.evaluate(
                (element) => (element as HTMLSelectElement).value
            );
        }
        return input.inputValue();
    }
}
