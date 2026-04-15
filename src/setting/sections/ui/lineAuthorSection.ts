import { moment, Platform, Setting } from "obsidian";
import {
    DEFAULT_SETTINGS,
    GIT_LINE_AUTHORING_MOVEMENT_DETECTION_MINIMAL_LENGTH,
} from "src/constants";
import { previewColor } from "src/editor/lineAuthor/lineAuthorProvider";
import type {
    LineAuthorDateTimeFormatOptions,
    LineAuthorDisplay,
    LineAuthorFollowMovement,
    LineAuthorSettings,
    LineAuthorTimezoneOption,
} from "src/editor/lineAuthor/model";
import type ObsidianGit from "src/main";
import type { ObsidianGitSettings } from "src/types";
import { convertToRgb, rgbToString } from "src/utils";
import {
    lineAuthorAvailabilityDescription,
    parseColoringMaxAgeDuration,
    pickColor,
} from "src/setting/settingsHelpers";

const FORMAT_STRING_REFERENCE_URL =
    "https://momentjs.com/docs/#/parsing/string-format/";
const LINE_AUTHOR_FEATURE_WIKI_LINK =
    "https://publish.obsidian.md/git-doc/Line+Authoring";

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

type LineAuthorSettingHandler = <
    K extends keyof ObsidianGitSettings["lineAuthor"],
>(
    key: K,
    value: ObsidianGitSettings["lineAuthor"][K]
) => Promise<void>;

