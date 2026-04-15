/**
 * E2E screenshot generator — opens the real Obsidian app against the
 * TEST_VAULT and captures a screenshot for every top-level markdown file.
 *
 * Usage (from plugin repo):
 * TEST_VAULT=/path/to/obsidian-test-vault TEST_OBSIDIAN=/path/to/Obsidian pnpm test:e2e tests/e2e/screenshots.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    expect,
    test,
    _electron as electron,
    type ElectronApplication,
} from "@playwright/test";

const _vaultFromEnv = process.env.TEST_VAULT;
const VAULT = _vaultFromEnv ?? path.join(os.tmpdir(), "obsidian-e2e-vault");
const _vaultIsTemp = !_vaultFromEnv;

const _defaultObsidian: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    linux: "/usr/bin/obsidian",
    win32: "Obsidian.exe",
};
const OBSIDIAN =
    process.env.TEST_OBSIDIAN ??
    _defaultObsidian[process.platform] ??
    "obsidian";

const PLUGIN_READY_TIMEOUT = 20_000;

function launchObsidian(): Promise<ElectronApplication> {
    return electron.launch({
        executablePath: OBSIDIAN,
        args: [`obsidian://open?path=${encodeURIComponent(VAULT)}`],
        timeout: 30_000,
    });
}

if (!fs.existsSync(VAULT) && !process.env.TEST_VAULT) {
    test("screenshot capture is disabled without TEST_VAULT", () => {
        expect(VAULT).toContain("obsidian-e2e-vault");
    });
} else {
    test("take screenshots for every markdown doc in the vault", async () => {
        if (!fs.existsSync(VAULT)) {
            throw new Error(`Vault path ${VAULT} does not exist`);
        }

        const app = await launchObsidian();
        const win = await app.firstWindow();
        await win.waitForLoadState("domcontentloaded");

        // Wait until our plugin registers (so UI and command palette are available).
        await win.waitForFunction(
            () => !!(window as any)?.app?.plugins?.plugins?.["git-vault"],
            { timeout: PLUGIN_READY_TIMEOUT }
        );

        const mdFiles = fs.readdirSync(VAULT).filter((f) => f.endsWith(".md"));
        const outDir = path.join(VAULT, ".generated-screenshots");
        fs.mkdirSync(outDir, { recursive: true });

        for (const file of mdFiles) {
            console.log("Opening", file);
            // Open the file in Obsidian via the app API inside the renderer.
            await win.evaluate(async (filePath) => {
                // @ts-ignore
                const app = (window as any).app;
                const f = app.vault.getAbstractFileByPath(filePath);
                if (!f) throw new Error(`File not found in vault: ${filePath}`);
                const leaf = app.workspace.getLeaf(true);
                await leaf.openFile(f);
            }, file);

            // Give Obsidian a short moment to render the note.
            await win.waitForTimeout(600);

            const safe = file
                .replace(/\s+/g, "_")
                .replace(/[^a-zA-Z0-9_.-]/g, "");
            const outFile = path.join(outDir, `${safe}.png`);
            await win.screenshot({ path: outFile });
            console.log("Saved screenshot:", outFile);
        }

        await app.close();
    });
}

export {};
