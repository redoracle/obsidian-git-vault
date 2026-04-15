import type { WorkspaceLeaf } from "obsidian";
import { ItemView, Setting } from "obsidian";
import { SYNC_METADATA_VIEW_CONFIG } from "src/constants";
import type ObsidianGit from "src/main";

export default class SyncMetadataView extends ItemView {
    private unsubscribe?: () => void;
    private renderToken = 0;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: ObsidianGit
    ) {
        super(leaf);
    }

    getViewType(): string {
        return SYNC_METADATA_VIEW_CONFIG.type;
    }

    getDisplayText(): string {
        return SYNC_METADATA_VIEW_CONFIG.name;
    }

    getIcon(): string {
        return SYNC_METADATA_VIEW_CONFIG.icon;
    }

    async onOpen(): Promise<void> {
        this.unsubscribe = this.plugin.syncState.subscribe(() => {
            void this.renderMetadata();
        });
        this.registerEvent(
            this.app.workspace.on("file-open", () => {
                void this.renderMetadata();
            })
        );
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                void this.renderMetadata();
            })
        );
        await this.renderMetadata();
    }

    onClose(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        return Promise.resolve();
    }

    private renderRow(name: string, value: string): void {
        new Setting(this.contentEl).setName(name).setDesc(value);
    }

    private async renderMetadata(): Promise<void> {
        const token = ++this.renderToken;
        this.contentEl.empty();
        this.contentEl.createEl("h2", { text: "Sync Metadata" });

        const file = this.app.workspace.getActiveFile();
        if (!file) {
            this.contentEl.createEl("p", {
                text: "Open a note or file to inspect its sync metadata.",
            });
            return;
        }

        let metadata;
        try {
            metadata = await this.plugin.syncManager.getFileMetadata(file.path);
            if (token !== this.renderToken || !metadata) {
                return;
            }
        } catch (error) {
            if (token !== this.renderToken) {
                return;
            }
            console.error("Failed to load sync metadata", error);
            this.contentEl.createEl("p", {
                text: "Failed to load sync metadata for the active file.",
                cls: "git-vault-metadata-error",
            });
            return;
        }

        this.contentEl.createEl("p", {
            text: file.path,
            cls: "git-vault-metadata-path",
        });

        this.renderRow("Provider", metadata.provider);
        this.renderRow("In scope", metadata.inScope ? "Yes" : "No");
        this.renderRow("Excluded", metadata.excluded ? "Yes" : "No");
        this.renderRow("Remote path", metadata.remotePath ?? "Not available");
        this.renderRow("Local hash", metadata.localHash ?? "Not available");
        this.renderRow(
            "Remote revision",
            metadata.remoteRevision ?? "Not available"
        );
        this.renderRow(
            "Encrypted",
            metadata.encrypted ? "Enabled for API sync" : "No"
        );
        this.renderRow(
            "Last sync",
            metadata.lastSyncTime
                ? new Date(metadata.lastSyncTime).toLocaleString()
                : "Never"
        );
        this.renderRow(
            "Last sync result",
            metadata.lastSyncResult ?? "Not available"
        );
        this.renderRow("Remote URL", metadata.remoteUrl ?? "Not available");
    }
}
