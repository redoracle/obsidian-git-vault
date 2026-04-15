import { describe, it, expect, vi } from "vitest";
import AutomaticsManager from "../../src/automaticsManager";
import type ObsidianGit from "../../src/main";

function createPluginStub(): Partial<ObsidianGit> {
    const plugin = {
        settings: {
            autoSaveInterval: 1,
            autoBackupAfterFileChange: true,
            autoCommitOnlyStaged: false,
            differentIntervalCommitAndPush: false,
            autoPushInterval: 0,
            autoPullInterval: 0,
        },
        localStorage: {
            getPausedAutomatics: () => false,
            setLastAutoBackup: vi.fn(),
            setLastAutoPull: vi.fn(),
            setLastAutoPush: vi.fn(),
            getLastAutoBackup: () => "",
            getLastAutoPull: () => "",
            getLastAutoPush: () => "",
        },
        promiseQueue: {
            addTask: vi.fn(async (task: () => Promise<unknown>, onFinish?: (res: unknown) => void) => {
                const res = await task();
                onFinish?.(res);
                return res;
            }),
        },
        gitManager: { getLastCommitTime: vi.fn(() => Promise.resolve(null)) },
        commit: vi.fn(() => Promise.resolve(true)),
        commitAndSync: vi.fn(() => Promise.resolve(true)),
        push: vi.fn(() => Promise.resolve(true)),
        pullChangesFromRemote: vi.fn(() => Promise.resolve()),
        areVaultChangeEffectsSuppressed: () => false,
        isBranchSwitchInProgress: false,
    } as unknown as Partial<ObsidianGit>;

    return plugin;
}

describe("AutomaticsManager suppression", () => {
    it("does not run auto-commit when branch switch suppression is active", async () => {
        const plugin = createPluginStub();
        const automatics = new AutomaticsManager(plugin as unknown as ObsidianGit);

        // Make the manager initialize its debouncer by reporting a recent
        // "last auto" time so startAutoCommitAndSync creates the debouncer
        // (instead of triggering an immediate run).
        plugin.localStorage!.getLastAutoBackup = () => new Date().toString();

        vi.useFakeTimers();
        try {
            await automatics.init();

            // Simulate suppression (branch switch in progress)
            plugin.areVaultChangeEffectsSuppressed = () => true;
            plugin.isBranchSwitchInProgress = true;

            automatics.handleFileChange();
            // Advance timers to trigger any debounced invocation
            vi.runAllTimers();
            // allow any microtasks to complete
            await Promise.resolve();
            expect(plugin.commitAndSync).not.toHaveBeenCalled();

            // Clear suppression and run again, commit should run
            plugin.areVaultChangeEffectsSuppressed = () => false;
            plugin.isBranchSwitchInProgress = false;

            automatics.handleFileChange();
            vi.runAllTimers();
            await Promise.resolve();
            expect(plugin.commitAndSync).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
