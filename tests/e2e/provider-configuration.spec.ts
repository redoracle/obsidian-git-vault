import { test, expect } from "@playwright/test";
import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import {
    expectVaultToMatchActiveApiRemote,
    PLUGIN_ID,
    ProviderSettingsPage,
    getStoredProviderToken,
    installWindowOpenSpy,
    launchObsidianApp,
    openSourceControlView,
    prepareTestVault,
    readPluginData,
    readRegisteredVaultPaths,
    readSecretsSafely,
    registerVaultPath,
    relaunchObsidianApp,
    seedAllProviderConfigs,
    setSyncMode,
    submitGeneralPrompt,
    waitForOpenedWindowUrl,
    writePluginData,
    type LaunchedObsidian,
    type PreparedVault,
} from "./helpers/obsidian";

const secrets = readSecretsSafely();
const execFileAsync = promisify(execFile);

type ObsidianPlugin = {
    settings?: Record<string, unknown>;
    providerSecrets?: {
        getToken?: (provider: string) => string | null;
    };
};

type ObsidianWindow<
    TPlugin extends Record<string, unknown> = Record<string, unknown>,
> = Window & {
    app?: {
        plugins?: {
            plugins?: Record<string, TPlugin>;
        };
    };
};

type ObsidianPluginWithSyncManager = ObsidianPlugin & {
    syncManager?: {
        getBranchSelection?: () => Promise<{
            current: string;
            branches: string[];
        }>;
    };
};

type ApiRemoteTargetPlugin = {
    settingsTab?: {
        _apiRemoteTargetWorkflow?: {
            describeCurrentTarget?: () => Promise<{
                kind: string;
                vaultPath?: string;
                fingerprint?: string;
            } | null>;
        };
    };
};

type PendingVaultSyncRequestSnapshot = {
    action: "sync-existing-vault";
    vaultPath: string;
    fingerprint: string;
    requestedAt: number;
};

type GitHubContentResponse = {
    sha?: string;
};

type ObsidianWindowWithSyncManager = ObsidianWindow & {
    app?: {
        plugins?: {
            plugins?: Record<string, ObsidianPluginWithSyncManager>;
        };
    };
};

function expectOrdered(settingNames: string[], labels: string[]): void {
    let previousIndex = -1;
    for (const label of labels) {
        const index = settingNames.indexOf(label);
        expect(index, `Expected visible setting "${label}"`).toBeGreaterThan(
            -1
        );
        expect(
            index,
            `Expected "${label}" to appear after "${settingNames[previousIndex] ?? "start"}"`
        ).toBeGreaterThan(previousIndex);
        previousIndex = index;
    }
}

async function selectPreferredOrFirstBranch(
    settings: ProviderSettingsPage,
    preferredBranch: string
): Promise<string> {
    return selectPreferredOrFirst(settings, "Branch", preferredBranch);
}

// Wrapper around the generic helper selectPreferredOrFirst that binds the
// label "Repository" and forwards the preferred repository value to the
// shared implementation.
async function selectPreferredOrFirstRepository(
    settings: ProviderSettingsPage,
    preferredRepo: string
): Promise<string> {
    return selectPreferredOrFirst(settings, "Repository", preferredRepo);
}

// Generic helper to select a preferred or first option from a dropdown
async function selectPreferredOrFirst(
    settings: ProviderSettingsPage,
    label: string,
    preferred: string
): Promise<string> {
    let selectable: Array<{ value: string; label: string; disabled: boolean }> =
        [];
    let refreshRequested = false;
    await expect
        .poll(
            async () => {
                const options = await settings.dropdownOptions(label);
                selectable = options.filter(
                    (option) => option.value.length > 0 && !option.disabled
                );
                if (selectable.length === 0) {
                    const isRefreshing = options.some(
                        (option) =>
                            /refreshing|fetching/i.test(option.label) ||
                            /refreshing|fetching/i.test(option.value)
                    );
                    if (!isRefreshing && !refreshRequested) {
                        refreshRequested = true;
                        await settings.refreshDropdown(label).catch(() => false);
                    }
                }
                return selectable.length;
            },
            { timeout: 60_000 }
        )
        .toBeGreaterThan(0);

    const current = await settings.inputValue(label);
    if (
        current.length > 0 &&
        selectable.some(
            (option) => option.value === current || option.label === current
        )
    ) {
        return current;
    }

    const target =
        selectable.find(
            (option) => option.value === preferred || option.label === preferred
        )?.value ?? selectable[0].value;

    await settings.selectDropdown(label, target);
    return settings.inputValue(label);
}

async function installGiteaSettingsApiFixture(
    page: LaunchedObsidian["page"]
): Promise<void> {
    await page.evaluate(
        ({ pluginId, repo, branch }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settingsTab?: {
                                        _giteaClient?: {
                                            fetchRepos?: (
                                                owner: string
                                            ) => Promise<
                                                Record<string, string>
                                            >;
                                            fetchBranches?: (
                                                owner: string,
                                                repo: string
                                            ) => Promise<
                                                Record<string, string>
                                            >;
                                            requestUser?: () => Promise<{
                                                login?: string;
                                                fullName?: string;
                                            } | null>;
                                        };
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];
            const giteaClient = plugin?.settingsTab?._giteaClient;
            if (!giteaClient) {
                throw new Error("Gitea settings API client is not available.");
            }
            giteaClient.fetchRepos = (owner: string) =>
                Promise.resolve(
                    owner
                        ? {
                              "": "Select repository",
                              [repo]: repo,
                          }
                        : { "": "Enter owner first" }
                );
            giteaClient.fetchBranches = (
                _owner: string,
                selectedRepo: string
            ) =>
                Promise.resolve(
                    selectedRepo
                        ? {
                              "": "Select branch",
                              [branch]: branch,
                          }
                        : { "": "Select a repository first" }
                );
            giteaClient.requestUser = () =>
                Promise.resolve({ login: "redoracle" });
        },
        {
            pluginId: PLUGIN_ID,
            repo: secrets.gitea.repo,
            branch: secrets.gitea.branch,
        }
    );
}

async function installGiteaRuntimeProviderFixture(
    page: LaunchedObsidian["page"]
): Promise<void> {
    await page.evaluate(
        async ({ pluginId, branch }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settings?: { activeSyncProvider?: string };
                                    syncManager?: {
                                        reload?: () => Promise<void>;
                                        provider?: {
                                            getBranchSelection?: () => Promise<{
                                                current: string;
                                                branches: string[];
                                            }>;
                                            sync?: () => Promise<unknown>;
                                            pull?: () => Promise<void>;
                                            push?: () => Promise<void>;
                                        };
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];
            if (plugin?.settings?.activeSyncProvider !== "gitea") {
                return;
            }
            if (!plugin.syncManager?.provider) {
                await plugin.syncManager?.reload?.();
            }
            if (!plugin.syncManager) {
                throw new Error(
                    "Gitea sync manager not available after reload."
                );
            }
            const provider = plugin.syncManager?.provider ?? {};
            plugin.syncManager.provider = provider;
            provider.getBranchSelection = () =>
                Promise.resolve({ current: branch, branches: [branch] });
            provider.sync = () =>
                Promise.resolve({
                    success: true,
                    filesChanged: 0,
                    message: "Gitea fixture sync completed",
                    conflicts: [],
                });
            provider.pull = () => Promise.resolve();
            provider.push = () => Promise.resolve();
        },
        { pluginId: PLUGIN_ID, branch: secrets.gitea.branch }
    );
}

async function withVault(
    run: (args: {
        vault: PreparedVault;
        session: LaunchedObsidian;
        replaceSession: (next: LaunchedObsidian) => void;
    }) => Promise<void>
): Promise<void> {
    const vault = prepareTestVault(secrets);
    let session: LaunchedObsidian | undefined;
    try {
        session = await launchObsidianApp(
            vault.vaultPath,
            vault.userDataDir,
            secrets
        );
        if (!session) {
            throw new Error("Failed to launch Obsidian test session");
        }
        await installGiteaSettingsApiFixture(session.page);
        await run({
            vault,
            session,
            replaceSession: (next) => {
                session = next;
            },
        });
    } catch (error) {
        await session?.page
            .screenshot({
                path: test.info().outputPath("failure.png"),
                fullPage: true,
            })
            .catch(() => undefined);
        throw error;
    } finally {
        await session?.close();
        await vault.cleanup();
    }
}

function gitRemoteUrl(vaultPath: string, remoteName = "origin"): string {
    return execFileSync("git", ["remote", "get-url", remoteName], {
        cwd: vaultPath,
        encoding: "utf8",
    }).trim();
}

async function gitRemoteUrlAsync(
    vaultPath: string,
    remoteName = "origin"
): Promise<string> {
    const result = await execFileAsync(
        "git",
        ["remote", "get-url", remoteName],
        {
            cwd: vaultPath,
            encoding: "utf8",
        }
    );
    return result.stdout.trim();
}

function forceUnrelatedGitRemote(vaultPath: string): void {
    execFileSync(
        "git",
        [
            "remote",
            "set-url",
            "origin",
            "https://example.com/redoracle/unrelated-vault.git",
        ],
        {
            cwd: vaultPath,
        }
    );
}

async function getApiRemoteTargetDecision(
    page: LaunchedObsidian["page"]
): Promise<{ kind: string; vaultPath?: string; fingerprint?: string } | null> {
    return page.evaluate(
        async ({ pluginId }) => {
            const plugin = (window as ObsidianWindow<ApiRemoteTargetPlugin>).app
                ?.plugins?.plugins?.[pluginId];
            return (
                (await plugin?.settingsTab?._apiRemoteTargetWorkflow?.describeCurrentTarget?.()) ??
                null
            );
        },
        { pluginId: PLUGIN_ID }
    );
}

async function getCurrentTargetFingerprint(
    page: LaunchedObsidian["page"]
): Promise<string> {
    const decision = await getApiRemoteTargetDecision(page);
    expect(decision).not.toBeNull();
    expect(decision?.fingerprint).toBeTruthy();
    return decision?.fingerprint as string;
}

async function getPendingVaultSyncRequestSnapshot(
    page: LaunchedObsidian["page"]
): Promise<PendingVaultSyncRequestSnapshot | null> {
    return page.evaluate((pluginId) => {
        const plugin = (
            window as ObsidianWindow<
                ObsidianPlugin & {
                    localStorage?: {
                        getPendingVaultSyncRequest?: () => PendingVaultSyncRequestSnapshot | null;
                    };
                }
            >
        ).app?.plugins?.plugins?.[pluginId];
        return plugin?.localStorage?.getPendingVaultSyncRequest?.() ?? null;
    }, PLUGIN_ID);
}

async function handleSecureSetupModalIfVisible(
    page: LaunchedObsidian["page"],
    action: "open-settings" | "later" = "later",
    timeout = 30_000
): Promise<boolean> {
    const modal = page
        .locator(".modal:visible")
        .filter({
            hasText: "Complete secure setup",
        })
        .last();
    try {
        await modal.waitFor({ state: "visible", timeout });
    } catch {
        return false;
    }

    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(
        modal.getByText("credentials were intentionally not copied", {
            exact: false,
        })
    ).toBeVisible({ timeout: 10_000 });
    await modal
        .getByRole("button", {
            name:
                action === "open-settings" ? "Open Git Vault settings" : "Later",
        })
        .click({ force: true, timeout: 10_000 });
    await expect(modal).toBeHidden({ timeout: 30_000 });
    return true;
}

async function expectSyncAuditLogs(
    session: LaunchedObsidian,
    expectedFragments: string[]
): Promise<void> {
    let logs: string[] = [];
    await expect
        .poll(
            async () => {
                await session.audit.refresh();
                logs = session.audit.consoleEntries
                    .filter(
                        (entry) => entry.type === "info" || entry.type === "log"
                    )
                    .map((entry) => entry.text)
                    .filter((entry) => entry.includes("[Git Vault][audit]"));
                return expectedFragments.filter(
                    (fragment) =>
                        !logs.some((entry) => entry.includes(fragment))
                );
            },
            { timeout: 60_000 }
        )
        .toEqual([]);
}

async function expectApiAdvancedSourceControlChrome(
    page: LaunchedObsidian["page"]
): Promise<void> {
    await openSourceControlView(page);
    await expect(page.locator("#push")).toBeVisible();
    await expect(page.locator("#pull")).toBeVisible();
    await expect(page.locator("#backup-btn")).toHaveCount(0);
    await expect(page.locator("#commit-btn")).toHaveCount(0);
}

function readCommunityPlugins(vaultPath: string): string[] {
    const pluginsPath = path.join(
        vaultPath,
        ".obsidian",
        "community-plugins.json"
    );
    return JSON.parse(fs.readFileSync(pluginsPath, "utf8")) as string[];
}

