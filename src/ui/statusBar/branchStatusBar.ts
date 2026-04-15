import { CurrentGitAction } from "src/types";
import type ObsidianGit from "src/main";

export class BranchStatusBar {
    constructor(
        private statusBarEl: HTMLElement,
        private readonly plugin: ObsidianGit
    ) {
        this.statusBarEl.setAttribute("data-git-vault-branch-status", "true");
        this.statusBarEl.addClass("mod-clickable");
        this.statusBarEl.onClickEvent((_) => {
            if (
                this.plugin.state.gitAction !== CurrentGitAction.idle ||
                this.plugin.syncState.getState().isSyncing
            ) {
                this.plugin.showNotice(
                    "Branch switching is busy right now. Wait for the current operation to finish.",
                    5000
                );
                return;
            }
            this.plugin
                .switchBranch()
                .catch((e) => this.plugin.displayError(e));
        });
    }

    async display() {
        let branchLabel = "";

        try {
            if (this.plugin.syncManager) {
                const selection =
                    await this.plugin.syncManager.getBranchSelection();
                branchLabel = selection.current ?? "";
            } else if (
                this.plugin.settings.activeSyncProvider === "git" &&
                this.plugin.gitReady
            ) {
                // Fallback when syncManager is not yet up (e.g. mid-init).
                const branchInfo = await this.plugin.gitManager.branchInfo();
                branchLabel = branchInfo.current ?? "";
            }
        } catch (err) {
            console.warn(
                "[Git Vault] BranchStatusBar: failed to resolve branch label:",
                err
            );
            branchLabel = "";
        }

        if (branchLabel.length > 0) {
            this.statusBarEl.setText(branchLabel);
            this.statusBarEl.setAttribute(
                "aria-label",
                `Current branch: ${branchLabel}`
            );
            this.statusBarEl.setAttribute("title", branchLabel);
        } else {
            this.statusBarEl.empty();
            this.statusBarEl.setAttribute("aria-label", "Branch selector");
            this.statusBarEl.removeAttribute("title");
        }
    }

    remove() {
        this.statusBarEl.remove();
    }
}
