import { describe, expect, it, vi } from "vitest";
import type ObsidianGit from "../../src/main";
import { PromiseQueue } from "../../src/promiseQueue";
import { GitSyncProvider } from "../../src/syncProvider/gitSyncProvider";

function makeProvider() {
    const plugin = {
        manifest: { id: "git-vault" },
        displayError: vi.fn(),
        settings: { lastSyncedRepoFingerprint: "" },
        saveSettings: vi.fn(async () => {}),
        commitAndSync: vi.fn(async () => {}),
        gitManager: {
            status: vi.fn(async () => ({
                changed: [{ path: "note.md" }],
                conflicted: [] as string[],
            })),
            branchInfo: vi.fn(async () => ({ current: "main", tracking: "" })),
            getRemotes: vi.fn(() => ({ first: () => null })),
        },
    };
    const instance = plugin as unknown as ObsidianGit;
    return { plugin, provider: new GitSyncProvider(instance), queue: new PromiseQueue(instance) };
}

describe("Native Git sync queue ownership", () => {
    it("completes from inside an existing serial queue task", async () => {
        const { plugin, provider, queue } = makeProvider();
        const result = await queue.addTask(() => provider.sync());
        expect(result).toMatchObject({ success: true, filesChanged: 1, conflicts: [] });
        expect(plugin.commitAndSync).toHaveBeenCalledOnce();
        expect(plugin.gitManager.status).toHaveBeenCalledOnce();
    });

    it("returns errors without stalling the queue", async () => {
        const { plugin, provider, queue } = makeProvider();
        plugin.commitAndSync.mockRejectedValueOnce(new Error("Git failure"));
        const result = await queue.addTask(() => provider.sync());
        expect(result).toMatchObject({ success: false, message: "Git failure" });
        expect(plugin.gitManager.status).not.toHaveBeenCalled();
    });

    it("preserves conflicted paths for resolution", async () => {
        const { plugin, provider, queue } = makeProvider();
        plugin.gitManager.status.mockResolvedValueOnce({ changed: [], conflicted: ["conflict.md"] });
        const result = await queue.addTask(() => provider.sync());
        expect(result).toMatchObject({ success: false, conflicts: [{ path: "conflict.md" }] });
    });
});
