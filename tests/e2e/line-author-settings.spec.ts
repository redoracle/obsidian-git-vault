import { expect, test, _electron as electron } from "@playwright/test";
import {
    LINE_AUTHOR_E2E_ENABLED,
    LINE_AUTHOR_READY_TIMEOUT,
    LINE_AUTHOR_VAULT,
    OBSIDIAN_BIN,
    captureLineAuthorWindow,
    ensurePluginReady,
} from "./helpers/lineAuthor";

const LINE_AUTHOR_SECTION_TITLE =
    "Show commit authoring information next to each line";

if (LINE_AUTHOR_E2E_ENABLED) {
    test.describe("line author settings", () => {
        // Re-enable once the test navigates into the Git Vault settings UI and sets the required config variants.
        test.skip("captures line-author settings variants", async () => {
            const app = await electron.launch({
                executablePath: OBSIDIAN_BIN,
                args: [
                    `obsidian://open?path=${encodeURIComponent(LINE_AUTHOR_VAULT)}`,
                ],
                timeout: 60_000,
            });

            try {
                const page = await app.firstWindow();
                await ensurePluginReady(page);

                await page.waitForSelector(
                    `.setting-item-name:text("${LINE_AUTHOR_SECTION_TITLE}")`,
                    {
                        state: "visible",
                        timeout: LINE_AUTHOR_READY_TIMEOUT,
                    }
                );

                // TODO: Navigate to Git Vault settings and the line-author section.
                // TODO: Capture config states for commit hash, custom date, timezone, colors, text color, follow movement.
                // This test is intentionally capture-only: captureLineAuthorWindow records fixture screenshots
                // after the UI is ready, while LINE_AUTHOR_READY_TIMEOUT gates the wait for the settings view.
                await captureLineAuthorWindow(
                    page,
                    "line-author-commit-hash-full-name-config"
                );
                await captureLineAuthorWindow(
                    page,
                    "line-author-custom-dates-config"
                );
                await captureLineAuthorWindow(page, "line-author-tz-config");
                await captureLineAuthorWindow(page, "line-author-color-config");
                await captureLineAuthorWindow(
                    page,
                    "line-author-text-color-config"
                );
                await captureLineAuthorWindow(
                    page,
                    "line-author-follow-config"
                );
            } finally {
                await app.close();
            }
        });
    });
} else {
    test("line-author settings capture is disabled without LINE_AUTHOR_E2E=1", () => {
        expect(LINE_AUTHOR_E2E_ENABLED).toBe(false);
    });
}