async function removeVaultFile(
    page: LaunchedObsidian["page"],
    relativePath: string
): Promise<void> {
    await page.evaluate(async (targetPath) => {
        const app = (
            window as typeof window & {
                app?: {
                    vault?: {
                        getFileByPath?: (path: string) => unknown;
                        delete?: (
                            file: unknown,
                            force?: boolean
                        ) => Promise<void>;
                    };
                };
            }
        ).app;
        const file = app?.vault?.getFileByPath?.(targetPath);
        if (!file) {
            return;
        }
        await app?.vault?.delete?.(file, true);
    }, relativePath);
}

async function writeVaultFile(
    page: LaunchedObsidian["page"],
    relativePath: string,
    content: string
): Promise<void> {
    await page.evaluate(
        async ({ targetPath, nextContent }) => {
            const app = (
                window as typeof window & {
                    app?: {
                        vault?: {
                            getFileByPath?: (path: string) => unknown;
                            create?: (
                                path: string,
                                content: string
                            ) => Promise<unknown>;
                            modify?: (
                                file: unknown,
                                content: string
                            ) => Promise<void>;
                        };
                    };
                }
            ).app;
            const file = app?.vault?.getFileByPath?.(targetPath);
            if (file) {
                await app?.vault?.modify?.(file, nextContent);
                return;
            }
            await app?.vault?.create?.(targetPath, nextContent);
        },
        { targetPath: relativePath, nextContent: content }
    );
}

async function triggerAdvancedPushFromUi(
    page: LaunchedObsidian["page"]
): Promise<void> {
    await openSourceControlView(page);
    const pushButton = page.locator("#push");
    await expect(pushButton).toBeVisible({ timeout: 30_000 });
    await expect(pushButton).toBeEnabled({ timeout: 30_000 });
    const syncCountBefore = (await getRuntimeSyncSnapshot(page)).syncCount;
    await pushButton.click();
    await expect
        .poll(async () => (await getRuntimeSyncSnapshot(page)).syncCount, {
            timeout: 120_000,
        })
        .toBeGreaterThan(syncCountBefore);
}

async function triggerAdvancedPullFromUi(
    page: LaunchedObsidian["page"]
): Promise<void> {
    await openSourceControlView(page);
    const pullButton = page.locator("#pull");
    await expect(pullButton).toBeVisible({ timeout: 30_000 });
    await expect(pullButton).toBeEnabled({ timeout: 30_000 });
    const syncCountBefore = (await getRuntimeSyncSnapshot(page)).syncCount;
    await pullButton.click();
    await expect
        .poll(async () => (await getRuntimeSyncSnapshot(page)).syncCount, {
            timeout: 120_000,
        })
        .toBeGreaterThan(syncCountBefore);
}

async function commitActiveApiRemoteMutation(
    page: LaunchedObsidian["page"],
    mutation: {
        kind: "create" | "update" | "delete";
        path: string;
        content?: string;
        previousRevision?: string;
    },
    message: string
): Promise<void> {
    await page.evaluate(
        async ({ pluginId, nextMutation, commitMessage }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    syncManager?: {
                                        provider?: {
                                            client?: {
                                                init?: () => Promise<void>;
                                                commitMutations?: (
                                                    mutations: unknown[],
                                                    message: string
                                                ) => Promise<number>;
                                            };
                                        };
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];

            const client = plugin?.syncManager?.provider?.client;
            if (!client?.commitMutations) {
                throw new Error(
                    "Active API provider client is not available for remote mutation."
                );
            }

            await client.init?.();
            await client.commitMutations([nextMutation], commitMessage);
        },
        { pluginId: PLUGIN_ID, nextMutation: mutation, commitMessage: message }
    );
}

async function deleteActiveApiRemotePathIfExists(
    page: LaunchedObsidian["page"],
    remotePath: string,
    message: string
): Promise<void> {
    await page.evaluate(
        async ({ pluginId, targetPath, commitMessage }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    syncManager?: {
                                        provider?: {
                                            client?: {
                                                init?: () => Promise<void>;
                                                listRemoteFiles?: () => Promise<
                                                    Map<
                                                        string,
                                                        { revision?: string }
                                                    >
                                                >;
                                                commitMutations?: (
                                                    mutations: unknown[],
                                                    message: string
                                                ) => Promise<number>;
                                            };
                                        };
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];

            const client = plugin?.syncManager?.provider?.client;
            if (!client?.listRemoteFiles || !client?.commitMutations) {
                return;
            }

            await client.init?.();
            const files = await client.listRemoteFiles();
            const remoteItem = files.get(targetPath);
            if (!remoteItem) {
                return;
            }

            await client.commitMutations(
                [
                    {
                        kind: "delete",
                        path: targetPath,
                        previousRevision: remoteItem.revision,
                    },
                ],
                commitMessage
            );
        },
        { pluginId: PLUGIN_ID, targetPath: remotePath, commitMessage: message }
    );
}

function githubContentApiPath(remotePath: string): string {
    const encodedPath = remotePath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    return `/repos/${secrets.github.owner}/${secrets.github.repo}/contents/${encodedPath}`;
}

function parseGitHubContentResponse(raw: string): GitHubContentResponse {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
        return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
        sha: typeof record.sha === "string" ? record.sha : undefined,
    };
}

async function deleteGitHubRemotePathIfExists(
    remotePath: string,
    message: string
): Promise<void> {
    try {
        const result = await execFileAsync("gh", [
            "api",
            `${githubContentApiPath(remotePath)}?ref=${encodeURIComponent(secrets.github.branch)}`,
        ]);
        const response = parseGitHubContentResponse(result.stdout);
        if (!response.sha) {
            return;
        }
        await execFileAsync("gh", [
            "api",
            "--method",
            "DELETE",
            githubContentApiPath(remotePath),
            "-f",
            `message=${message}`,
            "-f",
            `sha=${response.sha}`,
            "-f",
            `branch=${secrets.github.branch}`,
        ]);
    } catch {
        // The path may not exist if the test failed before the remote write.
    }
}

async function readActiveApiRemoteTextFile(
    page: LaunchedObsidian["page"],
    remotePath: string
): Promise<string | null> {
    return page.evaluate(
        async ({ pluginId, targetPath }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    syncManager?: {
                                        provider?: {
                                            client?: {
                                                init?: () => Promise<void>;
                                                listRemoteFiles?: () => Promise<
                                                    Map<string, unknown>
                                                >;
                                                downloadFile?: (
                                                    path: string
                                                ) => Promise<
                                                    string | Uint8Array
                                                >;
                                            };
                                        };
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];

            const client = plugin?.syncManager?.provider?.client;
            if (!client?.listRemoteFiles || !client?.downloadFile) {
                throw new Error(
                    "Active API provider client is not available for remote reads."
                );
            }

            await client.init?.();
            const files = await client.listRemoteFiles();
            if (!files.has(targetPath)) {
                return null;
            }

            const content = await client.downloadFile(targetPath);
            return typeof content === "string"
                ? content
                : new TextDecoder().decode(content);
        },
        { pluginId: PLUGIN_ID, targetPath: remotePath }
    );
}

async function getRuntimeSyncSnapshot(page: LaunchedObsidian["page"]): Promise<{
    lastSyncTime: number | null;
    syncCount: number;
    isSyncing: boolean;
    conflicts: number;
    lastError: string | null;
    manifestCount: number;
    pendingChanges: number;
}> {
    return page.evaluate((pluginId) => {
        const plugin = (
            window as typeof window & {
                app?: {
                    plugins?: {
                        plugins?: Record<
                            string,
                            {
                                syncState?: {
                                    getState?: () => {
                                        lastSyncTime: number | null;
                                        syncCount: number;
                                        isSyncing: boolean;
                                        conflicts: unknown[];
                                        lastError: string | null;
                                        pendingChanges?: unknown[];
                                    };
                                };
                                syncManifestStore?: {
                                    data?: { manifest?: unknown[] };
                                };
                            }
                        >;
                    };
                };
            }
        ).app?.plugins?.plugins?.[pluginId];

        const state = plugin?.syncState?.getState?.();
        return {
            lastSyncTime: state?.lastSyncTime ?? null,
            syncCount: state?.syncCount ?? 0,
            isSyncing: state?.isSyncing ?? false,
            conflicts: state?.conflicts?.length ?? 0,
            lastError: state?.lastError ?? null,
            manifestCount:
                plugin?.syncManifestStore?.data?.manifest?.length ?? 0,
            pendingChanges: state?.pendingChanges?.length ?? 0,
        };
    }, PLUGIN_ID);
}

function createLocalBareGitRemote(vaultPath: string): {
    remotePath: string;
    cleanup: () => void;
} {
    const remoteRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "git-vault-local-remote-")
    );
    const remotePath = path.join(remoteRoot, "vault-remote.git");

    execFileSync("git", ["init", "--bare", remotePath]);
    execFileSync(
        "git",
        ["remote", "set-url", secrets.git.remoteName, remotePath],
        { cwd: vaultPath }
    );
    execFileSync(
        "git",
        ["push", "--set-upstream", secrets.git.remoteName, secrets.git.branch],
        { cwd: vaultPath }
    );

    return {
        remotePath,
        cleanup: () => {
            fs.rmSync(remoteRoot, { recursive: true, force: true });
        },
    };
}

async function triggerSimpleModeSyncFromUi(
    page: LaunchedObsidian["page"]
): Promise<void> {
    const beforeSync = await getRuntimeSyncSnapshot(page);
    await openSourceControlView(page);
    const syncButton = page.locator(".git-vault-sync-btn").first();
    await expect(syncButton).toBeVisible({ timeout: 30_000 });
    await expect(syncButton).toBeEnabled({ timeout: 30_000 });
    await syncButton.click();
    await expect
        .poll(
            async () => {
                const current = await getRuntimeSyncSnapshot(page);
                return (
                    current.isSyncing ||
                    current.syncCount > beforeSync.syncCount ||
                    current.lastError !== beforeSync.lastError
                );
            },
            { timeout: 30_000 }
        )
        .toBe(true);
}

async function runSyncNowWithTimeout(
    page: LaunchedObsidian["page"],
    timeoutMs = 30_000
): Promise<string> {
    return page.evaluate(
        async ({ pluginId, timeout }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    syncManager?: {
                                        syncNow?: () => Promise<void>;
                                    };
                                }
                            >;
                        };
                    };
                }
            ).app?.plugins?.plugins?.[pluginId];

            if (!plugin?.syncManager?.syncNow) {
                throw new Error("Sync manager is not available.");
            }

            return await Promise.race([
                plugin.syncManager.syncNow().then(() => {
                    return "completed";
                }),
                new Promise<string>((resolve) => {
                    setTimeout(() => resolve("timed-out"), timeout);
                }),
            ]);
        },
        { pluginId: PLUGIN_ID, timeout: timeoutMs }
    );
}

