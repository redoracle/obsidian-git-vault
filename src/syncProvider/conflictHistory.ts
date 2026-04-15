import { Modal, Setting, normalizePath } from "obsidian";
import type ObsidianGit from "../main";
import type {
    Conflict,
    ConflictResolution,
    SyncProviderType,
} from "./syncProvider";

export interface ConflictHistoryEntry {
    timestamp: number;
    provider: SyncProviderType;
    path: string;
    strategy: ConflictResolution["strategy"];
    automatic: boolean;
    localHash?: string;
    remoteHash?: string;
    resultHash?: string;
    encrypted: boolean;
    syncSessionId: string;
}

const HISTORY_FILE = "conflict-history.json";
const HISTORY_LIMIT = 200;
const MAX_VISIBLE_ENTRIES = 50;

async function computeContentHash(
    content: string | Uint8Array | undefined
): Promise<string | undefined> {
    if (content === undefined) {
        return undefined;
    }
    const bytes =
        typeof content === "string"
            ? Buffer.from(content, "utf8")
            : Buffer.from(content);
    const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
    const payload = Buffer.concat([header, bytes]);
    const digest = await crypto.subtle.digest("SHA-1", payload);
    return Buffer.from(digest).toString("hex");
}

export class ConflictHistoryManager {
    private appendQueue: Promise<void> = Promise.resolve();

    constructor(private readonly plugin: ObsidianGit) {}

    private get filePath(): string {
        return normalizePath(
            `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/${HISTORY_FILE}`
        );
    }

    async listEntries(): Promise<ConflictHistoryEntry[]> {
        const exists = await this.plugin.app.vault.adapter.exists(
            this.filePath
        );
        if (!exists) {
            return [];
        }
        try {
            const raw = await this.plugin.app.vault.adapter.read(this.filePath);
            const parsed = JSON.parse(raw) as ConflictHistoryEntry[];
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.error("Failed to read conflict history", error);
            return [];
        }
    }

    async appendEntries(entries: ConflictHistoryEntry[]): Promise<void> {
        if (entries.length === 0) {
            return;
        }

        const appendOperation = async (): Promise<void> => {
            const current = await this.listEntries();
            const merged = [...entries, ...current].slice(0, HISTORY_LIMIT);
            await this.plugin.app.vault.adapter.write(
                this.filePath,
                JSON.stringify(merged, null, 2)
            );
        };

        const result = this.appendQueue.then(appendOperation, appendOperation);
        // Queue and serialize append operations:
        // - Chain appendOperation onto the current appendQueue to ensure only one append runs at a time
        // - If the previous operation failed, still run the next (second arg to .then)
        // - Set this.appendQueue = result.catch(() => undefined) so a failed operation doesn't block future appends
        // - Await result so the caller still observes errors from this call
        this.appendQueue = result.catch(() => undefined);
        await result;
    }

    async buildEntries(args: {
        conflicts: Conflict[];
        resolutions: ConflictResolution[];
        provider: SyncProviderType;
        automatic: boolean;
        encrypted: boolean;
        syncSessionId: string;
    }): Promise<ConflictHistoryEntry[]> {
        const conflictByPath = new Map(
            args.conflicts.map((conflict) => [conflict.path, conflict])
        );

        return Promise.all(
            args.resolutions.map(async (resolution) => {
                const conflict = conflictByPath.get(resolution.path);
                const localHash = await computeContentHash(
                    conflict?.localContent
                );
                const remoteHash = await computeContentHash(
                    conflict?.remoteContent
                );
                const resultHash =
                    resolution.strategy === "manual"
                        ? await computeContentHash(resolution.manualContent)
                        : resolution.strategy === "always-local"
                          ? localHash
                          : resolution.strategy === "always-remote"
                            ? remoteHash
                            : undefined;

                return {
                    timestamp: Date.now(),
                    provider: args.provider,
                    path: resolution.path,
                    strategy: resolution.strategy,
                    automatic: args.automatic,
                    localHash,
                    remoteHash,
                    resultHash,
                    encrypted: args.encrypted,
                    syncSessionId: args.syncSessionId,
                };
            })
        );
    }
}

export class ConflictHistoryModal extends Modal {
    private visibleCount = MAX_VISIBLE_ENTRIES;

    constructor(
        private readonly plugin: ObsidianGit,
        private readonly entries: ConflictHistoryEntry[]
    ) {
        super(plugin.app);
    }

    onOpen(): void {
        this.renderEntries();
    }

    private renderEntries(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Conflict Resolution History" });

        if (this.entries.length === 0) {
            contentEl.createEl("p", {
                text: "No conflict resolutions have been recorded on this device yet.",
            });
            return;
        }

        const visibleEntries = this.entries.slice(0, this.visibleCount);
        contentEl.createEl("p", {
            text: `Showing ${visibleEntries.length} of ${this.entries.length} recorded conflict resolution(s).`,
        });

        if (this.entries.length > MAX_VISIBLE_ENTRIES) {
            new Setting(contentEl)
                .setName("History view")
                .setDesc("Load more entries only when needed.")
                .addButton((button) => {
                    button
                        .setButtonText("Show more")
                        .setDisabled(this.visibleCount >= this.entries.length)
                        .onClick(() => {
                            this.visibleCount = Math.min(
                                this.visibleCount + MAX_VISIBLE_ENTRIES,
                                this.entries.length
                            );
                            this.renderEntries();
                        });
                })
                .addButton((button) => {
                    button
                        .setButtonText("Show less")
                        .setDisabled(this.visibleCount <= MAX_VISIBLE_ENTRIES)
                        .onClick(() => {
                            this.visibleCount = MAX_VISIBLE_ENTRIES;
                            this.renderEntries();
                        });
                });
        }

        for (const entry of visibleEntries) {
            const setting = new Setting(contentEl)
                .setName(entry.path)
                .setDesc(
                    `${new Date(entry.timestamp).toLocaleString()} • ${entry.provider} • ${
                        entry.automatic ? "auto" : "manual"
                    } • ${entry.strategy}${entry.encrypted ? " • encrypted" : ""}`
                );
            setting.infoEl.remove();
            setting.controlEl.empty();
            setting.controlEl.createEl("code", {
                text: entry.syncSessionId,
            });
        }
    }
}
