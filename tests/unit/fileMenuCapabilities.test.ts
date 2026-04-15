import { Menu, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { FileMenuService } from "../../src/runtime/fileMenuService";
import { mayTriggerFileMenu, resolveFileMenuRouting } from "../../src/utils";

class FakeMenuItem {
    title = "";
    clickHandler: (() => void) | undefined;

    setTitle(title: string): this {
        this.title = title;
        return this;
    }

    setIcon(_icon: string): this {
        return this;
    }

    setSection(_section: string): this {
        return this;
    }

    onClick(handler: () => void): this {
        this.clickHandler = handler;
        return this;
    }
}

interface FakeMenu {
    items: FakeMenuItem[];
    addItem(callback: (item: FakeMenuItem) => void): void;
}

function createFakeMenu(): FakeMenu {
    const items: FakeMenuItem[] = [];
    return {
        items,
        addItem(callback: (item: FakeMenuItem) => void): void {
            const item = new FakeMenuItem();
            callback(item);
            items.push(item);
        },
    };
}

describe("resolveFileMenuRouting", () => {
    it("disables all actions when file menu integration is off", () => {
        expect(
            resolveFileMenuRouting({
                showFileMenu: false,
                source: "file-explorer-context-menu",
                canDoGitActions: true,
                canShowHistory: true,
                canShowEncryption: true,
            })
        ).toEqual({
            shouldHandle: false,
            showExplorerGitActions: false,
            showSourceControlGitignore: false,
            showHistory: false,
            showEncryption: false,
        });
    });

    it("shows file explorer git actions, history, and encryption when all capabilities are available", () => {
        expect(
            resolveFileMenuRouting({
                showFileMenu: true,
                source: "file-explorer-context-menu",
                canDoGitActions: true,
                canShowHistory: true,
                canShowEncryption: true,
            })
        ).toEqual({
            shouldHandle: true,
            showExplorerGitActions: true,
            showSourceControlGitignore: false,
            showHistory: true,
            showEncryption: true,
        });
    });

    it("keeps encryption visible in source control even when git actions and history are unavailable", () => {
        expect(
            resolveFileMenuRouting({
                showFileMenu: true,
                source: "git-source-control",
                canDoGitActions: false,
                canShowHistory: false,
                canShowEncryption: true,
            })
        ).toEqual({
            shouldHandle: true,
            showExplorerGitActions: false,
            showSourceControlGitignore: false,
            showHistory: false,
            showEncryption: true,
        });
    });

    it("shows source control history, encryption, and gitignore when the corresponding capabilities are available", () => {
        expect(
            resolveFileMenuRouting({
                showFileMenu: true,
                source: "git-source-control",
                canDoGitActions: true,
                canShowHistory: true,
                canShowEncryption: true,
            })
        ).toEqual({
            shouldHandle: true,
            showExplorerGitActions: false,
            showSourceControlGitignore: true,
            showHistory: true,
            showEncryption: true,
        });
    });

    it("does not expose file-only actions for source control string-path fallbacks", () => {
        expect(
            resolveFileMenuRouting({
                showFileMenu: true,
                source: "git-source-control",
                canDoGitActions: true,
                canShowHistory: false,
                canShowEncryption: false,
            })
        ).toEqual({
            shouldHandle: true,
            showExplorerGitActions: false,
            showSourceControlGitignore: true,
            showHistory: false,
            showEncryption: false,
        });
    });

    it("supports history-view menu sources for file-level actions only", () => {
        expect(
            resolveFileMenuRouting({
                showFileMenu: true,
                source: "git-history",
                canDoGitActions: true,
                canShowHistory: true,
                canShowEncryption: true,
            })
        ).toEqual({
            shouldHandle: true,
            showExplorerGitActions: false,
            showSourceControlGitignore: false,
            showHistory: true,
            showEncryption: true,
        });
    });

    it("allows encryption without exposing history when local git history is unavailable", () => {
        expect(
            resolveFileMenuRouting({
                showFileMenu: true,
                source: "file-explorer-context-menu",
                canDoGitActions: false,
                canShowHistory: false,
                canShowEncryption: true,
            })
        ).toEqual({
            shouldHandle: true,
            showExplorerGitActions: false,
            showSourceControlGitignore: false,
            showHistory: false,
            showEncryption: true,
        });
    });
});

describe("FileMenuService", () => {
    it("adds an Obsidian file history item for local SimpleGit history", () => {
        const file = new TFile();
        file.path = "notes/example.md";
        const openRemoteFileHistory = vi.fn(() => Promise.resolve());
        const openFileHistory = vi.fn();
        const service = new FileMenuService({
            app: {
                vault: {
                    adapter: {},
                },
            },
            settings: {
                showFileMenu: true,
                activeSyncProvider: "git",
            },
            gitReady: true,
            useSimpleGit: true,
            supportsRemoteFileHistory: false,
            gitManager: {},
            promiseQueue: {
                addTask: vi.fn(),
            },
            interactions: {
                openFileHistory,
            },
            displayMessage: vi.fn(),
            displayError: vi.fn(),
            log: vi.fn(),
            showNotice: vi.fn(),
            refreshWorkspace: vi.fn(),
            openRemoteFileHistory,
            addFileToGitignore: vi.fn(),
            encryptSingleFile: vi.fn(),
            decryptSingleFile: vi.fn(),
            stageFile: vi.fn(),
            unstageFile: vi.fn(),
        } as never);
        const menu = createFakeMenu();

        service.handleFileMenu(
            menu as never,
            file,
            "file-explorer-context-menu",
            "file-menu"
        );

        const historyItem = menu.items.find((item) =>
            item.title === "Git: View file history in Obsidian"
        );
        expect(historyItem?.title).toBe("Git: View file history in Obsidian");

        historyItem?.clickHandler?.();

        expect(openFileHistory).toHaveBeenCalledWith(file);
        expect(openRemoteFileHistory).not.toHaveBeenCalled();
    });

    it("adds a remote file history item for API providers that expose history links", () => {
        const file = new TFile();
        file.path = "notes/example.md";
        const openRemoteFileHistory = vi.fn(() => Promise.resolve());
        const openFileHistory = vi.fn();
        const service = new FileMenuService({
            app: {
                vault: {
                    adapter: {},
                },
            },
            settings: {
                showFileMenu: true,
                activeSyncProvider: "github",
            },
            gitReady: false,
            useSimpleGit: false,
            supportsRemoteFileHistory: true,
            gitManager: {},
            promiseQueue: {
                addTask: vi.fn(),
            },
            interactions: {
                openFileHistory,
            },
            displayMessage: vi.fn(),
            displayError: vi.fn(),
            log: vi.fn(),
            showNotice: vi.fn(),
            refreshWorkspace: vi.fn(),
            openRemoteFileHistory,
            addFileToGitignore: vi.fn(),
            encryptSingleFile: vi.fn(),
            decryptSingleFile: vi.fn(),
            stageFile: vi.fn(),
            unstageFile: vi.fn(),
        } as never);
        const menu = createFakeMenu();

        service.handleFileMenu(
            menu as never,
            file,
            "file-explorer-context-menu",
            "file-menu"
        );

        const historyItem = menu.items.find((item) =>
            item.title === "Git: Open file history on GitHub"
        );
        expect(historyItem?.title).toBe("Git: Open file history on GitHub");

        historyItem?.clickHandler?.();

        expect(openRemoteFileHistory).toHaveBeenCalledWith(file);
        expect(openFileHistory).not.toHaveBeenCalled();
    });
});

describe("mayTriggerFileMenu", () => {
    it("dispatches the standard file-menu event for source-control items that resolve to a vault file", () => {
        const file = new TFile();
        file.path = "notes/example.md";
        const trigger = vi.fn();
        const app = {
            vault: {
                getAbstractFileByPath: vi.fn().mockReturnValue(file),
            },
            workspace: {
                trigger,
            },
        };
        const event = {
            button: 2,
            pageX: 10,
            pageY: 20,
        } as MouseEvent;
        const view = { id: "leaf" } as never;

        mayTriggerFileMenu(
            app as never,
            event,
            file.path,
            view,
            "git-source-control"
        );

        expect(trigger).toHaveBeenCalledTimes(1);
        expect(trigger).toHaveBeenCalledWith(
            "file-menu",
            expect.any(Menu),
            file,
            "git-source-control",
            view
        );
        const menu = trigger.mock.calls[0]?.[1] as Menu & {
            lastShownAt?: { x: number; y: number };
        };
        expect(menu.lastShownAt).toEqual({ x: 10, y: 20 });
    });

    it("falls back to obsidian-git:menu when the source-control path does not resolve to a vault file", () => {
        const trigger = vi.fn();
        const app = {
            vault: {
                getAbstractFileByPath: vi.fn().mockReturnValue(null),
            },
            workspace: {
                trigger,
            },
        };
        const event = {
            button: 2,
            pageX: 3,
            pageY: 4,
        } as MouseEvent;
        const view = { id: "leaf" } as never;

        mayTriggerFileMenu(
            app as never,
            event,
            "missing.md",
            view,
            "git-source-control"
        );

        expect(trigger).toHaveBeenCalledTimes(1);
        expect(trigger).toHaveBeenCalledWith(
            "obsidian-git:menu",
            expect.any(Menu),
            "missing.md",
            "git-source-control",
            view
        );
        const menu = trigger.mock.calls[0]?.[1] as Menu & {
            lastShownAt?: { x: number; y: number };
        };
        expect(menu.lastShownAt).toEqual({ x: 3, y: 4 });
    });
});