async function installConflictFixtureOnNextSync(
    page: LaunchedObsidian["page"],
    provider: "github" | "gitlab" | "gitea" = "github",
    options: { resolveConflicts?: boolean } = {}
): Promise<void> {
    await page.evaluate(
        async ({ pluginId, activeProvider, resolveConflicts }) => {
            const testWindow = window as typeof window & {
                __syncProLastConflictResolutions?: unknown[];
            };
            const plugin = (
                testWindow as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settings?: { activeSyncProvider?: string };
                                    saveSettings?: () => Promise<void>;
                                    syncManager?: {
                                        reload?: () => Promise<void>;
                                        provider?: {
                                            sync?: () => Promise<unknown>;
                                            resolveConflicts?: (
                                                resolutions: unknown[]
                                            ) => Promise<void>;
                                        };
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

            plugin.settings = plugin.settings ?? {};
            plugin.settings.activeSyncProvider = activeProvider;
            await plugin.saveSettings?.();
            await plugin.syncManager?.reload?.();

            const providerInstance = plugin.syncManager?.provider;
            if (!providerInstance?.sync) {
                throw new Error("Sync provider instance is not available.");
            }

            const originalSync: () => Promise<unknown> = providerInstance.sync;
            const originalResolveConflicts = providerInstance.resolveConflicts;
            providerInstance.sync = () => {
                providerInstance.sync = originalSync;
                return Promise.resolve({
                    success: true,
                    filesChanged: 1,
                    message: "Conflict fixture triggered",
                    conflicts: [
                        {
                            path: "conflicts/demo.md",
                            localContent: "local version",
                            remoteContent: "remote version",
                            isBinary: false,
                            requiresManualResolution: true,
                        },
                    ],
                });
            };
            if (resolveConflicts) {
                providerInstance.resolveConflicts = (
                    resolutions: unknown[]
                ) => {
                    testWindow.__syncProLastConflictResolutions = resolutions;
                    providerInstance.resolveConflicts =
                        originalResolveConflicts;
                    return Promise.resolve();
                };
            }
        },
        {
            pluginId: PLUGIN_ID,
            activeProvider: provider,
            resolveConflicts: options.resolveConflicts ?? false,
        }
    );
}

async function installRemoteUnavailableFixtureOnNextSync(
    page: LaunchedObsidian["page"],
    provider: "github" | "gitlab" | "gitea" = "github"
): Promise<void> {
    await page.evaluate(
        async ({ pluginId, activeProvider }) => {
            const plugin = (
                window as typeof window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settings?: { activeSyncProvider?: string };
                                    saveSettings?: () => Promise<void>;
                                    syncManager?: {
                                        reload?: () => Promise<void>;
                                        provider?: {
                                            sync?: () => Promise<unknown>;
                                        };
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

            plugin.settings = plugin.settings ?? {};
            plugin.settings.activeSyncProvider = activeProvider;
            await plugin.saveSettings?.();
            await plugin.syncManager?.reload?.();

            const providerInstance = plugin.syncManager?.provider;
            if (!providerInstance?.sync) {
                throw new Error("Sync provider instance is not available.");
            }

            const originalSync: () => Promise<unknown> = providerInstance.sync;
            providerInstance.sync = () => {
                providerInstance.sync = originalSync;
                return Promise.reject(
                    new Error("simulated remote unavailable")
                );
            };
        },
        { pluginId: PLUGIN_ID, activeProvider: provider }
    );
}

test("launches Obsidian and opens Git Vault settings cleanly", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();
        await settings.expectSettingVisible("Interface mode");
        await settings.expectSettingVisible("Sync backend");
        expectOrdered(await settings.visibleSettingNames(), [
            "Sync setup",
            "Interface mode",
            "Sync backend",
        ]);
        await session.audit.assertClean();
    });
});

test("switching providers updates the settings surface without renderer failures", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await seedAllProviderConfigs(session.page, secrets);
        await session.audit.reset();

        await settings.open();

        await settings.selectSyncBackend("git");
        await settings.expectSettingVisible("Remote URL");
        await settings.expectSettingHidden("Owner / organization");
        await settings.expectSettingHidden("API base URL");
        await settings.expectSettingHidden("Server URL");
        await settings.expectSettingVisible("Authentication");
        await settings.expectSettingVisible("Username");
        await settings.expectSettingVisible("Personal access token / password");
        expectOrdered(await settings.visibleSettingNames(), [
            "Sync backend",
            "Git backend",
            "Connection",
            "Branch tracking",
            "Authentication",
            "Sync behavior",
            "Git workflow",
            "Commit author",
            "Author name",
            "Author email",
            "Support",
        ]);

        await settings.selectSyncBackend("github");
        await settings.expectSettingVisible("Personal access token");
        await settings.expectSettingVisible("Owner / organization");
        await settings.expectSettingVisible("Repository");
        await settings.expectSettingVisible("Tracked directory");
        await settings.expectSettingHidden("Remote URL");
        await settings.expectSettingHidden("Project path / ID");
        await settings.expectSettingHidden("Server URL");
        expectOrdered(await settings.visibleSettingNames(), [
            "Sync backend",
            "GitHub API",
            "Authentication",
            "Repository target",
            "API sync",
            "Sync behavior",
        ]);

        await settings.selectSyncBackend("gitlab");
        await settings.expectSettingVisible("API base URL");
        await settings.expectSettingVisible("Project path / ID");
        await settings.expectSettingVisible("Branch");
        await settings.expectSettingHidden("Remote URL");
        await settings.expectSettingHidden("Owner / organization");
        await settings.expectSettingHidden("Server URL");
        expectOrdered(await settings.visibleSettingNames(), [
            "Sync backend",
            "GitLab API",
            "Connection",
            "Authentication",
            "Repository target",
            "API sync",
            "Sync behavior",
        ]);

        await settings.selectSyncBackend("gitea");
        await settings.expectSettingVisible("Server URL");
        await settings.expectSettingVisible("Owner / namespace");
        await settings.expectSettingVisible("Repository");
        await settings.expectSettingVisible("Tracked directory");
        await settings.expectSettingHidden("Remote URL");
        await settings.expectSettingHidden("Project path / ID");
        await settings.expectSettingHidden("API base URL");
        expectOrdered(await settings.visibleSettingNames(), [
            "Sync backend",
            "Gitea / Forgejo API",
            "Connection",
            "Authentication",
            "Repository target",
            "API sync",
            "Sync behavior",
        ]);

        await session.audit.assertClean();
    });
});

test("secure-field reveal toggles token and password inputs across providers", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();

        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        expect(await settings.inputType("Personal access token")).toBe(
            "password"
        );
        await settings.clickExtraButton("Personal access token");
        expect(await settings.inputType("Personal access token")).toBe("text");
        await settings.clickExtraButton("Personal access token");
        expect(await settings.inputType("Personal access token")).toBe(
            "password"
        );

        await settings.selectSyncBackend("gitlab");
        await settings.fillText("Personal access token", secrets.gitlab.token, {
            sensitive: true,
        });
        expect(await settings.inputType("Personal access token")).toBe(
            "password"
        );
        await settings.clickExtraButton("Personal access token");
        expect(await settings.inputType("Personal access token")).toBe("text");
        await settings.clickExtraButton("Personal access token");
        expect(await settings.inputType("Personal access token")).toBe(
            "password"
        );

        await settings.selectSyncBackend("gitea");
        await settings.fillText("Access token", secrets.gitea.token, {
            sensitive: true,
        });
        expect(await settings.inputType("Access token")).toBe("password");
        await settings.clickExtraButton("Access token");
        expect(await settings.inputType("Access token")).toBe("text");
        await settings.clickExtraButton("Access token");
        expect(await settings.inputType("Access token")).toBe("password");

        await settings.selectSyncBackend("git");
        await settings.fillText("Username", "git-user");
        await settings.fillText(
            "Personal access token / password",
            "test-password"
        );
        expect(
            await settings.inputType("Personal access token / password")
        ).toBe("password");
        await settings.clickExtraButton("Personal access token / password");
        expect(
            await settings.inputType("Personal access token / password")
        ).toBe("text");
        await settings.clickExtraButton("Personal access token / password");
        expect(
            await settings.inputType("Personal access token / password")
        ).toBe("password");

        await session.audit.assertClean();
    });
});

test("API settings expose a single remote action entry point", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await settings.selectSyncBackend("github");

        await settings.expectSettingVisible("Use selected remote");
        await settings.expectSettingHidden("Direct actions");
    });
});

test("flatten history is hidden unless the native Git provider is active", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await settings.selectSyncBackend("github");
        await settings.expectSettingHidden(
            "Flatten all commits into a single commit"
        );

        await settings.selectSyncBackend("git");
        const usesNativeGit = await session.page.evaluate((pluginId) => {
            const plugin = (window as ObsidianWindow<ObsidianPlugin>).app
                ?.plugins?.plugins?.[pluginId] as
                | (ObsidianPlugin & { useSimpleGit?: boolean })
                | undefined;
            return Boolean(plugin?.useSimpleGit);
        }, PLUGIN_ID);

        if (usesNativeGit) {
            await settings.expectSettingVisible(
                "Flatten all commits into a single commit"
            );
        } else {
            await settings.expectSettingHidden(
                "Flatten all commits into a single commit"
            );
        }
    });
});

test("API providers expose coherent repo and branch dropdown controls", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await seedAllProviderConfigs(session.page, secrets);
        await session.audit.reset();

        await settings.open();

        await settings.selectSyncBackend("github");
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await expect
            .poll(async () => {
                const options = await settings.dropdownOptions("Branch");
                return options.some(
                    (option) => option.value.length > 0 && !option.disabled
                );
            })
            .toBe(true);
        expect(await settings.controlTagName("Repository")).toBe("select");
        expect(await settings.controlTagName("Branch")).toBe("select");
        expect(await settings.isControlDisabled("Repository")).toBe(false);
        expect(await settings.isControlDisabled("Branch")).toBe(false);
        expectOrdered(await settings.visibleSettingNames(), [
            "Personal access token",
            "Token check",
            "Owner / organization",
            "Repository",
            "Branch",
            "Tracked directory",
        ]);

        await settings.selectSyncBackend("gitlab");
        await settings.waitForDropdownOption(
            "Project",
            secrets.gitlab.projectId
        );
        await settings.waitForDropdownOption("Branch", secrets.gitlab.branch);
        expect(await settings.controlTagName("Project")).toBe("select");
        expect(await settings.controlTagName("Project path / ID")).toBe(
            "input"
        );
        expect(await settings.controlTagName("Branch")).toBe("select");
        expect(await settings.isControlDisabled("Project")).toBe(false);
        expect(await settings.isControlDisabled("Branch")).toBe(false);
        expectOrdered(await settings.visibleSettingNames(), [
            "API base URL",
            "Personal access token",
            "Project",
            "Project path / ID",
            "Branch",
            "Tracked directory",
        ]);

        await settings.selectSyncBackend("gitea");
        await settings.waitForDropdownOption(
            "Repository",
            secrets.gitea.repo,
            15_000
        );
        await settings.waitForDropdownOption("Branch", secrets.gitea.branch);
        expect(await settings.controlTagName("Repository")).toBe("select");
        expect(await settings.controlTagName("Branch")).toBe("select");
        expect(await settings.isControlDisabled("Repository")).toBe(false);
        expect(await settings.isControlDisabled("Branch")).toBe(false);
        expectOrdered(await settings.visibleSettingNames(), [
            "Server URL",
            "Access token",
            "Owner / namespace",
            "Repository",
            "Branch",
            "Tracked directory",
        ]);

        await session.audit.assertClean();
    });
});

test("API repo and branch controls refresh coherently when prerequisite fields change", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();

        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        await expect
            .poll(async () => {
                const options = await settings.dropdownOptions("Branch");
                return options.some(
                    (option) => option.value.length > 0 && !option.disabled
                );
            })
            .toBe(true);
        await settings.fillText("Owner / organization", "");
        await settings.waitForDropdownLabel("Repository", "Enter owner first");
        await settings.waitForDropdownLabel(
            "Branch",
            "Select a repository first"
        );
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        await expect
            .poll(async () => {
                const options = await settings.dropdownOptions("Branch");
                return options.some(
                    (option) => option.value.length > 0 && !option.disabled
                );
            })
            .toBe(true);

        await settings.selectSyncBackend("gitlab");
        await settings.fillText("Personal access token", secrets.gitlab.token, {
            sensitive: true,
        });
        await settings.fillText("API base URL", secrets.gitlab.baseUrl);
        await settings.fillText("Project path / ID", secrets.gitlab.projectId);
        await settings.waitForDropdownOption("Branch", secrets.gitlab.branch);
        await settings.fillText("Project path / ID", "");
        await settings.waitForDropdownLabel("Branch", "Select a project first");
        await settings.fillText("Project path / ID", secrets.gitlab.projectId);
        await settings.waitForDropdownOption("Branch", secrets.gitlab.branch);

        await settings.selectSyncBackend("gitea");
        await settings.fillText("Access token", secrets.gitea.token, {
            sensitive: true,
        });
        await settings.fillText("Server URL", secrets.gitea.baseUrl);
        await settings.fillText("Owner / namespace", secrets.gitea.owner);
        await settings.waitForDropdownOption(
            "Repository",
            secrets.gitea.repo,
            15_000
        );
        await settings.selectDropdown("Repository", secrets.gitea.repo);
        await settings.waitForDropdownOption("Branch", secrets.gitea.branch);
        await settings.fillText("Owner / namespace", "");
        await settings.refreshDropdown("Repository");
        await settings.waitForDropdownLabel("Repository", "Enter owner first");
        await settings.fillText("Owner / namespace", secrets.gitea.owner);
        await settings.waitForDropdownOption("Repository", secrets.gitea.repo);
        await settings.selectDropdown("Repository", secrets.gitea.repo);
        await settings.waitForDropdownOption("Branch", secrets.gitea.branch);

        await session.audit.assertClean();
    });
});

