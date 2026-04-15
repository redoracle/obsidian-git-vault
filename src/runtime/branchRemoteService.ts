import { Platform } from "obsidian";
import { CurrentGitAction } from "src/types";
import { formatRemoteUrl, splitRemoteBranch } from "src/utils";
import { SimpleGit } from "src/gitManager/simpleGit";
import type {
    IBranchRemoteHost,
    IBranchRemoteService,
    IRuntimeInteractionService,
} from "./runtimeServices";

function isRuntimeInteractionService(
    value: unknown
): value is IRuntimeInteractionService {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.chooseBranch === "function" &&
        typeof candidate.promptText === "function" &&
        typeof candidate.openFileHistory === "function"
    );
}

export class BranchRemoteService implements IBranchRemoteService {
    constructor(private readonly host: IBranchRemoteHost) {}

    private get interactions(): IRuntimeInteractionService {
        const interactions: unknown = Reflect.get(this.host, "interactions");
        if (!isRuntimeInteractionService(interactions)) {
            throw new Error(
                "BranchRemoteService requires this.host.interactions to satisfy IRuntimeInteractionService."
            );
        }
        return interactions;
    }

    async switchRemoteBranch(): Promise<string | undefined> {
        if (!(await this.host.ensureInitialized())) return;

        const selectedBranch = (await this.selectRemoteBranch()) || "";
        const [remote, branch] = splitRemoteBranch(selectedBranch);

        if (branch !== undefined && remote !== undefined) {
            await this.host.gitManager.checkout(branch, remote);
            this.host.displayMessage(`Switched to ${selectedBranch}`);
            this.host.refreshWorkspace();
            this.host
                .notifyIfNonDefaultTrackingBranch()
                .catch((e) =>
                    this.host.log("notifyIfNonDefaultTrackingBranch failed:", e)
                );
            await this.host.branchBar?.display();
            return selectedBranch;
        }
    }

    async createBranch(): Promise<string | undefined> {
        if (!(await this.host.ensureInitialized())) return;

        const newBranch = await this.interactions.promptText({
            placeholder: "Create new branch",
        });
        if (newBranch !== undefined) {
            await this.host.gitManager.createBranch(newBranch);
            this.host.displayMessage(`Created new branch ${newBranch}`);
            await this.host.branchBar?.display();
            return newBranch;
        }
    }

    async deleteBranch(): Promise<string | undefined> {
        if (!(await this.host.ensureInitialized())) return;

        const branchInfo = await this.host.gitManager.branchInfo();
        if (branchInfo.current) branchInfo.branches.remove(branchInfo.current);
        const branch = await this.interactions.promptText({
            options: branchInfo.branches,
            placeholder: "Delete branch",
            onlySelection: true,
        });
        if (branch !== undefined) {
            let force = false;
            const merged = await this.host.gitManager.branchIsMerged(branch);
            if (!merged) {
                const forceAnswer = await this.interactions.promptText({
                    options: ["YES", "NO"],
                    placeholder:
                        "This branch isn't merged into HEAD. Force delete?",
                    onlySelection: true,
                });
                if (forceAnswer !== "YES") {
                    return;
                }
                force = true;
            }
            await this.host.gitManager.deleteBranch(branch, force);
            this.host.displayMessage(`Deleted branch ${branch}`);
            await this.host.branchBar?.display();
            return branch;
        }
    }

    async remotesAreSet(): Promise<boolean> {
        if (this.host.settings.updateSubmodules) {
            return true;
        }
        const gitManager = this.host.gitManager;
        if (gitManager == null) {
            this.host.displayError(
                "Git is not ready yet. Please try again after initialization finishes."
            );
            return false;
        }

        const useSimpleGit =
            Platform.isDesktopApp &&
            this.host.settings.activeSyncProvider === "git";
        if (useSimpleGit) {
            if (gitManager instanceof SimpleGit) {
                if (
                    (await gitManager.getConfig(
                        "push.autoSetupRemote",
                        "all"
                    )) === "true"
                ) {
                    return true;
                }
            } else {
                this.host.log(
                    "Unexpected gitManager type for simple-git remotesAreSet; falling back to tracking-branch checks",
                    gitManager
                );
            }
        }
        if (!(await gitManager.branchInfo()).tracking) {
            this.host.showNotice(
                "No upstream branch is set. Please select one."
            );
            return await this.setUpstreamBranch();
        }
        return true;
    }

    async setUpstreamBranch(): Promise<boolean> {
        const remoteBranch = await this.selectRemoteBranch();

        if (remoteBranch === undefined) {
            this.host.displayError(
                "Aborted. No upstream-branch is set!",
                10000
            );
            this.host.setPluginState({ gitAction: CurrentGitAction.idle });
            return false;
        }

        try {
            await this.host.gitManager.updateUpstreamBranch(remoteBranch);
            this.host
                .notifyIfNonDefaultTrackingBranch()
                .catch((e) =>
                    this.host.log("notifyIfNonDefaultTrackingBranch failed:", e)
                );
            this.host.displayMessage(`Set upstream branch to ${remoteBranch}`);
        } finally {
            this.host.setPluginState({ gitAction: CurrentGitAction.idle });
        }
        return true;
    }

    async editRemotes(): Promise<string | undefined> {
        if (!(await this.host.ensureInitialized())) return;

        const remotes = await this.host.gitManager.getRemotes();

        const remoteName = await this.interactions.promptText({
            options: remotes,
            placeholder:
                "Select or create a new remote by typing its name and selecting it",
        });

        if (remoteName) {
            const oldUrl = await this.host.gitManager.getRemoteUrl(remoteName);
            const remoteURL = await this.interactions.promptText({
                initialValue: oldUrl,
                placeholder: "Enter remote URL",
            });
            if (remoteURL) {
                await this.host.gitManager.setRemote(
                    remoteName,
                    formatRemoteUrl(remoteURL)
                );
                return remoteName;
            }
        }
    }

    async selectRemoteBranch(): Promise<string | undefined> {
        let remotes = await this.host.gitManager.getRemotes();
        let selectedRemote: string | undefined;
        if (remotes.length === 0) {
            selectedRemote = await this.editRemotes();
            if (selectedRemote === undefined) {
                remotes = await this.host.gitManager.getRemotes();
            }
        }

        const remoteName =
            selectedRemote ??
            (await this.interactions.promptText({
                options: remotes,
                placeholder:
                    "Select or create a new remote by typing its name and selecting it",
            }));

        if (remoteName) {
            this.host.displayMessage("Fetching remote branches");
            await this.host.gitManager.fetch(remoteName);
            const branches =
                await this.host.gitManager.getRemoteBranches(remoteName);
            const branch = await this.interactions.promptText({
                options: branches,
                placeholder:
                    "Select or create a new remote branch by typing its name and selecting it",
            });
            if (branch === undefined) return;
            if (!branch.startsWith(remoteName + "/")) {
                return `${remoteName}/${branch}`;
            }
            return branch;
        }
    }

    async removeRemote(): Promise<void> {
        if (!(await this.host.ensureInitialized())) return;

        const remotes = await this.host.gitManager.getRemotes();
        const remoteName = await this.interactions.promptText({
            options: remotes,
            placeholder: "Select a remote",
        });

        if (remoteName) {
            await this.host.gitManager.removeRemote(remoteName);
            this.host.displayMessage(`Removed remote ${remoteName}`);
        }
    }
}
