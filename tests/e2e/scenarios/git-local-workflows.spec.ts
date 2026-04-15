import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    PLUGIN_ID,
    ProviderSettingsPage,
    launchObsidianApp,
    openSourceControlView,
    prepareTestVault,
    readSecretsSafely,
    type LaunchedObsidian,
    type PreparedVault,
} from "../helpers/obsidian";

const secrets = readSecretsSafely();
const REMOTE_NAME = "origin";
const MAIN_BRANCH = secrets.git.branch || "main";
const FEATURE_BRANCH = "feature/e2e-branch-switch";

async function getWorkspaceLeafCount(
    page: Page,
    leafType: string
): Promise<number> {
    return page.evaluate((type) => {
        const app = (
            window as typeof window & {
                app?: {
                    workspace?: {
                        getLeavesOfType?: (type: string) => unknown[];
                    };
                };
            }
        ).app;
        return app?.workspace?.getLeavesOfType?.(type).length ?? 0;
    }, leafType);
}

test.describe("Git provider local bare-remote workflows", () => {
    test.setTimeout(180_000);

    test("switches branches from the plugin branch switcher and keeps upstream state coherent", async () => {
        await withLocalGitVault(async ({ vault, session }) => {
            const settings = new ProviderSettingsPage(session.page);
            await settings.open();
            await settings.selectSyncBackend("git");
            await settings.expectSettingVisible("Authentication status");
            await settings.clickExtraButton("Upstream branch");
            await settings.waitForDropdownOption(
                "Upstream branch",
                `${REMOTE_NAME}/${MAIN_BRANCH}`
            );

            await switchBranchFromPluginSwitcher(session.page, FEATURE_BRANCH);
            expect(
                gitOutput(vault.vaultPath, ["branch", "--show-current"])
            ).toBe(FEATURE_BRANCH);
            expect(
                fs.readFileSync(
                    path.join(vault.vaultPath, "branch-switch.md"),
                    "utf8"
                )
            ).toContain(FEATURE_BRANCH);
            expect(
                gitOutput(vault.vaultPath, [
                    "rev-parse",
                    "--abbrev-ref",
                    "@{upstream}",
                ])
            ).toBe(`${REMOTE_NAME}/${FEATURE_BRANCH}`);

            await switchBranchFromPluginSwitcher(session.page, MAIN_BRANCH);
            expect(
                gitOutput(vault.vaultPath, ["branch", "--show-current"])
            ).toBe(MAIN_BRANCH);
            expect(
                fs.readFileSync(
                    path.join(vault.vaultPath, "branch-switch.md"),
                    "utf8"
                )
            ).toContain(MAIN_BRANCH);

            await session.audit.assertClean();
        });
    });

    test("corrects wrong remote URL and upstream branch from Git settings", async () => {
        await withLocalGitVault(async ({ vault, session, remotePath }) => {
            const wrongRemoteRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), "git-vault-wrong-remote-")
            );
            const wrongRemotePath = path.join(wrongRemoteRoot, "wrong.git");
            execFileSync("git", ["init", "--bare", wrongRemotePath], {
                stdio: "ignore",
            });

            try {
                execFileSync(
                    "git",
                    ["remote", "set-url", REMOTE_NAME, wrongRemotePath],
                    { cwd: vault.vaultPath, stdio: "ignore" }
                );
                execFileSync(
                    "git",
                    [
                        "branch",
                        "--set-upstream-to",
                        `${REMOTE_NAME}/${FEATURE_BRANCH}`,
                        MAIN_BRANCH,
                    ],
                    { cwd: vault.vaultPath, stdio: "ignore" }
                );

                const settings = new ProviderSettingsPage(session.page);
                await settings.open();
                await settings.selectSyncBackend("git");
                await saveRemoteUrlFromGitSettings(
                    settings,
                    vault.vaultPath,
                    remotePath
                );

                await settings.clickExtraButton("Upstream branch");
                await settings.waitForDropdownOption(
                    "Upstream branch",
                    `${REMOTE_NAME}/${MAIN_BRANCH}`
                );
                await settings.selectDropdown(
                    "Upstream branch",
                    `${REMOTE_NAME}/${MAIN_BRANCH}`
                );
                await expect
                    .poll(() =>
                        gitOutputOrEmpty(vault.vaultPath, [
                            "rev-parse",
                            "--abbrev-ref",
                            "@{upstream}",
                        ])
                    )
                    .toBe(`${REMOTE_NAME}/${MAIN_BRANCH}`);

                await session.audit.assertClean();
            } finally {
                fs.rmSync(wrongRemoteRoot, { recursive: true, force: true });
            }
        });
    });

    test("switches a saved remote from HTTPS to SSH syntax without requiring an SSH handshake", async () => {
        await withLocalGitVault(async ({ vault, session }) => {
            const sshRemoteUrl =
                "git@example.invalid:redoracle/git-vault-e2e.git";
            const settings = new ProviderSettingsPage(session.page);

            await settings.open();
            await settings.selectSyncBackend("git");
            await settings.expectSettingVisible("Remote URL");
            await settings.expectSettingVisible("Authentication status");
            await saveRemoteUrlFromGitSettings(
                settings,
                vault.vaultPath,
                sshRemoteUrl
            );
            await session.audit.assertClean();
        });
    });

    test("surfaces local/remote divergence as a diagnosable Git conflict", async () => {
        await withLocalGitVault(async ({ vault, session, remotePath }) => {
            createDivergence(vault.vaultPath, remotePath);

            await openSourceControlView(session.page);
            const pullButton = session.page.locator("#pull");
            await expect(pullButton).toBeVisible({ timeout: 30_000 });
            await session.audit.reset();
            await pullButton.click();

            await expect
                .poll(() => gitOutput(vault.vaultPath, ["status", "--short"]), {
                    timeout: 60_000,
                })
                .toContain("conflict.md");
            expect(
                gitOutput(vault.vaultPath, ["status", "--porcelain"])
            ).toMatch(/^(UU|AA|DD|AU|UA) conflict\.md/m);

            await session.audit.assertClean({
                allowConsoleErrors: [
                    /CONFLICT/i,
                    /Automatic merge failed/i,
                    /Pull failed/i,
                    /Merge conflict/i,
                ],
                allowAppLogErrors: [
                    /CONFLICT/i,
                    /Automatic merge failed/i,
                    /Pull failed/i,
                    /Merge conflict/i,
                ],
            });
        });
    });

    test("opens changed files in split and unified diff workspace views", async () => {
        await withLocalGitVault(
            async ({ vault, session }) => {
                await openSourceControlView(session.page);
                await expect
                    .poll(() =>
                        gitOutput(vault.vaultPath, ["status", "--short"])
                    )
                    .toContain("split-view.md");

                const sourceControl = session.page
                    .locator('main[data-type="git-view"]')
                    .first();
                const changedFile = sourceControl
                    .locator('[data-path="split-view.md"]')
                    .first();
                await expect(changedFile).toBeVisible({ timeout: 30_000 });

                await setDiffStyle(session.page, "split");
                await changedFile.click();

                const splitDiff = session.page
                    .locator(".git-split-diff-view.git-diff")
                    .first();
                await expect(splitDiff).toBeVisible({ timeout: 30_000 });
                await expect(
                    splitDiff.locator(".cm-editor")
                ).toHaveCount(2);
                await expect(splitDiff).toContainText("original split text");
                await expect(splitDiff).toContainText("workspace split update");
                await expect
                    .poll(() => getWorkspaceLeafCount(session.page, "split-diff-view"))
                    .toBeGreaterThan(0);

                await setDiffStyle(session.page, "git_unified");
                await changedFile.click();

                const unifiedDiff = session.page
                    .locator(".git-diff")
                    .filter({
                        has: session.page.locator(".git-diff-header"),
                    })
                    .last();
                await expect(unifiedDiff).toBeVisible({ timeout: 30_000 });
                await expect(unifiedDiff.locator(".git-diff-title")).toContainText(
                    "split-view.md"
                );
                await expect(unifiedDiff.locator(".d2h-file-diff")).toBeVisible();
                await expect(unifiedDiff).toContainText("original split text");
                await expect(unifiedDiff).toContainText("workspace split update");
                await expect
                    .poll(() => getWorkspaceLeafCount(session.page, "diff-view"))
                    .toBeGreaterThan(0);

                await session.audit.assertClean();
            },
            {
                prepareRepo: ({ vault }) => {
                    writeAndCommit(
                        vault.vaultPath,
                        "split-view.md",
                        "original split text\n",
                        "add split view fixture"
                    );
                    fs.writeFileSync(
                        path.join(vault.vaultPath, "split-view.md"),
                        "original split text\nworkspace split update\n",
                        "utf8"
                    );
                },
            }
        );
    });

    test("updates local submodules during Git pull when submodule sync is enabled", async () => {
        await withLocalGitVault(
            async ({ vault, session }) => {
                const submodulePath = "vendor/submodule-fixture";
                const submoduleFilePath = path.join(
                    vault.vaultPath,
                    submodulePath,
                    "submodule-note.md"
                );

                const settings = new ProviderSettingsPage(session.page);
                await settings.open();
                await settings.selectSyncBackend("git");
                await settings.expectSettingVisible("Update submodules");
                await enableGitSubmoduleSync(session.page);

                const sourcePath = gitOutput(vault.vaultPath, [
                    "config",
                    "--file",
                    ".gitmodules",
                    `submodule.${submodulePath}.url`,
                ]);
                updateSubmoduleSource(
                    sourcePath,
                    "updated submodule content\n"
                );

                await openSourceControlView(session.page);
                await session.audit.reset();
                const pullButton = session.page.locator("#pull");
                await expect(pullButton).toBeVisible({ timeout: 30_000 });
                await pullButton.click();

                await expect
                    .poll(
                        () =>
                            fs.existsSync(submoduleFilePath)
                                ? fs.readFileSync(submoduleFilePath, "utf8")
                                : "",
                        { timeout: 60_000 }
                    )
                    .toBe("updated submodule content\n");
                expect(
                    gitOutput(vault.vaultPath, ["submodule", "status"])
                ).toContain(submodulePath);

                await session.audit.assertClean();
            },
            {
                launchEnv: {
                    GIT_ALLOW_PROTOCOL: "file",
                },
                prepareRepo: ({ vault, addCleanup }) => {
                    const source = createSubmoduleSource();
                    addCleanup(source.cleanup);
                    addSubmoduleToVault(vault.vaultPath, source.repoPath);
                },
            }
        );
    });
});