test("API provider selectors expose coherent empty-state guidance before prerequisites are complete", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await session.audit.reset();

        await settings.selectSyncBackend("github");
        await settings.waitForDropdownLabel("Repository", "Enter owner first");
        await settings.waitForDropdownLabel(
            "Branch",
            "Select a repository first"
        );
        expect(await settings.dropdownLabels("Repository")).toContain(
            "Enter owner first"
        );
        expect(await settings.dropdownLabels("Branch")).toContain(
            "Select a repository first"
        );

        await settings.selectSyncBackend("gitlab");
        await settings.waitForDropdownLabel("Branch", "Select a project first");
        expect(await settings.dropdownLabels("Branch")).toContain(
            "Select a project first"
        );

        await settings.selectSyncBackend("gitea");
        await settings.waitForDropdownLabel("Repository", "Enter owner first");
        await settings.waitForDropdownLabel(
            "Branch",
            "Select a repository first"
        );
        expect(await settings.dropdownLabels("Repository")).toContain(
            "Enter owner first"
        );
        expect(await settings.dropdownLabels("Branch")).toContain(
            "Select a repository first"
        );

        await session.audit.assertClean();
    });
});

test("switching API providers refreshes dependent repo selectors without stale carryover", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await session.audit.reset();

        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        await selectPreferredOrFirstBranch(settings, secrets.github.branch);
        const githubRepoLabels = await settings.dropdownLabels("Repository");
        expect(githubRepoLabels).toContain(secrets.github.repo);

        await settings.selectSyncBackend("gitlab");
        await settings.fillText("Personal access token", secrets.gitlab.token, {
            sensitive: true,
        });
        await settings.fillText("API base URL", secrets.gitlab.baseUrl);
        await settings.fillText("Project path / ID", secrets.gitlab.projectId);
        await settings.waitForDropdownOption(
            "Project",
            secrets.gitlab.projectId
        );
        const gitlabProjectLabels = await settings.dropdownLabels("Project");
        expect(gitlabProjectLabels).toContain(secrets.gitlab.projectId);
        expect(gitlabProjectLabels).not.toContain(secrets.github.repo);
        expect(await settings.inputValue("Project path / ID")).toBe(
            secrets.gitlab.projectId
        );

        await settings.selectSyncBackend("gitea");
        await settings.fillText("Access token", secrets.gitea.token, {
            sensitive: true,
        });
        await settings.fillText("Server URL", secrets.gitea.baseUrl);
        await settings.fillText("Owner / namespace", secrets.gitea.owner);
        await settings.waitForDropdownOption(
            "Repository",
            secrets.gitea.repo,
            15_000
        );
        const giteaRepoLabels = await settings.dropdownLabels("Repository");
        expect(giteaRepoLabels).toContain(secrets.gitea.repo);
        expect(giteaRepoLabels).not.toContain(secrets.github.repo);

        await session.audit.assertClean();
    });
});

test("selected API repo and branch become the active runtime target without stale carryover", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        let selectedGitHubBranch = "";

        await settings.open();

        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        selectedGitHubBranch = await selectPreferredOrFirstBranch(
            settings,
            secrets.github.branch
        );
        await settings.dismissRemoteActionModalIfVisible();
        await expect
            .poll(
                async () => {
                    return session.page.evaluate(async (pluginId) => {
                        const plugin = (window as ObsidianWindowWithSyncManager)
                            .app?.plugins?.plugins?.[pluginId];
                        return {
                            provider: plugin?.settings?.activeSyncProvider,
                            selection:
                                (await plugin?.syncManager?.getBranchSelection?.()) ??
                                null,
                        };
                    }, PLUGIN_ID);
                },
                { timeout: 15_000 }
            )
            .toMatchObject({
                provider: "github",
                selection: {
                    current: selectedGitHubBranch,
                    branches: expect.arrayContaining([selectedGitHubBranch]),
                },
            });

        await settings.selectSyncBackend("gitlab");
        await settings.fillText("Personal access token", secrets.gitlab.token, {
            sensitive: true,
        });
        await settings.fillText("API base URL", secrets.gitlab.baseUrl);
        await settings.fillText("Project path / ID", secrets.gitlab.projectId);
        await settings.waitForDropdownOption("Branch", secrets.gitlab.branch);
        await settings.selectDropdown("Branch", secrets.gitlab.branch);
        await settings.dismissRemoteActionModalIfVisible();
        await expect
            .poll(
                async () => {
                    return session.page.evaluate(async (pluginId) => {
                        const plugin = (window as ObsidianWindowWithSyncManager)
                            .app?.plugins?.plugins?.[pluginId];
                        return {
                            provider: plugin?.settings?.activeSyncProvider,
                            selection:
                                (await plugin?.syncManager?.getBranchSelection?.()) ??
                                null,
                        };
                    }, PLUGIN_ID);
                },
                { timeout: 15_000 }
            )
            .toMatchObject({
                provider: "gitlab",
                selection: {
                    current: secrets.gitlab.branch,
                    branches: expect.arrayContaining([secrets.gitlab.branch]),
                },
            });

        await settings.selectSyncBackend("gitea");
        await settings.fillText("Access token", secrets.gitea.token, {
            sensitive: true,
        });
        await settings.fillText("Server URL", secrets.gitea.baseUrl);
        await settings.fillText("Owner / namespace", secrets.gitea.owner);
        await settings.clickExtraButton("Repository");
        await settings.waitForDropdownOption("Repository", secrets.gitea.repo);
        await settings.selectDropdown("Repository", secrets.gitea.repo);
        await settings.clickExtraButton("Branch");
        await settings.waitForDropdownOption("Branch", secrets.gitea.branch);
        await settings.selectDropdown("Branch", secrets.gitea.branch);
        await settings.dismissRemoteActionModalIfVisible();
        await installGiteaRuntimeProviderFixture(session.page);
        await expect
            .poll(
                async () => {
                    return session.page.evaluate(async (pluginId) => {
                        const plugin = (window as ObsidianWindowWithSyncManager)
                            .app?.plugins?.plugins?.[pluginId];
                        return {
                            provider: plugin?.settings?.activeSyncProvider,
                            selection:
                                (await plugin?.syncManager?.getBranchSelection?.()) ??
                                null,
                            githubRepo: plugin?.settings?.githubRepo,
                            gitlabProjectId: plugin?.settings?.gitlabProjectId,
                            giteaRepo: plugin?.settings?.giteaRepo,
                        };
                    }, PLUGIN_ID);
                },
                { timeout: 15_000 }
            )
            .toMatchObject({
                provider: "gitea",
                selection: {
                    current: secrets.gitea.branch,
                    branches: expect.arrayContaining([secrets.gitea.branch]),
                },
                githubRepo: secrets.github.repo,
                gitlabProjectId: secrets.gitlab.projectId,
                giteaRepo: secrets.gitea.repo,
            });

        await session.audit.assertClean();
    });
});

type ApiProviderScenario = {
    name: string;
    backend: "github" | "gitlab" | "gitea";
    setup: (settings: ProviderSettingsPage) => Promise<void>;
};

const apiProviders: ApiProviderScenario[] = [
    {
        name: "GitHub",
        backend: "github",
        setup: async (settings) => {
            await settings.fillText(
                "Personal access token",
                secrets.github.token,
                {
                    sensitive: true,
                }
            );
            await settings.fillText(
                "Owner / organization",
                secrets.github.owner
            );
            await settings.waitForDropdownOption(
                "Repository",
                secrets.github.repo
            );
            await settings.selectDropdown("Repository", secrets.github.repo);
            await selectPreferredOrFirstBranch(settings, secrets.github.branch);
            await settings.disableApiEncryptionForTest();
            await settings.saveAndReloadSyncManager();
        },
    },
    {
        name: "GitLab",
        backend: "gitlab",
        setup: async (settings) => {
            await settings.fillText(
                "Personal access token",
                secrets.gitlab.token,
                {
                    sensitive: true,
                }
            );
            await settings.fillText("API base URL", secrets.gitlab.baseUrl);
            await settings.fillText(
                "Project path / ID",
                secrets.gitlab.projectId
            );
            await settings.waitForDropdownOption(
                "Branch",
                secrets.gitlab.branch
            );
            await settings.selectDropdown("Branch", secrets.gitlab.branch);
            await settings.disableApiEncryptionForTest();
            await settings.saveAndReloadSyncManager();
        },
    },
    {
        name: "Gitea",
        backend: "gitea",
        setup: async (settings) => {
            await settings.fillText("Access token", secrets.gitea.token, {
                sensitive: true,
            });
            await settings.fillText("Server URL", secrets.gitea.baseUrl);
            await settings.fillText("Owner / namespace", secrets.gitea.owner);
            await selectPreferredOrFirstRepository(
                settings,
                secrets.gitea.repo
            );
            await selectPreferredOrFirstBranch(settings, secrets.gitea.branch);
            await settings.disableApiEncryptionForTest();
            await settings.saveAndReloadSyncManager();
        },
    },
];

for (const { name, backend, setup } of apiProviders) {
    test(`${name} API enters sync from simple mode without runtime failures`, async () => {
        test.setTimeout(180_000);

        await withVault(async ({ session }) => {
            const settings = new ProviderSettingsPage(session.page);

            await settings.open();
            await setSyncMode(session.page, "simple");
            await settings.selectSyncBackend(backend);
            await setup(settings);
            if (backend === "gitea") {
                await installGiteaRuntimeProviderFixture(session.page);
            }
            await settings.dismissRemoteActionModalIfVisible();
            await removeVaultFile(session.page, "README.md");
            await settings.close();

            const beforeSync = await getRuntimeSyncSnapshot(session.page);
            await session.audit.reset();

            await triggerSimpleModeSyncFromUi(session.page);

            await expect
                .poll(() => getRuntimeSyncSnapshot(session.page), {
                    timeout: 120_000,
                })
                .toMatchObject({
                    lastError: null,
                });
            await expect
                .poll(
                    async () =>
                        (await getRuntimeSyncSnapshot(session.page)).syncCount,
                    {
                        timeout: 120_000,
                    }
                )
                .toBeGreaterThan(beforeSync.syncCount);

            await session.audit.assertNoUnexpectedRendererErrors();
            await session.audit.assertNoUnexpectedWarnings();
            await session.audit.assertNoCriticalRequestFailures();
        });
    });
}

test("Git provider enters sync from simple mode against a local bare remote", async () => {
    test.setTimeout(180_000);

    await withVault(async ({ vault, session }) => {
        const settings = new ProviderSettingsPage(session.page);
        const localRemote = createLocalBareGitRemote(vault.vaultPath);

        try {
            await writeVaultFile(
                session.page,
                "local-sync-note.md",
                "# Git simple mode sync\n\nThis file is committed by the E2E suite.\n"
            );

            await settings.open();
            await setSyncMode(session.page, "simple");
            await settings.selectSyncBackend("git");
            await expect
                .poll(() => settings.inputValue("Remote URL"))
                .toBe(localRemote.remotePath);
            await settings.clickExtraButton("Upstream branch");
            await settings.waitForDropdownOption(
                "Upstream branch",
                `${secrets.git.remoteName}/${secrets.git.branch}`
            );
            await expect
                .poll(async () => {
                    return session.page.evaluate(async (pluginId) => {
                        const plugin = (
                            window as ObsidianWindow<
                                ObsidianPlugin & {
                                    gitManager?: {
                                        branchInfo?: () => Promise<{
                                            tracking?: string;
                                        }>;
                                    };
                                }
                            >
                        ).app?.plugins?.plugins?.[pluginId];
                        return (
                            (await plugin?.gitManager?.branchInfo?.())
                                ?.tracking ?? null
                        );
                    }, PLUGIN_ID);
                })
                .toBe(`${secrets.git.remoteName}/${secrets.git.branch}`);
            await settings.saveAndReloadSyncManager();
            await settings.close();
            await openSourceControlView(session.page);
            await expect(
                session.page.locator(".git-vault-sync-btn").first()
            ).toBeVisible();

            await session.audit.reset();

            const syncButton = session.page
                .locator(".git-vault-sync-btn")
                .first();
            await expect(syncButton).toBeEnabled({ timeout: 30_000 });
            await syncButton.click();

            await expectSyncAuditLogs(session, [
                "[Git Vault][audit][ui.simple-sync] click.sync",
                "[Git Vault][audit][manager] sync.enqueue",
            ]);

            await session.audit.assertNoUnexpectedRendererErrors();
            await session.audit.assertNoUnexpectedWarnings();
            await session.audit.assertNoCriticalRequestFailures();
        } finally {
            localRemote.cleanup();
        }
    });
});

test("simple mode sync opens the conflict resolver when the provider returns a conflict", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        await selectPreferredOrFirstBranch(settings, secrets.github.branch);
        await settings.dismissRemoteActionModalIfVisible();
        await setSyncMode(session.page, "simple");
        await installConflictFixtureOnNextSync(session.page, "github");
        await session.audit.reset();

        await openSourceControlView(session.page);
        await expect(
            session.page.locator(".git-vault-sync-btn").first()
        ).toBeVisible();

        expect(await runSyncNowWithTimeout(session.page)).toBe("completed");
        await expect(
            session.page.locator(".git-vault-conflict-modal").first()
        ).toBeVisible({ timeout: 30_000 });
        await expect(
            session.page.getByText("Resolve Merge Conflicts", { exact: false })
        ).toBeVisible();
        await expect(
            session.page.getByRole("button", { name: "Keep Local" })
        ).toBeVisible();
        await expect(
            session.page.getByRole("button", { name: "Keep Remote" })
        ).toBeVisible();

        await session.audit.assertNoUnexpectedRendererErrors();
        await session.audit.assertNoUnexpectedWarnings();
        await session.audit.assertNoCriticalRequestFailures();
    });
});

