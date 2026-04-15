import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const LINE_AUTHOR_E2E_ENABLED = process.env.LINE_AUTHOR_E2E === "1";
export const LINE_AUTHOR_READY_TIMEOUT = 30_000;

const defaultObsidian: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    linux: "/usr/bin/obsidian",
    win32: process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Obsidian", "Obsidian.exe")
        : path.join("C:\\Program Files", "Obsidian", "Obsidian.exe"),
};

export const OBSIDIAN_BIN =
    process.env.TEST_OBSIDIAN ??
    defaultObsidian[process.platform] ??
    "Obsidian.exe";

export const LINE_AUTHOR_VAULT =
    process.env.LINE_AUTHOR_TEST_VAULT ??
    process.env.TEST_VAULT ??
    path.join(os.tmpdir(), "obsidian-line-author-vault");

export type LineAuthorFixtureNote =
    | "default"
    | "timezone"
    | "movement"
    | "whitespace"
    | "untracked";

export type LineAuthorCaptureName =
    | "line-author-activate"
    | "line-author-default"
    | "line-author-commit-hash-full-name"
    | "line-author-commit-hash-full-name-config"
    | "line-author-natural-language-dates"
    | "line-author-custom-dates"
    | "line-author-custom-dates-config"
    | "line-author-tz-utc0000"
    | "line-author-tz-viewer-local"
    | "line-author-tz-author-local"
    | "line-author-tz-config"
    | "line-author-color-config"
    | "line-author-text-color-config"
    | "line-author-copy-commit-hash"
    | "line-author-quick-configure-gutter"
    | "line-author-untracked"
    | "line-author-follow-none"
    | "line-author-follow-all-commits"
    | "line-author-follow-config"
    | "line-author-ignore-whitespace-before"
    | "line-author-ignore-whitespace-preserved"
    | "line-author-ignore-whitespace-ignored";

function assertUnreachable(value: never): never {
    throw new Error(`Unexpected value: ${value}`);
}

export function lineAuthorArtifactsDir(): string {
    return path.resolve(process.cwd(), "test-results/line-author");
}

export function ensureLineAuthorArtifactsDir(): string {
    const dir = lineAuthorArtifactsDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export async function ensurePluginReady(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
        () =>
            !!(
                (window as unknown as {
                    app?: { plugins?: { plugins?: Record<string, unknown> } };
                }).app?.plugins?.plugins?.["git-vault"]
            ),
        { timeout: LINE_AUTHOR_READY_TIMEOUT }
    );
}

export async function ensureLineAuthorFeatureVisible(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const app = (window as unknown as {
                app?: {
                    plugins?: { plugins?: Record<string, { settings?: { lineAuthor?: { show?: boolean } } }> };
                };
            }).app;
            return app?.plugins?.plugins?.["git-vault"]?.settings?.lineAuthor?.show === true;
        },
        { timeout: LINE_AUTHOR_READY_TIMEOUT }
    );
}

export async function assertGitBackendActive(page: Page): Promise<void> {
    const activeProvider = await page.evaluate(() => {
        const app = (window as unknown as {
            app?: {
                plugins?: { plugins?: Record<string, { settings?: { activeSyncProvider?: string } }> };
            };
        }).app;
        return app?.plugins?.plugins?.["git-vault"]?.settings?.activeSyncProvider ?? null;
    });

    expect(activeProvider).toBe("git");
}

export async function openNote(page: Page, relativePath: string): Promise<void> {
    await page.evaluate(async (filePath: string) => {
        const app = (window as unknown as {
            app: {
                vault: { getAbstractFileByPath(path: string): unknown };
                workspace: { getLeaf(newLeaf: boolean): { openFile(file: unknown): Promise<void> } };
            };
        }).app;
        const file = app.vault.getAbstractFileByPath(filePath);
        if (!file) {
            throw new Error(`File not found in vault: ${filePath}`);
        }
        const leaf = app.workspace.getLeaf(true);
        await leaf.openFile(file);
    }, relativePath);
}

export function fixtureNotePath(note: LineAuthorFixtureNote): string {
    switch (note) {
        case "default":
            return "LineAuthor/default.md";
        case "timezone":
            return "LineAuthor/timezone.md";
        case "movement":
            return "LineAuthor/movement.md";
        case "whitespace":
            return "LineAuthor/whitespace.md";
        case "untracked":
            return "LineAuthor/untracked.md";
        default:
            return assertUnreachable(note);
    }
}

export async function openFixtureNote(page: Page, note: LineAuthorFixtureNote): Promise<void> {
    await openNote(page, fixtureNotePath(note));
}

export async function captureLineAuthorWindow(
    page: Page,
    captureName: LineAuthorCaptureName
): Promise<string> {
    const dir = ensureLineAuthorArtifactsDir();
    const outFile = path.join(dir, `${captureName}.png`);
    await page.screenshot({ path: outFile });
    return outFile;
}

export function lineAuthorSeedScriptPath(): string {
    return path.resolve(process.cwd(), "tests/fixtures/line-author/seedFixture.ts");
}

export async function evaluateInMainWindow<T>(
    app: ElectronApplication,
    fn: () => T | Promise<T>
): Promise<T> {
    const page = await app.firstWindow();
    return page.evaluate(fn);
}
