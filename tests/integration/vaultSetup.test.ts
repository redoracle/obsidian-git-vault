/**
 * Integration tests — operate on real vault filesystem.
 * Vault path: /Users/tesla/Documents/obsidian-test-vault
 *
 * These tests do NOT need Obsidian to be running.
 * They exercise the vault filesystem directly to verify that
 * files written here are accessible to the plugin when Obsidian opens.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Use the OBSIDIAN_TEST_VAULT env var when set; skip all suites otherwise so
// the tests remain portable across machines and CI environments.
const VAULT = process.env.OBSIDIAN_TEST_VAULT ?? "";

/**
 * Lower bound for the esbuild production bundle. The unminified bundle is
 * ~780 KB; 50 KB is conservative enough to survive future tree-shaking while
 * still catching an accidentally empty or truncated file.
 */
const MIN_BUNDLE_SIZE = 50_000;

async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

if (!VAULT) {
    describe("vault filesystem integration", () => {
        it("is disabled when OBSIDIAN_TEST_VAULT is not set", () => {
            expect(VAULT).toBe("");
        });
    });
} else {
    describe("vault filesystem", () => {
        const scratch = path.join(VAULT, "_vitest-scratch.md");

        afterEach(async () => {
            await fs.rm(scratch, { force: true });
        });

        it("vault directory is accessible", async () => {
            expect(await exists(VAULT)).toBe(true);
        });

        it("writes and reads a markdown file", async () => {
            await fs.writeFile(
                scratch,
                "# integration test\nwritten by vitest\n"
            );
            const content = await fs.readFile(scratch, "utf8");
            expect(content).toContain("integration test");
        });

        it("overwrites an existing file", async () => {
            await fs.writeFile(scratch, "initial");
            await fs.writeFile(scratch, "updated");
            const content = await fs.readFile(scratch, "utf8");
            expect(content).toBe("updated");
        });

        it("deletes a file", async () => {
            await fs.writeFile(scratch, "to be deleted");
            await fs.rm(scratch);
            expect(await exists(scratch)).toBe(false);
        });
    });

    describe("vault plugin installation", () => {
        it("plugin symlink exists and resolves to an existing path", async () => {
            const link = path.join(VAULT, ".obsidian/plugins/git-vault");
            const stat = await fs.lstat(link);
            expect(stat.isSymbolicLink()).toBe(true);
            const target = await fs.readlink(link);
            const resolved = path.resolve(path.dirname(link), target);
            expect(await exists(resolved)).toBe(true);
        });

        it("main.js is accessible through the symlink", async () => {
            const main = path.join(VAULT, ".obsidian/plugins/git-vault/main.js");
            expect(await exists(main)).toBe(true);
            const stat = await fs.stat(main);
            expect(stat.size).toBeGreaterThan(MIN_BUNDLE_SIZE); // bundled file should be > 50 KB
        });

        it("manifest.json contains expected plugin id", async () => {
            const mf = path.join(
                VAULT,
                ".obsidian/plugins/git-vault/manifest.json"
            );
            const raw = await fs.readFile(mf, "utf8");
            const manifest = JSON.parse(raw) as { id: string; name: string };
            expect(manifest.id).toBe("git-vault");
            expect(manifest.name).toBe("Obsidian Git Vault");
        });

        it("community-plugins.json enables git-vault", async () => {
            const cp = path.join(VAULT, ".obsidian/community-plugins.json");
            const raw = await fs.readFile(cp, "utf8");
            const enabled = JSON.parse(raw) as string[];
            expect(enabled).toContain("git-vault");
        });
    });

    describe("vault GitHub remote", () => {
        it("vault has a git remote pointing to the private test repo", async () => {
            const { stdout } = await execFileAsync(
                "git",
                ["remote", "get-url", "origin"],
                { cwd: VAULT }
            );
            expect(stdout.trim()).toMatch(/obsidian-test-vault/);
        });
    });
}
