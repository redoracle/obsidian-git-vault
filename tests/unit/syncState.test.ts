import { describe, expect, it } from "vitest";
import { SyncStateManager } from "../../src/syncProvider/syncState";

describe("SyncStateManager", () => {
    it("freezes cached git status in returned snapshots", () => {
        const manager = new SyncStateManager();
        manager.updateCachedGitStatus({
            all: [
                {
                    path: "note.md",
                    vaultPath: "note.md",
                    index: "M",
                    workingDir: "M",
                },
            ],
            changed: [],
            staged: [],
            conflicted: [],
        });

        const snapshot = manager.getState();

        expect(snapshot.cachedGitStatus).not.toBeNull();
        expect(Object.isFrozen(snapshot.cachedGitStatus)).toBe(true);
        expect(Object.isFrozen(snapshot.cachedGitStatus?.all)).toBe(true);

        expect(() => {
            snapshot.cachedGitStatus?.all.push({
                path: "another.md",
                vaultPath: "another.md",
                index: "A",
                workingDir: "A",
            });
        }).toThrow();

        expect(manager.getCachedGitStatus()?.all).toHaveLength(1);
    });
});
