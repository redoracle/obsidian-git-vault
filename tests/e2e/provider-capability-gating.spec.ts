import { test } from "@playwright/test";
import {
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
    let closeError: Error | undefined;
    let cleanupError: Error | undefined;
    let runError: Error | undefined;

    try {
        session = await launchObsidianApp(
            vault.vaultPath,
            vault.userDataDir,
            secrets
        );
        if (!session) throw new Error("Failed to launch Obsidian test session");
        try {
            await run({ vault, session });
        } catch (e) {
            // capture run error for later aggregation
            runError = toError(e);
        }
    } finally {
        if (session) {
            try {
                await session.close();
            } catch (e) {
                closeError = toError(e);
            }
        }

        try {
            await vault.cleanup();
        } catch (e) {
            cleanupError = toError(e);
        }
    }

    // Surface multiple errors if present. If a run() error occurred and there are
    // cleanup errors, surface all together.
    if (runError) {
        if (closeError || cleanupError) {
            // Log cleanup and run errors for visibility
            if (closeError) {
                console.error(
                    "session.close error during test cleanup:",
                    closeError
                );
            }
            if (cleanupError) {
                console.error(
                    "vault.cleanup error during test cleanup:",
                    cleanupError
                );
            }
            const errors = [runError, closeError, cleanupError].filter(
                (e): e is Error => e instanceof Error
            );
            throw Object.assign(
                new Error("Run failed and cleanup produced errors"),
                { causes: errors }
            );
        } else {
            throw runError;
        }
    }
    if (closeError && cleanupError) {
        throw Object.assign(new Error("Cleanup failed with multiple errors"), {
            causes: [closeError, cleanupError],
        });
    }
    if (closeError) throw closeError;
    if (cleanupError) throw cleanupError;
}

test("API providers render token and encryption controls", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();

        const apiProviders: Array<{
            key: "github" | "gitlab" | "gitea";
            expectedTokenLabel: string;
            expectedLabel: string;
        }> = [
            {
                key: "github",
                expectedTokenLabel: "Personal access token",
                expectedLabel: "Owner / organization",
            },
            {
                key: "gitlab",
                expectedTokenLabel: "Personal access token",
                expectedLabel: "API base URL",
            },
            {
                key: "gitea",
                expectedTokenLabel: "Access token",
                expectedLabel: "Server URL",
            },
        ];

        for (const p of apiProviders) {
            await settings.selectSyncBackend(p.key);
            await settings.expectSettingVisible(p.expectedTokenLabel);
            // Encryption controls should be present for API providers
            await settings.expectSettingVisible("Encrypt synced file contents");
            await settings.expectSettingVisible("Encryption passphrase");
            // Provider-specific primary input should be visible
            await settings.expectSettingVisible(p.expectedLabel);
        }

        await session.audit.assertClean();
    });
});

test("Native Git hides API-only controls", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();
        await settings.selectSyncBackend("git");

        await settings.expectSettingVisible("Remote URL");
        await settings.expectSettingNotVisible("Remote name");
        await settings.expandDetails("Advanced Git options");
        await settings.expectSettingVisible("Remote name");

        // API-only controls should be hidden for native Git
        // Some providers (e.g. Gitea) label this field "Access token", so check both labels.
        await settings.expectSettingHidden("Personal access token");
        await settings.expectSettingHidden("Access token");
        await settings.expectSettingHidden("Encrypt synced file contents");
        await settings.expectSettingHidden("Encryption passphrase");

        await session.audit.assertClean();
    });
});
