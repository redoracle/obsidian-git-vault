import { normalizePath, TFile, moment } from "obsidian";
import { IsomorphicGit } from "src/gitManager/isomorphicGit";
import { SimpleGit } from "src/gitManager/simpleGit";
import { DiscardModal, type DiscardResult } from "src/ui/modals/discardModal";
import { CustomMessageModal } from "src/ui/modals/customMessageModal";
import {
    GeneralModal,
    type GeneralModalHost,
} from "src/ui/modals/generalModal";
import {
    CurrentGitAction,
    NoNetworkError,
    type Status,
    type UnstagedFile,
} from "src/types";
import { assertNever, formatRemoteUrl, spawnAsync } from "src/utils";
import type {
    ICloneRepoOptions,
    ICommitAndSyncArgs,
    ICommitArgs,
    ICreateRepoOptions,
    IGitOperationsHost,
    IGitOperationsService,
} from "./runtimeServices";

interface IExtendedGitOperationsHost extends IGitOperationsHost {
    ensureSensitiveVaultGitignore(): Promise<void>;
    saveSettings(): Promise<void>;
    reinitializePluginAfterRepoChange(): Promise<void>;
}

export class GitOperationsService implements IGitOperationsService {
    constructor(private readonly host: IExtendedGitOperationsHost) {}

    private sanitizeHostnameForScript(hostname: string): string {
        return hostname.replace(/[^A-Za-z0-9._-]/g, "_");
    }

    private mapChangedFilesToUnstagedFiles(
        status: Status
    ): (UnstagedFile & { vaultPath: string })[] {
        if (!Array.isArray(status.changed)) {
            throw new Error("Expected status.changed to be an array.");
        }

        return status.changed.map((file, index) => {
            if (file == null || typeof file.path !== "string") {
                throw new Error(
                    `Invalid changed file entry at index ${index}: missing path.`
                );
            }
            if (typeof file.workingDir !== "string") {
                throw new Error(
                    `Invalid changed file entry at index ${index}: missing workingDir.`
                );
            }

            return {
                path: file.path,
                type: file.workingDir === "D" ? "D" : "M",
                vaultPath:
                    typeof file.vaultPath === "string" &&
                    file.vaultPath.length > 0
                        ? file.vaultPath
                        : this.host.gitManager.getRelativeVaultPath(file.path),
            };
        });
    }

    async createNewRepo(options: ICreateRepoOptions = {}): Promise<boolean> {
        try {
            const gitManager = this.host.gitManager;
            if (gitManager == null) {
                this.host.displayError(
                    "Git is not ready yet. Please try again after initialization finishes."
                );
                return false;
            }

            await gitManager.init();
            const remoteUrl = options.remoteUrl?.trim();
            const remoteName = options.remoteName?.trim() || "origin";
            if (remoteUrl) {
                await gitManager.setRemote(
                    remoteName,
                    formatRemoteUrl(remoteUrl)
                );
                this.host.showNotice(
                    `Initialized repo and saved remote ${remoteName}.`,
                    5000
                );
            } else {
                this.host.showNotice("Initialized new repo");
            }
            await this.host.reinitializePluginAfterRepoChange();
            return true;
        } catch (e) {
            this.host.displayError(e);
            return false;
        }
    }

