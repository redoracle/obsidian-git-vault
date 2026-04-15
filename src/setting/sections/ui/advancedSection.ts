import { debounce, Platform, Setting } from "obsidian";
import type { SimpleGit } from "src/gitManager/simpleGit";
import type ObsidianGit from "src/main";
import { GeneralModal } from "src/ui/modals/generalModal";
import { splitRemoteBranch } from "src/utils";

export function renderAdvancedSection({
    containerEl,
    plugin,
    reloadSyncManager,
}: {
    containerEl: HTMLElement;
    plugin: ObsidianGit;
    reloadSyncManager: () => Promise<void>;
}): void {
    const updateGitPath = debounce((value: string) => {
        plugin.gitManager
            .updateGitPath(value || "git")
            .catch((error) => plugin.displayError(error));
    }, 300);

    new Setting(containerEl)
        .setName("Advanced")
        .setDesc(
            "These settings usually don't need to be changed, but may be required for special setups."
        )
        .setHeading();

    if (plugin.useSimpleGit) {
        new Setting(containerEl)
            .setName("Update submodules")
            .setDesc(
                '"Commit-and-sync" and "pull" takes care of submodules. Missing features: Conflicted files, count of pulled/pushed/committed files. Tracking branch needs to be set for each submodule.'
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.updateSubmodules)
                    .onChange(async (value) => {
                        plugin.settings.updateSubmodules = value;
                        await plugin.saveSettings();
                    })
            );
        if (plugin.settings.updateSubmodules) {
            new Setting(containerEl)
                .setName("Submodule recurse checkout/switch")
                .setDesc(
                    "Whenever a checkout happens on the root repository, recurse the checkout on the submodules (if the branches exist)."
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.submoduleRecurseCheckout)
                        .onChange(async (value) => {
                            plugin.settings.submoduleRecurseCheckout = value;
                            await plugin.saveSettings();
                        })
                );
        }
    }

    if (plugin.useSimpleGit)
        new Setting(containerEl)
            .setName("Custom Git binary path")
            .setDesc(
                "Specify the path to the Git binary/executable. Git should already be in your PATH. Should only be necessary for a custom Git installation."
            )
            .addText((cb) => {
                cb.setValue(plugin.localStorage.getGitPath() ?? "");
                cb.setPlaceholder("git");
                cb.onChange((value) => {
                    plugin.localStorage.setGitPath(value);
                    updateGitPath(value);
                });
            });

    if (plugin.useSimpleGit)
        new Setting(containerEl)
            .setName("Additional environment variables")
            .setDesc(
                "Use each line for a new environment variable in the format KEY=VALUE ."
            )
            .addTextArea((cb) => {
                cb.setPlaceholder("GIT_DIR=/path/to/git/dir");
                cb.setValue(plugin.localStorage.getEnvVars().join("\n"));
                cb.onChange((value) => {
                    plugin.localStorage.setEnvVars(value.split("\n"));
                });
            });

    if (plugin.useSimpleGit)
        new Setting(containerEl)
            .setName("Additional PATH environment variable paths")
            .setDesc("Use each line for one path")
            .addTextArea((cb) => {
                cb.setValue(plugin.localStorage.getPATHPaths().join("\n"));
                cb.onChange((value) => {
                    plugin.localStorage.setPATHPaths(value.split("\n"));
                });
            });
    if (plugin.useSimpleGit)
        new Setting(containerEl)
            .setName("Reload with new environment variables")
            .setDesc(
                "Removing previously added environment variables will not take effect until Obsidian is restarted."
            )
            .addButton((cb) => {
                cb.setButtonText("Reload");
                cb.setCta();
                cb.onClick(async () => {
                    try {
                        await (plugin.gitManager as SimpleGit).setGitInstance();
                        plugin.showNotice(
                            "Reloaded Git with the updated environment variables."
                        );
                    } catch (error) {
                        console.error("Failed to reload Git instance:", error);
                        plugin.displayError(
                            "Failed to reload Git with the updated environment variables."
                        );
                    }
                });
            });

    new Setting(containerEl)
        .setName("Custom base path (Git repository path)")
        .setDesc(
            `
            Sets the relative path to the vault from which the Git binary should be executed.
             Mostly used to set the path to the Git repository, which is only required if the Git repository is below the vault root directory. Use "\\" instead of "/" on Windows.
            `
        )
        .addText((cb) => {
            cb.setValue(plugin.settings.basePath);
            cb.setPlaceholder("directory/directory-with-git-repo");
            cb.onChange(async (value) => {
                plugin.settings.basePath = value;
                await plugin.saveSettings();
                plugin.gitManager
                    .updateBasePath(value || "")
                    .catch((e) => plugin.displayError(e));
            });
        });

    new Setting(containerEl)
        .setName("Custom Git directory path (Instead of '.git')")
        .setDesc(
            `Corresponds to the GIT_DIR environment variable. Requires restart of Obsidian to take effect. Use "\\" instead of "/" on Windows.`
        )
        .addText((cb) => {
            cb.setValue(plugin.settings.gitDir);
            cb.setPlaceholder(".git");
            cb.onChange(async (value) => {
                plugin.settings.gitDir = value;
                await plugin.saveSettings();
            });
        });

    if (plugin.useSimpleGit && plugin.settings.activeSyncProvider === "git") {
        let flattenForcePush = false;

        new Setting(containerEl)
            .setName("Flatten all commits into a single commit")
            .setDesc(
                "Rewrites the current branch history into one single root commit. Destructive and irreversible. Only available for the native Git provider on desktop. Optionally force-pushes to overwrite the remote history as well."
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(false)
                    .setTooltip(
                        "Force push after flattening (overwrites remote history)"
                    )
                    .onChange((v) => (flattenForcePush = v));
                const wrapper = toggle.toggleEl.parentElement;
                if (wrapper) {
                    wrapper.createEl("span", {
                        text: " Force push",
                        cls: "setting-item-description obsidian-git-force-push-label",
                    });
                }
            })
            .addButton((button) =>
                button
                    .setButtonText("Flatten now")
                    .setCta()
                    .onClick(async () => {
                        const info = await plugin.gitManager.branchInfo();
                        const target = info.current;
                        if (!target) {
                            plugin.displayError(
                                "Cannot flatten history without an active local branch."
                            );
                            return;
                        }

                        if (info.tracking) {
                            const [remote] = splitRemoteBranch(info.tracking);
                            if (remote) {
                                const remoteDefaultBranch = await (
                                    plugin.gitManager as SimpleGit
                                ).getRemoteDefaultBranch(remote);
                                if (
                                    remoteDefaultBranch &&
                                    remoteDefaultBranch !== target
                                ) {
                                    plugin.showNotice(
                                        `Flatten target is "${target}" while remote default is "${remoteDefaultBranch}". Hosting UI may show compare/PR prompts from "${target}" into "${remoteDefaultBranch}".`,
                                        10000
                                    );
                                }
                            }
                        }
                        const confirmedForcePush = flattenForcePush;
                        const expectedConfirmation = confirmedForcePush
                            ? `FLATTEN ${target} PUSH`
                            : `FLATTEN ${target}`;
                        const confirmModal = new GeneralModal(plugin, {
                            placeholder: `Type ${expectedConfirmation} to confirm`,
                            allowEmpty: false,
                        });
                        const confirmation: string | undefined =
                            await confirmModal.openAndGetResult();
                        if (confirmation !== expectedConfirmation) {
                            plugin.showNotice("Aborted flatten operation");
                            return;
                        }

                        void plugin.promiseQueue.addTask(async () => {
                            try {
                                await (
                                    plugin.gitManager as SimpleGit
                                ).flattenBranch(target, confirmedForcePush);
                                plugin.displayMessage(
                                    confirmedForcePush
                                        ? "Flatten completed and force-pushed to remote"
                                        : "Flatten completed"
                                );
                                await reloadSyncManager();
                                await plugin.refresh();
                            } catch (e) {
                                plugin.displayError(e);
                            }
                        });
                    })
            );
    }

    new Setting(containerEl)
        .setName("Disable on this device")
        .setDesc(
            "Disables the plugin on this device. This setting is not synced."
        )
        .addToggle((toggle) =>
            toggle
                .setValue(plugin.localStorage.getPluginDisabled())
                .onChange((value) => {
                    plugin.localStorage.setPluginDisabled(value);
                    if (value) {
                        plugin.unloadPlugin();
                    } else {
                        plugin
                            .init({ fromReload: true })
                            .catch((e) => plugin.displayError(e));
                    }
                    plugin.showNotice(
                        "Obsidian must be restarted for the changes to take effect."
                    );
                })
        );

    new Setting(containerEl)
        .setName("Show explorer encryption indicator")
        .setDesc(
            "Show a small lock icon next to encrypted files in the file explorer (local or remote)."
        )
        .addToggle((toggle) =>
            toggle
                .setValue(
                    typeof plugin.settings.showExplorerEncryptionIndicator ===
                        "boolean"
                        ? plugin.settings.showExplorerEncryptionIndicator
                        : true
                )
                .onChange(async (value) => {
                    plugin.settings.showExplorerEncryptionIndicator = value;
                    await plugin.saveSettings();
                    // Trigger a UI refresh so the indicator updates immediately
                    plugin
                        .refresh()
                        .catch((err) =>
                            plugin.displayError(
                                err instanceof Error ? err : String(err)
                            )
                        );
                })
        );

    new Setting(containerEl).setName("Support").setHeading();
    new Setting(containerEl)
        .setDesc(
            "If you like this Plugin, consider donating to support continued development."
        )
        .addButton((bt) => {
            bt.buttonEl.outerHTML =
                "<a href='https://ko-fi.com/X8X71XF2G2' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://cdn.ko-fi.com/cdn/kofi3.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>";
        });

    const debugDiv = containerEl.createDiv();
    debugDiv.setAttr("align", "center");
    debugDiv.setAttr("style", "margin: var(--size-4-2)");

    const debugButton = debugDiv.createEl("button");
    debugButton.setText("Copy Debug Information");
    debugButton.onclick = async () => {
        await window.navigator.clipboard.writeText(
            JSON.stringify(
                {
                    settings: plugin.settings,
                    pluginVersion: plugin.manifest.version,
                },
                null,
                4
            )
        );
        plugin.showNotice(
            "Debug information copied to clipboard. May contain sensitive information!"
        );
    };

    if (Platform.isDesktopApp) {
        const info = containerEl.createDiv();
        info.setAttr("align", "center");
        info.setText(
            "Debugging and logging:\nYou can always see the logs of this and every other plugin by opening the console with"
        );
        const keys = containerEl.createDiv();
        keys.setAttr("align", "center");
        keys.addClass("obsidian-git-shortcuts");
        if (Platform.isMacOS === true) {
            keys.createEl("kbd", { text: "CMD (⌘) + OPTION (⌥) + I" });
        } else {
            keys.createEl("kbd", { text: "CTRL + SHIFT + I" });
        }
    }
}
