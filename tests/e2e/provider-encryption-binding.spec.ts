import { test, expect } from "@playwright/test";
import {
    PLUGIN_ID,
    launchObsidianApp,
    prepareTestVault,
    readSecretsSafely,
    ProviderSettingsPage,
    type LaunchedObsidian,
    type PreparedVault,
} from "./helpers/obsidian";

const secrets = readSecretsSafely();

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

async function withVault(
    run: (args: {
        vault: PreparedVault;
        session: LaunchedObsidian;
    }) => Promise<void>
): Promise<void> {
    const vault = prepareTestVault(secrets);
    let session: LaunchedObsidian | undefined;
    let runError: Error | undefined;
    let closeError: Error | undefined;
    let cleanupError: Error | undefined;

    try {
        session = await launchObsidianApp(
            vault.vaultPath,
            vault.userDataDir,
            secrets
        );
        if (!session) throw new Error("Failed to launch Obsidian test session");
        await run({ vault, session });
    } catch (e) {
        // Capture the original run error and attempt to continue with
        // predictable teardown. We'll prefer throwing the original run
        // error below so test failures aren't masked by cleanup errors.
        runError = toError(e);
    } finally {
        if (session) {
            try {
                await session.close();
            } catch (e) {
                // Only overwrite closeError if there wasn't an earlier run error
                // so the original failure remains visible to callers.
                if (!runError) closeError = toError(e);
            }
        }
        try {
            await vault.cleanup();
        } catch (e) {
            cleanupError = toError(e);
        }
    }
    // Prefer to surface the original run error if present; however, if
    // teardown produced additional errors we should not silently drop them.
    // Attach any teardown errors to the original run error (and log them)
    // so callers / reporters can inspect both the test failure and cleanup
    // failures.
    if (runError) {
        const suppressed: Error[] = [];
        if (closeError) suppressed.push(closeError);
        if (cleanupError) suppressed.push(cleanupError);
        if (suppressed.length > 0) {
            type SuppressibleError = Error & { suppressed?: Error[] };
            // Try to attach suppressed errors to the original run error when
            // possible. Avoid throwing by checking mutability before assignment.
            if (!Object.isFrozen(runError) && !Object.isSealed(runError)) {
                (runError as SuppressibleError).suppressed = suppressed;
            }

            // Log teardown errors directly; don't swallow them silently.
            console.error(
                "withVault: additional errors occurred during teardown",
                suppressed
            );
        }
        throw runError;
    }
    if (closeError && cleanupError) {
        const combined = Object.assign(
            new Error(
                `close failed: ${closeError.message}; cleanup failed: ${cleanupError.message}`
            ),
            { suppressed: [closeError, cleanupError] }
        );
        throw combined;
    }
    if (closeError) throw closeError;
    if (cleanupError) throw cleanupError;
}

test("API providers: encryption passphrase UI presence and storage", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();

        const providers: Array<"github" | "gitlab" | "gitea"> = [
            "github",
            "gitlab",
            "gitea",
        ];

        for (const provider of providers) {
            await test.step(`provider: ${provider}`, async () => {
                await settings.selectSyncBackend(provider);

                // Seed required fields so the UI shows repo/branch controls
                if (provider === "github") {
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
                } else if (provider === "gitlab") {
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
                } else if (provider === "gitea") {
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
                }

                // Encryption passphrase field should be present
                await settings.expectSettingVisible("Encryption passphrase");

                const passphrase = `e2e-pass-${provider}`;
                await settings.fillText("Encryption passphrase", passphrase, {
                    sensitive: true,
                });

                // Poll the plugin's providerSecrets to ensure the value was stored
                await expect
                    .poll(
                        async () => {
                            return await session.page.evaluate(
                                ({
                                    pluginId,
                                    providerName,
                                }: {
                                    pluginId: string;
                                    providerName: string;
                                }) => {
                                    const typedWindow =
                                        window as unknown as Window & {
                                            app?: {
                                                plugins?: {
                                                    plugins?: Record<
                                                        string,
                                                        {
                                                            providerSecrets?: {
                                                                getEncryptionPassphrase?: (
                                                                    provider: string
                                                                ) =>
                                                                    | string
                                                                    | null;
                                                            };
                                                        }
                                                    >;
                                                };
                                            };
                                        };
                                    const plugin =
                                        typedWindow.app?.plugins?.plugins?.[
                                            pluginId
                                        ];
                                    return (
                                        plugin?.providerSecrets?.getEncryptionPassphrase?.(
                                            providerName
                                        ) ?? null
                                    );
                                },
                                { pluginId: PLUGIN_ID, providerName: provider }
                            );
                        },
                        { timeout: 5_000 }
                    )
                    .toEqual(passphrase);
            });
        }

        await session.audit.assertClean();
    });
});
