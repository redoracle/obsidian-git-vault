import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import {
    PLUGIN_ID,
    launchObsidianApp,
    registerVaultPath,
    readRegisteredVaultPaths,
    ProviderSettingsPage,
    submitGeneralPrompt,
    openSourceControlView,
    type LaunchedObsidian,
    type PreparedVault,
    type ProviderSecretsFixture,
} from "../helpers/obsidian";

type DisposableGitHubRepo = {
    owner: string;
    repo: string;
    cloneUrl: string;
    defaultBranch: string;
};

type GitOnboardingSecrets = ProviderSecretsFixture & {
    github: ProviderSecretsFixture["github"] & {
        apiOwner: string;
    };
};

const SETTINGS_ORDER_WHEN_NOT_READY = [
    "Sync setup",
    "Interface mode",
    "Sync backend",
    "Git backend",
    "Git runtime",
    "Git setup guide",
    "Setup path",
    "Connection",
    "Repository status",
    "Remote name",
    "Remote URL",
    "Remote check",
    "Hosted HTTPS helper",
    "Base URL",
    "Owner / namespace path",
    "Repository",
    "Remote helper actions",
    "Authentication",
    "Authentication status",
    "Username",
    "Personal access token / password",
    "Repository setup",
    "Initialize and publish this vault",
    "Create private GitHub remote",
    "Clone an existing remote",
];

const SETTINGS_ORDER_WHEN_READY = [
    "Sync setup",
    "Interface mode",
    "Sync backend",
    "Git backend",
    "Git runtime",
    "Git setup guide",
    "Setup path",
    "Connection",
    "Repository status",
    "Remote URL",
    "Remote check",
    "Authentication",
    "Authentication status",
    "Username",
    "Personal access token / password",
];