    async cloneNewRepo(options?: string | ICloneRepoOptions): Promise<void> {
        const cloneOptions: ICloneRepoOptions =
            typeof options === "string"
                ? { remoteUrl: options }
                : options ?? {};
        const modalHost: GeneralModalHost = { app: this.host.app };
        const gitManager = this.host.gitManager;
        if (gitManager == null) {
            this.host.displayError(
                "Git is not ready yet. Please try again after initialization finishes."
            );
            return;
        }

        const url =
            cloneOptions.remoteUrl?.trim() ||
            (await new GeneralModal(modalHost, {
                placeholder: "Enter remote URL",
            }).openAndGetResult());
        if (!url) {
            return;
        }

        const confirmOption = "Vault Root";
        let dir =
            cloneOptions.target === "current-vault"
                ? "."
                : await new GeneralModal(modalHost, {
                      options:
                          gitManager instanceof IsomorphicGit
                              ? [confirmOption]
                              : [],
                      placeholder:
                          "Enter directory for clone. It needs to be empty or not existent.",
                      allowEmpty: gitManager instanceof IsomorphicGit,
                  }).openAndGetResult();
        if (dir === undefined) return;
        if (dir === confirmOption) {
            dir = ".";
        }

        dir = normalizePath(dir);
        if (dir === "/") {
            dir = ".";
        }

        if (dir === ".") {
            const containsConflictDir = await new GeneralModal(modalHost, {
                options: ["NO", "YES"],
                placeholder: `Does your remote repo contain a ${this.host.app.vault.configDir} directory at the root?`,
                onlySelection: true,
            }).openAndGetResult();
            if (containsConflictDir === undefined) {
                this.host.showNotice("Aborted clone");
                return;
            } else if (containsConflictDir === "YES") {
                const deleteConfirm =
                    "DELETE ALL YOUR LOCAL CONFIG AND PLUGINS";
                const shouldDelete =
                    (await new GeneralModal(modalHost, {
                        options: ["Abort clone", deleteConfirm],
                        placeholder: `To avoid conflicts, the local ${this.host.app.vault.configDir} directory needs to be deleted.`,
                        onlySelection: true,
                    }).openAndGetResult()) === deleteConfirm;
                if (shouldDelete) {
                    await this.host.app.vault.adapter.rmdir(
                        this.host.app.vault.configDir,
                        true
                    );
                } else {
                    this.host.showNotice("Aborted clone");
                    return;
                }
            }
        }

        const depth = await new GeneralModal(modalHost, {
            placeholder: "Specify depth of clone. Leave empty for full clone.",
            allowEmpty: true,
        }).openAndGetResult();
        let depthInt: number | undefined;
        if (depth === undefined) {
            this.host.showNotice("Aborted clone");
            return;
        }

        if (depth !== "") {
            depthInt = parseInt(depth, 10);
            if (isNaN(depthInt) || depthInt <= 0) {
                this.host.showNotice("Invalid depth. Aborting clone.");
                return;
            }
        }
        this.host.showNotice(`Cloning new repo into "${dir}"`);
        const oldBase = this.host.settings.basePath;
        const customDir = dir && dir !== ".";
        if (customDir) {
            this.host.settings.basePath = dir;
        }
        try {
            await gitManager.clone(formatRemoteUrl(url), dir, depthInt);
            await this.host.ensureSensitiveVaultGitignore();
            this.host.showNotice("Cloned new repo.");
            this.host.showNotice("Please restart Obsidian");

            if (customDir) {
                await this.host.saveSettings();
            }
        } catch (error) {
            this.host.displayError(error);
            this.host.settings.basePath = oldBase;
            await this.host.saveSettings();
        }
    }

    async pullChangesFromRemote(): Promise<void> {
        if (!(await this.host.ensureInitialized())) return;

        const pullResult = await this.pull();
        if (!pullResult.success) {
            this.host.setPluginState({ gitAction: CurrentGitAction.idle });
            return;
        }
        if (pullResult.filesChanged === 0) {
            this.host.displayMessage("Pull: Everything is up-to-date");
        }

        if (this.host.useSimpleGit) {
            const status = await this.host.updateCachedStatus();
            if (status.conflicted.length > 0) {
                this.host.displayError(
                    `You have conflicts in ${status.conflicted.length} ${
                        status.conflicted.length == 1 ? "file" : "files"
                    }`
                );
                await this.host.conflictCoordinator.handleConflict(
                    status.conflicted
                );
            }
        }

        this.host.refreshWorkspace();
        this.host.setPluginState({ gitAction: CurrentGitAction.idle });
    }

    async commitAndSync({
        fromAutoBackup,
        requestCustomMessage = false,
        commitMessage,
        onlyStaged = false,
    }: ICommitAndSyncArgs): Promise<void> {
        if (!(await this.host.ensureInitialized())) return;

        if (
            this.host.settings.syncMethod == "reset" &&
            this.host.settings.pullBeforePush
        ) {
            const pullResult = await this.pull();
            if (!pullResult.success) {
                this.host.setPluginState({ gitAction: CurrentGitAction.idle });
                return;
            }
        }

        const commitSuccessful = await this.commit({
            fromAutoBackup,
            requestCustomMessage,
            commitMessage,
            onlyStaged,
        });
        if (!commitSuccessful) {
            return;
        }

        if (
            this.host.settings.syncMethod != "reset" &&
            this.host.settings.pullBeforePush
        ) {
            const pullResult = await this.pull();
            if (!pullResult.success) {
                this.host.setPluginState({ gitAction: CurrentGitAction.idle });
                return;
            }
        }

        if (!this.host.settings.disablePush) {
            if (
                (await this.host.branchRemote.remotesAreSet()) &&
                (await this.host.gitManager.canPush())
            ) {
                await this.push();
            } else {
                this.host.displayMessage("No commits to push");
            }
        }
        this.host.setPluginState({ gitAction: CurrentGitAction.idle });
    }

