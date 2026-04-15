import { expect, test, _electron as electron } from "@playwright/test";
import {
    LINE_AUTHOR_E2E_ENABLED,
    LINE_AUTHOR_VAULT,
    OBSIDIAN_BIN,
    assertGitBackendActive,
    captureLineAuthorWindow,
    ensureLineAuthorFeatureVisible,
    ensurePluginReady,
    openFixtureNote,
} from "./helpers/lineAuthor";

if (LINE_AUTHOR_E2E_ENABLED) {
    test.describe("line author gutter rendering", () => {
        test("captures primary gutter states", async () => {
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
                await assertGitBackendActive(page);
                await ensureLineAuthorFeatureVisible(page);

                await openFixtureNote(page, "default");
                await page.waitForSelector(".line-author-gutter-container", {
                    state: "visible",
                    timeout: 5000,
                });
                await captureLineAuthorWindow(page, "line-author-default");
                await captureLineAuthorWindow(
                    page,
                    "line-author-commit-hash-full-name"
                );
                await captureLineAuthorWindow(
                    page,
                    "line-author-natural-language-dates"
                );
                await captureLineAuthorWindow(page, "line-author-custom-dates");
                await captureLineAuthorWindow(page, "line-author-untracked");
            } finally {
                await app.close();
            }
        });
    });
} else {
    test("line-author gutter capture is disabled without LINE_AUTHOR_E2E=1", () => {
        expect(LINE_AUTHOR_E2E_ENABLED).toBe(false);
    });
}