test.describe("Git provider onboarding scenarios", () => {
    test.setTimeout(300_000);

    test("Scenario 1 - empty vault clones two repos into separate folders", async () => {
        const secrets = readGitOnboardingSecretsSafely();
        const vault = prepareEmptyObsidianVault("gitTest");
        let session: LaunchedObsidian | undefined;

        try {
            session = await launchObsidianApp(
                vault.vaultPath,
                vault.userDataDir,
                secrets
            );
            const settings = new ProviderSettingsPage(session.page);
            await settings.open();
            await settings.selectSyncBackend("git");
            await expectSettingsOrder(settings, SETTINGS_ORDER_WHEN_NOT_READY);
            await settings.expectSettingVisible("Clone an existing remote");

            await cloneIntoVaultFolderViaGitCommand(
                session.page,
                "https://github.com/redoracle/tor-gateway.git",
                "tor-gateway"
            );
            await expectGitRepoAt(path.join(vault.vaultPath, "tor-gateway"), {
                remoteUrl: "https://github.com/redoracle/tor-gateway.git",
                expectedBranch: "main",
            });
            expectSubmoduleState(path.join(vault.vaultPath, "tor-gateway"));

            expect(
                hasSshAvailable(),
                "Scenario 1 requires the redoracle SSH key/agent noted in secrets.txt so the SSH clone path is actually exercised."
            ).toBe(true);
            await cloneIntoVaultFolderViaGitCommand(
                session.page,
                "git@github.com:redoracle/nixos.git",
                "nixos"
            );
            await expectGitRepoAt(path.join(vault.vaultPath, "nixos"), {
                remoteUrl: "git@github.com:redoracle/nixos.git",
                expectedBranch: "master",
            });
            expectSubmoduleState(path.join(vault.vaultPath, "nixos"));

            expect(fs.existsSync(path.join(vault.vaultPath, "tor-gateway"))).toBe(
                true
            );
            expect(fs.existsSync(path.join(vault.vaultPath, "nixos"))).toBe(
                true
            );
            expect(readRegisteredVaultPaths(vault.userDataDir)).toContain(
                vault.vaultPath
            );

            await session.audit.assertClean({
                allowAppLogErrors: [
                    /No local Git repository is ready/i,
                    /Can't find a valid git repository/i,
                ],
            });
        } finally {
            await session?.close();
            await vault.cleanup();
        }
    });

    test("Scenario 2 - CLI-cloned repo opens as vault and syncs with GitHub PAT", async () => {
        const secrets = readGitOnboardingSecretsSafely();
        let disposableRepo: DisposableGitHubRepo | undefined;
        let vault: PreparedVault | undefined;
        let session: LaunchedObsidian | undefined;

        await withGitAskpass(secrets, async () => {
            try {
                disposableRepo = await createDisposableGitHubRepo(secrets, {
                    autoInit: true,
                    purpose: "cli-opened-vault",
                });
                vault = await cloneRepositoryAsObsidianVault(disposableRepo.cloneUrl);
                const activeVault = vault;

                session = await launchObsidianApp(
                    activeVault.vaultPath,
                    activeVault.userDataDir,
                    secrets
                );
                await expectPluginGitReady(session.page);
                const settings = new ProviderSettingsPage(session.page);
                await settings.open();
                await settings.selectSyncBackend("git");
                await expectSettingsOrder(settings, SETTINGS_ORDER_WHEN_READY);
                await settings.expectSettingHidden("Repository setup");
                await settings.expectSettingHidden("Clone an existing remote");
                await expect
                    .poll(() => settings.inputValue("Remote URL"))
                    .toBe(disposableRepo.cloneUrl);

                await fillSettingTextWithRetry(
                    settings,
                    "Username",
                    secrets.github.apiOwner
                );
                await fillSettingTextWithRetry(
                    settings,
                    "Personal access token / password",
                    secrets.github.token,
                    { sensitive: true }
                );

                const pushedFile = `e2e-test-push-${Date.now()}.md`;
                await createVaultFile(
                    session.page,
                    pushedFile,
                    "hello from scenario 2\n"
                );
                expect(
                    fs.existsSync(path.join(activeVault.vaultPath, pushedFile))
                ).toBe(true);
                await commitAndSyncFromSourceControl(session.page, {
                    awaitCompletion: true,
                    changedFile: pushedFile,
                });
                await expect
                    .poll(() => gitStatus(activeVault.vaultPath), {
                        timeout: 60_000,
                    })
                    .toBe("");
                expect(
                    gitOutput(activeVault.vaultPath, [
                        "show",
                        "--name-only",
                        "--format=",
                        "HEAD",
                    ])
                ).toContain(pushedFile);

                await expectGitHubFile(disposableRepo, pushedFile, {
                    ref: disposableRepo.defaultBranch,
                    token: secrets.github.token,
                });
                expect(gitStatus(vault.vaultPath)).toBe("");

                await session.audit.assertClean();
            } finally {
                if (disposableRepo) {
                    const repoForCleanup = disposableRepo;
                    await deleteDisposableGitHubRepo(
                        secrets,
                        repoForCleanup
                    ).catch((error: unknown) => {
                        test.info().annotations.push({
                            type: "cleanup-warning",
                            description: `Failed to delete disposable GitHub repo ${formatDisposableRepoName(repoForCleanup)}: ${error instanceof Error ? error.message : String(error)}`,
                        });
                    });
                }
                await session?.close().catch(() => undefined);
                await vault?.cleanup().catch(() => undefined);
            }
        });
    });

    test("Scenario 3 - initialize current vault and push test.md to private GitHub repo", async () => {
        const secrets = readGitOnboardingSecretsSafely();
        const vault = prepareEmptyObsidianVault("gitInitPush");
        const testFilePath = path.join(vault.vaultPath, "test.md");
        const nestedFilePath = path.join(vault.vaultPath, "notes", "nested.md");
        const dataFilePath = path.join(vault.vaultPath, "metadata.json");
        fs.writeFileSync(testFilePath, "hello from scenario 3\n", "utf8");
        fs.mkdirSync(path.dirname(nestedFilePath), { recursive: true });
        fs.writeFileSync(nestedFilePath, "nested file from scenario 3\n", "utf8");
        fs.writeFileSync(
            dataFilePath,
            JSON.stringify({ source: "git-onboarding-scenario-3" }, null, 2),
            "utf8"
        );
        fs.writeFileSync(
            path.join(vault.vaultPath, ".gitignore"),
            ".obsidian/\n",
            "utf8"
        );

        let disposableRepo: DisposableGitHubRepo | undefined;
        let session: LaunchedObsidian | undefined;

        test.info().annotations.push({
            type: "ui-path",
            description:
                "The Git provider settings UI creates a disposable private GitHub repository, then initializes, configures, commits, and pushes through the Git flow.",
        });

        await withGitAskpass(secrets, async () => {
            try {
                disposableRepo = buildDisposableGitHubRepo(secrets, {
                    purpose: "ui-init-push",
                });

                session = await launchObsidianApp(
                    vault.vaultPath,
                    vault.userDataDir,
                    secrets
                );
                const settings = new ProviderSettingsPage(session.page);
                await settings.open();
                await settings.selectSyncBackend("git");
                await expectSettingsOrder(settings, SETTINGS_ORDER_WHEN_NOT_READY);

                await settings.fillText("Remote name", "origin");
                await settings.fillText("Remote URL", disposableRepo.cloneUrl);
                await fillSettingTextWithRetry(
                    settings,
                    "Username",
                    secrets.github.apiOwner
                );
                await fillSettingTextWithRetry(
                    settings,
                    "Personal access token / password",
                    secrets.github.token,
                    { sensitive: true }
                );
                await settings.clickButton(
                    "Create private GitHub remote",
                    "Create private repo"
                );
                await expectGitHubRepo(disposableRepo, {
                    token: secrets.github.token,
                });
                await settings.clickButton(
                    "Initialize and publish this vault",
                    "Initialize current vault"
                );

                await expect
                    .poll(
                        () => fs.existsSync(path.join(vault.vaultPath, ".git")),
                        { timeout: 60_000 }
                    )
                    .toBe(true);

                await expect
                    .poll(() => tryGitRemoteUrl(vault.vaultPath, "origin"), {
                        timeout: 60_000,
                    })
                    .toBe(disposableRepo.cloneUrl);

                await settings.open();
                await settings.selectSyncBackend("git");
                await settings.expectSettingVisible("Author name");
                await fillSettingTextWithRetry(
                    settings,
                    "Author name",
                    "Git Vault E2E"
                );
                await fillSettingTextWithRetry(
                    settings,
                    "Author email",
                    "git-vault-e2e@example.invalid"
                );

                const localBranch = gitOutput(vault.vaultPath, [
                    "branch",
                    "--show-current",
                ]);
                await commitAndSyncFromSourceControl(session.page, {
                    changedFiles: ["test.md", "notes/nested.md", "metadata.json"],
                    upstreamBranch: `origin/${localBranch || "main"}`,
                });

                await expectGitHubFile(disposableRepo, "test.md", {
                    ref: localBranch || "main",
                    token: secrets.github.token,
                });
                await expectGitHubFile(disposableRepo, "notes/nested.md", {
                    ref: localBranch || "main",
                    token: secrets.github.token,
                });
                await expectGitHubFile(disposableRepo, "metadata.json", {
                    ref: localBranch || "main",
                    token: secrets.github.token,
                });
                expect(gitStatus(vault.vaultPath)).toBe("");

                await session.audit.assertClean();
            } finally {
                if (disposableRepo) {
                    const repoForCleanup = disposableRepo;
                    await deleteDisposableGitHubRepo(
                        secrets,
                        repoForCleanup
                    ).catch((error: unknown) => {
                        test.info().annotations.push({
                            type: "cleanup-warning",
                            description: `Failed to delete disposable GitHub repo ${formatDisposableRepoName(repoForCleanup)}: ${error instanceof Error ? error.message : String(error)}`,
                        });
                    });
                }
                await session?.close().catch(() => undefined);
                await vault.cleanup().catch(() => undefined);
            }
        });
    });

    test("Scenario 12 - invalid remote URL is diagnosable and recoverable", async () => {
        const secrets = readGitOnboardingSecretsSafely();
        const vault = prepareEmptyObsidianVault("gitInvalidRemote");
        execFileSync("git", ["init"], { cwd: vault.vaultPath, stdio: "ignore" });
        execFileSync("git", ["remote", "add", "origin", secrets.github.repoUrl], {
            cwd: vault.vaultPath,
            stdio: "ignore",
        });
        let session: LaunchedObsidian | undefined;

        try {
            session = await launchObsidianApp(
                vault.vaultPath,
                vault.userDataDir,
                secrets
            );
            const settings = new ProviderSettingsPage(session.page);
            await settings.open();
            await settings.selectSyncBackend("git");
            await expectSettingsOrder(settings, SETTINGS_ORDER_WHEN_READY);

            await fillSettingTextUntilValue(
                settings,
                "Remote URL",
                "https://github.com/redoracle/git-vault-e2e-missing-remote.git"
            );
            await settings.clickButton("Remote check", "Check remote");
            await expect(
                session.page.locator(".git-vault-remote-url-validation")
            ).toContainText(/Remote check failed/i, { timeout: 30_000 });

            await fillSettingTextUntilValue(
                settings,
                "Remote URL",
                "https://github.com/redoracle/tor-gateway.git"
            );
            await settings.clickButton("Remote check", "Check remote");
            await expect(
                session.page.locator(".git-vault-remote-url-validation")
            ).toContainText(/Remote check succeeded/i, { timeout: 30_000 });

            await session.audit.assertClean({
                allowAppLogErrors: [
                    /No local Git repository is ready/i,
                    /Can't find a valid git repository/i,
                    /Remote check failed/i,
                ],
            });
        } finally {
            await session?.close();
            await vault.cleanup();
        }
    });
});

