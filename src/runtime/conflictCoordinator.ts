import { MarkdownView, TFile, type WorkspaceLeaf } from "obsidian";
import { CONFLICT_OUTPUT_FILE } from "src/constants";
import { CurrentGitAction } from "src/types";
import type {
    IConflictCoordinator,
    IConflictCoordinatorHost,
} from "./runtimeServices";

export class ConflictCoordinator implements IConflictCoordinator {
    constructor(private readonly host: IConflictCoordinatorHost) {}

    async mayDeleteConflictFile(): Promise<void> {
        const file =
            this.host.app.vault.getAbstractFileByPath(CONFLICT_OUTPUT_FILE);
        if (!(file instanceof TFile)) {
            return;
        }
        try {
            const leavesToDetach: WorkspaceLeaf[] = [];
            this.host.app.workspace.iterateAllLeaves((leaf) => {
                if (
                    leaf.view instanceof MarkdownView &&
                    leaf.view.file?.path === file.path
                ) {
                    leavesToDetach.push(leaf);
                }
            });
            for (const leaf of leavesToDetach) {
                leaf.detach();
            }
            await this.host.app.vault.delete(file);
        } catch (error) {
            this.host.log(
                `Failed to delete conflict file ${CONFLICT_OUTPUT_FILE}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
            );
            throw error;
        }
    }

    async handleConflict(conflicted?: string[]): Promise<void> {
        this.host.localStorage.setConflict(true);
        if (conflicted === undefined) {
            await this.host.tools.writeAndOpenFile("");
            return;
        }

        const lines = [
            "# Conflicts",
            "Please resolve them and commit them using the commands `Git: Commit all changes` followed by `Git: Push`",
            "(This file will automatically be deleted before commit)",
            "[[#Additional Instructions]] available below file list",
            "",
            ...conflicted.map((entry) => {
                const file = this.host.app.vault.getAbstractFileByPath(entry);
                if (file instanceof TFile) {
                    const link = this.host.app.metadataCache.fileToLinktext(
                        file,
                        "/"
                    );
                    return `- [[${link}]]`;
                }
                return `- Not a file: ${entry}`;
            }),
            `
# Additional Instructions
I strongly recommend to use "Source mode" for viewing the conflicted files. For simple conflicts, in each file listed above replace every occurrence of the following text blocks with the desired text.
\`\`\`diff
<<<<<<< HEAD
    File changes in local repository
=======
    File changes in remote repository
>>>>>>> <remote>/<branch>
\`\`\``,
        ];
        await this.host.tools.writeAndOpenFile(lines.join("\n"));
    }

    handleNoNetworkError(error: Error): void {
        const errorMessage = error.stack ?? error.message ?? String(error);
        this.host.log(`Network error: ${errorMessage}`);
        if (!this.host.state.offlineMode) {
            this.host.displayError(
                "Git: Going into offline mode. Future network errors will no longer be displayed.",
                2000
            );
        } else {
            this.host.log(
                "Encountered network error, but already in offline mode"
            );
        }
        this.host.setPluginState({
            gitAction: CurrentGitAction.idle,
            offlineMode: true,
        });
    }
}
