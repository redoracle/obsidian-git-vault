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

// Timeout used for dropdown population waits. Gitea can be slower/less
// consistent in responding to API calls in CI or networked test environments,
// so a longer timeout is required when asserting repository/branch options.
const DROPDOWN_TIMEOUT_MS = 60_000;

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

async function withVault(
    run: (args: { vault: PreparedVault; session: LaunchedObsidian }) => Promise<void>
): Promise<void> {
    const vault = prepareTestVault(secrets);
    let session: LaunchedObsidian | undefined;
    let closeError: Error | undefined;
    let cleanupError: Error | undefined;
    let runError: Error | undefined;

    try {
        session = await launchObsidianApp(vault.vaultPath, vault.userDataDir, secrets);
        if (!session) throw new Error("Failed to launch Obsidian test session");
        try {
            await run({ vault, session });
        } catch (e) {
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
    // Surface errors from all phases. If a run() error occurred, surface that first,
    // and append any cleanup errors to the message for visibility.
    if (runError) {
        if (closeError || cleanupError) {
            if (closeError) console.error("session.close error during test cleanup:", closeError);
            if (cleanupError) console.error("vault.cleanup error during test cleanup:", cleanupError);
            const parts = [
                `Run failed: ${runError.message}`,
                closeError ? `Close error: ${closeError.message}` : undefined,
                cleanupError ? `Cleanup error: ${cleanupError.message}` : undefined,
            ].filter((p) => p != null);
            const combinedMsg = parts.join(" | ");
            throw new Error(combinedMsg);
        } else {
            throw runError;
        }
    }
    // No run() error; report cleanup errors as a combined message if both occurred
    if (closeError && cleanupError) {
        const combinedMsg = `Multiple errors occurred during cleanup: close="${closeError.message}" cleanup="${cleanupError.message}"`;
        throw new Error(combinedMsg);
    }
    if (closeError) throw closeError;
    if (cleanupError) throw cleanupError;
}

test("API providers: refresh repositories and branches populate options after refresh - github", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();

        // GitHub
        await settings.selectSyncBackend("github");
        await settings.fillText("Personal access token", secrets.github.token, { sensitive: true });
        await settings.fillText("Owner / organization", secrets.github.owner);
        await settings.clickExtraButton("Repository");
        await settings.waitForDropdownOption("Repository", secrets.github.repo);

        // Intentionally avoid asserting the transient "Refreshing..." label here.
        // That intermediate label is timing-sensitive and can disappear before
        // Playwright observes it, which leads to flaky timing-based failures.
        // Instead wait for the final populated dropdown option.
        await settings.clickExtraButton("Repository");
        await settings.waitForDropdownOption("Repository", secrets.github.repo);

        // Branch refresh — same rationale as above: skip asserting the
        // intermediate "Refreshing..." label to avoid flaky timing assertions.
        await settings.clickExtraButton("Branch");
        await settings.waitForDropdownOption("Branch", secrets.github.branch);

        await session.audit.assertClean();
    });
});

test("API providers: refresh repositories and branches populate options after refresh - gitlab", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();

        // GitLab
        await settings.selectSyncBackend("gitlab");
        await settings.fillText("Personal access token", secrets.gitlab.token, { sensitive: true });
        await settings.fillText("API base URL", secrets.gitlab.baseUrl);
        await settings.fillText("Project path / ID", secrets.gitlab.projectId);
        await settings.waitForDropdownOption("Branch", secrets.gitlab.branch);

        // Skip asserting the transient "Refreshing..." label here to avoid
        // flaky timing-based checks; wait for the final populated option instead.
        await settings.clickExtraButton("Project");
        await settings.waitForDropdownOption("Project", secrets.gitlab.projectId);

        // Same rationale for branches: wait for the final option rather than
        // asserting a short-lived "Refreshing..." intermediate state.
        await settings.clickExtraButton("Branch");
        await settings.waitForDropdownOption("Branch", secrets.gitlab.branch);

        await session.audit.assertClean();
    });
});

test("API providers: refresh repositories and branches populate options after refresh - gitea", async () => {
    await withVault(async ({ session }) => {
        const settings = new ProviderSettingsPage(session.page);
        await settings.open();

        // Gitea
        await settings.selectSyncBackend("gitea");
        await settings.fillText("Access token", secrets.gitea.token, { sensitive: true });
        await settings.fillText("Server URL", secrets.gitea.baseUrl);
        await settings.fillText("Owner / namespace", secrets.gitea.owner);
        await settings.clickExtraButton("Repository");
        await settings.waitForDropdownOption("Repository", secrets.gitea.repo, DROPDOWN_TIMEOUT_MS);

        await settings.clickExtraButton("Repository");
        await settings.waitForDropdownOption("Repository", secrets.gitea.repo, DROPDOWN_TIMEOUT_MS);

        await settings.clickExtraButton("Branch");
        await settings.waitForDropdownOption("Branch", secrets.gitea.branch, DROPDOWN_TIMEOUT_MS);

        await session.audit.assertClean();
    });
});