function readGitOnboardingSecretsSafely(): GitOnboardingSecrets {
    const filePath = path.resolve(process.cwd(), "secrets.txt");
    if (!fs.existsSync(filePath)) {
        throw new Error("Required local secrets file is missing: secrets.txt");
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const githubToken = raw.match(/\bgh[pousr]_[A-Za-z0-9_]+\b/u)?.[0] ?? "";
    const githubRepoUrl =
        raw.match(/https:\/\/github\.com\/[^\s]+?\.git\b/u)?.[0] ??
        "https://github.com/redoracle/obsidian-git-vault.git";
    const parsed = parseGitHubRepoUrl(githubRepoUrl);
    const apiOwner = parsed.owner || "redoracle";

    if (!githubToken) {
        throw new Error("secrets.txt is missing a GitHub token");
    }

    return {
        github: {
            token: githubToken,
            repoUrl: githubRepoUrl,
            owner: parsed.owner,
            repo: parsed.repo,
            branch: "main",
            apiOwner,
        },
        gitlab: {
            token: "",
            repoUrl: "",
            baseUrl: "https://gitlab.com/api/v4",
            projectId: "",
            branch: "main",
        },
        gitea: {
            token: "",
            repoUrl: "",
            baseUrl: "",
            owner: "",
            repo: "",
            branch: "main",
        },
        git: {
            repoUrl: githubRepoUrl,
            remoteName: "origin",
            branch: "main",
        },
    };
}

function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } {
    const parsed = new URL(repoUrl);
    const [owner = "redoracle", repoWithGit = "obsidian-git-vault.git"] =
        parsed.pathname.replace(/^\/+/, "").split("/");
    return { owner, repo: repoWithGit.replace(/\.git$/i, "") };
}

