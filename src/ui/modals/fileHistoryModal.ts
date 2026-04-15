import { Modal, type App, TFile } from "obsidian";
import type { GitManager } from "src/gitManager/gitManager";
import type { SimpleGit } from "src/gitManager/simpleGit";
import type { LogEntry } from "../../types";
import { fileIsBinary } from "../../utils";

export interface IFileHistoryModalHost {
    app: App;
    gitManager: GitManager;
    useSimpleGit: boolean;
    showNotice(message: string, timeout?: number): void;
}

function isSimpleGitManager(manager: GitManager): manager is SimpleGit {
    return typeof (manager as { show?: unknown }).show === "function";
}

/**
 * FileHistoryModal
 *
 * Shows the git commit history for a single file.
 * Each entry can be previewed (read-only) or restored to overwrite the
 * current vault copy.
 *
 * Requires SimpleGit (desktop only) for `show()` support.
 */
export class FileHistoryModal extends Modal {
    private logs: LogEntry[] | undefined;
    private readonly isBinaryFile: boolean;
    private isOpen = false;

    constructor(
        private readonly plugin: IFileHistoryModalHost,
        private readonly file: TFile
    ) {
        super(plugin.app);
        this.isBinaryFile = fileIsBinary(file.path);
        this.modalEl.addClass("git-vault-file-history-modal");
        this.titleEl.textContent = `History — ${file.path}`;
    }

    async onOpen(): Promise<void> {
        this.isOpen = true;
        this.renderLoading();
        try {
            const logs = await this.plugin.gitManager.log(
                this.file.path,
                true,
                50
            );
            if (!this.isOpen) return;
            this.logs = logs;
            this.renderList();
        } catch (e) {
            if (!this.isOpen) return;
            const msg = e instanceof Error ? e.message : String(e);
            this.renderError(msg);
        }
    }

    onClose(): void {
        this.isOpen = false;
        this.contentEl.empty();
    }

    // ── Render helpers ─────────────────────────────────────────────────────

    private renderLoading(): void {
        this.contentEl.empty();
        this.contentEl.createDiv({
            cls: "git-vault-fh-loading",
            text: "Loading history…",
        });
    }

    private renderError(message: string): void {
        this.contentEl.empty();
        this.contentEl.createDiv({
            cls: "git-vault-fh-error",
            text: `Failed to load history: ${message}`,
        });
    }

    private renderList(): void {
        const { contentEl } = this;
        contentEl.empty();

        if (!this.logs || this.logs.length === 0) {
            contentEl.createDiv({
                cls: "git-vault-fh-empty",
                text: "No commits found for this file.",
            });
            return;
        }

        if (this.isBinaryFile) {
            contentEl.createDiv({
                cls: "git-vault-fh-error",
                text: "History preview/restore for binary files is not supported yet.",
            });
            return;
        }

        const list = contentEl.createDiv("git-vault-fh-list");

        this.logs.forEach((entry, idx) => {
            const row = list.createDiv("git-vault-fh-row");

            // Commit info
            const info = row.createDiv("git-vault-fh-info");
            info.createDiv({
                cls: "git-vault-fh-message",
                text: entry.message,
            });
            const meta = info.createDiv("git-vault-fh-meta");
            meta.createSpan({
                cls: "git-vault-fh-hash",
                text: entry.hash.slice(0, 7),
            });
            meta.createSpan({ text: " · " });
            meta.createSpan({
                cls: "git-vault-fh-date",
                text: entry.date,
            });
            meta.createSpan({ text: " · " });
            const authorName = this.getAuthorName(entry);
            meta.createSpan({ cls: "git-vault-fh-author", text: authorName });

            // Action buttons
            const actions = row.createDiv("git-vault-fh-actions");
            const btnPreview = actions.createEl("button", {
                text: "Preview",
                cls: "git-vault-btn-secondary",
            });
            btnPreview.addEventListener("click", () => {
                void this.showPreview(idx);
            });

            const btnRestore = actions.createEl("button", {
                text: "Restore",
                cls: "mod-warning",
            });
            btnRestore.addEventListener("click", () => {
                void this.confirmRestore(idx);
            });
        });
    }

    private getAuthorName(entry: LogEntry): string {
        return entry.author.name || "Unknown";
    }