export function renderLineAuthorSection({
    containerEl,
    plugin,
    configureLineAuthorShowStatus,
    lineAuthorSettingHandler,
    refreshDisplayWithDelay,
}: {
    containerEl: HTMLElement;
    plugin: ObsidianGit;
    configureLineAuthorShowStatus: (show: boolean) => void;
    lineAuthorSettingHandler: LineAuthorSettingHandler;
    refreshDisplayWithDelay: () => void;
}): void {
    const lineAuthorColorSettings = new Map<"oldest" | "newest", Setting>();

    const previewCustomDateTimeDescriptionHtml = (
        dateTimeFormatCustomString: string
    ) => {
        const formattedDateTime = moment
            .utc()
            .local()
            .format(dateTimeFormatCustomString);
        return `<a href="${FORMAT_STRING_REFERENCE_URL}">Format string</a> to display the authoring date.<br/>Currently: ${escapeHtml(
            formattedDateTime
        )}`;
    };

    const previewOldestAgeDescriptionHtml = (coloringMaxAge: string) => {
        const duration = parseColoringMaxAgeDuration(coloringMaxAge);
        const durationString =
            duration !== undefined ? `${duration.asDays()} days` : "invalid!";
        return [
            `The oldest age in the line author coloring. Everything older will have the same color.
            </br>Smallest valid age is "1d". Currently: ${durationString}`,
            duration,
        ] as const;
    };

    const colorSettingPreviewDescHtml = (
        which: "oldest" | "newest",
        laSettings: LineAuthorSettings,
        colorIsValid: boolean
    ): string => {
        const rgbStr = colorIsValid
            ? previewColor(which, laSettings)
            : `rgba(127,127,127,0.3)`;
        const today = moment.utc().local().format("YYYY-MM-DD");
        const text = colorIsValid
            ? `abcdef Author Name ${today}`
            : "invalid color";
        const preview = `<div
            class="line-author-settings-preview"
            style="background-color: ${rgbStr}; width: 30ch;"
            >${text}</div>`;

        return `Supports 'rgb(r,g,b)', 'hsl(h,s,l)', hex (#) and
            named colors (e.g. 'black', 'purple'). Color preview: ${preview}`;
    };

    const refreshColorSettingsName = (which: "oldest" | "newest") => {
        const settingsDom = lineAuthorColorSettings.get(which);
        if (settingsDom) {
            const whichDescriber =
                which === "oldest"
                    ? `oldest (${plugin.settings.lineAuthor.coloringMaxAge} or older)`
                    : "newest";
            settingsDom.nameEl.innerText = `Color for ${whichDescriber} commits`;
        }
    };

    const refreshColorSettingsDesc = (
        which: "oldest" | "newest",
        rgb?: { r: number; g: number; b: number }
    ) => {
        const settingsDom = lineAuthorColorSettings.get(which);
        if (settingsDom) {
            settingsDom.descEl.innerHTML = colorSettingPreviewDescHtml(
                which,
                plugin.settings.lineAuthor,
                rgb !== undefined
            );
        }
    };

    const createColorSetting = (which: "oldest" | "newest") => {
        const setting = new Setting(containerEl).setName("").addText((text) => {
            const color = pickColor(which, plugin.settings.lineAuthor);
            const defaultColor = pickColor(which, DEFAULT_SETTINGS.lineAuthor);
            text.setPlaceholder(rgbToString(defaultColor));
            text.setValue(rgbToString(color));
            text.onChange(async (colorNew) => {
                const rgb = convertToRgb(colorNew);
                if (rgb !== undefined) {
                    const key = which === "newest" ? "colorNew" : "colorOld";
                    await lineAuthorSettingHandler(key, rgb);
                }
                refreshColorSettingsDesc(which, rgb);
            });
        });
        lineAuthorColorSettings.set(which, setting);

        refreshColorSettingsName(which);
        refreshColorSettingsDesc(
            which,
            pickColor(which, plugin.settings.lineAuthor)
        );
    };

    const baseLineAuthorInfoSetting = new Setting(containerEl).setName(
        "Show commit authoring information next to each line"
    );
    const lineAuthorAvailability = lineAuthorAvailabilityDescription({
        isDesktopApp: Platform.isDesktopApp,
        usesGitBackend: plugin.useSimpleGit,
    });

    if (!lineAuthorAvailability.available) {
        baseLineAuthorInfoSetting
            .setDesc(lineAuthorAvailability.description)
            .setDisabled(true);
        return;
    }

    baseLineAuthorInfoSetting.descEl.innerHTML = `
            <a href="${LINE_AUTHOR_FEATURE_WIKI_LINK}">Feature guide and quick examples</a></br>
            The commit hash, author name, and authoring date can all be individually toggled.</br>
            Hide everything to show only the age-colored sidebar.</br>
            Available only on desktop while the <strong>Git</strong> backend is active.`;

    baseLineAuthorInfoSetting.addToggle((toggle) =>
        toggle.setValue(plugin.settings.lineAuthor.show).onChange((value) => {
            configureLineAuthorShowStatus(value);
            refreshDisplayWithDelay();
        })
    );

    if (plugin.settings.lineAuthor.show) {
        const trackMovement = new Setting(containerEl)
            .setName("Follow movement and copies across files and commits")
            .setDesc("")
            .addDropdown((dropdown) => {
                dropdown.addOptions(<Record<LineAuthorFollowMovement, string>>{
                    inactive: "Do not follow (default)",
                    "same-commit": "Follow within same commit",
                    "all-commits": "Follow within all commits (maybe slow)",
                });
                dropdown.setValue(plugin.settings.lineAuthor.followMovement);
                dropdown.onChange((value) =>
                    lineAuthorSettingHandler(
                        "followMovement",
                        value as LineAuthorFollowMovement
                    )
                );
            });
        trackMovement.descEl.innerHTML = `
                By default (deactivated), each line only shows the newest commit where it was changed.
                <br/>
                With <i>same commit</i>, cut-copy-paste-ing of text is followed within the same commit and the original commit of authoring will be shown.
                <br/>
                With <i>all commits</i>, cut-copy-paste-ing text inbetween multiple commits will be detected.
                <br/>
                It uses <a href="https://git-scm.com/docs/git-blame">git-blame</a> and
                for matches (at least ${GIT_LINE_AUTHORING_MOVEMENT_DETECTION_MINIMAL_LENGTH} characters) within the same (or all) commit(s), <em>the originating</em> commit's information is shown.`;

        new Setting(containerEl)
            .setName("Show commit hash")
            .addToggle((tgl) => {
                tgl.setValue(plugin.settings.lineAuthor.showCommitHash);
                tgl.onChange((value: boolean) =>
                    lineAuthorSettingHandler("showCommitHash", value)
                );
            });

        new Setting(containerEl)
            .setName("Author name display")
            .setDesc("If and how the author is displayed")
            .addDropdown((dropdown) => {
                const options: Record<LineAuthorDisplay, string> = {
                    hide: "Hide",
                    initials: "Initials (default)",
                    "first name": "First name",
                    "last name": "Last name",
                    full: "Full name",
                };
                dropdown.addOptions(options);
                dropdown.setValue(plugin.settings.lineAuthor.authorDisplay);

                dropdown.onChange(async (value) =>
                    lineAuthorSettingHandler(
                        "authorDisplay",
                        value as LineAuthorDisplay
                    )
                );
            });

        new Setting(containerEl)
            .setName("Authoring date display")
            .setDesc(
                "Choose whether to hide the authoring date, show only the date, show date and time, use natural language, or provide a custom format."
            )
            .addDropdown((dropdown) => {
                const options: Record<LineAuthorDateTimeFormatOptions, string> =
                    {
                        hide: "Hide",
                        date: "Date (default)",
                        datetime: "Date and time",
                        "natural language": "Natural language",
                        custom: "Custom",
                    };
                dropdown.addOptions(options);
                dropdown.setValue(
                    plugin.settings.lineAuthor.dateTimeFormatOptions
                );

                dropdown.onChange(async (value) => {
                    await lineAuthorSettingHandler(
                        "dateTimeFormatOptions",
                        value as LineAuthorDateTimeFormatOptions
                    );
                    refreshDisplayWithDelay();
                });
            });

        if (plugin.settings.lineAuthor.dateTimeFormatOptions === "custom") {
            const dateTimeFormatCustomStringSetting = new Setting(containerEl);

            dateTimeFormatCustomStringSetting
                .setName("Custom authoring date format")
                .addText((cb) => {
                    cb.setValue(
                        plugin.settings.lineAuthor.dateTimeFormatCustomString
                    );
                    cb.setPlaceholder("YYYY-MM-DD HH:mm");

                    cb.onChange(async (value) => {
                        await lineAuthorSettingHandler(
                            "dateTimeFormatCustomString",
                            value
                        );
                        dateTimeFormatCustomStringSetting.descEl.innerHTML =
                            previewCustomDateTimeDescriptionHtml(value);
                    });
                });

            dateTimeFormatCustomStringSetting.descEl.innerHTML =
                previewCustomDateTimeDescriptionHtml(
                    plugin.settings.lineAuthor.dateTimeFormatCustomString
                );
        }

        new Setting(containerEl)
            .setName("Authoring date display timezone")
            .addDropdown((dropdown) => {
                const options: Record<LineAuthorTimezoneOption, string> = {
                    "viewer-local": "My local (default)",
                    "author-local": "Author's local",
                    utc0000: "UTC+0000/Z",
                };
                dropdown.addOptions(options);
                dropdown.setValue(plugin.settings.lineAuthor.dateTimeTimezone);

                dropdown.onChange(async (value) =>
                    lineAuthorSettingHandler(
                        "dateTimeTimezone",
                        value as LineAuthorTimezoneOption
                    )
                );
            }).descEl.innerHTML = `
                    The time-zone in which the authoring date should be shown.
                    Either your local time-zone (default),
                    the author's time-zone during commit creation or
                    <a href="https://en.wikipedia.org/wiki/UTC%C2%B100:00">UTC±00:00</a>.
            `;

        const oldestAgeSetting = new Setting(containerEl).setName(
            "Oldest age in coloring"
        );

        oldestAgeSetting.descEl.innerHTML = previewOldestAgeDescriptionHtml(
            plugin.settings.lineAuthor.coloringMaxAge
        )[0];

        oldestAgeSetting.addText((text) => {
            text.setPlaceholder("1y");
            text.setValue(plugin.settings.lineAuthor.coloringMaxAge);
            text.onChange(async (value) => {
                const [preview, valid] = previewOldestAgeDescriptionHtml(value);
                oldestAgeSetting.descEl.innerHTML = preview;
                if (valid) {
                    await lineAuthorSettingHandler("coloringMaxAge", value);
                    refreshColorSettingsName("oldest");
                }
            });
        });

        createColorSetting("newest");
        createColorSetting("oldest");

        new Setting(containerEl).setName("Text color").addText((field) => {
            field.setValue(plugin.settings.lineAuthor.textColorCss);
            field.onChange(async (value) => {
                await lineAuthorSettingHandler("textColorCss", value);
            });
        }).descEl.innerHTML = `
                    The CSS color of the gutter text.<br/>

                    It is highly recommended to use
                    <a href="https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties">
                    CSS variables</a>
                    defined by themes
                    (e.g. <pre style="display:inline">var(--text-muted)</pre> or
                    <pre style="display:inline">var(--text-on-accent)</pre>,
                    because they automatically adapt to theme changes.<br/>

                    See: <a href="https://github.com/obsidian-community/obsidian-theme-template/blob/main/obsidian.css">
                    List of available CSS variables in Obsidian
                    </a>
                `;

        new Setting(containerEl)
            .setName("Ignore whitespace and newlines in changes")
            .addToggle((tgl) => {
                tgl.setValue(plugin.settings.lineAuthor.ignoreWhitespace);
                tgl.onChange((value) =>
                    lineAuthorSettingHandler("ignoreWhitespace", value)
                );
            }).descEl.innerHTML = `
                    Whitespace and newlines are interpreted as
                    part of the document and in changes
                    by default (hence not ignored).
                    This makes the last line being shown as 'changed'
                    when a new subsequent line is added,
                    even if the previously last line's text is the same.
                    <br>
                    If you don't care about purely-whitespace changes
                    (e.g. list nesting / quote indentation changes),
                    then activating this will provide more meaningful change detection.
                `;
    }
}