function prepareEmptyObsidianVault(vaultName: string): PreparedVault {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "git-vault-e2e-parent-"));
    const vaultPath = path.join(parent, vaultName);
    const userDataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "git-vault-e2e-profile-")
    );

    fs.mkdirSync(vaultPath, { recursive: true });
    installPluginIntoVault(vaultPath);
    registerVaultPath(vaultPath, userDataDir);

    return {
        vaultPath,
        userDataDir,
        cleanup: async () => {
            await fs.promises.rm(parent, { recursive: true, force: true });
            await fs.promises.rm(userDataDir, {
                recursive: true,
                force: true,
            });
        },
    };
}

function installPluginIntoVault(vaultPath: string): void {
    const repoRoot = process.cwd();
    const obsidianDir = path.join(vaultPath, ".obsidian");
    const installedPluginDir = path.join(
        obsidianDir,
        "plugins",
        PLUGIN_ID
    );

    fs.mkdirSync(installedPluginDir, { recursive: true });
    fs.writeFileSync(
        path.join(obsidianDir, "app.json"),
        JSON.stringify({ restrictedMode: false }, null, 2)
    );
    fs.writeFileSync(
        path.join(obsidianDir, "community-plugins.json"),
        JSON.stringify([PLUGIN_ID], null, 2)
    );

    for (const fileName of ["main.js", "manifest.json", "styles.css"]) {
        const source = path.join(repoRoot, fileName);
        if (!fs.existsSync(source)) {
            throw new Error(
                `Missing built plugin artifact: ${fileName}. Run pnpm run build before the E2E suite.`
            );
        }
        fs.copyFileSync(source, path.join(installedPluginDir, fileName));
    }
}

async function cloneRepositoryAsObsidianVault(
    cloneUrl: string
): Promise<PreparedVault> {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "git-vault-e2e-parent-"));
    const vaultPath = path.join(parent, "cli-cloned-vault");
    const userDataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "git-vault-e2e-profile-")
    );

    await cloneWithRetry(cloneUrl, vaultPath);
    execFileSync("git", ["config", "user.name", "Git Vault E2E"], {
        cwd: vaultPath,
        stdio: "ignore",
    });
    execFileSync(
        "git",
        ["config", "user.email", "git-vault-e2e@example.invalid"],
        {
            cwd: vaultPath,
            stdio: "ignore",
        }
    );
    execFileSync("git", ["config", "pull.rebase", "false"], {
        cwd: vaultPath,
        stdio: "ignore",
    });

    installPluginIntoVault(vaultPath);
    appendGitInfoExclude(vaultPath, [".obsidian/"]);
    registerVaultPath(vaultPath, userDataDir);

    return {
        vaultPath,
        userDataDir,
        cleanup: async () => {
            await fs.promises.rm(parent, { recursive: true, force: true });
            await fs.promises.rm(userDataDir, {
                recursive: true,
                force: true,
            });
        },
    };
}

