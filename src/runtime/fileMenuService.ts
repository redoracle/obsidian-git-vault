import {
    isAbsolute as pathIsAbsolute,
    relative as pathRelative,
    resolve as pathResolve,
} from "path";
import {
    FileSystemAdapter,
    TFile,
    TFolder,
    type Menu,
    type TAbstractFile,
} from "obsidian";
import { isFileMenuSource, resolveFileMenuRouting } from "src/utils";
import type {
    FileMenuTriggerType,
    IFileMenuHost,
    IFileMenuService,
} from "./runtimeServices";

interface ElectronShell {
    showItemInFolder(filePath: string): void;
}

interface WindowWithElectron extends Window {
    electron?: {
        shell?: ElectronShell;
    };
}

export class FileMenuService implements IFileMenuService {
    constructor(private readonly host: IFileMenuHost) {}

    handleFileMenu(
        menu: Menu,
        file: TAbstractFile | string,
        source: string,
        type: FileMenuTriggerType
    ): void {
        if (!this.host.settings.showFileMenu) return;
        if (!file) return;
        if (!isFileMenuSource(source)) return;

        const filePath = typeof file === "string" ? file : file.path;
        const concreteFile = file instanceof TFile ? file : undefined;
        const routing = resolveFileMenuRouting({
            showFileMenu: this.host.settings.showFileMenu,
            source,
            canDoGitActions: this.canShowGitActions(),
            canShowHistory: this.canShowFileHistory(concreteFile),
            canShowEncryption: this.canShowEncryptionActions(concreteFile),
        });
        if (!routing.shouldHandle) return;

        if (source === "file-explorer-context-menu") {
            if (routing.showExplorerGitActions) {
                this.addGitFileMenuItems(menu, file, filePath);
            }
            if (routing.showHistory && concreteFile) {
                this.addHistoryMenuItems(menu, concreteFile);
            }
            if (routing.showEncryption && concreteFile) {
                this.addEncryptionMenuItems(menu, concreteFile);
            }
        }

        if (source === "git-source-control" || source === "git-history") {
            if (routing.showHistory && concreteFile) {
                this.addHistoryMenuItems(menu, concreteFile);
            }
            if (routing.showEncryption && concreteFile) {
                this.addEncryptionMenuItems(menu, concreteFile);
            }
            if (
                source === "git-source-control" &&
                routing.showSourceControlGitignore
            ) {
                menu.addItem((item) => {
                    item.setTitle("Git: Add to .gitignore")
                        .setIcon("file-x")
                        .setSection("action")
                        .onClick(() => {
                            this.host
                                .addFileToGitignore(
                                    filePath,
                                    file instanceof TFolder
                                )
                                .catch((e) => this.host.displayError(e));
                        });
                });
            }
            const adapter = this.host.app.vault.adapter;
            if (
                type === "obsidian-git:menu" &&
                adapter instanceof FileSystemAdapter
            ) {
                menu.addItem((item) => {
                    item.setTitle("Open in default app")
                        .setIcon("arrow-up-right")
                        .setSection("action")
                        .onClick(() => {
                            this.host.app.openWithDefaultApp(filePath);
                        });
                });
                menu.addItem((item) => {
                    item.setTitle("Show in system explorer")
                        .setIcon("arrow-up-right")
                        .setSection("action")
                        .onClick(() => {
                            const electronShell =
                                typeof window !== "undefined"
                                    ? (window as WindowWithElectron).electron
                                          ?.shell
                                    : undefined;
                            if (electronShell?.showItemInFolder) {
                                const vaultPath = pathResolve(
                                    adapter.getBasePath()
                                );
                                // Obsidian file paths are vault-relative; validate the resolved path remains in the vault before opening it.
                                // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
                                const absoluteFilePath = pathResolve(
                                    vaultPath,
                                    filePath // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
                                );
                                const relativeFilePath = pathRelative(
                                    vaultPath,
                                    absoluteFilePath
                                );
                                if (
                                    relativeFilePath.startsWith("..") ||
                                    pathIsAbsolute(relativeFilePath)
                                ) {
                                    this.host.showNotice(
                                        "Refusing to open a path outside the vault.",
                                        6000
                                    );
                                    return;
                                }
                                electronShell.showItemInFolder(
                                    absoluteFilePath
                                );
                            } else {
                                this.host.showNotice(
                                    "Show in system explorer is unavailable outside Electron.",
                                    6000
                                );
                            }
                        });
                });
            }
        }
    }

    private canShowGitActions(): boolean {
        return this.host.gitReady;
    }