test("simple mode sync applies conflict resolution from the workspace resolver", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        await selectPreferredOrFirstBranch(settings, secrets.github.branch);
        await settings.dismissRemoteActionModalIfVisible();
        await setSyncMode(session.page, "simple");
        await installConflictFixtureOnNextSync(session.page, "github", {
            resolveConflicts: true,
        });
        await session.audit.reset();

        await triggerSimpleModeSyncFromUi(session.page);
        const modal = session.page.locator(".git-vault-conflict-modal").first();
        await expect(modal).toBeVisible({ timeout: 30_000 });
        await modal.getByRole("button", { name: "Keep Remote" }).click();
        await expect(
            modal.getByText("All conflicts resolved", { exact: false })
        ).toBeVisible();
        await modal.getByRole("button", { name: "Apply Resolutions" }).click();
        await expect(modal).toBeHidden({ timeout: 30_000 });

        await expect
            .poll(() => getRuntimeSyncSnapshot(session.page), {
                timeout: 30_000,
            })
            .toMatchObject({ conflicts: 0, lastError: null });
        await expect
            .poll(() =>
                session.page.evaluate(() => {
                    const testWindow = window as typeof window & {
                        __syncProLastConflictResolutions?: Array<{
                            path: string;
                            strategy: string;
                        }>;
                    };
                    return testWindow.__syncProLastConflictResolutions ?? [];
                })
            )
            .toEqual([
                {
                    path: "conflicts/demo.md",
                    strategy: "always-remote",
                },
            ]);

        await session.audit.assertNoUnexpectedRendererErrors();
        await session.audit.assertNoUnexpectedWarnings();
        await session.audit.assertNoCriticalRequestFailures();
    });
});

test("simple mode sync surfaces a remote-unavailable error without blocking the workspace", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        await selectPreferredOrFirstBranch(settings, secrets.github.branch);
        await settings.dismissRemoteActionModalIfVisible();
        await setSyncMode(session.page, "simple");
        await installRemoteUnavailableFixtureOnNextSync(session.page, "github");
        await session.audit.reset();

        await openSourceControlView(session.page);
        const syncButton = session.page.locator(".git-vault-sync-btn").first();
        await expect(syncButton).toBeVisible({ timeout: 30_000 });
        await expect(syncButton).toBeEnabled({ timeout: 30_000 });
        await syncButton.click();
        await expect
            .poll(
                async () =>
                    (await getRuntimeSyncSnapshot(session.page)).lastError,
                { timeout: 30_000 }
            )
            .toBe("simulated remote unavailable");
        await expect(
            session.page.locator(".git-vault-status-text").first()
        ).toContainText("Error: simulated remote unavailable");
        await expect(
            session.page.locator(".git-vault-sync-btn").first()
        ).toBeEnabled();

        await session.audit.assertNoUnexpectedRendererErrors();
        await session.audit.assertNoUnexpectedWarnings();
        await session.audit.assertNoCriticalRequestFailures();
    });
});

test("switching away from configured providers and back preserves provider-specific values", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        let selectedGitHubBranch = "";

        await settings.open();
        await seedAllProviderConfigs(session.page, secrets);
        await session.audit.reset();

        await settings.selectSyncBackend("git");
        await expect
            .poll(() => settings.inputValue("Remote name"))
            .toBe(secrets.git.remoteName);
        await expect
            .poll(() => settings.inputValue("Remote URL"))
            .toBe(secrets.git.repoUrl);
        await settings.expectSettingHidden("Owner / organization");
        await settings.expectSettingHidden("API base URL");
        await settings.expectSettingHidden("Server URL");

        await settings.selectSyncBackend("github");
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.waitForDropdownOption("Branch", secrets.github.branch);
        selectedGitHubBranch = await settings.inputValue("Branch");
        expect(await settings.inputValue("Owner / organization")).toBe(
            secrets.github.owner
        );
        expect(await settings.inputValue("Repository")).toBe(
            secrets.github.repo
        );
        expect(await settings.inputValue("Branch")).toBe(selectedGitHubBranch);
        await settings.expectSettingHidden("Remote URL");
        await settings.expectSettingHidden("API base URL");
        await settings.expectSettingHidden("Server URL");

        await settings.selectSyncBackend("gitlab");
        await settings.waitForDropdownOption("Branch", secrets.gitlab.branch);
        expect(await settings.inputValue("API base URL")).toBe(
            secrets.gitlab.baseUrl
        );
        expect(await settings.inputValue("Project path / ID")).toBe(
            secrets.gitlab.projectId
        );
        expect(await settings.inputValue("Branch")).toBe(secrets.gitlab.branch);
        await settings.expectSettingHidden("Remote URL");
        await settings.expectSettingHidden("Owner / organization");
        await settings.expectSettingHidden("Server URL");

        await installGiteaSettingsApiFixture(session.page);
        await settings.selectSyncBackend("gitea");
        await settings.waitForDropdownOption("Repository", secrets.gitea.repo);
        await settings.waitForDropdownOption("Branch", secrets.gitea.branch);
        expect(await settings.inputValue("Server URL")).toBe(
            secrets.gitea.baseUrl
        );
        expect(await settings.inputValue("Owner / namespace")).toBe(
            secrets.gitea.owner
        );
        expect(await settings.inputValue("Repository")).toBe(
            secrets.gitea.repo
        );
        expect(await settings.inputValue("Branch")).toBe(secrets.gitea.branch);
        await settings.expectSettingHidden("Remote URL");
        await settings.expectSettingHidden("Owner / organization");
        await settings.expectSettingHidden("API base URL");

        // Switch back through the previously configured providers to verify
        // values are preserved and not contaminated by later selections.
        await settings.selectSyncBackend("github");
        await expect
            .poll(() => settings.inputValue("Owner / organization"))
            .toBe(secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await expect
            .poll(() => settings.inputValue("Repository"))
            .toBe(secrets.github.repo);
        await settings.waitForDropdownOption("Branch", selectedGitHubBranch);
        await expect
            .poll(() => settings.inputValue("Branch"))
            .toBe(selectedGitHubBranch);

        await settings.selectSyncBackend("git");
        await expect
            .poll(() => settings.inputValue("Remote name"))
            .toBe(secrets.git.remoteName);
        await expect
            .poll(() => settings.inputValue("Remote URL"))
            .toBe(secrets.git.repoUrl);

        await session.audit.assertClean();
    });
});

