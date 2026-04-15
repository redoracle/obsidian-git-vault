import { test, expect } from "@playwright/test";
import {
    PLUGIN_ID,
    launchObsidianApp,
    prepareTestVault,
    readSecretsSafely,
    type LaunchedObsidian,
    type PreparedVault,
} from "./helpers/obsidian";

const secrets = readSecretsSafely();

async function withVault(
    run: (args: {
        vault: PreparedVault;
        session: LaunchedObsidian;
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
        await run({ vault, session });
    } finally {
        await session?.close();
        await vault.cleanup();
    }
}

test("Obsidian launches and a window opens", async () => {
    await withVault(async ({ session }) => {
        const title = await session.page.title();
        expect(title.length).toBeGreaterThan(0);
        await session.audit.assertClean();
    });
});

test("git-vault commands are registered", async () => {
    await withVault(async ({ session }) => {
        const commandIds: string[] = await session.page.evaluate((pluginId) => {
            const app = (window as typeof window & {
                app?: {
                    commands?: {
                        commands?: Record<string, unknown>;
                    };
                };
            }).app;
            return Object.keys(app?.commands?.commands ?? {}).filter((id) =>
                id.startsWith(`${pluginId}:`)
            );
        }, PLUGIN_ID);

        expect(commandIds.length).toBeGreaterThan(0);
        await session.audit.assertClean();
    });
});

test("plugin settings object is defined", async () => {
    await withVault(async ({ session }) => {
        const settingsDefined = await session.page.evaluate((pluginId) => {
            const app = (window as typeof window & {
                app?: {
                    plugins?: {
                        plugins?: Record<string, { settings?: unknown }>;
                    };
                };
            }).app;
            return typeof app?.plugins?.plugins?.[pluginId]?.settings !== "undefined";
        }, PLUGIN_ID);

        expect(settingsDefined).toBe(true);
        await session.audit.assertClean();
    });
});
