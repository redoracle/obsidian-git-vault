import { Platform, TFolder, WorkspaceLeaf } from "obsidian";
import { FileHistoryModal } from "./ui/modals/fileHistoryModal";
import {
    HISTORY_VIEW_CONFIG,
    SOURCE_CONTROL_VIEW_CONFIG,
    SYNC_METADATA_VIEW_CONFIG,
} from "./constants";
import ObsidianGit from "./main";
import { openHistoryInGitHub, openLineInGitHub } from "./openInGitHub";
import { ConflictHistoryModal } from "./syncProvider/conflictHistory";
import { ChangedFilesModal } from "./ui/modals/changedFilesModal";
import { GeneralModal } from "./ui/modals/generalModal";
import { IgnoreModal } from "./ui/modals/ignoreModal";
import { assertNever } from "./utils";
import { togglePreviewHunk } from "./editor/signs/tooltip";

export function addCommmands(plugin: ObsidianGit) {
    const app = plugin.app;

    // ── Git Vault commands (provider-agnostic) ─────────────────────────────
    plugin.addCommand({
        id: "git-vault-sync",
        name: "Git Vault: Sync now",
        callback: () => {
            plugin.syncManager.triggerSync();
        },
    });

    plugin.addCommand({
        id: "git-vault-pull",
        name: "Git Vault: Pull (download remote changes)",
        callback: () => {
            plugin.syncManager.triggerPull();
        },
    });

    plugin.addCommand({
        id: "git-vault-push",
        name: "Git Vault: Push (upload local changes)",
        callback: () => {
            plugin.syncManager.triggerPush();
        },
    });

    plugin.addCommand({
        id: "git-vault-resolve-conflicts",
        name: "Git Vault: Open conflict resolver",
        callback: () => {
            const conflicts = plugin.syncState.getState().conflicts;
            if (conflicts.length === 0) {
                plugin.showNotice("No conflicts to resolve.");
                return;
            }
            plugin.syncManager.openConflictResolver([...conflicts]);
        },
    });

    plugin.addCommand({
        id: "git-vault-open-conflict-history",
        name: "Git Vault: Open conflict history",
        callback: async () => {
            try {
                const history = await plugin.syncManager.getConflictHistory();
                new ConflictHistoryModal(plugin, history).open();
            } catch (error) {
                plugin.displayError(error);
            }
        },
    });

    plugin.addCommand({
        id: "git-vault-open-metadata-sidebar",
        name: "Git Vault: Open sync metadata sidebar",
        callback: async () => {
            const leafs = app.workspace.getLeavesOfType(
                SYNC_METADATA_VIEW_CONFIG.type
            );
            let leaf: WorkspaceLeaf;
            if (leafs.length === 0) {
                leaf =
                    app.workspace.getRightLeaf(false) ??
                    app.workspace.getLeaf();
                await leaf.setViewState({
                    type: SYNC_METADATA_VIEW_CONFIG.type,
                });
            } else {
                leaf = leafs.first()!;
            }
            await app.workspace.revealLeaf(leaf);
        },
    });

    plugin.addCommand({
        id: "git-vault-toggle-mode",
        name: "Git Vault: Toggle Simple / Advanced mode",
        callback: async () => {
            plugin.settings.syncMode =
                plugin.settings.syncMode === "simple" ? "advanced" : "simple";
            await plugin.saveSettings();
            plugin.showNotice(
                `Git Vault: switched to ${plugin.settings.syncMode} mode`
            );
            app.workspace.trigger(
                "obsidian-git:sync-mode-changed",
                plugin.settings.syncMode
            );
        },
    });

    plugin.addCommand({
        id: "git-vault-file-history",
        name: "Git Vault: View file history",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            const canOpenHistory =
                file !== null && plugin.gitReady && plugin.useSimpleGit;
            if (checking) return canOpenHistory;
            if (canOpenHistory && file)
                new FileHistoryModal(plugin, file).open();
        },
    });

    plugin.addCommand({
        id: "git-vault-encrypt-file",
        name: "Git Vault: Encrypt current file",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) return file !== null;
            if (file) {
                plugin
                    .encryptSingleFile(file)
                    .catch((error) => plugin.displayError(error));
            }
        },
    });

    plugin.addCommand({
        id: "git-vault-decrypt-file",
        name: "Git Vault: Decrypt current file",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) return file !== null;
            if (file)
                plugin
                    .decryptSingleFile(file)
                    .catch((e) => plugin.displayError(e));
        },
    });

    // ── Existing Git commands ──────────────────────────────────────────────
    plugin.addCommand({
        id: "edit-gitignore",
        name: "Edit .gitignore",
        callback: async () => {
            const path = plugin.gitManager.getRelativeVaultPath(".gitignore");
            if (!(await app.vault.adapter.exists(path))) {
                await app.vault.adapter.write(path, "");
            }
            const content = await app.vault.adapter.read(path);
            const modal = new IgnoreModal(app, content);
            const res = await modal.openAndGetResult();
            if (res !== undefined) {
                await app.vault.adapter.write(path, res);
                await plugin.refresh();
            }
        },
    });
    plugin.addCommand({
        id: "open-git-view",
        name: "Open source control view",
        callback: async () => {
            const leafs = app.workspace.getLeavesOfType(
                SOURCE_CONTROL_VIEW_CONFIG.type
            );
            let leaf: WorkspaceLeaf;
            if (leafs.length === 0) {
                leaf =
                    app.workspace.getRightLeaf(false) ??
                    app.workspace.getLeaf();
                await leaf.setViewState({
                    type: SOURCE_CONTROL_VIEW_CONFIG.type,
                });
            } else {
                leaf = leafs.first()!;
            }
            await app.workspace.revealLeaf(leaf);

            // Is not needed for the first open, but allows to refresh the view
            // per hotkey even if already opened
            app.workspace.trigger("obsidian-git:refresh");
        },
    });
    plugin.addCommand({
        id: "open-history-view",
        name: "Open history view",
        callback: async () => {
            const leafs = app.workspace.getLeavesOfType(
                HISTORY_VIEW_CONFIG.type
            );
            let leaf: WorkspaceLeaf;
            if (leafs.length === 0) {
                leaf =
                    app.workspace.getRightLeaf(false) ??
                    app.workspace.getLeaf();
                await leaf.setViewState({
                    type: HISTORY_VIEW_CONFIG.type,
                });
            } else {
                leaf = leafs.first()!;
            }
            await app.workspace.revealLeaf(leaf);

            // Is not needed for the first open, but allows to refresh the view
            // per hotkey even if already opened
            app.workspace.trigger("obsidian-git:refresh");
        },
    });

    plugin.addCommand({
        id: "open-diff-view",
        name: "Open diff view",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                const filePath = plugin.gitManager.getRelativeRepoPath(
                    file!.path,
                    true
                );
                plugin.tools.openDiff({
                    aFile: filePath,
                    aRef: "",
                });
            }
        },
    });

    plugin.addCommand({
        id: "view-file-on-github",
        name: "Open file on GitHub",
        editorCallback: (editor, { file }) => {
            if (file)
                return openLineInGitHub(
                    editor,
                    file,
                    plugin.gitManager,
                    (message, duration) => plugin.showNotice(message, duration)
                );
        },
    });

    plugin.addCommand({
        id: "view-history-on-github",
        name: "Open file history on GitHub",
        editorCallback: (_, { file }) => {
            if (file)
                return openHistoryInGitHub(
                    file,
                    plugin.gitManager,
                    (message, duration) => plugin.showNotice(message, duration)
                );
        },
    });

    plugin.addCommand({
        id: "pull",
        name: "Pull",
        callback: () =>
            void plugin.promiseQueue.addTask(() =>
                plugin.pullChangesFromRemote()
            ),
    });

    plugin.addCommand({
        id: "fetch",
        name: "Fetch",
        callback: () => void plugin.promiseQueue.addTask(() => plugin.fetch()),
    });

    plugin.addCommand({
        id: "switch-to-remote-branch",
        name: "Switch to remote branch",
        callback: () =>
            void plugin.promiseQueue.addTask(() => plugin.switchRemoteBranch()),
    });

    plugin.addCommand({
        id: "add-to-gitignore",
        name: "Add file to .gitignore",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                plugin
                    .addFileToGitignore(file!.path, file instanceof TFolder)
                    .catch((e) => plugin.displayError(e));
            }
        },
    });

    plugin.addCommand({
        id: "push",
        name: "Commit-and-sync",
        callback: () =>
            void plugin.promiseQueue.addTask(() =>
                plugin.commitAndSync({ fromAutoBackup: false })
            ),
    });

    plugin.addCommand({
        id: "backup-and-close",
        name: "Commit-and-sync and then close Obsidian",
        callback: () =>
            void plugin.promiseQueue.addTask(async () => {
                await plugin.commitAndSync({ fromAutoBackup: false });
                window.close();
            }),
    });

    plugin.addCommand({
        id: "commit-push-specified-message",
        name: "Commit-and-sync with specific message",
        callback: () =>
            void plugin.promiseQueue.addTask(() =>
                plugin.commitAndSync({
                    fromAutoBackup: false,
                    requestCustomMessage: true,
                })
            ),
    });

    plugin.addCommand({
        id: "commit",
        name: "Commit all changes",
        callback: () =>
            void plugin.promiseQueue.addTask(() =>
                plugin.commit({ fromAutoBackup: false })
            ),
    });

    plugin.addCommand({
        id: "commit-specified-message",
        name: "Commit all changes with specific message",
        callback: () =>
            void plugin.promiseQueue.addTask(() =>
                plugin.commit({
                    fromAutoBackup: false,
                    requestCustomMessage: true,
                })
            ),
    });

    plugin.addCommand({
        id: "commit-smart",
        name: "Commit",
        callback: () =>
            void plugin.promiseQueue.addTask(async () => {
                const status = await plugin.updateCachedStatus();
                const onlyStaged = status.staged.length > 0;
                return plugin.commit({
                    fromAutoBackup: false,
                    requestCustomMessage: false,
                    onlyStaged: onlyStaged,
                });
            }),
    });

    plugin.addCommand({
        id: "commit-staged",
        name: "Commit staged",
        checkCallback: function (checking) {
            // Don't show this command in command palette, because the
            // commit-smart command is more useful. Still provide this command
            // for hotkeys and automation.
            if (checking) return false;

            void plugin.promiseQueue.addTask(async () => {
                return plugin.commit({
                    fromAutoBackup: false,
                    requestCustomMessage: false,
                });
            });
        },
    });

    if (Platform.isDesktopApp) {
        plugin.addCommand({
            id: "commit-amend-staged-specified-message",
            name: "Amend staged",
            callback: () =>
                void plugin.promiseQueue.addTask(() =>
                    plugin.commit({
                        fromAutoBackup: false,
                        requestCustomMessage: true,
                        onlyStaged: true,
                        amend: true,
                    })
                ),
        });
    }

    plugin.addCommand({
        id: "commit-smart-specified-message",
        name: "Commit with specific message",
        callback: () =>
            void plugin.promiseQueue.addTask(async () => {
                const status = await plugin.updateCachedStatus();
                const onlyStaged = status.staged.length > 0;
                return plugin.commit({
                    fromAutoBackup: false,
                    requestCustomMessage: true,
                    onlyStaged: onlyStaged,
                });
            }),
    });

    plugin.addCommand({
        id: "commit-staged-specified-message",
        name: "Commit staged with specific message",
        checkCallback: function (checking) {
            // Same reason as for commit-staged
            if (checking) return false;
            void plugin.promiseQueue.addTask(() =>
                plugin.commit({
                    fromAutoBackup: false,
                    requestCustomMessage: true,
                    onlyStaged: true,
                })
            );
        },
    });

    plugin.addCommand({
        id: "push2",
        name: "Push",
        callback: () => void plugin.promiseQueue.addTask(() => plugin.push()),
    });

    plugin.addCommand({
        id: "stage-current-file",
        name: "Stage current file",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                void plugin.promiseQueue.addTask(() => plugin.stageFile(file!));
            }
        },
    });

    plugin.addCommand({
        id: "unstage-current-file",
        name: "Unstage current file",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                void plugin.promiseQueue.addTask(() =>
                    plugin.unstageFile(file!)
                );
            }
        },
    });

    plugin.addCommand({
        id: "edit-remotes",
        name: "Edit remotes",
        callback: () =>
            plugin.editRemotes().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "remove-remote",
        name: "Remove remote",
        callback: () =>
            plugin.removeRemote().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "set-upstream-branch",
        name: "Set upstream branch",
        callback: () =>
            plugin.setUpstreamBranch().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "delete-repo",
        name: "CAUTION: Delete repository",
        callback: async () => {
            const repoExists = await app.vault.adapter.exists(
                `${plugin.settings.basePath}/.git`
            );
            if (repoExists) {
                const modal = new GeneralModal(plugin, {
                    options: ["NO", "YES"],
                    placeholder:
                        "Do you really want to delete the repository (.git directory)? plugin action cannot be undone.",
                    onlySelection: true,
                });
                const shouldDelete = (await modal.openAndGetResult()) === "YES";
                if (shouldDelete) {
                    await app.vault.adapter.rmdir(
                        `${plugin.settings.basePath}/.git`,
                        true
                    );
                    plugin.showNotice(
                        "Successfully deleted repository. Reloading plugin..."
                    );
                    plugin.unloadPlugin();
                    await plugin.init({ fromReload: true });
                }
            } else {
                plugin.showNotice("No repository found");
            }
        },
    });

    plugin.addCommand({
        id: "init-repo",
        name: "Initialize a new repo",
        callback: () =>
            plugin.createNewRepo().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "clone-repo",
        name: "Clone an existing remote repo",
        callback: () =>
            plugin.cloneNewRepo().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "list-changed-files",
        name: "List changed files",
        callback: async () => {
            if (!(await plugin.isAllInitialized())) return;

            try {
                const status = await plugin.updateCachedStatus();
                if (status.changed.length + status.staged.length > 500) {
                    plugin.displayError("Too many changes to display");
                    return;
                }

                new ChangedFilesModal(plugin, status.all).open();
            } catch (e) {
                plugin.displayError(e);
            }
        },
    });

    plugin.addCommand({
        id: "switch-branch",
        name: "Switch branch",
        callback: () => {
            plugin.createBranch().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "delete-branch",
        name: "Delete branch",
        callback: () => {
            plugin.deleteBranch().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "discard-all",
        name: "CAUTION: Discard all changes",
        callback: async () => {
            const res = await plugin.discardAll();
            switch (res) {
                case "discard":
                    plugin.showNotice(
                        "Discarded all changes in tracked files."
                    );
                    break;
                case "delete":
                    plugin.showNotice("Discarded all files.");
                    break;
                case false:
                    break;
                default:
                    assertNever(res);
            }
        },
    });

    plugin.addCommand({
        id: "pause-automatic-routines",
        name: "Pause/Resume automatic routines",
        callback: () => {
            const currentlyPaused = plugin.localStorage.getPausedAutomatics();
            if (currentlyPaused) {
                // Resume: clear both boolean and any timed pause.
                plugin.localStorage.setPausedAutomatics(false);
                plugin.clearPausedAutomaticsResumeTimer();
                plugin.automaticsManager.reload("commit", "push", "pull");
                plugin.showNotice("Resumed automatic routines.");
            } else {
                // Pause: ask for an optional duration (minutes).
                // An empty or non-numeric answer means pause indefinitely.
                const rawInput = window.prompt(
                    "Pause automatic routines for how many minutes?\n(Leave empty to pause indefinitely)"
                );
                if (rawInput === null) {
                    // User cancelled the prompt — do nothing.
                    return;
                }
                const minutes = parseFloat(rawInput.trim());
                if (!isNaN(minutes) && minutes > 0) {
                    const untilMs = Date.now() + minutes * 60_000;
                    plugin.localStorage.setPausedUntil(untilMs);
                    plugin.syncPausedAutomaticsResumeTimer(
                        `Automatic routines resumed after ${minutes} minute(s).`
                    );
                    plugin.showNotice(
                        `Paused automatic routines for ${minutes} minute(s).`
                    );
                } else {
                    plugin.clearPausedAutomaticsResumeTimer();
                    plugin.localStorage.setPausedAutomatics(true);
                    plugin.showNotice(
                        "Paused automatic routines indefinitely."
                    );
                }
                plugin.automaticsManager.unload();
            }
        },
    });

    plugin.addCommand({
        id: "raw-command",
        name: "Raw command",
        checkCallback: (checking) => {
            if (checking) {
                // only available on desktop
                return plugin.useSimpleGit;
            } else {
                plugin.tools
                    .runRawCommand()
                    .catch((e) => plugin.displayError(e));
            }
        },
    });

    plugin.addCommand({
        id: "toggle-line-author-info",
        name: "Toggle line author information",
        callback: () =>
            plugin.settingsTab?.configureLineAuthorShowStatus(
                !plugin.settings.lineAuthor.show
            ),
    });

    plugin.addCommand({
        id: "toggle-hunk-signs",
        name: "Toggle editor hunk signs",
        callback: async () => {
            plugin.settings.hunks.showSigns = !plugin.settings.hunks.showSigns;
            await plugin.saveSettings();
            plugin.editorIntegration.refreshSignsSettings();
            plugin.showNotice(
                `Editor hunk signs ${plugin.settings.hunks.showSigns ? "enabled" : "disabled"}`
            );
        },
    });

    plugin.addCommand({
        id: "reset-hunk",
        name: "Reset hunk",
        editorCheckCallback(checking, _, __) {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }

            plugin.hunkActions.resetHunk();
        },
    });

    plugin.addCommand({
        id: "stage-hunk",
        name: "Stage hunk",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            void plugin.promiseQueue.addTask(() =>
                plugin.hunkActions.stageHunk()
            );
        },
    });

    plugin.addCommand({
        id: "preview-hunk",
        name: "Preview hunk",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            const editor = plugin.hunkActions.editor!.editor;
            togglePreviewHunk(editor);
        },
    });

    plugin.addCommand({
        id: "next-hunk",
        name: "Go to next hunk",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            plugin.hunkActions.goToHunk("next");
        },
    });

    plugin.addCommand({
        id: "prev-hunk",
        name: "Go to previous hunk",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            plugin.hunkActions.goToHunk("prev");
        },
    });
}