test("source control branch surfaces stay coherent across providers", async () => {
    await withVault(async ({ vault, session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();
        await session.audit.reset();

        const scenarios: Array<{
            provider: "git" | "github" | "gitlab" | "gitea";
            expectedBranch: () => string | Promise<string>;
            setup: () => Promise<void>;
            gitOnly: boolean;
        }> = [
            {
                provider: "git",
                expectedBranch: () =>
                    execFileSync("git", ["branch", "--show-current"], {
                        cwd: vault.vaultPath,
                        encoding: "utf8",
                    }).trim(),
                setup: async () => {
                    await settings.selectSyncBackend("git");
                    await expect
                        .poll(() => settings.inputValue("Remote name"))
                        .toBe(secrets.git.remoteName);
                    await expect
                        .poll(() => settings.inputValue("Remote URL"))
                        .toBe(secrets.git.repoUrl);
                },
                gitOnly: true,
            },
            {
                provider: "github",
                expectedBranch: async () => await settings.inputValue("Branch"),
                setup: async () => {
                    await settings.selectSyncBackend("github");
                    await settings.fillText(
                        "Personal access token",
                        secrets.github.token,
                        { sensitive: true }
                    );
                    await settings.fillText(
                        "Owner / organization",
                        secrets.github.owner
                    );
                    await settings.waitForDropdownOption(
                        "Repository",
                        secrets.github.repo
                    );
                    await settings.selectDropdown(
                        "Repository",
                        secrets.github.repo
                    );
                    await selectPreferredOrFirstBranch(
                        settings,
                        secrets.github.branch
                    );
                    await settings.dismissRemoteActionModalIfVisible();
                },
                gitOnly: false,
            },
            {
                provider: "gitlab",
                expectedBranch: async () => await settings.inputValue("Branch"),
                setup: async () => {
                    await settings.selectSyncBackend("gitlab");
                    await settings.fillText(
                        "Personal access token",
                        secrets.gitlab.token,
                        { sensitive: true }
                    );
                    await settings.fillText(
                        "API base URL",
                        secrets.gitlab.baseUrl
                    );
                    await settings.fillText(
                        "Project path / ID",
                        secrets.gitlab.projectId
                    );
                    await settings.waitForDropdownOption(
                        "Branch",
                        secrets.gitlab.branch
                    );
                    await settings.selectDropdown(
                        "Branch",
                        secrets.gitlab.branch
                    );
                    await settings.dismissRemoteActionModalIfVisible();
                },
                gitOnly: false,
            },
            {
                provider: "gitea",
                expectedBranch: async () => await settings.inputValue("Branch"),
                setup: async () => {
                    await settings.selectSyncBackend("gitea");
                    await settings.fillText(
                        "Access token",
                        secrets.gitea.token,
                        { sensitive: true }
                    );
                    await settings.fillText(
                        "Server URL",
                        secrets.gitea.baseUrl
                    );
                    await settings.fillText(
                        "Owner / namespace",
                        secrets.gitea.owner
                    );
                    await settings.clickExtraButton("Repository");
                    await settings.waitForDropdownOption(
                        "Repository",
                        secrets.gitea.repo
                    );
                    await settings.selectDropdown(
                        "Repository",
                        secrets.gitea.repo
                    );
                    await settings.waitForDropdownOption(
                        "Branch",
                        secrets.gitea.branch
                    );
                    await settings.selectDropdown(
                        "Branch",
                        secrets.gitea.branch
                    );
                    await settings.dismissRemoteActionModalIfVisible();
                },
                gitOnly: false,
            },
        ];

        for (const scenario of scenarios) {
            await settings.open();
            await scenario.setup();
            await settings.dismissRemoteActionModalIfVisible();
            const expectedBranch = await scenario.expectedBranch();
            await session.page.evaluate(
                async ({ pluginId }) => {
                    const plugin = (
                        window as typeof window & {
                            app?: {
                                plugins?: {
                                    plugins?: Record<
                                        string,
                                        {
                                            branchBar?: {
                                                display?: () => Promise<void> | void;
                                            };
                                        }
                                    >;
                                };
                            };
                        }
                    ).app?.plugins?.plugins?.[pluginId];
                    await plugin?.branchBar?.display?.();
                },
                { pluginId: PLUGIN_ID }
            );

            await openSourceControlView(session.page);
            const statusBar = session.page.locator(
                '[data-git-vault-branch-status="true"]'
            );
            await expect(statusBar).toBeVisible();
            await expect(statusBar).toContainText(expectedBranch);

            const branchSelector = session.page
                .locator('[data-git-vault-branch-selector="true"]')
                .first();
            await expect(branchSelector).toBeVisible();
            expect(
                await branchSelector.getAttribute(
                    "data-git-vault-current-branch"
                )
            ).toBe(expectedBranch);
            await expect
                .poll(
                    () =>
                        branchSelector.getAttribute(
                            "data-git-vault-branch-state"
                        ),
                    { timeout: 30_000 }
                )
                .toBe("ready");
            await expect(branchSelector).toBeEnabled();

            if (scenario.gitOnly) {
                await expect(session.page.locator("#backup-btn")).toHaveCount(
                    1
                );
                await expect(session.page.locator("#commit-btn")).toHaveCount(
                    1
                );
            }
        }

        await session.audit.assertClean();
    });
});

for (const { name, backend, setup } of apiProviders) {
    test(`${name} API use-selected-remote workflow offers new-target choices`, async () => {
        await withVault(async ({ vault, session }) => {
            forceUnrelatedGitRemote(vault.vaultPath);
            const settings = new ProviderSettingsPage(session.page);

            await settings.open();
            await session.audit.reset();

            await settings.selectSyncBackend(backend);
            await setup(settings);
            await expect
                .poll(() => getApiRemoteTargetDecision(session.page), {
                    timeout: 30_000,
                })
                .toMatchObject({ kind: "new-target" });
            await settings.clickButton("Use selected remote", "Choose action");
            await settings.waitForRemoteActionModal();
            await expect(
                session.page.getByRole("button", {
                    name: "Import into current vault",
                })
            ).toBeVisible();
            await expect(
                session.page.getByRole("button", {
                    name: "Clone as dedicated vault",
                })
            ).toBeVisible();
            await session.page.getByRole("button", { name: "Cancel" }).click();

            await session.audit.assertClean();
        });
    });
}

for (const { name, backend, setup } of apiProviders) {
    test(`${name} API use-selected-remote workflow offers update for the current linked vault`, async () => {
        await withVault(async ({ session }) => {
            const settings = new ProviderSettingsPage(session.page);

            await settings.open();
            await session.audit.reset();

            await settings.selectSyncBackend(backend);
            await setup(settings);
            await settings.dismissRemoteActionModalIfVisible();
            const currentFingerprint = await getCurrentTargetFingerprint(
                session.page
            );

            await session.page.evaluate(
                async ({ pluginId, fingerprint }) => {
                    const plugin = (
                        window as typeof window & {
                            app?: {
                                plugins?: {
                                    plugins?: Record<
                                        string,
                                        {
                                            settings?: Record<string, unknown>;
                                            saveSettings?: () => Promise<void>;
                                        }
                                    >;
                                };
                            };
                        }
                    ).app?.plugins?.plugins?.[pluginId];
                    if (!plugin?.settings || !plugin.saveSettings) {
                        throw new Error("Git Vault plugin not available");
                    }
                    plugin.settings.lastSyncedRepoFingerprint = fingerprint;
                    await plugin.saveSettings();
                },
                {
                    pluginId: PLUGIN_ID,
                    fingerprint: currentFingerprint,
                }
            );
            await expect
                .poll(() => getApiRemoteTargetDecision(session.page))
                .toMatchObject({
                    kind: "current-vault-linked",
                });

            await settings.clickButton("Use selected remote", "Choose action");
            await settings.waitForRemoteActionModal();
            await expect(
                session.page.getByRole("button", {
                    name: "Update this vault",
                })
            ).toBeVisible();
            await expect(
                session.page.getByRole("button", {
                    name: "Forget encryption binding",
                })
            ).toBeVisible();
            await expect(
                session.page.getByRole("button", {
                    name: "Open existing vault",
                })
            ).toHaveCount(0);
            await expect(
                session.page.getByRole("button", {
                    name: "Clone as dedicated vault",
                })
            ).toHaveCount(0);
            await session.page.getByRole("button", { name: "Cancel" }).click();

            await session.audit.assertClean();
        });
    });
}

for (const { name, backend, setup } of apiProviders) {
    test(`${name} API import into current vault bootstraps a baseline and then updates as the linked vault`, async () => {
        test.setTimeout(180_000);
        await withVault(async ({ vault, session }) => {
            forceUnrelatedGitRemote(vault.vaultPath);
            const settings = new ProviderSettingsPage(session.page);

            await settings.open();
            await session.audit.reset();
            await removeVaultFile(session.page, "README.md");

            await settings.selectSyncBackend(backend);
            await setup(settings);
            await settings.dismissRemoteActionModalIfVisible();
            const expectedFingerprint = await getCurrentTargetFingerprint(
                session.page
            );

            await settings.chooseRemoteAction("Import into current vault");

            await expect
                .poll(
                    () => {
                        const fingerprint = readPluginData(
                            vault.vaultPath
                        ).lastSyncedRepoFingerprint;
                        return typeof fingerprint === "string"
                            ? fingerprint
                            : "";
                    },
                    {
                        timeout: 120_000,
                    }
                )
                .toBe(expectedFingerprint);
            await expect
                .poll(() => getRuntimeSyncSnapshot(session.page), {
                    timeout: 120_000,
                })
                .toMatchObject({
                    lastError: null,
                    conflicts: 0,
                });

            await expectVaultToMatchActiveApiRemote(
                session.page,
                vault.vaultPath,
                {
                    ignoreRelativePaths: [".obsidian", ".gitignore"],
                }
            );
            await settings.dismissRemoteActionModalIfVisible();

            const hardenedGitignore = fs.readFileSync(
                path.join(vault.vaultPath, ".gitignore"),
                "utf8"
            );
            expect(hardenedGitignore).toContain(
                ".obsidian/plugins/git-vault/data.json"
            );

            const syncCountBeforeUpdate = (
                await getRuntimeSyncSnapshot(session.page)
            ).syncCount;

            await expect
                .poll(() => getApiRemoteTargetDecision(session.page))
                .toMatchObject({ kind: "current-vault-linked" });
            await settings.chooseRemoteAction("Update this vault");

            await expect
                .poll(
                    async () =>
                        (await getRuntimeSyncSnapshot(session.page)).syncCount,
                    {
                        timeout: 120_000,
                    }
                )
                .toBeGreaterThan(syncCountBeforeUpdate);
            await expect
                .poll(() => getRuntimeSyncSnapshot(session.page), {
                    timeout: 120_000,
                })
                .toMatchObject({
                    lastError: null,
                    conflicts: 0,
                });

            await expectVaultToMatchActiveApiRemote(
                session.page,
                vault.vaultPath,
                {
                    ignoreRelativePaths: [".obsidian", ".gitignore"],
                }
            );

            await session.audit.assertClean();
        });
    });

    test(`${name} API advanced mode preserves API parity during import and update`, async () => {
        test.setTimeout(180_000);
        await withVault(async ({ vault, session }) => {
            forceUnrelatedGitRemote(vault.vaultPath);
            const settings = new ProviderSettingsPage(session.page);

            await setSyncMode(session.page, "advanced");
            await settings.open();
            await session.audit.reset();
            await removeVaultFile(session.page, "README.md");

            await settings.selectSyncBackend(backend);
            await setup(settings);
            await settings.dismissRemoteActionModalIfVisible();
            const expectedFingerprint = await getCurrentTargetFingerprint(
                session.page
            );

            await settings.chooseRemoteAction("Import into current vault");

            await expect
                .poll(
                    () => {
                        const fingerprint = readPluginData(
                            vault.vaultPath
                        ).lastSyncedRepoFingerprint;
                        return typeof fingerprint === "string"
                            ? fingerprint
                            : "";
                    },
                    {
                        timeout: 120_000,
                    }
                )
                .toBe(expectedFingerprint);
            await settings.dismissRemoteActionModalIfVisible();
            await expectApiAdvancedSourceControlChrome(session.page);
            await expectVaultToMatchActiveApiRemote(
                session.page,
                vault.vaultPath,
                {
                    ignoreRelativePaths: [".obsidian", ".gitignore"],
                }
            );

            const syncCountBeforeUpdate = (
                await getRuntimeSyncSnapshot(session.page)
            ).syncCount;

            await settings.open();
            await settings.dismissRemoteActionModalIfVisible();
            await expect
                .poll(() => getApiRemoteTargetDecision(session.page))
                .toMatchObject({ kind: "current-vault-linked" });
            await settings.chooseRemoteAction("Update this vault");

            await expect
                .poll(
                    async () =>
                        (await getRuntimeSyncSnapshot(session.page)).syncCount,
                    {
                        timeout: 120_000,
                    }
                )
                .toBeGreaterThan(syncCountBeforeUpdate);
            await expectApiAdvancedSourceControlChrome(session.page);
            await expectVaultToMatchActiveApiRemote(
                session.page,
                vault.vaultPath,
                {
                    ignoreRelativePaths: [".obsidian", ".gitignore"],
                }
            );

            await session.audit.assertClean();
        });
    });

    test(`${name} API advanced mode push and pull buttons execute audited provider actions`, async () => {
        // Extended to 300s: the test now waits for push/pull runtime sync
        // counters and performs two-stage file checks.
        test.setTimeout(300_000);
        await withVault(async ({ vault, session }) => {
            forceUnrelatedGitRemote(vault.vaultPath);
            const settings = new ProviderSettingsPage(session.page);
            const runId = `${backend}-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
            const remotePathsToCleanup: string[] = [];

            try {
                await setSyncMode(session.page, "advanced");
                await settings.open();
                await session.audit.reset();
                await removeVaultFile(session.page, "README.md");
                await settings.selectSyncBackend(backend);
                await setup(settings);
                await settings.dismissRemoteActionModalIfVisible();

                // Wait for the sync manager to be fully ready after setup() called
                // saveAndReloadSyncManager(). Without this guard the manager may
                // still be in a transitional state when chooseRemoteAction fires,
                // causing the import to be silently discarded.
                await expect
                    .poll(() => getApiRemoteTargetDecision(session.page), {
                        timeout: 30_000,
                    })
                    .not.toBeNull();

                const expectedFingerprint = await getCurrentTargetFingerprint(
                    session.page
                );
                await settings.chooseRemoteAction("Import into current vault");

                // A "Complete secure setup" modal may appear after the action is
                // triggered and block the import from proceeding. Dismiss it so
                // the import can run.
                await handleSecureSetupModalIfVisible(session.page, "later");

                await expect
                    .poll(
                        () => {
                            const fingerprint = readPluginData(
                                vault.vaultPath
                            ).lastSyncedRepoFingerprint;
                            return typeof fingerprint === "string"
                                ? fingerprint
                                : "";
                        },
                        {
                            timeout: 120_000,
                        }
                    )
                    .toBe(expectedFingerprint);

                await settings.dismissRemoteActionModalIfVisible();
                await settings.close();
                await expectApiAdvancedSourceControlChrome(session.page);

                const localPushPath = `${runId}-advanced-push.md`;
                const localPushContent = `advanced push ${backend} ${Date.now()}`;
                remotePathsToCleanup.push(localPushPath);
                await writeVaultFile(
                    session.page,
                    localPushPath,
                    localPushContent
                );

                await session.audit.reset();
                await triggerAdvancedPushFromUi(session.page);

                await expect
                    .poll(
                        () =>
                            readActiveApiRemoteTextFile(
                                session.page,
                                localPushPath
                            ),
                        { timeout: 120_000 }
                    )
                    .toBe(localPushContent);
                await expectSyncAuditLogs(session, [
                    "[Git Vault][audit][manager] push.enqueue",
                    "[Git Vault][audit][manager] push:start",
                    `[Git Vault][audit][provider.${backend}] push:start`,
                    `[Git Vault][audit][provider.${backend}] push:success`,
                    "[Git Vault][audit][manager] push:success",
                ]);

                const remotePullPath = `${runId}-advanced-pull.md`;
                const remotePullContent = `advanced pull ${backend} ${Date.now()}`;
                remotePathsToCleanup.push(remotePullPath);
                await commitActiveApiRemoteMutation(
                    session.page,
                    {
                        kind: "create",
                        path: remotePullPath,
                        content: remotePullContent,
                    },
                    `git-vault e2e advanced pull ${backend}`
                );
                await expect
                    .poll(
                        () =>
                            readActiveApiRemoteTextFile(
                                session.page,
                                remotePullPath
                            ),
                        { timeout: 120_000 }
                    )
                    .toBe(remotePullContent);

                // Flush any in-flight console events from prior operations
                // before resetting the audit. Playwright buffers console
                // messages asynchronously; a small evaluate round-trip drains
                // the bridge queue so that stale pull:success logs from the
                // earlier import don't contaminate the next expectSyncAuditLogs
                // check.
                await session.page.evaluate(() => undefined);
                await session.audit.reset();
                await triggerAdvancedPullFromUi(session.page);
                // triggerAdvancedPullFromUi waits for the runtime sync counter
                // to advance, so audit logs and file writes should already be
                // settled by the time we assert below.

                await expectSyncAuditLogs(session, [
                    "[Git Vault][audit][manager] pull.enqueue",
                    "[Git Vault][audit][manager] pull:start",
                    `[Git Vault][audit][provider.${backend}] pull:start`,
                    `[Git Vault][audit][provider.${backend}] pull:success`,
                    "[Git Vault][audit][manager] pull:success",
                ]);
                const pulledFilePath = path.join(
                    vault.vaultPath,
                    remotePullPath
                );

                // Primary check via Obsidian vault adapter — this exercises the
                // same path the plugin uses to write files and avoids any OS
                // filesystem path mismatch (case sensitivity, symlinks, etc.).
                await expect
                    .poll(
                        () =>
                            session.page.evaluate(
                                async ({ targetPath }) => {
                                    const app = (
                                        window as typeof window & {
                                            app?: {
                                                vault?: {
                                                    adapter?: {
                                                        exists?: (
                                                            path: string
                                                        ) => Promise<boolean>;
                                                    };
                                                };
                                            };
                                        }
                                    ).app;
                                    return (
                                        (await app?.vault?.adapter?.exists?.(
                                            targetPath
                                        )) ?? false
                                    );
                                },
                                { targetPath: remotePullPath }
                            ),
                        { timeout: 60_000 }
                    )
                    .toBe(true);

                // Secondary check via Node.js fs to confirm the file is visible
                // at the expected filesystem path.
                await expect
                    .poll(() => fs.existsSync(pulledFilePath), {
                        timeout: 30_000,
                    })
                    .toBe(true);
                expect(fs.readFileSync(pulledFilePath, "utf8")).toBe(
                    remotePullContent
                );

                await session.audit.assertClean();
            } finally {
                for (const remotePath of remotePathsToCleanup) {
                    await deleteActiveApiRemotePathIfExists(
                        session.page,
                        remotePath,
                        `git-vault e2e cleanup ${backend}`
                    ).catch(() => undefined);
                    if (backend === "github") {
                        await deleteGitHubRemotePathIfExists(
                            remotePath,
                            `git-vault e2e cleanup ${backend}`
                        );
                    }
                }
            }
        });
    });
}

test("GitHub API dedicated-vault clone bootstraps the cloned vault safely", async () => {
    test.setTimeout(180_000);
    await withVault(async ({ vault, session, replaceSession }) => {
        let activeSession = session;
        forceUnrelatedGitRemote(vault.vaultPath);
        const settings = new ProviderSettingsPage(activeSession.page);
        const dedicatedVaultRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "git-vault-dedicated-vault-")
        );
        const dedicatedVaultPath = path.join(
            dedicatedVaultRoot,
            "github-reference-slice"
        );

        try {
            await settings.open();
            await activeSession.audit.reset();

            await settings.selectSyncBackend("github");
            await settings.fillText(
                "Personal access token",
                secrets.github.token,
                {
                    sensitive: true,
                }
            );
            await settings.fillText(
                "Owner / organization",
                secrets.github.owner
            );
            await settings.waitForDropdownOption(
                "Repository",
                secrets.github.repo
            );
            await settings.selectDropdown("Repository", secrets.github.repo);
            await selectPreferredOrFirstBranch(settings, secrets.github.branch);
            const expectedFingerprintPrefix = `repo:github.com/${secrets.github.owner}/${secrets.github.repo}@`;

            await settings.chooseRemoteAction("Clone as dedicated vault");
            await submitGeneralPrompt(activeSession.page, dedicatedVaultPath);

            await expect
                .poll(
                    () =>
                        fs.existsSync(
                            path.join(
                                dedicatedVaultPath,
                                ".obsidian",
                                "plugins",
                                PLUGIN_ID,
                                "main.js"
                            )
                        ),
                    { timeout: 120_000 }
                )
                .toBe(true);
            await expect
                .poll(() => readRegisteredVaultPaths(vault.userDataDir), {
                    timeout: 120_000,
                })
                .toContain(dedicatedVaultPath);
            expect(readCommunityPlugins(dedicatedVaultPath)).toContain(
                PLUGIN_ID
            );

            const dedicatedData = readPluginData(dedicatedVaultPath);
            expect(dedicatedData.activeSyncProvider).toBe("github");
            const dedicatedFingerprint =
                dedicatedData.lastSyncedRepoFingerprint;
            expect(
                typeof dedicatedFingerprint === "string"
                    ? dedicatedFingerprint
                    : ""
            ).toMatch(
                new RegExp(
                    `^${expectedFingerprintPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
                )
            );
            expect(dedicatedData.githubToken).toBe("");
            expect(dedicatedData.vaultBootstrapPending).toBe(true);

            const dedicatedGitignore = fs.readFileSync(
                path.join(dedicatedVaultPath, ".gitignore"),
                "utf8"
            );
            expect(dedicatedGitignore).toContain(
                ".obsidian/plugins/git-vault/data.json"
            );

            const closeButton = activeSession.page.getByRole("button", {
                name: "Close",
            });
            if ((await closeButton.count()) > 0) {
                await closeButton.first().click();
            }

            const restartedSession = await relaunchObsidianApp(
                activeSession,
                dedicatedVaultPath,
                vault.userDataDir,
                secrets
            );
            replaceSession(restartedSession);
            activeSession = restartedSession;

            const openedSettingsFromBootstrap =
                await handleSecureSetupModalIfVisible(
                    activeSession.page,
                    "open-settings",
                    60_000
                );
            expect(openedSettingsFromBootstrap).toBe(true);
            await expect
                .poll(
                    () =>
                        readPluginData(dedicatedVaultPath)
                            .vaultBootstrapPending ?? false,
                    { timeout: 30_000 }
                )
                .toBe(false);

            const restartedSettings = new ProviderSettingsPage(
                activeSession.page
            );
            await restartedSettings.expectSettingVisible(
                "Personal access token"
            );
            await restartedSettings.expectSettingVisible("Repository");

            await activeSession.audit.assertClean();
        } finally {
            fs.rmSync(dedicatedVaultRoot, { recursive: true, force: true });
        }
    });
});