    private canShowFileHistory(file: TFile | undefined): boolean {
        return (
            file !== undefined &&
            (this.canShowLocalFileHistory() || this.canShowRemoteFileHistory())
        );
    }

    private canShowLocalFileHistory(): boolean {
        return this.host.gitReady && this.host.useSimpleGit;
    }

    private canShowRemoteFileHistory(): boolean {
        return (
            this.host.settings.activeSyncProvider !== "git" &&
            this.host.supportsRemoteFileHistory === true &&
            typeof this.host.openRemoteFileHistory === "function"
        );
    }

    private canShowEncryptionActions(file: TFile | undefined): boolean {
        return file !== undefined;
    }

    private addGitFileMenuItems(
        menu: Menu,
        file: TAbstractFile | string,
        filePath: string
    ): void {
        menu.addItem((item) => {
            item.setTitle("Git: Stage")
                .setIcon("plus-circle")
                .setSection("action")
                .onClick(() => {
                    void this.host.promiseQueue.addTask(async () => {
                        try {
                            if (file instanceof TFile) {
                                await this.host.stageFile(file);
                            } else {
                                await this.host.gitManager.stageAll({
                                    dir: this.host.gitManager.getRelativeRepoPath(
                                        filePath,
                                        true
                                    ),
                                });
                                this.host.refreshWorkspace();
                            }
                        } catch (error) {
                            this.host.log(
                                "Failed to stage from file menu:",
                                error
                            );
                            this.host.displayError(error);
                        }
                    });
                });
        });
        menu.addItem((item) => {
            item.setTitle("Git: Unstage")
                .setIcon("minus-circle")
                .setSection("action")
                .onClick(() => {
                    void this.host.promiseQueue.addTask(async () => {
                        try {
                            if (file instanceof TFile) {
                                await this.host.unstageFile(file);
                            } else {
                                await this.host.gitManager.unstageAll({
                                    dir: this.host.gitManager.getRelativeRepoPath(
                                        filePath,
                                        true
                                    ),
                                });
                                this.host.refreshWorkspace();
                            }
                        } catch (error) {
                            this.host.log(
                                "Failed to unstage from file menu:",
                                error
                            );
                            this.host.displayError(error);
                        }
                    });
                });
        });
        menu.addItem((item) => {
            item.setTitle("Git: Add to .gitignore")
                .setIcon("file-x")
                .setSection("action")
                .onClick(() => {
                    this.host
                        .addFileToGitignore(filePath, file instanceof TFolder)
                        .catch((e) => this.host.displayError(e));
                });
        });
    }

    private addHistoryMenuItems(menu: Menu, file: TFile): void {
        if (this.canShowLocalFileHistory()) {
            menu.addItem((item) => {
                item.setTitle("Git: View file history in Obsidian")
                    .setIcon("history")
                    .setSection("action")
                    .onClick(() => {
                        this.host.interactions.openFileHistory(file);
                    });
            });
        }

        if (this.canShowRemoteFileHistory()) {
            menu.addItem((item) => {
                item.setTitle(
                    `Git: Open file history on ${this.remoteHistoryProviderName()}`
                )
                    .setIcon("history")
                    .setSection("action")
                    .onClick(() => {
                        void (
                            this.host.openRemoteFileHistory as (
                                f: TFile
                            ) => Promise<void>
                        )(file).catch((error) => this.host.displayError(error));
                    });
            });
        }
    }

    private remoteHistoryProviderName(): string {
        switch (this.host.settings.activeSyncProvider) {
            case "github":
                return "GitHub";
            case "gitlab":
                return "GitLab";
            case "gitea":
                return "Gitea";
            case "git":
                return "remote";
        }
        // Fallback for future/unknown providers
        const provider = String(this.host.settings.activeSyncProvider ?? "");
        return provider.length > 0 ? provider : "remote";
    }

    private addEncryptionMenuItems(menu: Menu, file: TFile): void {
        menu.addItem((item) => {
            item.setTitle("Git: Encrypt file")
                .setIcon("lock")
                .setSection("action")
                .onClick(async () => {
                    try {
                        const success = await this.host.encryptSingleFile(file);
                        if (!success) {
                            this.host.displayError("Failed to encrypt file.");
                            return;
                        }
                    } catch (error) {
                        this.host.displayError(error);
                    }
                });
        });
        menu.addItem((item) => {
            item.setTitle("Git: Decrypt file")
                .setIcon("unlock")
                .setSection("action")
                .onClick(async () => {
                    try {
                        const success = await this.host.decryptSingleFile(file);
                        if (!success) {
                            this.host.displayError("Failed to decrypt file.");
                        }
                    } catch (error) {
                        this.host.displayError(error);
                    }
                });
        });
    }
}
