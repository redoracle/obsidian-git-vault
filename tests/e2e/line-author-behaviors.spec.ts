import { expect, test, _electron as electron } from "@playwright/test";
import {
    LINE_AUTHOR_E2E_ENABLED,
    LINE_AUTHOR_VAULT,
    OBSIDIAN_BIN,
    captureLineAuthorWindow,
    ensurePluginReady,
    openFixtureNote,
} from "./helpers/lineAuthor";

async function openFixtureNoteAndWaitForGutter(
    page: Parameters<typeof openFixtureNote>[0],
    fixture: Parameters<typeof openFixtureNote>[1]
): Promise<void> {
    await openFixtureNote(page, fixture);
    await page.waitForSelector(".line-author-gutter-container", {
        state: "visible",
        timeout: 5_000,
    });
}

if (LINE_AUTHOR_E2E_ENABLED) {
    test.describe("line author behaviors", () => {
        test("captures timezone, movement, and whitespace scenarios", async () => {
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

                await openFixtureNoteAndWaitForGutter(page, "timezone");
                await captureLineAuthorWindow(page, "line-author-tz-utc0000");
                await captureLineAuthorWindow(
                    page,
                    "line-author-tz-viewer-local"
                );
                await captureLineAuthorWindow(
                    page,
                    "line-author-tz-author-local"
                );

                await openFixtureNoteAndWaitForGutter(page, "movement");
                await captureLineAuthorWindow(page, "line-author-follow-none");
                await captureLineAuthorWindow(
                    page,
                    "line-author-follow-all-commits"
                );
                await captureLineAuthorWindow(
                    page,
                    "line-author-copy-commit-hash"
                );
                await captureLineAuthorWindow(
                    page,
                    "line-author-quick-configure-gutter"
                );

                await openFixtureNoteAndWaitForGutter(page, "whitespace");
                await captureLineAuthorWindow(
                    page,
                    "line-author-ignore-whitespace-before"
                );
                await captureLineAuthorWindow(
                    page,
                    "line-author-ignore-whitespace-preserved"
                );
                await captureLineAuthorWindow(
                    page,
                    "line-author-ignore-whitespace-ignored"
                );
            } finally {
                await app.close();
            }
        });
    });
} else {
    test("line-author behavior capture is disabled without LINE_AUTHOR_E2E=1", () => {
        expect(LINE_AUTHOR_E2E_ENABLED).toBeFalsy();
    });
}