for (const { name, backend, setup } of apiProviders) {
    test(`${name} API use-selected-remote opens the registered matching vault`, async () => {
        await withVault(async ({ vault, session }) => {
            forceUnrelatedGitRemote(vault.vaultPath);
            const settings = new ProviderSettingsPage(session.page);
            const existingVaultPath = fs.mkdtempSync(
                path.join(os.tmpdir(), "git-vault-existing-vault-")
            );

            try {
                await settings.open();
                await session.audit.reset();

                await settings.selectSyncBackend(backend);
                await setup(settings);
                const currentDecision = await getApiRemoteTargetDecision(
                    session.page
                );
                await settings.dismissRemoteActionModalIfVisible();

                expect(currentDecision).not.toBeNull();
                expect(currentDecision).toHaveProperty("fingerprint");
                const currentFingerprint = currentDecision?.fingerprint;
                expect(currentFingerprint).toBeDefined();
                expect(typeof currentFingerprint).toBe("string");

                writePluginData(existingVaultPath, {
                    lastSyncedRepoFingerprint: currentFingerprint,
                });
                registerVaultPath(existingVaultPath, vault.userDataDir);
                await installWindowOpenSpy(session.page);

                await settings.dismissRemoteActionModalIfVisible();
                await settings.clickButton(
                    "Use selected remote",
                    "Choose action"
                );
                await expect(
                    session.page.getByRole("button", {
                        name: "Open existing vault",
                    })
                ).toBeVisible();
                await expect(
                    session.page.getByRole("button", {
                        name: "Open and update existing vault",
                    })
                ).toBeVisible();
                await settings.chooseRemoteAction("Open existing vault");
                const openedUrl = await waitForOpenedWindowUrl(
                    session.page,
                    /obsidian:\/\/open\?vault=/
                );
                expect(openedUrl).toContain("obsidian://open?vault=");

                await session.audit.assertClean();
            } finally {
                fs.rmSync(existingVaultPath, { recursive: true, force: true });
            }
        });
    });

    test(`${name} API queues update for the registered matching vault`, async () => {
        test.setTimeout(180_000);
        await withVault(async ({ vault, session }) => {
            forceUnrelatedGitRemote(vault.vaultPath);
            const settings = new ProviderSettingsPage(session.page);
            const existingVault = prepareTestVault(secrets);

            try {
                await settings.open();
                await session.audit.reset();

                await settings.selectSyncBackend(backend);
                await setup(settings);
                await settings.dismissRemoteActionModalIfVisible();
                const currentFingerprint = await getCurrentTargetFingerprint(
                    session.page
                );

                writePluginData(existingVault.vaultPath, {
                    ...readPluginData(vault.vaultPath),
                    activeSyncProvider: backend,
                    lastSyncedRepoFingerprint: currentFingerprint,
                });
                registerVaultPath(existingVault.vaultPath, vault.userDataDir);
                await installWindowOpenSpy(session.page);

                await settings.dismissRemoteActionModalIfVisible();
                await settings.chooseRemoteAction(
                    "Open and update existing vault"
                );
                const openedUrl = await waitForOpenedWindowUrl(
                    session.page,
                    /obsidian:\/\/open\?vault=/
                );
                expect(openedUrl).toContain("obsidian://open?vault=");

                await expect
                    .poll(
                        () => getPendingVaultSyncRequestSnapshot(session.page),
                        {
                            timeout: 30_000,
                        }
                    )
                    .toMatchObject({
                        action: "sync-existing-vault",
                        vaultPath: existingVault.vaultPath,
                        fingerprint: currentFingerprint,
                    });

                await session.audit.assertClean();
            } finally {
                await existingVault.cleanup().catch((cleanupError: unknown) => {
                    console.error(
                        "[E2E] existingVault.cleanup() failed:",
                        cleanupError instanceof Error
                            ? cleanupError.message
                            : String(cleanupError)
                    );
                });
            }
        });
    });
}

test("persists Git remote configuration across restart", async () => {
    test.setTimeout(150_000);
    await withVault(async ({ vault, session, replaceSession }) => {
        const settings = new ProviderSettingsPage(session.page);
        const updatedRemoteUrl = secrets.gitlab.repoUrl;

        await settings.open();
        await settings.selectSyncBackend("git");
        await expect
            .poll(() => settings.inputValue("Remote URL"))
            .toBe(secrets.git.repoUrl);
        // Wait for the Remote URL input to settle before filling; the Git
        // settings refresh briefly disables controls after backend selection.
        await settings.expectSettingVisible("Remote URL");
        await expect
            .poll(() => settings.isControlDisabled("Remote URL"), {
                timeout: 5_000,
            })
            .toBe(false);
        await settings.fillText("Remote URL", updatedRemoteUrl);
        await settings.clickButton("Remote URL", "Save remote");
        await expect
            .poll(
                () =>
                    gitRemoteUrlAsync(vault.vaultPath, secrets.git.remoteName),
                { timeout: 60_000 }
            )
            .toBe(updatedRemoteUrl);

        await session.audit.reset();
        const restartedSession = await relaunchObsidianApp(
            session,
            vault.vaultPath,
            vault.userDataDir,
            secrets
        );
        replaceSession(restartedSession);
        session = restartedSession;

        const restartedSettings = new ProviderSettingsPage(session.page);
        await restartedSettings.open();
        await restartedSettings.expectSettingVisible("Remote URL");
        await expect
            .poll(() => restartedSettings.inputValue("Remote URL"))
            .toBe(updatedRemoteUrl);
        expect(gitRemoteUrl(vault.vaultPath, secrets.git.remoteName)).toBe(
            updatedRemoteUrl
        );

        await session.audit.assertClean();
    });
});

test("rejects saving an empty Git remote URL without mutating the existing remote", async () => {
    await withVault(async ({ vault, session }) => {
        const settings = new ProviderSettingsPage(session.page);
        const initialRemoteUrl = gitRemoteUrl(
            vault.vaultPath,
            secrets.git.remoteName
        );

        await settings.open();
        await settings.selectSyncBackend("git");
        await expect
            .poll(() => settings.inputValue("Remote URL"))
            .toBe(secrets.git.repoUrl);
        // Wait for the Remote URL input to settle before clearing; the Git
        // settings refresh briefly disables controls after backend selection.
        await settings.expectSettingVisible("Remote URL");
        await expect
            .poll(
                async () => {
                    const before = await settings.inputValue("Remote URL");
                    await session.page.waitForTimeout(300);
                    const after = await settings.inputValue("Remote URL");
                    const disabled =
                        await settings.isControlDisabled("Remote URL");
                    return (
                        before === after &&
                        after === secrets.git.repoUrl &&
                        !disabled
                    );
                },
                { timeout: 10_000 }
            )
            .toBe(true);
        const remoteUrlRow = session.page
            .locator(".setting-item")
            .filter({
                has: session.page
                    .locator(".setting-item-name")
                    .filter({ hasText: /^Remote URL$/ }),
            })
            .filter({ visible: true })
            .first();
        const saveRemoteButton = remoteUrlRow.getByRole("button", {
            name: "Save remote",
        });
        await settings.fillText("Remote URL", "", { blur: false });
        await expect.poll(() => settings.inputValue("Remote URL")).toBe("");
        await saveRemoteButton.click();
        await expect
            .poll(
                async () => {
                    const inlineMessages = await session.page
                        .locator(".git-vault-remote-url-validation")
                        .allInnerTexts();
                    const noticeMessages = await session.page
                        .locator(".notice")
                        .allInnerTexts();
                    return [...inlineMessages, ...noticeMessages].some(
                        (message) =>
                            message.includes(
                                "Enter a remote URL before saving."
                            )
                    );
                },
                { timeout: 10_000 }
            )
            .toBe(true);
        await expect
            .poll(() =>
                gitRemoteUrlAsync(vault.vaultPath, secrets.git.remoteName)
            )
            .toBe(initialRemoteUrl);

        await session.audit.assertClean();
    });
});

