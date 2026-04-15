import { Setting } from "obsidian";
import type {
    HistorySectionContext,
    ShowAuthorInHistoryView,
} from "../renderContext";

export const renderHistorySection: (context: HistorySectionContext) => void = (
    context
) => {
    const { containerEl, plugin, refreshPlugin } = context;
    new Setting(containerEl).setName("History view (Git)").setHeading();

    new Setting(containerEl)
        .setName("Show author")
        .setDesc("Show the author of the commit in the history view.")
        .addDropdown((dropdown) => {
            const options: Record<ShowAuthorInHistoryView, string> = {
                hide: "Hide",
                full: "Full",
                initials: "Initials",
            };
            dropdown.addOptions(options);
            dropdown.setValue(plugin.settings.authorInHistoryView);
            dropdown.onChange(async (option) => {
                plugin.settings.authorInHistoryView =
                    option as ShowAuthorInHistoryView;
                await plugin.saveSettings();
                await refreshPlugin();
            });
        });

    new Setting(containerEl)
        .setName("Show date")
        .setDesc(
            "Show the date of the commit in the history view. The {{date}} placeholder format is used to display the date."
        )
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.settings.dateInHistoryView)
                .onChange(async (value) => {
                    plugin.settings.dateInHistoryView = value;
                    await plugin.saveSettings();
                    await refreshPlugin();
                })
        );
};
