import { Setting } from "obsidian";
import type ObsidianGit from "src/main";
import type { MergeStrategy, ObsidianGitSettings, SyncMethod } from "src/types";

export function renderPullSection({
    containerEl,
    plugin,
    refreshDisplayWithDelay,
}: {
    containerEl: HTMLElement;
    plugin: ObsidianGit;
    refreshDisplayWithDelay: () => void;
}): void {
    new Setting(containerEl).setName("Git sync behavior").setHeading();

    if (plugin.useSimpleGit) {
        new Setting(containerEl)
            .setName("Merge strategy")
            .setDesc(
                "Decide how to integrate commits from your remote branch into your local branch."
            )
            .addDropdown((dropdown) => {
                const options: Record<SyncMethod, string> = {
                    merge: "Merge",
                    rebase: "Rebase",
                    reset: "Other sync service (Only updates the HEAD without touching the working directory)",
                };
                dropdown.addOptions(options);
                dropdown.setValue(plugin.settings.syncMethod);

                dropdown.onChange(async (option) => {
                    const syncMethod = option as SyncMethod;
                    plugin.settings.syncMethod = syncMethod;
                    await plugin.saveSettings();
                });
            });
    }

    new Setting(containerEl)
        .setName("Conflict merge strategy during pull")
        .setDesc(
            "Decide how to solve conflicts when pulling remote changes. This can be used to favor your local changes or the remote changes automatically."
        )
        .addDropdown((dropdown) => {
            const options: Record<MergeStrategy, string> = {
                none: "None (git default)",
                ours: "Our changes",
                theirs: "Their changes",
            };
            dropdown.addOptions(options);
            dropdown.setValue(plugin.settings.mergeStrategy);

            dropdown.onChange(async (option) => {
                plugin.settings.mergeStrategy = option as MergeStrategy;
                await plugin.saveSettings();
            });
        });

    new Setting(containerEl)
        .setName("Pull on startup")
        .setDesc("Automatically pull commits when Obsidian starts.")
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.autoPullOnBoot)
                .onChange(async (value) => {
                    plugin.settings.autoPullOnBoot = value;
                    await plugin.saveSettings();
                })
        );

    new Setting(containerEl)
        .setName("Commit-and-sync")
        .setDesc(
            "Commit-and-sync with default settings means staging everything -> committing -> pulling -> pushing. Ideally this is a single action that you do regularly to keep your local and remote repository in sync."
        )
        .setHeading();

    new Setting(containerEl)
        .setName("Push on commit-and-sync")
        .setDesc(
            `Most of the time you want to push after committing. Turning this off turns a commit-and-sync action into commit ${plugin.settings.pullBeforePush ? "and pull " : ""}only. It will still be called commit-and-sync.`
        )
        .addToggle((toggle) =>
            toggle
                .setValue(!plugin.settings.disablePush)
                .onChange(async (value) => {
                    plugin.settings.disablePush = !value;
                    refreshDisplayWithDelay();
                    await plugin.saveSettings();
                })
        );

    new Setting(containerEl)
        .setName("Pull on commit-and-sync")
        .setDesc(
            `On commit-and-sync, pull commits as well. Turning this off turns a commit-and-sync action into commit ${plugin.settings.disablePush ? "" : "and push "}only.`
        )
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.pullBeforePush)
                .onChange(async (value) => {
                    plugin.settings.pullBeforePush = value;
                    refreshDisplayWithDelay();
                    await plugin.saveSettings();
                })
        );

    if (plugin.useSimpleGit) {
        new Setting(containerEl)
            .setName("Editor hunk tools")
            .setDesc(
                "Hunks are sections of grouped line changes right in your editor."
            )
            .setHeading();

        new Setting(containerEl)
            .setName("Signs")
            .setDesc(
                "This allows you to see your changes right in your editor via colored markers and stage/reset/preview individual hunks."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.hunks.showSigns)
                    .onChange(async (value) => {
                        plugin.settings.hunks.showSigns = value;
                        await plugin.saveSettings();
                        plugin.editorIntegration.refreshSignsSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Hunk commands")
            .setDesc(
                "Adds commands to stage/reset individual Git diff hunks and navigate between them via 'Go to next/prev hunk' commands."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.hunks.hunkCommands)
                    .onChange(async (value) => {
                        plugin.settings.hunks.hunkCommands = value;
                        await plugin.saveSettings();

                        plugin.editorIntegration.refreshSignsSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Status bar with summary of line changes")
            .addDropdown((dropdown) =>
                dropdown
                    .addOptions({
                        disabled: "Disabled",
                        colored: "Colored",
                        monochrome: "Monochrome",
                    })
                    .setValue(plugin.settings.hunks.statusBar)
                    .onChange(async (option) => {
                        plugin.settings.hunks.statusBar =
                            option as ObsidianGitSettings["hunks"]["statusBar"];
                        await plugin.saveSettings();
                        plugin.editorIntegration.refreshSignsSettings();
                    })
            );
    }
}
