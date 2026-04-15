import { Setting } from "obsidian";
import type ObsidianGit from "src/main";
import type { ObsidianGitSettings } from "src/types";

export function renderSyncBehaviorSection({
    containerEl,
    plugin,
    openConflictHistory,
    persistAndReloadSyncAndRedraw,
    persistAndReloadSync,
}: {
    containerEl: HTMLElement;
    plugin: ObsidianGit;
    openConflictHistory: () => Promise<void>;
    persistAndReloadSyncAndRedraw: () => Promise<void>;
    persistAndReloadSync: () => Promise<void>;
}): void {
    new Setting(containerEl)
        .setName("Sync behavior")
        .setDesc(
            "Set how Git Vault reacts to conflicts and when it should run automatically."
        )
        .setHeading();

    new Setting(containerEl)
        .setName("Conflict handling")
        .setDesc(
            "Choose how conflicts should be resolved when local and remote changes differ."
        )
        .setHeading();

    new Setting(containerEl)
        .setName("Conflict resolution strategy")
        .setDesc(
            "Choose how conflicts are handled when local and remote changes differ. Manual is the safer default and prompts you to review each conflict in the visual resolver before anything is overwritten."
        )
        .addDropdown((dd) => {
            dd.addOptions({
                "last-write-wins":
                    "Last write wins (may overwrite remote changes)",
                "always-local": "Always keep local",
                "always-remote": "Always keep remote",
                manual: "Manual (prompt before resolving)",
            });
            dd.setValue(plugin.settings.conflictResolutionStrategy);
            dd.onChange(async (v) => {
                plugin.settings.conflictResolutionStrategy =
                    v as ObsidianGitSettings["conflictResolutionStrategy"];
                await plugin.saveSettings();
            });
        });

    new Setting(containerEl)
        .setName("Conflict resolution history")
        .setDesc(
            "View a local log of past conflict resolutions without storing note contents."
        )
        .addButton((button) =>
            button.setButtonText("Open history").onClick(async () => {
                await openConflictHistory();
            })
        );

    new Setting(containerEl).setName("Smart sync triggers").setHeading();

    new Setting(containerEl)
        .setName("Sync on file change")
        .setDesc(
            "Automatically sync when notes are created, modified, or deleted."
        )
        .addToggle((t) => {
            t.setValue(plugin.settings.syncOnFileChange);
            t.onChange(async (v) => {
                plugin.settings.syncOnFileChange = v;
                await persistAndReloadSyncAndRedraw();
            });
        });

    if (plugin.settings.syncOnFileChange) {
        new Setting(containerEl)
            .setName("File-change debounce (ms)")
            .setDesc(
                "Wait this many ms after the last file change before syncing (default: 5000)."
            )
            .addText((t) => {
                t.inputEl.type = "number";
                t.setValue(String(plugin.settings.syncOnFileChangeDebounce));
                t.setPlaceholder("5000");
                t.onChange(async (v) => {
                    const n = Number(v);
                    plugin.settings.syncOnFileChangeDebounce =
                        Number.isFinite(n) && n >= 0 ? n : 5000;
                    await plugin.saveSettings();
                });
            });
    }

    new Setting(containerEl)
        .setName("Sync on app close")
        .setDesc("Trigger a sync when Obsidian quits.")
        .addToggle((t) => {
            t.setValue(plugin.settings.syncOnClose);
            t.onChange(async (v) => {
                plugin.settings.syncOnClose = v;
                await persistAndReloadSync();
            });
        });

    new Setting(containerEl)
        .setName("Sync on network reconnect")
        .setDesc(
            "Automatically sync when the device regains internet connectivity."
        )
        .addToggle((t) => {
            t.setValue(plugin.settings.syncOnNetworkReconnect);
            t.onChange(async (v) => {
                plugin.settings.syncOnNetworkReconnect = v;
                await persistAndReloadSync();
            });
        });

    new Setting(containerEl)
        .setName("Sync after idle time (minutes)")
        .setDesc(
            "Sync after this many minutes of inactivity. Set to -1 to disable."
        )
        .addText((t) => {
            t.inputEl.type = "number";
            t.setValue(String(plugin.settings.syncOnIdleMinutes));
            t.setPlaceholder("-1");
            t.onChange(async (v) => {
                const n = Number(v);
                plugin.settings.syncOnIdleMinutes = Number.isFinite(n)
                    ? n < 0
                        ? -1
                        : n
                    : -1;
                await persistAndReloadSync();
            });
        });
}