async function withLocalGitVault(
    run: (args: {
        vault: PreparedVault;
        session: LaunchedObsidian;
        remotePath: string;
    }) => Promise<void>,
    options: {
        launchEnv?: NodeJS.ProcessEnv;
        prepareRepo?: (args: {
            vault: PreparedVault;
            remotePath: string;
            addCleanup: (cleanup: () => void) => void;
        }) => void;
    } = {}
): Promise<void> {
    const vault = prepareTestVault(secrets);
    const { remotePath, cleanup: cleanupRemote } = createMultiBranchRemote(
        vault.vaultPath
    );
    const extraCleanups: Array<() => void> = [];
    let session: LaunchedObsidian | undefined;

    try {
        options.prepareRepo?.({
            vault,
            remotePath,
            addCleanup: (cleanup) => extraCleanups.push(cleanup),
        });
        session = await launchObsidianApp(
            vault.vaultPath,
            vault.userDataDir,
            secrets,
            options.launchEnv ? { env: options.launchEnv } : undefined
        );
        await run({ vault, session, remotePath });
    } finally {
        await session?.close().catch(() => undefined);
        await vault.cleanup().catch(() => undefined);
        for (const cleanup of extraCleanups.reverse()) {
            cleanup();
        }
        cleanupRemote();
    }
}

