import { describe, it, expect, vi } from "vitest";
import {
    SettingsPersistenceService,
    SETTINGS_CHANGE_CLASS,
    type IPersistencePluginContext,
} from "../../src/setting/controller/settingsPersistenceService";
import { DEFAULT_SETTINGS } from "../../src/constants";
import type { ObsidianGitSettings } from "../../src/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePlugin(
    patch: Partial<ObsidianGitSettings> = {}
): IPersistencePluginContext {
    return {
        settings: { ...DEFAULT_SETTINGS, ...patch } as ObsidianGitSettings,
        saveSettings: vi.fn().mockResolvedValue(undefined),
    };
}

function makeService(plugin: IPersistencePluginContext = makePlugin()) {
    const reloadSyncManager = vi.fn().mockResolvedValue(undefined);
    const scheduleRedraw = vi.fn();
    const svc = new SettingsPersistenceService(
        plugin,
        reloadSyncManager,
        scheduleRedraw
    );
    return { svc, plugin, reloadSyncManager, scheduleRedraw };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SettingsPersistenceService", () => {
    describe("persistOnly()", () => {
        it("saves settings without reloading or redrawing", async () => {
            const { svc, plugin, reloadSyncManager, scheduleRedraw } =
                makeService();
            await svc.persistOnly();
            expect(plugin.saveSettings).toHaveBeenCalledOnce();
            expect(reloadSyncManager).not.toHaveBeenCalled();
            expect(scheduleRedraw).not.toHaveBeenCalled();
        });
    });

    describe("persistAndReloadSync()", () => {
        it("saves settings and reloads sync manager", async () => {
            const { svc, plugin, reloadSyncManager, scheduleRedraw } =
                makeService();
            await svc.persistAndReloadSync();
            expect(plugin.saveSettings).toHaveBeenCalledOnce();
            expect(reloadSyncManager).toHaveBeenCalledOnce();
            expect(scheduleRedraw).not.toHaveBeenCalled();
        });
    });

    describe("persistAndReloadSyncAndRedraw()", () => {
        it("saves settings, reloads, and schedules redraw", async () => {
            const { svc, plugin, reloadSyncManager, scheduleRedraw } =
                makeService();
            await svc.persistAndReloadSyncAndRedraw();
            expect(plugin.saveSettings).toHaveBeenCalledOnce();
            expect(reloadSyncManager).toHaveBeenCalledOnce();
            expect(scheduleRedraw).toHaveBeenCalledOnce();
        });
    });

    describe("commit()", () => {
        it("sets the field value before saving", async () => {
            const plugin = makePlugin({ githubOwner: "old-owner" });
            const { svc } = makeService(plugin);
            await svc.commit("githubOwner", "new-owner");
            expect(plugin.settings.githubOwner).toBe("new-owner");
            expect(plugin.saveSettings).toHaveBeenCalled();
        });

        it("triggers reload-sync for 'githubOwner' (reload-sync class)", async () => {
            const plugin = makePlugin();
            const { svc, reloadSyncManager } = makeService(plugin);
            await svc.commit("githubOwner", "my-org");
            expect(reloadSyncManager).toHaveBeenCalled();
        });

        it("triggers redraw for 'disablePopups' (redraw-only class)", async () => {
            const plugin = makePlugin();
            const { svc, reloadSyncManager, scheduleRedraw } = makeService(plugin);
            await svc.commit("disablePopups", true);
            expect(reloadSyncManager).not.toHaveBeenCalled();
            expect(scheduleRedraw).toHaveBeenCalled();
        });

        it("neither reloads nor redraws for 'commitMessage' (persist-only class)", async () => {
            const plugin = makePlugin();
            const { svc, reloadSyncManager, scheduleRedraw } = makeService(plugin);
            await svc.commit("commitMessage", "feat: {{files}}");
            expect(reloadSyncManager).not.toHaveBeenCalled();
            expect(scheduleRedraw).not.toHaveBeenCalled();
        });
    });

    describe("commitBatch()", () => {
        it("applies all changes to settings before saving", async () => {
            const plugin = makePlugin();
            const { svc } = makeService(plugin);
            await svc.commitBatch({
                githubOwner: "batch-org",
                githubRepo: "batch-repo",
            });
            expect(plugin.settings.githubOwner).toBe("batch-org");
            expect(plugin.settings.githubRepo).toBe("batch-repo");
        });

        it("uses the most severe class among the batch (reload-sync wins)", async () => {
            const plugin = makePlugin();
            const { svc, reloadSyncManager } = makeService(plugin);
            // commitMessage is persist-only, githubOwner is reload-sync
            await svc.commitBatch({ commitMessage: "fix: typo", githubOwner: "org" });
            expect(reloadSyncManager).toHaveBeenCalled();
        });
    });

    describe("serialisation", () => {
        it("serialises concurrent persist calls", async () => {
            const log: string[] = [];
            const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
            const plugin: IPersistencePluginContext = {
                settings: { ...DEFAULT_SETTINGS } as ObsidianGitSettings,
                saveSettings: vi.fn().mockImplementation(async () => {
                    log.push("save-start");
                    await delay();
                    log.push("save-end");
                }),
            };
            const reloadSyncManager = vi.fn().mockImplementation(async () => {
                log.push("reload-start");
                await delay();
                log.push("reload-end");
            });
            const scheduleRedraw = vi.fn();
            const svc = new SettingsPersistenceService(
                plugin,
                reloadSyncManager,
                scheduleRedraw
            );

            // Fire two concurrent calls; both should complete without interleaving.
            await Promise.all([
                svc.persistAndReloadSync(),
                svc.persistAndReloadSync(),
            ]);

            expect(log).toEqual([
                "save-start",
                "save-end",
                "reload-start",
                "reload-end",
                "save-start",
                "save-end",
                "reload-start",
                "reload-end",
            ]);
        });

        it("continues queue processing even if reloadSyncManager throws", async () => {
            let callCount = 0;
            const plugin = makePlugin();
            const reloadSyncManager = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) throw new Error("reload failed");
            });
            const scheduleRedraw = vi.fn();
            const svc = new SettingsPersistenceService(
                plugin,
                reloadSyncManager,
                scheduleRedraw
            );

            await svc.persistAndReloadSync(); // first call throws inside reload
            await svc.persistAndReloadSync(); // second call must still execute

            expect(reloadSyncManager).toHaveBeenCalledTimes(2);
            expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
        });
    });

    describe("SETTINGS_CHANGE_CLASS", () => {
        it("classifies activeSyncProvider as reload-sync", () => {
            expect(SETTINGS_CHANGE_CLASS.activeSyncProvider).toBe("reload-sync");
        });

        it("classifies disablePopups as redraw-only", () => {
            expect(SETTINGS_CHANGE_CLASS.disablePopups).toBe("redraw-only");
        });

        it("has no entry for commitMessage (defaults to persist-only)", () => {
            expect(SETTINGS_CHANGE_CLASS.commitMessage).toBeUndefined();
        });
    });
});