function appendGitInfoExclude(repoPath: string, patterns: string[]): void {
    const excludePath = path.join(repoPath, ".git", "info", "exclude");
    fs.appendFileSync(excludePath, `\n${patterns.join("\n")}\n`, "utf8");
}

async function cloneWithRetry(cloneUrl: string, vaultPath: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await execFileAsync("git", ["clone", cloneUrl, vaultPath]);
            return;
        } catch (error) {
            lastError = error;
            try {
                fs.rmSync(vaultPath, { recursive: true, force: true });
            } catch {
                // ignore cleanup errors
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("Timed out waiting for disposable GitHub repo clone.");
}

async function expectSettingsOrder(
    settings: ProviderSettingsPage,
    expectedOrder: string[]
): Promise<void> {
    const visibleNames = await settings.visibleSettingNames();
    let lastIndex = -1;
    for (const name of expectedOrder) {
        const index = visibleNames.indexOf(name);
        expect(index, `Expected Git setting "${name}" to be visible`).toBeGreaterThan(
            -1
        );
        expect(
            index,
            `Expected Git setting "${name}" to appear after the previous expected Git setting`
        ).toBeGreaterThan(lastIndex);
        lastIndex = index;
    }
}

async function fillSettingTextWithRetry(
    settings: ProviderSettingsPage,
    name: string,
    value: string,
    options: { sensitive?: boolean } = {}
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await settings.fillText(name, value, options);
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to fill setting ${name}`);
}

async function fillSettingTextUntilValue(
    settings: ProviderSettingsPage,
    name: string,
    value: string,
    options: { sensitive?: boolean } = {}
): Promise<void> {
    await expect
        .poll(
            async () => {
                await fillSettingTextWithRetry(settings, name, value, options);
                return settings.inputValue(name);
            },
            { timeout: 15_000 }
        )
        .toBe(value);
}

async function cloneIntoVaultFolderViaGitCommand(
    page: Page,
    remoteUrl: string,
    folderName: string
): Promise<void> {
    await page.evaluate((pluginId) => {
        const plugin = (window as typeof window & {
            app?: {
                plugins?: {
                    plugins?: Record<
                        string,
                        {
                            cloneNewRepo?: () => Promise<void>;
                        }
                    >;
                };
            };
        }).app?.plugins?.plugins?.[pluginId];
        if (!plugin?.cloneNewRepo) {
            throw new Error("Git Vault clone entry point is unavailable.");
        }
        void plugin.cloneNewRepo();
    }, PLUGIN_ID);
    await submitPromptValue(page, /Enter remote URL/, remoteUrl);
    await submitPromptValue(page, /Enter directory for clone/, folderName);
    await submitPromptValue(page, /Specify depth of clone/, "");
    await expect(
        page.locator('.prompt input[type="text"], .prompt input[type="password"]')
    ).toBeHidden({ timeout: 30_000 });
}

async function expectGitRepoAt(
    repoPath: string,
    options: { remoteUrl: string; expectedBranch: string }
): Promise<void> {
    await expect
        .poll(() => fs.existsSync(path.join(repoPath, ".git")), {
            timeout: 180_000,
        })
        .toBe(true);
    await expect
        .poll(() => tryGitOutput(repoPath, ["rev-parse", "--is-inside-work-tree"]), {
            timeout: 180_000,
        })
        .toBe("true");
    await expect
        .poll(() => tryGitRemoteUrl(repoPath, "origin"), {
            timeout: 180_000,
        })
        .toBe(options.remoteUrl);
    await expect
        .poll(() => tryGitOutput(repoPath, ["branch", "--show-current"]), {
            timeout: 180_000,
        })
        .toBe(options.expectedBranch);
}

function expectSubmoduleState(repoPath: string): void {
    const gitmodulesPath = path.join(repoPath, ".gitmodules");
    if (!fs.existsSync(gitmodulesPath)) {
        expect(gitOutput(repoPath, ["submodule", "status"])).toBe("");
        return;
    }

    const submoduleStatus = gitOutput(repoPath, ["submodule", "status"]);
    expect(
        submoduleStatus,
        "Repository has .gitmodules; submodule status should be diagnosable"
    ).not.toBe("");
}

function tryGitRemoteUrl(
    repoPath: string,
    remoteName: string
): string | undefined {
    return tryGitOutput(repoPath, ["remote", "get-url", remoteName]);
}

function tryGitOutput(repoPath: string, args: string[]): string | undefined {
    try {
        return gitOutput(repoPath, args);
    } catch {
        return undefined;
    }
}

function gitStatus(repoPath: string): string {
    return gitOutput(repoPath, ["status", "--short"]);
}

function gitOutput(repoPath: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}

function hasSshAvailable(): boolean {
    const sshSock = !!process.env.SSH_AUTH_SOCK;
    const sshDir = path.join(os.homedir(), ".ssh");
    const hasKey =
        fs.existsSync(path.join(sshDir, "id_ed25519")) ||
        fs.existsSync(path.join(sshDir, "id_rsa")) ||
        fs.existsSync(path.join(sshDir, "id_ecdsa"));
    return sshSock || hasKey;
}

async function createVaultFile(
    page: Page,
    filePath: string,
    content: string
): Promise<void> {
    await page.evaluate(
        async ({ targetPath, targetContent }) => {
            const app = (window as typeof window & {
                app?: {
                    vault?: {
                        create?: (
                            path: string,
                            content: string
                        ) => Promise<unknown>;
                        modify?: (
                            file: unknown,
                            content: string
                        ) => Promise<unknown>;
                        getAbstractFileByPath?: (path: string) => unknown;
                    };
                };
            }).app;
            const existing = app?.vault?.getAbstractFileByPath?.(targetPath);
            if (existing) {
                await app?.vault?.modify?.(existing, targetContent);
            } else {
                await app?.vault?.create?.(targetPath, targetContent);
            }
        },
        { targetPath: filePath, targetContent: content }
    );
}

async function expectPluginGitReady(page: Page): Promise<void> {
    await expect
        .poll(
            () =>
                page.evaluate((pluginId) => {
                    const plugin = (window as typeof window & {
                        app?: {
                            plugins?: {
                                plugins?: Record<
                                    string,
                                    {
                                        gitReady?: boolean;
                                        gitManager?: unknown;
                                    }
                                >;
                            };
                        };
                    }).app?.plugins?.plugins?.[pluginId];
                    return Boolean(plugin?.gitReady && plugin.gitManager);
                }, PLUGIN_ID),
            { timeout: 60_000 }
        )
        .toBe(true);
}

async function submitPromptValue(
    page: Page,
    placeholder: RegExp,
    value: string
): Promise<void> {
    const promptInput = page
        .locator('.prompt input[type="text"], .prompt input[type="password"]')
        .first();
    await expect(promptInput).toBeVisible({ timeout: 30_000 });
    await expect(promptInput).toHaveAttribute("placeholder", placeholder, {
        timeout: 30_000,
    });
    await promptInput.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    if (value) {
        await page.keyboard.type(value);
    }
    await page.keyboard.press("Enter");
}

async function commitAndSyncFromSourceControl(
    page: Page,
    options: {
        awaitCompletion?: boolean;
        changedFile?: string;
        changedFiles?: string[];
        upstreamBranch?: string;
    } = {}
): Promise<void> {
    await openSourceControlView(page);
    const refreshButton = page.locator("#refresh");
    if (await refreshButton.isVisible().catch(() => false)) {
        await refreshButton.click();
        await waitForGitIndexUnlocked(page);
    }
    const changedFiles =
        options.changedFiles ?? (options.changedFile ? [options.changedFile] : []);
    if (changedFiles.length > 0) {
        for (const changedFile of changedFiles) {
            await waitForCachedGitStatusFile(page, changedFile);
        }
        if (await refreshButton.isVisible().catch(() => false)) {
            await refreshButton.click();
            await waitForGitIndexUnlocked(page);
        }
    }
    await waitForGitIndexUnlocked(page);
    const commitAndSyncButton = page.locator("#backup-btn");
    await expect(commitAndSyncButton).toBeVisible({ timeout: 30_000 });
    await triggerCommitAndSync(page, {
        awaitCompletion: options.awaitCompletion ?? false,
    });

    if (options.upstreamBranch) {
        await submitPromptIfVisible(page, "origin");
        await submitPromptIfVisible(page, options.upstreamBranch);
    }
}

async function triggerCommitAndSync(
    page: Page,
    options: { awaitCompletion: boolean }
): Promise<void> {
    await page.evaluate(async ({ pluginId, awaitCompletion }) => {
        const plugin = (window as typeof window & {
            app?: {
                plugins?: {
                    plugins?: Record<
                        string,
                        {
                            commitAndSync?: (args: {
                                fromAutoBackup: boolean;
                            }) => Promise<void>;
                        }
                    >;
                };
            };
        }).app?.plugins?.plugins?.[pluginId];
        if (!plugin?.commitAndSync) {
            throw new Error("Git Vault commit-and-sync entry point is unavailable.");
        }
        const operation = plugin.commitAndSync({ fromAutoBackup: false });
        if (awaitCompletion) {
            await operation;
        } else {
            void operation;
        }
    }, { pluginId: PLUGIN_ID, awaitCompletion: options.awaitCompletion });
}

async function waitForCachedGitStatusFile(
    page: Page,
    changedFile: string,
    options: { location?: "changed-or-staged" | "staged" } = {}
): Promise<void> {
    await expect
        .poll(
            async () =>
                page.evaluate(
                    async ({ pluginId, filePath, expectedLocation }) => {
                        const app = (window as typeof window & {
                            app?: {
                                plugins?: {
                                    plugins?: Record<
                                        string,
                                        {
                                            updateCachedStatus?: () => Promise<{
                                                changed?: Array<{
                                                    path?: string;
                                                    vaultPath?: string;
                                                }>;
                                                staged?: Array<{
                                                    path?: string;
                                                    vaultPath?: string;
                                                }>;
                                            }>;
                                        }
                                    >;
                                };
                            };
                        }).app;
                        const plugin = app?.plugins?.plugins?.[pluginId];
                        const status = await plugin?.updateCachedStatus?.();
                        const entries =
                            expectedLocation === "staged"
                                ? status?.staged ?? []
                                : [
                                      ...(status?.changed ?? []),
                                      ...(status?.staged ?? []),
                                  ];
                        return entries.some(
                            (entry) =>
                                entry.path === filePath ||
                                entry.vaultPath === filePath
                        );
                    },
                    {
                        pluginId: PLUGIN_ID,
                        filePath: changedFile,
                        expectedLocation: options.location ?? "changed-or-staged",
                    }
                ),
            { timeout: 30_000 }
        )
        .toBe(true);
}

async function waitForGitIndexUnlocked(page: Page): Promise<void> {
    await expect
        .poll(
            async () => {
                const basePath = await page.evaluate((pluginId) => {
                    const plugin = (window as typeof window & {
                        app?: {
                            plugins?: {
                                plugins?: Record<
                                    string,
                                    {
                                        gitManager?: {
                                            basePath?: string;
                                        };
                                    }
                                >;
                            };
                        };
                    }).app?.plugins?.plugins?.[pluginId];
                    return plugin?.gitManager?.basePath;
                }, PLUGIN_ID);
                if (!basePath) return true;
                return !fs.existsSync(path.join(basePath, ".git", "index.lock"));
            },
            { timeout: 30_000 }
        )
        .toBe(true);
}

async function submitPromptIfVisible(
    page: Page,
    value: string
): Promise<boolean> {
    const promptInput = page
        .locator('.prompt input[type="text"], .prompt input[type="password"]')
        .first();
    const visible = await promptInput
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
    if (!visible) {
        return false;
    }
    await submitGeneralPrompt(page, value);
    return true;
}

async function withGitAskpass<T>(
    secrets: GitOnboardingSecrets,
    run: () => Promise<T>
): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-vault-askpass-"));
    const tokenFile = path.join(tempDir, "token");
    const askpassScript = path.join(tempDir, "askpass.sh");
    const previousEnv = {
        GIT_ASKPASS: process.env.GIT_ASKPASS,
        GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
        SYNC_PRO_E2E_GIT_USERNAME: process.env.SYNC_PRO_E2E_GIT_USERNAME,
        SYNC_PRO_E2E_GIT_TOKEN_FILE:
            process.env.SYNC_PRO_E2E_GIT_TOKEN_FILE,
    };

    fs.writeFileSync(tokenFile, secrets.github.token, { mode: 0o600 });
    fs.writeFileSync(
        askpassScript,
        [
            "#!/bin/sh",
            "case \"$1\" in",
            "  *Username*) printf '%s\\n' \"$SYNC_PRO_E2E_GIT_USERNAME\" ;;",
            "  *) cat \"$SYNC_PRO_E2E_GIT_TOKEN_FILE\" ;;",
            "esac",
            "",
        ].join("\n"),
        { mode: 0o700 }
    );

    process.env.GIT_ASKPASS = askpassScript;
    process.env.GIT_TERMINAL_PROMPT = "0";
    process.env.SYNC_PRO_E2E_GIT_USERNAME = secrets.github.apiOwner;
    process.env.SYNC_PRO_E2E_GIT_TOKEN_FILE = tokenFile;

    try {
        return await run();
    } finally {
        restoreEnv(previousEnv);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function restoreEnv(previousEnv: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function buildDisposableGitHubRepo(
    secrets: GitOnboardingSecrets,
    options: { purpose: string }
): DisposableGitHubRepo {
    const owner = secrets.github.apiOwner || "redoracle";
    const repo = `git-vault-e2e-${options.purpose}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    return {
        owner,
        repo,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        defaultBranch: "main",
    };
}

async function createDisposableGitHubRepo(
    secrets: GitOnboardingSecrets,
    options: { autoInit: boolean; purpose: string }
): Promise<DisposableGitHubRepo> {
    const authenticated = await githubRequest<{ login?: string }>(
        secrets,
        "/user"
    );
    const owner = secrets.github.apiOwner || authenticated.login || "redoracle";
    const repo = `git-vault-e2e-${options.purpose}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    const pathPrefix =
        authenticated.login && owner === authenticated.login
            ? "/user/repos"
            : `/orgs/${encodeURIComponent(owner)}/repos`;

    const created = await githubRequest<{
        name: string;
        clone_url: string;
        default_branch?: string;
        owner?: { login?: string };
    }>(secrets, pathPrefix, {
        method: "POST",
        body: JSON.stringify({
            name: repo,
            private: true,
            auto_init: options.autoInit,
        }),
    });

    return {
        owner: created.owner?.login ?? owner,
        repo: created.name,
        cloneUrl: created.clone_url,
        defaultBranch: created.default_branch ?? "main",
    };
}

async function deleteDisposableGitHubRepo(
    secrets: GitOnboardingSecrets,
    repo: DisposableGitHubRepo
): Promise<void> {
    await githubRequest<void>(
        secrets,
        `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(
            repo.repo
        )}`,
        { method: "DELETE", expectedStatus: 204 }
    );
}

function formatDisposableRepoName(repo: DisposableGitHubRepo): string {
    return `${repo.owner}/${repo.repo}`;
}

async function expectGitHubRepo(
    repo: DisposableGitHubRepo,
    options: { token: string }
): Promise<void> {
    await expect
        .poll(
            async () => {
                const response = await fetch(
                    `https://api.github.com/repos/${encodeURIComponent(
                        repo.owner
                    )}/${encodeURIComponent(repo.repo)}`,
                    {
                        headers: githubHeaders(options.token),
                    }
                );
                return response.status;
            },
            { timeout: 120_000 }
        )
        .toBe(200);
}

async function expectGitHubFile(
    repo: DisposableGitHubRepo,
    filePath: string,
    options: { ref: string; token: string }
): Promise<void> {
    await expect
        .poll(
            async () => {
                const response = await fetch(
                    `https://api.github.com/repos/${encodeURIComponent(
                        repo.owner
                    )}/${encodeURIComponent(repo.repo)}/contents/${encodeGitHubContentsPath(
                        filePath
                    )}?ref=${encodeURIComponent(options.ref)}`,
                    {
                        headers: githubHeaders(options.token),
                    }
                );
                return response.status;
            },
            { timeout: 120_000 }
        )
        .toBe(200);
}

function encodeGitHubContentsPath(filePath: string): string {
    return filePath.split("/").map(encodeURIComponent).join("/");
}

async function githubRequest<T = unknown>(
    secrets: GitOnboardingSecrets,
    apiPath: string,
    options?: {
        method?: string;
        body?: string;
        expectedStatus?: number;
    }
): Promise<T>;
async function githubRequest(
    secrets: GitOnboardingSecrets,
    apiPath: string,
    options?: {
        method?: string;
        body?: string;
        expectedStatus?: number;
    }
): Promise<void>;
async function githubRequest<T = unknown>(
    secrets: GitOnboardingSecrets,
    apiPath: string,
    options: {
        method?: string;
        body?: string;
        expectedStatus?: number;
    } = {}
): Promise<unknown> {
    const response = await fetch(`https://api.github.com${apiPath}`, {
        method: options.method ?? "GET",
        headers: githubHeaders(secrets.github.token),
        body: options.body,
    });
    const expectedStatus =
        options.expectedStatus ??
        (options.method === "POST" ? 201 : options.method === "DELETE" ? 204 : 200);
    if (response.status !== expectedStatus) {
        throw new Error(
            `GitHub API request failed with HTTP ${response.status} for ${apiPath}`
        );
    }
    if (response.status === 204) {
        return undefined;
    }
    const parsed: unknown = await response.json();
    // Return as the requested generic type. This is safe in test code where
    // callers control the expected shape. The cast is intentional.
    return parsed as T;
}

function githubHeaders(token: string): Record<string, string> {
    return {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
}
