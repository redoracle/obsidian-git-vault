import { Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "src/constants";
import type ObsidianGit from "src/main";
import type { ObsidianGitSettings } from "src/types";
import { formatMinutes } from "src/utils";

export function renderAutomaticSection({
    containerEl,
    plugin,
    mayDisableSetting,
    setNonDefaultValue,
    refreshDisplayWithDelay,
}: {
    containerEl: HTMLElement;
    plugin: ObsidianGit;
    mayDisableSetting: (setting: Setting, disable: boolean) => void;
    setNonDefaultValue: (args: {
        settingsProperty: keyof ObsidianGitSettings;
        text:
            | import("obsidian").TextComponent
            | import("obsidian").TextAreaComponent;
    }) => void;
    refreshDisplayWithDelay: () => void;
}): void {
    const parseInterval = (value: string): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0
            ? parsed
            : DEFAULT_SETTINGS.autoSaveInterval;
    };

    new Setting(containerEl).setName("Scheduled Git sync").setHeading();

    new Setting(containerEl)
        .setName("Use separate commit and push timers")
        .setDesc("Enable to use one interval for commit and another for sync.")
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.differentIntervalCommitAndPush)
                .onChange(async (value) => {
                    plugin.settings.differentIntervalCommitAndPush = value;
                    await plugin.saveSettings();
                    plugin.automaticsManager.reload("commit", "push");
                    refreshDisplayWithDelay();
                })
        );

    let setting = new Setting(containerEl)
        .setName("Auto commit interval (minutes)")
        .setDesc(
            `${
                plugin.settings.differentIntervalCommitAndPush
                    ? "Commit"
                    : "Commit and sync"
            } changes every X minutes. Set to 0 (default) to disable. (See below setting for further configuration!)`
        )
        .addText((text) => {
            text.inputEl.type = "number";
            setNonDefaultValue({
                text,
                settingsProperty: "autoSaveInterval",
            });
            text.setPlaceholder(String(DEFAULT_SETTINGS.autoSaveInterval));
            text.onChange(async (value) => {
                plugin.settings.autoSaveInterval = parseInterval(value);
                await plugin.saveSettings();
                plugin.automaticsManager.reload("commit");
            });
        });

    setting = new Setting(containerEl)
        .setName("Commit after file-edit idle period")
        .setDesc(
            `Requires the commit interval not to be 0.
                        If turned on, do auto commit every ${formatMinutes(
                            plugin.settings.autoSaveInterval
                        )} after stopping file edits.
                        This also prevents auto commit while editing a file. If turned off, it's independent from the last file edit.`
        )
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.autoBackupAfterFileChange)
                .onChange(async (value) => {
                    plugin.settings.autoBackupAfterFileChange = value;
                    refreshDisplayWithDelay();

                    await plugin.saveSettings();
                    plugin.automaticsManager.reload("commit");
                })
        );
    mayDisableSetting(setting, plugin.settings.autoSaveInterval === 0);

    setting = new Setting(containerEl)
        .setName("Auto push interval (minutes)")
        .setDesc("Push commits every X minutes. Set to 0 (default) to disable.")
        .addText((text) => {
            text.inputEl.type = "number";
            setNonDefaultValue({
                text,
                settingsProperty: "autoPushInterval",
            });
            text.setPlaceholder(String(DEFAULT_SETTINGS.autoPushInterval));
            text.onChange(async (value) => {
                const parsed = Number(value);
                plugin.settings.autoPushInterval =
                    Number.isFinite(parsed) && parsed >= 0
                        ? parsed
                        : DEFAULT_SETTINGS.autoPushInterval;
                await plugin.saveSettings();
                plugin.automaticsManager.reload("push");
            });
        });
    mayDisableSetting(setting, !plugin.settings.differentIntervalCommitAndPush);

    new Setting(containerEl)
        .setName("Auto pull interval (minutes)")
        .setDesc("Pull changes every X minutes. Set to 0 (default) to disable.")
        .addText((text) => {
            text.inputEl.type = "number";
            setNonDefaultValue({
                text,
                settingsProperty: "autoPullInterval",
            });
            text.setPlaceholder(String(DEFAULT_SETTINGS.autoPullInterval));
            text.onChange(async (value) => {
                const parsed = Number(value);
                plugin.settings.autoPullInterval =
                    Number.isFinite(parsed) && parsed >= 0
                        ? parsed
                        : DEFAULT_SETTINGS.autoPullInterval;
                await plugin.saveSettings();
                plugin.automaticsManager.reload("pull");
            });
        });

    new Setting(containerEl)
        .setName("Commit only staged files automatically")
        .setDesc(
            "If turned on, only staged files are committed on commit. If turned off, all changed files are committed."
        )
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.autoCommitOnlyStaged)
                .onChange(async (value) => {
                    plugin.settings.autoCommitOnlyStaged = value;
                    await plugin.saveSettings();
                })
        );

    new Setting(containerEl)
        .setName("Prompt for a custom auto-commit message")
        .setDesc("You will get a pop up to specify your message.")
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.customMessageOnAutoBackup)
                .onChange(async (value) => {
                    plugin.settings.customMessageOnAutoBackup = value;
                    await plugin.saveSettings();
                    refreshDisplayWithDelay();
                })
        );

    setting = new Setting(containerEl)
        .setName("Default auto-commit message")
        .setDesc(
            "Available placeholders: {{date}} (see below), {{hostname}} (see below), {{numFiles}} (number of changed files in the commit) and {{files}} (changed files in commit message)."
        )
        .addTextArea((text) => {
            text.setPlaceholder(DEFAULT_SETTINGS.autoCommitMessage).onChange(
                async (value) => {
                    if (value === "") {
                        plugin.settings.autoCommitMessage =
                            DEFAULT_SETTINGS.autoCommitMessage;
                    } else {
                        plugin.settings.autoCommitMessage = value;
                    }
                    await plugin.saveSettings();
                }
            );
            setNonDefaultValue({
                text,
                settingsProperty: "autoCommitMessage",
            });
        });
    mayDisableSetting(setting, plugin.settings.customMessageOnAutoBackup);
}
