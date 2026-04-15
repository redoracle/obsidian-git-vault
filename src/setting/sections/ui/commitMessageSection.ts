import { Setting } from "obsidian";
import { DATE_TIME_FORMAT_SECONDS, DEFAULT_SETTINGS } from "src/constants";
import type ObsidianGit from "src/main";

export function renderCommitMessageSection({
    containerEl,
    plugin,
    setNonDefaultValue,
}: {
    containerEl: HTMLElement;
    plugin: ObsidianGit;
    setNonDefaultValue: (args: {
        settingsProperty: keyof ObsidianGit["settings"];
        text:
            | import("obsidian").TextComponent
            | import("obsidian").TextAreaComponent;
    }) => void;
}): void {
    new Setting(containerEl).setName("Commit message").setHeading();

    const manualCommitMessageSetting = new Setting(containerEl)
        .setName("Commit message on manual commit")
        .setDesc(
            "Available placeholders: {{date}} (see below), {{hostname}} (see below), {{numFiles}} (number of changed files in the commit) and {{files}} (changed files in commit message). Leave empty to require manual input on each commit."
        );
    manualCommitMessageSetting.addTextArea((text) => {
        manualCommitMessageSetting.addButton((button) => {
            button
                .setIcon("reset")
                .setTooltip(
                    `Set to default: "${DEFAULT_SETTINGS.commitMessage}"`
                )
                .onClick(() => {
                    text.setValue(DEFAULT_SETTINGS.commitMessage);
                    text.onChanged();
                });
        });
        text.setValue(plugin.settings.commitMessage);
        text.onChange(async (value) => {
            plugin.settings.commitMessage = value;
            await plugin.saveSettings();
        });
    });

    new Setting(containerEl)
        .setName("Commit message script")
        .setDesc(
            "A script that is run using 'sh -c' to generate the commit message. May be used to generate commit messages using AI tools. Available placeholders: {{hostname}}, {{date}}."
        )
        .addText((text) => {
            text.setValue(plugin.settings.commitMessageScript);
            text.onChange(async (value) => {
                if (value === "") {
                    plugin.settings.commitMessageScript =
                        DEFAULT_SETTINGS.commitMessageScript;
                } else {
                    plugin.settings.commitMessageScript = value;
                }
                await plugin.saveSettings();
            });
            setNonDefaultValue({
                text,
                settingsProperty: "commitMessageScript",
            });
        });

    const datePlaceholderSetting = new Setting(containerEl)
        .setName("{{date}} placeholder format")
        .addMomentFormat((text) =>
            text
                .setDefaultFormat(DEFAULT_SETTINGS.commitDateFormat)
                .setValue(plugin.settings.commitDateFormat)
                .onChange(async (value) => {
                    plugin.settings.commitDateFormat = value;
                    await plugin.saveSettings();
                })
        );
    datePlaceholderSetting.descEl.innerHTML = `
            Specify custom date format. E.g. "${DATE_TIME_FORMAT_SECONDS}". See <a href="https://momentjs.com">Moment.js</a> for more formats.`;

    new Setting(containerEl)
        .setName("{{hostname}} placeholder replacement")
        .setDesc(
            "Specify custom hostname for every device. Defaults to the OS hostname if not set on desktop."
        )
        .addText((text) =>
            text
                .setValue(plugin.localStorage.getHostname() ?? "")
                .onChange((value) => {
                    plugin.localStorage.setHostname(value);
                })
        );

    new Setting(containerEl)
        .setName("Preview commit message")
        .addButton((button) =>
            button.setButtonText("Preview").onClick(async () => {
                const commitMessagePreview =
                    await plugin.gitManager.formatCommitMessage(
                        plugin.settings.commitMessage
                    );
                plugin.showNotice(commitMessagePreview);
            })
        );

    new Setting(containerEl)
        .setName("List filenames affected by commit in the commit body")
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.listChangedFilesInMessageBody)
                .onChange(async (value) => {
                    plugin.settings.listChangedFilesInMessageBody = value;
                    await plugin.saveSettings();
                })
        );
}