    async commit({
        fromAutoBackup,
        requestCustomMessage = false,
        onlyStaged = false,
        commitMessage,
        amend = false,
    }: ICommitArgs): Promise<boolean> {
        if (!(await this.host.ensureInitialized())) return false;
        try {
            let hadConflict = this.host.localStorage.getConflict();

            let status: Status | undefined;
            let stagedFiles: { vaultPath: string; path: string }[] = [];
            let unstagedFiles: (UnstagedFile & { vaultPath: string })[] = [];

            if (this.host.useSimpleGit) {
                await this.host.conflictCoordinator.mayDeleteConflictFile();
                status = await this.host.updateCachedStatus();

                if (status.conflicted.length == 0) {
                    hadConflict = false;
                }

                if (fromAutoBackup && status.conflicted.length > 0) {
                    this.host.displayError(
                        `Did not commit, because you have conflicts in ${
                            status.conflicted.length
                        } ${status.conflicted.length == 1 ? "file" : "files"}. Please resolve them and commit per command.`
                    );
                    await this.host.conflictCoordinator.handleConflict(
                        status.conflicted
                    );
                    return false;
                }
                stagedFiles = status.staged;
                unstagedFiles = this.mapChangedFilesToUnstagedFiles(status);
            } else {
                if (fromAutoBackup && hadConflict) {
                    this.host.displayError(
                        "Did not commit, because you have conflicts. Please resolve them and commit per command."
                    );
                    return false;
                } else {
                    if (hadConflict) {
                        await this.host.conflictCoordinator.mayDeleteConflictFile();
                    }
                    const gitManager = this.host.gitManager as IsomorphicGit;
                    if (onlyStaged) {
                        stagedFiles = await gitManager.getStagedFiles();
                    } else {
                        const res = await gitManager.getUnstagedFiles();
                        unstagedFiles = res.map(({ path, type }) => ({
                            vaultPath:
                                this.host.gitManager.getRelativeVaultPath(path),
                            path,
                            type,
                        }));
                    }
                }
            }

            if (
                await this.host.tools.hasTooBigFiles(
                    onlyStaged
                        ? stagedFiles
                        : [...stagedFiles, ...unstagedFiles]
                )
            ) {
                this.host.setPluginState({ gitAction: CurrentGitAction.idle });
                return false;
            }

            if (
                unstagedFiles.length + stagedFiles.length !== 0 ||
                hadConflict
            ) {
                const resolvedMessage =
                    commitMessage ??
                    (fromAutoBackup
                        ? this.host.settings.autoCommitMessage
                        : this.host.settings.commitMessage);
                commitMessage = resolvedMessage;
                let cmtMessage = resolvedMessage;

                if (
                    (fromAutoBackup &&
                        this.host.settings.customMessageOnAutoBackup) ||
                    requestCustomMessage
                ) {
                    if (!this.host.settings.disablePopups && fromAutoBackup) {
                        this.host.showNotice(
                            "Auto backup: Please enter a custom commit message. Leave empty to abort"
                        );
                    }
                    const modalMessage = await new CustomMessageModal({
                        app: this.host.app,
                        settings: this.host.settings,
                    }).openAndGetResult();

                    if (
                        modalMessage != undefined &&
                        modalMessage != "" &&
                        modalMessage != "..."
                    ) {
                        cmtMessage = modalMessage;
                    } else {
                        this.host.setPluginState({
                            gitAction: CurrentGitAction.idle,
                        });
                        return false;
                    }
                } else if (
                    this.host.useSimpleGit &&
                    this.host.settings.commitMessageScript
                ) {
                    const templateScript =
                        this.host.settings.commitMessageScript;
                    const hostname = this.sanitizeHostnameForScript(
                        this.host.localStorage.getHostname() || ""
                    );
                    const formattedDate = moment
                        .utc()
                        .local()
                        .format(this.host.settings.commitDateFormat);
                    let formattedScript = templateScript
                        .split("{{hostname}}")
                        .join(hostname);

                    formattedScript = formattedScript
                        .split("{{date}}")
                        .join(formattedDate);

                    const shell =
                        process.platform === "win32"
                            ? process.env.ComSpec || "cmd.exe"
                            : "/bin/sh";
                    const shellArgs =
                        process.platform === "win32"
                            ? ["/d", "/s", "/c", formattedScript]
                            : ["-c", formattedScript];
                    const res = await spawnAsync(shell, shellArgs, {
                        cwd: (this.host.gitManager as SimpleGit)
                            .absoluteRepoPath,
                    });
                    if (res.code != 0) {
                        this.host.displayError(res.stderr);
                    } else if (res.stdout.trim().length == 0) {
                        this.host.displayMessage(
                            "Stdout from commit message script is empty. Using default message."
                        );
                    } else {
                        cmtMessage = res.stdout;
                    }
                }

                if (!cmtMessage || cmtMessage.trim() === "") {
                    this.host.showNotice(
                        "Commit aborted: No commit message provided"
                    );
                    this.host.setPluginState({
                        gitAction: CurrentGitAction.idle,
                    });
                    return false;
                }

                let committedFiles: number | undefined;
                if (onlyStaged) {
                    committedFiles = await this.host.gitManager.commit({
                        message: cmtMessage,
                        amend,
                    });
                } else {
                    committedFiles = await this.host.gitManager.commitAll({
                        message: cmtMessage,
                        status,
                        unstagedFiles,
                        amend,
                    });
                }

                if (this.host.useSimpleGit) {
                    await this.host.updateCachedStatus();
                }

                let roughly = false;
                if (committedFiles === undefined) {
                    roughly = true;
                    committedFiles =
                        unstagedFiles.length + stagedFiles.length || 0;
                }
                this.host.displayMessage(
                    `Committed${roughly ? " approx." : ""} ${committedFiles} ${
                        committedFiles == 1 ? "file" : "files"
                    }`
                );
            } else {
                this.host.displayMessage("No changes to commit", undefined, {
                    isNoChanges: true,
                });
            }
            this.host.refreshWorkspace();

            return true;
        } catch (error) {
            this.host.displayError(error);
            return false;
        }
    }

