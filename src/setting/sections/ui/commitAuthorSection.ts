import { Setting, type TextComponent } from "obsidian";
import type { CommitAuthorSectionContext } from "../renderContext";

export const renderCommitAuthorSection: (
    context: CommitAuthorSectionContext
) => Promise<void> = async (context) => {
    const { containerEl, gitReady, getConfig, setConfig, plugin } = context;
    const sectionEl = containerEl.createDiv({
        cls: "git-vault-commit-author-section",
    });
    new Setting(sectionEl)
        .setName("Commit author")
        .setDesc(
            "Used for commits Git Vault creates in this vault. Saved to this repository's local Git config."
        )
        .setHeading();

    let authorNameWriteTimer: number | undefined;
    let authorEmailWriteTimer: number | undefined;

    const debounceConfigWrite = (
        timer: number | undefined,
        input: TextComponent,
        key: "user.name" | "user.email",
        value: string
    ): number => {
        if (timer !== undefined) {
            window.clearTimeout(timer);
        }
        return window.setTimeout(() => {
            void (async () => {
                try {
                    await setConfig(key, value === "" ? undefined : value);
                } catch (error: unknown) {
                    console.error("Failed to update commit author config", {
                        key,
                        value,
                        error,
                    });
                    plugin.showNotice(
                        `Failed to save ${key} = ${JSON.stringify(value)}`,
                        7000
                    );

                    try {
                        const persistedValue = (await getConfig(key)) ?? "";
                        input.setValue(persistedValue);
                    } catch (restoreError: unknown) {
                        console.error(
                            "Failed to restore commit author config after write failure",
                            {
                                key,
                                value,
                                restoreError,
                            }
                        );
                    }
                }
            })();
        }, 300);
    };

    if (gitReady) {
        let authorName = "";
        let authorEmail = "";

        try {
            const [loadedAuthorName, loadedAuthorEmail] = await Promise.all([
                getConfig("user.name"),
                getConfig("user.email"),
            ]);
            authorName = loadedAuthorName ?? "";
            authorEmail = loadedAuthorEmail ?? "";
        } catch (error) {
            console.error("Failed to load commit author config", error);
        }

        new Setting(sectionEl).setName("Author name").addText((cb) => {
            cb.setValue(authorName);
            cb.onChange((value) => {
                authorNameWriteTimer = debounceConfigWrite(
                    authorNameWriteTimer,
                    cb,
                    "user.name",
                    value
                );
            });
        });

        new Setting(sectionEl).setName("Author email").addText((cb) => {
            cb.setValue(authorEmail);
            cb.onChange((value) => {
                authorEmailWriteTimer = debounceConfigWrite(
                    authorEmailWriteTimer,
                    cb,
                    "user.email",
                    value
                );
            });
        });
    }
};