    private async showPreview(idx: number): Promise<void> {
        if (!this.logs) return;
        const entry = this.logs[idx];
        if (!entry) return;

        const { contentEl } = this;
        contentEl.empty();

        // Back button
        const toolbar = contentEl.createDiv("git-vault-fh-toolbar");
        const btnBack = toolbar.createEl("button", {
            text: "← Back to list",
            cls: "git-vault-btn-secondary",
        });
        btnBack.addEventListener("click", () => this.renderList());

        toolbar.createSpan({
            cls: "git-vault-fh-preview-label",
            text: `${entry.hash.slice(0, 7)} — ${entry.message}`,
        });

        const btnRestore = toolbar.createEl("button", {
            text: "Restore this version",
            cls: "mod-warning",
        });
        btnRestore.addEventListener("click", () => {
            void this.confirmRestore(idx);
        });

        // Load content with a temporary loading state
        const previewContainer = contentEl.createDiv(
            "git-vault-fh-preview-container"
        );
        const loadingEl = previewContainer.createDiv({
            cls: "git-vault-fh-preview-loading",
            text: "Loading…",
        });
        try {
            const content = await this.getFileAtCommit(
                entry.hash,
                this.file.path
            );
            if (!this.isOpen) return;
            // Remove loading indicator and show content
            loadingEl.remove();
            const pre = previewContainer.createEl("pre", {
                cls: "git-vault-fh-preview-code",
            });
            pre.createEl("code", { text: content });
        } catch (e) {
            if (!this.isOpen) return;
            // Remove loading indicator and show error
            loadingEl.remove();
            const msg = e instanceof Error ? e.message : String(e);
            previewContainer.createDiv({
                cls: "git-vault-fh-error",
                text: `Cannot preview: ${msg}`,
            });
        }
    }

    private confirmRestore(idx: number): void {
        if (!this.logs) return;
        const entry = this.logs[idx];
        if (!entry) return;

        // Show confirmation dialog
        const { contentEl } = this;
        contentEl.empty();

        const confirm = contentEl.createDiv("git-vault-fh-confirm");
        confirm.createEl("h3", {
            text: "Restore file to this version?",
        });
        confirm.createDiv({
            cls: "git-vault-fh-confirm-detail",
            text: `This will overwrite "${this.file.path}" with the content from commit ${entry.hash.slice(0, 7)} (${entry.date}).`,
        });
        confirm.createDiv({
            cls: "git-vault-fh-confirm-warn",
            text: "You can undo this with Git if needed.",
        });

        const actions = confirm.createDiv("git-vault-fh-confirm-actions");
        const btnCancel = actions.createEl("button", {
            text: "Cancel",
            cls: "git-vault-btn-secondary",
        });
        btnCancel.addEventListener("click", () => this.renderList());

        const btnConfirm = actions.createEl("button", {
            text: "Restore",
            cls: "mod-warning",
        });
        btnConfirm.addEventListener("click", () => {
            void (async () => {
                if (!this.isOpen) {
                    return;
                }
                // Disable the button and apply a visual loading state
                btnConfirm.disabled = true;
                btnConfirm.classList.add("git-vault-btn-loading");
                try {
                    const content = await this.getFileAtCommit(
                        entry.hash,
                        this.file.path
                    );
                    if (!this.isOpen) {
                        return;
                    }
                    await this.app.vault.modify(this.file, content);
                    if (!this.isOpen) {
                        return;
                    }
                    this.plugin.showNotice(
                        `Restored "${this.file.path}" to ${entry.hash.slice(0, 7)}`
                    );
                    this.close();
                } catch (e) {
                    if (!this.isOpen) {
                        return;
                    }
                    const msg = e instanceof Error ? e.message : String(e);
                    this.plugin.showNotice(`Restore failed: ${msg}`);
                    btnConfirm.disabled = false;
                    btnConfirm.classList.remove("git-vault-btn-loading");
                    if (this.isOpen) {
                        this.renderList();
                    }
                }
            })();
        });
    }

    /**
     * Retrieve file content at a specific commit hash.
     * Uses SimpleGit's `show()` method (desktop only).
     */
    private async getFileAtCommit(
        hash: string,
        filePath: string
    ): Promise<string> {
        if (this.isBinaryFile) {
            throw new Error(
                "History preview/restore for binary files is not supported yet."
            );
        }
        if (!this.plugin.useSimpleGit) {
            throw new Error(
                "File version preview is only available on desktop."
            );
        }
        const manager = this.plugin.gitManager;
        if (!isSimpleGitManager(manager)) {
            throw new Error(
                "File version preview is only available when SimpleGit is active."
            );
        }
        return manager.show(hash, filePath);
    }
}