    async push(): Promise<boolean> {
        if (!(await this.host.ensureInitialized())) return false;
        if (!(await this.host.branchRemote.remotesAreSet())) {
            return false;
        }
        const hadConflict = this.host.localStorage.getConflict();
        try {
            let status: Status | undefined;
            if (this.host.useSimpleGit) {
                status = await this.host.updateCachedStatus();
            }
            if (
                this.host.useSimpleGit &&
                status &&
                status.conflicted.length > 0
            ) {
                this.host.displayError(
                    `Cannot push. You have conflicts in ${
                        status.conflicted.length
                    } ${status.conflicted.length == 1 ? "file" : "files"}`
                );
                await this.host.conflictCoordinator.handleConflict(
                    status.conflicted
                );
                return false;
            } else if (
                this.host.gitManager instanceof IsomorphicGit &&
                hadConflict
            ) {
                this.host.displayError("Cannot push. You have conflicts");
                return false;
            }
            this.host.log("Pushing....");
            try {
                await this.host.notifyIfNonDefaultTrackingBranch();
            } catch (notifyErr) {
                this.host.log(
                    "notifyIfNonDefaultTrackingBranch failed:",
                    notifyErr
                );
            }
            const pushedFiles = await this.host.gitManager.push();

            if (pushedFiles !== undefined) {
                if (pushedFiles === null) {
                    this.host.displayMessage("Pushed to remote");
                } else if (pushedFiles > 0) {
                    this.host.displayMessage(
                        `Pushed ${pushedFiles} ${
                            pushedFiles == 1 ? "file" : "files"
                        } to remote`
                    );
                } else {
                    this.host.displayMessage("No commits to push");
                }
            }
            this.host.setPluginState({ offlineMode: false });
            this.host.refreshWorkspace();
            return true;
        } catch (e) {
            if (e instanceof NoNetworkError) {
                this.host.conflictCoordinator.handleNoNetworkError(e);
            } else {
                this.host.displayError(e);
            }
            return false;
        }
    }

