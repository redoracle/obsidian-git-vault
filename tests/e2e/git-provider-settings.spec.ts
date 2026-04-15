import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import {
    PLUGIN_ID,
    launchObsidianApp,
    openSourceControlView,
    prepareTestVault,
    readSecretsSafely,
    ProviderSettingsPage,
    type LaunchedObsidian,
    type PreparedVault,
} from "./helpers/obsidian";

const secrets = readSecretsSafely();

async function withVault(
    run: (args: { vault: PreparedVault; session: LaunchedObsidian }) => Promise<void>
): Promise<void> {
    const vault = prepareTestVault(secrets);
    let session: LaunchedObsidian | undefined;
    try {
        session = await launchObsidianApp(vault.vaultPath, vault.userDataDir, secrets);
        if (!session) throw new Error("Failed to launch Obsidian test session");
        await run({ vault, session });
    } finally {
        await session?.close();
        await vault.cleanup();
    }
}

test("Git settings: remote, auth fields and save remote", async () => {
    await withVault(async ({ vault, session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();

        await settings.selectSyncBackend("git");

        await settings.expectSettingVisible("Remote URL");
        await settings.expectSettingVisible("Username");
        await settings.expectSettingVisible("Personal access token / password");
        await expect(
            session.page.getByText("Advanced Git options", { exact: true })
        ).toBeVisible();
        await settings.expectSettingNotVisible("Remote name");

        // Save a remote and verify Git config was updated
        await settings.fillText("Remote URL", secrets.git.repoUrl);
        await settings.clickButton("Remote URL", "Save remote");

        // Wait for the remote to be persisted to disk to avoid race with git write
        let remoteUrl = "";
        const expected = secrets.git.repoUrl;
        const maxWait = 2000; // ms
        const delay = 200; // ms
        const end = Date.now() + maxWait;
        while (Date.now() < end) {
            try {
                remoteUrl = execFileSync("git", ["remote", "get-url", secrets.git.remoteName], {
                    cwd: vault.vaultPath,
                    encoding: "utf8",
                }).trim();
            } catch {
                remoteUrl = "";
            }
            if (remoteUrl === expected) break;
            await new Promise((r) => setTimeout(r, delay));
        }
        expect(remoteUrl).toBe(secrets.git.repoUrl);

        await session.audit.assertClean();
    });
});

test("Git advanced settings and flatten control are present when native Git is used", async () => {
    await withVault(async ({ session }) => {
        // Gate the test to environments where the plugin actually uses the native Git runtime.
        const useSimpleGit = await session.page.evaluate(
            (pluginId: string) => {
                const typedWindow = window as unknown as Window & {
                    app?: {
                        plugins?: {
                            plugins?: Record<string, { useSimpleGit?: boolean }>;
                        };
                    };
                };
                const plugin = typedWindow.app?.plugins?.plugins?.[pluginId];
                return !!plugin?.useSimpleGit;
            },
            PLUGIN_ID
        );

        if (!useSimpleGit) {
            // Skip this test when simple-git is not available in this runtime
            test.skip(true, "simple-git not available in this runtime");
            return;
        }

        const settings = new ProviderSettingsPage(session.page);
        await settings.open();
        await settings.selectSyncBackend("git");

        // Advanced, environment and flatten controls should be visible on desktop native Git
        await settings.expectSettingVisible("Custom Git binary path");
        await settings.expectSettingVisible("Additional environment variables");
        await settings.expectSettingVisible("Custom base path (Git repository path)");
        await settings.expectSettingVisible("Custom Git directory path (Instead of '.git')");
        await settings.expectSettingVisible("Flatten all commits into a single commit");

        await session.audit.assertClean();
    });
});

test("Git source control change-layout button toggles between list and folder views", async () => {
    await withVault(async ({ session }) => {
        await session.page.evaluate(async (pluginId) => {
            const windowAny = window as typeof window & {
                app?: {
                    plugins?: {
                        plugins?: Record<
                            string,
                            { refresh?: () => Promise<void> }
                        >;
                    };
                    vault?: {
                        adapter?: {
                            exists?: (path: string) => Promise<boolean>;
                            write?: (
                                path: string,
                                content: string
                            ) => Promise<void>;
                        };
                        createFolder?: (path: string) => Promise<void>;
                    };
                    workspace?: {
                        trigger?: (eventName: string) => void;
                    };
                };
            };
            const app = windowAny.app;
            if (!(await app?.vault?.adapter?.exists?.("layout-fixture"))) {
                await app?.vault?.createFolder?.("layout-fixture");
            }
            await app?.vault?.adapter?.write?.(
                "layout-fixture/nested-change.md",
                "# Nested change\n"
            );
            await app?.plugins?.plugins?.[pluginId]?.refresh?.();
            app?.workspace?.trigger?.("obsidian-git:refresh");
        }, PLUGIN_ID);
        await openSourceControlView(session.page);
        await session.page.evaluate(() => {
            const app = (window as typeof window & {
                app?: {
                    workspace?: {
                        trigger?: (eventName: string) => void;
                    };
                };
            }).app;
            app?.workspace?.trigger?.("obsidian-git:refresh");
        });

        const sourceControl = session.page
            .locator('main[data-type="git-view"]')
            .first();
        await expect(sourceControl).toBeVisible();
        await expect(sourceControl).toHaveAttribute(
            "data-git-vault-layout",
            "list"
        );
        await expect(
            session.page.locator(
                '[data-path="layout-fixture/nested-change.md"]'
            )
        ).toBeVisible({ timeout: 30_000 });

        await session.page.getByLabel("Change Layout").click();
        await expect(sourceControl).toHaveAttribute(
            "data-git-vault-layout",
            "tree"
        );
        await expect(
            session.page.getByText("layout-fixture", { exact: true }).first()
        ).toBeVisible();

        await session.page.getByLabel("Change Layout").click();
        await expect(sourceControl).toHaveAttribute(
            "data-git-vault-layout",
            "list"
        );

        await session.audit.assertClean();
    });
});
