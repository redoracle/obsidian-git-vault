import { Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "src/constants";
import type { SourceControlSectionContext } from "../renderContext";

const MIN_SOURCE_CONTROL_REFRESH_INTERVAL = 500;

export const renderSourceControlSection: (
    context: SourceControlSectionContext
) => void = (context) => {
    const { containerEl, plugin, setNonDefaultValue } = context;
    const updateRefreshDebouncer = () => context.updateRefreshDebouncer();
    new Setting(containerEl).setName("Source control view (Git)").setHeading();

    new Setting(containerEl)
        .setName("Refresh source control view on file changes")
        .setDesc(
            "On slower machines this may cause lags. If so, just disable this option."
        )
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.refreshSourceControl)
                .onChange(async (value) => {
                    plugin.settings.refreshSourceControl = value;
                    await plugin.saveSettings();
                    updateRefreshDebouncer();
                })
        );

    new Setting(containerEl)
        .setName("Refresh delay (ms)")
        .setDesc(
            "Milliseconds to wait after file change before refreshing the Source Control View."
        )
        .addText((text) => {
            text.inputEl.type = "number";
            setNonDefaultValue({
                text,
                settingsProperty: "refreshSourceControlTimer",
            });
            text.setPlaceholder(
                String(DEFAULT_SETTINGS.refreshSourceControlTimer)
            );
            text.onChange(async (value) => {
                if (value !== "" && Number.isInteger(Number(value))) {
                    plugin.settings.refreshSourceControlTimer = Math.max(
                        Number(value),
                        MIN_SOURCE_CONTROL_REFRESH_INTERVAL
                    );
                } else {
                    plugin.settings.refreshSourceControlTimer =
                        DEFAULT_SETTINGS.refreshSourceControlTimer;
                }
                text.setValue(
                    String(plugin.settings.refreshSourceControlTimer)
                );
                await plugin.saveSettings();
                updateRefreshDebouncer();
            });
        });
};
