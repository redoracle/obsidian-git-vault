import { html } from "diff2html";
import type { EventRef, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { ItemView, Platform } from "obsidian";
import { DIFF_VIEW_CONFIG } from "src/constants";
import { SimpleGit } from "src/gitManager/simpleGit";
import type ObsidianGit from "src/main";
import type { DiffViewState } from "src/types";

export default class DiffView extends ItemView {
    parser: DOMParser;
    gettingDiff = false;
    state!: DiffViewState;
    gitRefreshRef: EventRef;
    gitViewRefreshRef?: EventRef;

    constructor(
        leaf: WorkspaceLeaf,
        private plugin: ObsidianGit
    ) {
        super(leaf);
        this.parser = new DOMParser();
        this.navigation = true;
        this.contentEl.addClass("git-diff");
        this.gitRefreshRef = this.app.workspace.on(
            "obsidian-git:status-changed",
            () => {
                this.refresh().catch(console.error);
            }
        );
    }

    getViewType(): string {
        return DIFF_VIEW_CONFIG.type;
    }

    getDisplayText(): string {
        if (this.state?.bFile != null) {
            let fileName = this.state.bFile.split("/").last();
            if (fileName?.endsWith(".md")) fileName = fileName.slice(0, -3);

            return `Diff: ${fileName}`;
        }
        return DIFF_VIEW_CONFIG.name;
    }

    getIcon(): string {
        return DIFF_VIEW_CONFIG.icon;
    }

    async setState(state: DiffViewState, _: ViewStateResult): Promise<void> {
        this.state = state;

        if (Platform.isMobile) {
            //Update view title on mobile only to show the file name of the diff
            this.leaf.view.titleEl.textContent = this.getDisplayText();
        }

        await this.refresh();
    }

    getState(): Record<string, unknown> {
        return this.state as unknown as Record<string, unknown>;
    }

    onClose(): Promise<void> {
        this.app.workspace.offref(this.gitRefreshRef);
        if (this.gitViewRefreshRef) {
            this.app.workspace.offref(this.gitViewRefreshRef);
        }
        return super.onClose();
    }

    async onOpen(): Promise<void> {
        await this.refresh();
        return super.onOpen();
    }

    async refresh(): Promise<void> {
        if (this.state?.bFile && !this.gettingDiff && this.plugin.gitManager) {
            this.gettingDiff = true;
            // Create a header (title + actions) and show a spinner while diff is computed
            this.contentEl.empty();
            const headerEl = this.contentEl.createDiv({
                cls: "git-diff-header",
            });
            const refLabel = (r?: string) => {
                if (r === undefined) return "Working Tree";
                if (r === "") return "Index";
                return r.length > 7 ? r.substring(0, 7) : r;
            };
            headerEl.createSpan({
                cls: "git-diff-title",
                text: `Comparing ${refLabel(this.state.aRef)} → ${refLabel(
                    this.state.bRef
                )} — ${this.state.bFile}`,
            });
            const actions = headerEl.createDiv({ cls: "git-diff-actions" });
            const spinner = headerEl.createDiv({ cls: "git-diff-spinner" });
            const openSplitBtn = actions.createEl("button", {
                text: "Open split view",
            });
            openSplitBtn.addClass("git-vault-btn-secondary");
            openSplitBtn.onmousedown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.plugin.tools.openDiff({
                    aFile: this.state.aFile,
                    bFile: this.state.bFile,
                    aRef: this.state.aRef,
                    bRef: this.state.bRef,
                    event: e,
                });
            };

            const stageBtn = actions.createEl("button", { text: "Stage file" });
            stageBtn.addClass("git-vault-btn-secondary");
            stageBtn.onmousedown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                void this.plugin.promiseQueue.addTask(async () => {
                    // Only refresh UI state when a staging action actually happened.
                    let stagingSucceeded = false;
                    try {
                        // Defensive: ensure gitManager is available before staging
                        if (!this.plugin.gitManager) {
                            this.plugin.displayError(
                                "Git manager is not available"
                            );
                            return;
                        }

                        await this.plugin.gitManager.stage(
                            this.state.bFile,
                            true
                        );
                        this.plugin.showNotice("Staged file", 3000);
                        // Mark that staging completed so finally can refresh UI.
                        stagingSucceeded = true;
                    } catch (err) {
                        this.plugin.displayError(err);
                    } finally {
                        if (stagingSucceeded) {
                            try {
                                this.plugin.editorIntegration.signsFeature.refresh();
                            } catch (_e) {
                                // Intentionally ignore refresh errors: best-effort UI update
                            }
                            // Intentionally refresh workspace to update UI state after staging
                            this.plugin.app.workspace.trigger(
                                "obsidian-git:refresh"
                            );
                        }
                    }
                });
            };

            const vaultPath = this.plugin.gitManager.getRelativeVaultPath(
                this.state.bFile
            );
            try {
                let diff = await this.plugin.gitManager.getDiffString(
                    this.state.bFile,
                    this.state.aRef == "HEAD",
                    this.state.bRef
                );
                if (!diff) {
                    if (
                        this.plugin.useSimpleGit &&
                        this.plugin.gitManager instanceof SimpleGit &&
                        (await this.plugin.gitManager.isTracked(
                            this.state.bFile
                        ))
                    ) {
                        // File is tracked but no changes
                        diff = [
                            `--- ${this.state.aFile}`,
                            `+++ ${this.state.bFile}`,
                            "",
                        ].join("\n");
                    } else if (await this.app.vault.adapter.exists(vaultPath)) {
                        const content =
                            await this.app.vault.adapter.read(vaultPath);
                        const header = `--- /dev/null
+++ ${this.state.bFile}
@@ -0,0 +1,${content.split("\n").length} @@`;

                        diff = [
                            ...header.split("\n"),
                            ...content.split("\n").map((line) => `+${line}`),
                        ].join("\n");
                    }
                }

                if (diff) {
                    const diffEl = this.parser
                        .parseFromString(html(diff), "text/html")
                        .querySelector(".d2h-file-diff");
                    this.contentEl.append(diffEl!);
                } else {
                    const div = this.contentEl.createDiv({
                        cls: "obsidian-git-center",
                    });
                    div.createSpan({
                        text: "⚠️",
                        attr: { style: "font-size: 2em" },
                    });
                    div.createEl("br");
                    div.createSpan({
                        text: "File not found: " + this.state.bFile,
                    });
                }
            } finally {
                // hide spinner
                try {
                    spinner.remove();
                } catch (_e) {
                    void 0;
                }
                this.gettingDiff = false;
            }
        }
    }
}