async function saveRemoteUrlFromGitSettings(
    settings: ProviderSettingsPage,
    vaultPath: string,
    remoteUrl: string
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await settings.fillText("Remote URL", remoteUrl);
            await expect
                .poll(() => settings.inputValue("Remote URL"), {
                    timeout: 10_000,
                })
                .toBe(remoteUrl);
            await settings.clickButton("Remote URL", "Save remote");
            await expect
                .poll(
                    () =>
                        gitOutput(vaultPath, [
                            "remote",
                            "get-url",
                            REMOTE_NAME,
                        ]),
                    { timeout: 10_000 }
                )
                .toBe(remoteUrl);
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to save remote URL ${remoteUrl}.`);
}

function createMultiBranchRemote(vaultPath: string): {
    remotePath: string;
    cleanup: () => void;
} {
    const remoteRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "git-vault-local-remote-")
    );
    const remotePath = path.join(remoteRoot, "vault-remote.git");
    execFileSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
    execFileSync("git", ["remote", "set-url", REMOTE_NAME, remotePath], {
        cwd: vaultPath,
        stdio: "ignore",
    });

    writeAndCommit(
        vaultPath,
        "branch-switch.md",
        `${MAIN_BRANCH}\n`,
        "main branch content"
    );
    execFileSync("git", ["push", "--set-upstream", REMOTE_NAME, MAIN_BRANCH], {
        cwd: vaultPath,
        stdio: "ignore",
    });

    execFileSync("git", ["checkout", "-b", FEATURE_BRANCH], {
        cwd: vaultPath,
        stdio: "ignore",
    });
    writeAndCommit(
        vaultPath,
        "branch-switch.md",
        `${FEATURE_BRANCH}\n`,
        "feature branch content"
    );
    execFileSync(
        "git",
        ["push", "--set-upstream", REMOTE_NAME, FEATURE_BRANCH],
        {
            cwd: vaultPath,
            stdio: "ignore",
        }
    );
    execFileSync("git", ["checkout", MAIN_BRANCH], {
        cwd: vaultPath,
        stdio: "ignore",
    });

    return {
        remotePath,
        cleanup: () => {
            fs.rmSync(remoteRoot, { recursive: true, force: true });
        },
    };
}

function createDivergence(vaultPath: string, remotePath: string): void {
    const peerPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-vault-peer-"));
    try {
        execFileSync("git", ["clone", remotePath, peerPath], {
            stdio: "ignore",
        });
        execFileSync("git", ["checkout", MAIN_BRANCH], {
            cwd: peerPath,
            stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Git Vault E2E"], {
            cwd: peerPath,
            stdio: "ignore",
        });
        execFileSync(
            "git",
            ["config", "user.email", "git-vault-e2e@example.invalid"],
            {
                cwd: peerPath,
                stdio: "ignore",
            }
        );
        writeAndCommit(
            peerPath,
            "conflict.md",
            "remote change\n",
            "remote conflict change"
        );
        execFileSync("git", ["push", REMOTE_NAME, MAIN_BRANCH], {
            cwd: peerPath,
            stdio: "ignore",
        });

        writeAndCommit(
            vaultPath,
            "conflict.md",
            "local change\n",
            "local conflict change"
        );
    } finally {
        fs.rmSync(peerPath, { recursive: true, force: true });
    }
}

function createSubmoduleSource(): {
    repoPath: string;
    cleanup: () => void;
} {
    const repoPath = fs.mkdtempSync(
        path.join(os.tmpdir(), "git-vault-submodule-")
    );
    execFileSync("git", ["init", "-b", MAIN_BRANCH], {
        cwd: repoPath,
        stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Git Vault E2E"], {
        cwd: repoPath,
        stdio: "ignore",
    });
    execFileSync(
        "git",
        ["config", "user.email", "git-vault-e2e@example.invalid"],
        {
            cwd: repoPath,
            stdio: "ignore",
        }
    );
    writeAndCommit(
        repoPath,
        "submodule-note.md",
        "initial submodule content\n",
        "initial submodule content"
    );

    return {
        repoPath,
        cleanup: () => fs.rmSync(repoPath, { recursive: true, force: true }),
    };
}

function addSubmoduleToVault(vaultPath: string, sourcePath: string): void {
    const submodulePath = "vendor/submodule-fixture";
    execGitEventually(vaultPath, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        sourcePath,
        submodulePath,
    ]);
    execGitEventually(vaultPath, [
        "config",
        "--file",
        ".gitmodules",
        `submodule.${submodulePath}.branch`,
        MAIN_BRANCH,
    ]);
    execGitEventually(vaultPath, ["add", ".gitmodules", submodulePath]);
    execGitEventually(vaultPath, ["commit", "-m", "add submodule fixture"]);
    execGitEventually(vaultPath, ["push", REMOTE_NAME, MAIN_BRANCH]);
}

function updateSubmoduleSource(repoPath: string, content: string): void {
    writeAndCommit(
        repoPath,
        "submodule-note.md",
        content,
        "update submodule content"
    );
}

async function enableGitSubmoduleSync(page: Page): Promise<void> {
    await page.evaluate(async (pluginId) => {
        const plugin = (
            window as typeof window & {
                app?: {
                    plugins?: {
                        plugins?: Record<
                            string,
                            {
                                settings?: {
                                    updateSubmodules?: boolean;
                                };
                                saveSettings?: () => Promise<void>;
                            }
                        >;
                    };
                };
            }
        ).app?.plugins?.plugins?.[pluginId];
        if (!plugin?.settings || !plugin.saveSettings) {
            throw new Error("Git Vault plugin settings are unavailable.");
        }
        plugin.settings.updateSubmodules = true;
        await plugin.saveSettings();
    }, PLUGIN_ID);
}

async function setDiffStyle(
    page: Page,
    diffStyle: "split" | "git_unified"
): Promise<void> {
    await page.evaluate(
        async ({ pluginId, nextDiffStyle }) => {
            const app = (
                window as typeof window & {
                    app?: {
                        workspace?: {
                            trigger?: (eventName: string) => void;
                        };
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    settings?: { diffStyle?: string };
                                    saveSettings?: () => Promise<void>;
                                }
                            >;
                        };
                    };
                }
            ).app;
            const plugin = app?.plugins?.plugins?.[pluginId];
            if (!plugin?.settings || !plugin.saveSettings) {
                throw new Error("Git Vault plugin settings are unavailable.");
            }
            plugin.settings.diffStyle = nextDiffStyle;
            await plugin.saveSettings();
            app?.workspace?.trigger?.("obsidian-git:refresh");
        },
        { pluginId: PLUGIN_ID, nextDiffStyle: diffStyle }
    );
}

function writeAndCommit(
    repoPath: string,
    filePath: string,
    content: string,
    message: string
): void {
    fs.writeFileSync(path.join(repoPath, filePath), content, "utf8");
    execGitEventually(repoPath, ["add", filePath]);
    execGitEventually(repoPath, ["commit", "-m", message]);
}

function execGitEventually(repoPath: string, args: string[]): void {
    const deadline = Date.now() + 5_000;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
            return;
        } catch (error) {
            lastError = error;
            sleepSync(100);
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`git ${args.join(" ")} failed`);
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function switchBranchFromPluginSwitcher(
    page: Page,
    branch: string
): Promise<void> {
    await openSourceControlView(page);
    await page.evaluate(async (pluginId) => {
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

        // Fail fast with a descriptive error when the plugin or branchBar
        // surface is not available rather than silently returning and
        // letting the test time out later on UI selectors.
        if (!plugin) {
            throw new Error(
                `Git Vault plugin instance not found: ${String(pluginId)}`
            );
        }
        const branchBar = plugin.branchBar;
        if (!branchBar) {
            throw new Error(
                `Git Vault branchBar is unavailable on plugin: ${String(pluginId)}`
            );
        }
        if (typeof branchBar.display !== "function") {
            throw new Error(
                `Git Vault branchBar.display is not a function for plugin: ${String(pluginId)}`
            );
        }

        await branchBar.display();
    }, PLUGIN_ID);

    const branchStatus = page.locator('[data-git-vault-branch-status="true"]');
    await expect(branchStatus).toBeVisible({ timeout: 30_000 });
    await branchStatus.click();

    const branchModal = page.locator('[data-git-vault-branch-modal="true"]');
    await expect(branchModal).toBeVisible({ timeout: 30_000 });
    await expect(branchModal.getByText(branch, { exact: true })).toBeVisible();
    await branchModal.getByText(branch, { exact: true }).click();
    await expect(branchModal).toBeHidden({ timeout: 30_000 });

    await expect
        .poll(
            () =>
                page.evaluate(async (pluginId) => {
                    const plugin = (
                        window as typeof window & {
                            app?: {
                                plugins?: {
                                    plugins?: Record<
                                        string,
                                        {
                                            syncManager?: {
                                                getBranchSelection?: () => Promise<{
                                                    current: string;
                                                }>;
                                            };
                                        }
                                    >;
                                };
                            };
                        }
                    ).app?.plugins?.plugins?.[pluginId];
                    return (
                        (await plugin?.syncManager?.getBranchSelection?.())
                            ?.current ?? ""
                    );
                }, PLUGIN_ID),
            { timeout: 30_000 }
        )
        .toBe(branch);
}

function gitOutput(repoPath: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}

function gitOutputOrEmpty(repoPath: string, args: string[]): string {
    try {
        return gitOutput(repoPath, args);
    } catch {
        return "";
    }
}