test("persists GitHub API configuration and secret storage across restart", async () => {
    await withVault(async ({ vault, session, replaceSession }) => {
        const settings = new ProviderSettingsPage(session.page);
        const trackedDirectory = "provider-tests/github";
        const excludePaths = ".git/\nprivate/\n";
        let selectedGithubBranch = "";

        await settings.open();
        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, {
            sensitive: true,
        });
        await expect
            .poll(async () => {
                return (
                    (await getStoredProviderToken(session.page, "github")) ===
                    secrets.github.token
                );
            })
            .toBe(true);
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.waitForDropdownOption("Repository", secrets.github.repo);
        await settings.selectDropdown("Repository", secrets.github.repo);
        selectedGithubBranch = await selectPreferredOrFirstBranch(
            settings,
            secrets.github.branch
        );
        await settings.dismissRemoteActionModalIfVisible();
        expect(selectedGithubBranch.length).toBeGreaterThan(0);
        await settings.fillText("Tracked directory", trackedDirectory);
        await settings.fillTextArea("Excluded paths", excludePaths);
        await expect
            .poll(() => {
                const data = readPluginData(vault.vaultPath);
                return {
                    provider: data.activeSyncProvider,
                    owner: data.githubOwner,
                    repo: data.githubRepo,
                    branch: data.githubBranch,
                    tracked: data.trackedDirectory,
                };
            })
            .toMatchObject({
                provider: "github",
                owner: secrets.github.owner,
                repo: secrets.github.repo,
                branch: selectedGithubBranch,
                tracked: trackedDirectory,
            });

        await session.audit.reset();
        const restartedSession = await relaunchObsidianApp(
            session,
            vault.vaultPath,
            vault.userDataDir,
            secrets
        );
        replaceSession(restartedSession);
        session = restartedSession;

        const restartedSettings = new ProviderSettingsPage(session.page);
        await restartedSettings.open();
        expect(await restartedSettings.inputValue("Owner / organization")).toBe(
            secrets.github.owner
        );
        await restartedSettings.waitForDropdownOption(
            "Repository",
            secrets.github.repo
        );
        expect(await restartedSettings.inputValue("Repository")).toBe(
            secrets.github.repo
        );
        await restartedSettings.waitForDropdownOption(
            "Branch",
            selectedGithubBranch
        );
        expect(await restartedSettings.inputValue("Branch")).toBe(
            selectedGithubBranch
        );
        expect(await restartedSettings.inputValue("Tracked directory")).toBe(
            trackedDirectory
        );
        expect(
            (await restartedSettings.inputValue("Excluded paths")).trimEnd()
        ).toBe(excludePaths.trimEnd());
        expect(
            await session.page.evaluate(
                ({ token, pluginId }: { token: string; pluginId: string }) => {
                    const plugin = (window as ObsidianWindow<ObsidianPlugin>)
                        .app?.plugins?.plugins?.[pluginId];
                    return (
                        plugin?.providerSecrets?.getToken?.("github") === token
                    );
                },
                { token: secrets.github.token, pluginId: PLUGIN_ID }
            )
        ).toBe(true);

        const data = readPluginData(vault.vaultPath);
        expect(data.activeSyncProvider).toBe("github");
        expect(data.githubOwner).toBe(secrets.github.owner);
        expect(data.githubRepo).toBe(secrets.github.repo);
        expect(data.githubBranch).toBe(selectedGithubBranch);
        expect(data.trackedDirectory).toBe(trackedDirectory);
        expect(data.githubToken).toBe("");

        await session.audit.assertClean();
    });
});

test("reports incomplete GitHub API configuration without crashing the renderer", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await settings.installNoticeSpy();
        await setSyncMode(session.page, "simple");
        await settings.selectSyncBackend("github");
        await settings.expectNoticeVisible(
            /provider reload failed.*GitHub token is not configured/i
        );
        await settings.close();
        await openSourceControlView(session.page);
        const syncButton = session.page.locator(".git-vault-sync-btn").first();
        await expect(syncButton).toBeEnabled({ timeout: 30_000 });
        await syncButton.click();
        await settings.expectNoticeVisible(/no provider initialised/i);

        await session.audit.assertClean();
    });
});

test("persists GitLab API configuration and secret storage across restart", async () => {
    await withVault(async ({ vault, session, replaceSession }) => {
        const settings = new ProviderSettingsPage(session.page);
        const trackedDirectory = "provider-tests/gitlab";

        await settings.open();
        await settings.selectSyncBackend("gitlab");
        await settings.fillText("Personal access token", secrets.gitlab.token, {
            sensitive: true,
        });
        await expect
            .poll(async () => {
                return (
                    (await getStoredProviderToken(session.page, "gitlab")) ===
                    secrets.gitlab.token
                );
            })
            .toBe(true);
        await settings.fillText("API base URL", secrets.gitlab.baseUrl);
        await settings.fillText("Project path / ID", secrets.gitlab.projectId);
        await settings.waitForDropdownOption("Branch", secrets.gitlab.branch);
        await settings.selectDropdown("Branch", secrets.gitlab.branch);
        await settings.dismissRemoteActionModalIfVisible();
        await settings.fillText("Tracked directory", trackedDirectory);
        await expect
            .poll(() => {
                const data = readPluginData(vault.vaultPath);
                return {
                    provider: data.activeSyncProvider,
                    baseUrl: data.gitlabBaseUrl,
                    projectId: data.gitlabProjectId,
                    branch: data.gitlabBranch,
                    tracked: data.trackedDirectory,
                };
            })
            .toMatchObject({
                provider: "gitlab",
                baseUrl: secrets.gitlab.baseUrl,
                projectId: secrets.gitlab.projectId,
                branch: secrets.gitlab.branch,
                tracked: trackedDirectory,
            });

        await session.audit.reset();
        const restartedSession = await relaunchObsidianApp(
            session,
            vault.vaultPath,
            vault.userDataDir,
            secrets
        );
        replaceSession(restartedSession);
        session = restartedSession;

        const restartedSettings = new ProviderSettingsPage(session.page);
        await restartedSettings.open();
        expect(await restartedSettings.inputValue("API base URL")).toBe(
            secrets.gitlab.baseUrl
        );
        expect(await restartedSettings.inputValue("Project path / ID")).toBe(
            secrets.gitlab.projectId
        );
        await restartedSettings.waitForDropdownOption(
            "Branch",
            secrets.gitlab.branch
        );
        expect(await restartedSettings.inputValue("Branch")).toBe(
            secrets.gitlab.branch
        );
        expect(await restartedSettings.inputValue("Tracked directory")).toBe(
            trackedDirectory
        );
        expect(
            await session.page.evaluate(
                ({ token, pluginId }: { token: string; pluginId: string }) => {
                    const plugin = (window as ObsidianWindow<ObsidianPlugin>)
                        .app?.plugins?.plugins?.[pluginId];
                    return (
                        plugin?.providerSecrets?.getToken?.("gitlab") === token
                    );
                },
                { token: secrets.gitlab.token, pluginId: PLUGIN_ID }
            )
        ).toBe(true);

        const data = readPluginData(vault.vaultPath);
        expect(data.activeSyncProvider).toBe("gitlab");
        expect(data.gitlabBaseUrl).toBe(secrets.gitlab.baseUrl);
        expect(data.gitlabProjectId).toBe(secrets.gitlab.projectId);
        expect(data.gitlabBranch).toBe(secrets.gitlab.branch);
        expect(data.trackedDirectory).toBe(trackedDirectory);

        await session.audit.assertClean();
    });
});

test("reports incomplete GitLab API configuration without crashing the renderer", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await settings.installNoticeSpy();
        await setSyncMode(session.page, "simple");
        await settings.selectSyncBackend("gitlab");
        await settings.expectNoticeVisible(
            /provider reload failed.*GitLab token is not configured/i
        );
        await settings.close();
        await openSourceControlView(session.page);
        const syncButton = session.page.locator(".git-vault-sync-btn").first();
        await expect(syncButton).toBeEnabled({ timeout: 30_000 });
        await syncButton.click();
        await settings.expectNoticeVisible(/no provider initialised/i);

        await session.audit.assertClean();
    });
});

test("persists Gitea / Forgejo API configuration and secret storage across restart", async () => {
    await withVault(async ({ vault, session, replaceSession }) => {
        const settings = new ProviderSettingsPage(session.page);
        const trackedDirectory = "provider-tests/gitea";

        await settings.open();
        await settings.selectSyncBackend("gitea");
        await settings.fillText("Access token", secrets.gitea.token, {
            sensitive: true,
        });
        await expect
            .poll(async () => {
                return (
                    (await getStoredProviderToken(session.page, "gitea")) ===
                    secrets.gitea.token
                );
            })
            .toBe(true);
        await settings.fillText("Server URL", secrets.gitea.baseUrl);
        await settings.fillText("Owner / namespace", secrets.gitea.owner);
        await settings.clickExtraButton("Repository");
        await settings.waitForDropdownOption("Repository", secrets.gitea.repo);
        await settings.selectDropdown("Repository", secrets.gitea.repo);
        await settings.clickExtraButton("Branch");
        await settings.waitForDropdownOption("Branch", secrets.gitea.branch);
        await settings.selectDropdown("Branch", secrets.gitea.branch);
        await settings.dismissRemoteActionModalIfVisible();
        await settings.fillText("Tracked directory", trackedDirectory);
        await expect
            .poll(() => {
                const data = readPluginData(vault.vaultPath);
                return {
                    provider: data.activeSyncProvider,
                    baseUrl: data.giteaBaseUrl,
                    owner: data.giteaOwner,
                    repo: data.giteaRepo,
                    branch: data.giteaBranch,
                    tracked: data.trackedDirectory,
                };
            })
            .toMatchObject({
                provider: "gitea",
                baseUrl: secrets.gitea.baseUrl,
                owner: secrets.gitea.owner,
                repo: secrets.gitea.repo,
                branch: secrets.gitea.branch,
                tracked: trackedDirectory,
            });

        await session.audit.reset();
        const restartedSession = await relaunchObsidianApp(
            session,
            vault.vaultPath,
            vault.userDataDir,
            secrets
        );
        replaceSession(restartedSession);
        session = restartedSession;
        await installGiteaSettingsApiFixture(session.page);

        const restartedSettings = new ProviderSettingsPage(session.page);
        await restartedSettings.open();
        expect(await restartedSettings.inputValue("Server URL")).toBe(
            secrets.gitea.baseUrl
        );
        expect(await restartedSettings.inputValue("Owner / namespace")).toBe(
            secrets.gitea.owner
        );
        await restartedSettings.waitForDropdownOption(
            "Repository",
            secrets.gitea.repo
        );
        expect(await restartedSettings.inputValue("Repository")).toBe(
            secrets.gitea.repo
        );
        await restartedSettings.waitForDropdownOption(
            "Branch",
            secrets.gitea.branch
        );
        expect(await restartedSettings.inputValue("Branch")).toBe(
            secrets.gitea.branch
        );
        expect(await restartedSettings.inputValue("Tracked directory")).toBe(
            trackedDirectory
        );
        expect(
            await session.page.evaluate(
                ({ token, pluginId }: { token: string; pluginId: string }) => {
                    const plugin = (window as ObsidianWindow<ObsidianPlugin>)
                        .app?.plugins?.plugins?.[pluginId];
                    return (
                        plugin?.providerSecrets?.getToken?.("gitea") === token
                    );
                },
                { token: secrets.gitea.token, pluginId: PLUGIN_ID }
            )
        ).toBe(true);

        const data = readPluginData(vault.vaultPath);
        expect(data.activeSyncProvider).toBe("gitea");
        expect(data.giteaBaseUrl).toBe(secrets.gitea.baseUrl);
        expect(data.giteaOwner).toBe(secrets.gitea.owner);
        expect(data.giteaRepo).toBe(secrets.gitea.repo);
        expect(data.giteaBranch).toBe(secrets.gitea.branch);
        expect(data.trackedDirectory).toBe(trackedDirectory);

        await session.audit.assertClean();
    });
});

test("reports incomplete Gitea / Forgejo API configuration without crashing the renderer", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);

        await settings.open();
        await settings.installNoticeSpy();
        await setSyncMode(session.page, "simple");
        await settings.selectSyncBackend("gitea");
        await settings.expectNoticeVisible(
            /provider reload failed.*Gitea token is not configured/i
        );
        await settings.close();
        await openSourceControlView(session.page);
        const syncButton = session.page.locator(".git-vault-sync-btn").first();
        await expect(syncButton).toBeEnabled({ timeout: 30_000 });
        await syncButton.click();
        await settings.expectNoticeVisible(/no provider initialised/i);

        await session.audit.assertClean();
    });
});