    async pull(): Promise<
        | { success: true; filesChanged: number }
        | { success: false; reason?: string }
    > {
        if (!(await this.host.branchRemote.remotesAreSet())) {
            return { success: false, reason: "Remotes are not set" };
        }
        try {
            this.host.log("Pulling....");
            const pulledFiles = (await this.host.gitManager.pull()) || [];
            this.host.setPluginState({ offlineMode: false });

            if (pulledFiles.length > 0) {
                this.host.displayMessage(
                    `Pulled ${pulledFiles.length} ${
                        pulledFiles.length == 1 ? "file" : "files"
                    } from remote`
                );
                this.host.lastPulledFiles = pulledFiles;
            }
            return { success: true, filesChanged: pulledFiles.length };
        } catch (e) {
            this.host.displayError(e);
            return {
                success: false,
                reason: e instanceof Error ? e.message : String(e),
            };
        }
    }

    async fetch(): Promise<void> {
        if (!(await this.host.branchRemote.remotesAreSet())) {
            return;
        }
        try {
            await this.host.gitManager.fetch();
            this.host.displayMessage("Fetched from remote");
            this.host.setPluginState({ offlineMode: false });
            this.host.refreshWorkspace();
        } catch (error) {
            this.host.displayError(error);
        }
    }

    async stageFile(file: TFile): Promise<boolean> {
        if (!(await this.host.ensureInitialized())) return false;

        try {
            await this.host.gitManager.stage(file.path, true);
            return true;
        } catch (error) {
            this.host.displayError(error);
            return false;
        } finally {
            this.host.refreshWorkspace();
            this.host.setPluginState({ gitAction: CurrentGitAction.idle });
        }
    }

    async unstageFile(file: TFile): Promise<boolean> {
        if (!(await this.host.ensureInitialized())) return false;

        try {
            await this.host.gitManager.unstage(file.path, true);
            return true;
        } catch (error) {
            this.host.displayError(error);
            return false;
        } finally {
            this.host.refreshWorkspace();
            this.host.setPluginState({ gitAction: CurrentGitAction.idle });
        }
    }

    async discardAll(path?: string): Promise<DiscardResult> {
        if (!(await this.host.ensureInitialized())) return false;

        const status = await this.host.gitManager.status({ path });

        let filesToDeleteCount = 0;
        let filesToDiscardCount = 0;
        for (const file of status.changed) {
            if (file.workingDir == "U") {
                filesToDeleteCount++;
            } else {
                filesToDiscardCount++;
            }
        }
        if (filesToDeleteCount + filesToDiscardCount == 0) {
            return false;
        }

        const result = await new DiscardModal({
            app: this.host.app,
            filesToDeleteCount,
            filesToDiscardCount,
            path: path ?? "",
        }).openAndGetResult();

        switch (result) {
            case false:
                return result;
            case "discard":
                await this.host.gitManager.discardAll({
                    dir: path,
                    status,
                });
                break;
            case "delete": {
                try {
                    await this.host.gitManager.discardAll({
                        dir: path,
                        status,
                    });
                    const untrackedPaths =
                        await this.host.gitManager.getUntrackedPaths({
                            path,
                            status,
                        });
                    for (const file of untrackedPaths) {
                        const vaultPath =
                            this.host.gitManager.getRelativeVaultPath(file);
                        const tFile =
                            this.host.app.vault.getAbstractFileByPath(
                                vaultPath
                            );

                        if (tFile) {
                            await this.host.app.fileManager.trashFile(tFile);
                        } else if (file.endsWith("/")) {
                            await this.host.app.vault.adapter.rmdir(
                                vaultPath,
                                true
                            );
                        } else {
                            await this.host.app.vault.adapter.remove(vaultPath);
                        }
                    }
                } catch (error) {
                    this.host.log("discardAll delete failed:", error);
                    this.host.refreshWorkspace();
                    return false;
                }
                break;
            }
            default:
                assertNever(result);
        }
        this.host.refreshWorkspace();
        return result;
    }
}
