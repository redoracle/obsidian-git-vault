import { normalizePath, type App } from "obsidian";

export interface SyncManifestData {
    manifest: string[];
    sample: string[];
}

export interface ISyncManifestStore {
    getSyncManifest(): Promise<string[]>;
    loadSyncManifestSample(): Promise<string[]>;
    saveSyncManifest(
        manifest: Iterable<string>,
        sample?: Iterable<string>
    ): Promise<void>;
    clearSyncManifest(): Promise<void>;
}

export class SyncManifestStore implements ISyncManifestStore {
    private readonly app: App;
    private readonly manifestPath: string;

    constructor(app: App, pluginId: string) {
        this.app = app;
        if (!/^[A-Za-z0-9_-]+$/.test(pluginId)) {
            throw new Error(
                `SyncManifestStore: invalid pluginId "${pluginId}"`
            );
        }
        this.manifestPath = normalizePath(
            `${app.vault.configDir}/plugins/${pluginId}/sync-manifest.json`
        );
    }

    async getSyncManifest(): Promise<string[]> {
        const data = await this.readManifestData();
        return data?.manifest ?? [];
    }

    async loadSyncManifestSample(): Promise<string[]> {
        const data = await this.readManifestData();
        return data?.sample ?? [];
    }

    async saveSyncManifest(
        manifest: Iterable<string>,
        sample: Iterable<string> = []
    ): Promise<void> {
        await this.writeManifestData({
            manifest: [...manifest],
            sample: [...sample],
        });
    }

    async clearSyncManifest(): Promise<void> {
        await this.writeManifestData({ manifest: [], sample: [] });
    }

    private async readManifestData(): Promise<SyncManifestData | null> {
        const exists = await this.ensureManifestFileExists();
        if (!exists) {
            return null;
        }

        try {
            const raw = await this.getAdapter().read(this.manifestPath);
            const parsed = JSON.parse(raw) as Partial<SyncManifestData>;
            return {
                manifest: Array.isArray(parsed.manifest)
                    ? parsed.manifest.filter(
                          (value) => typeof value === "string"
                      )
                    : [],
                sample: Array.isArray(parsed.sample)
                    ? parsed.sample.filter((value) => typeof value === "string")
                    : [],
            };
        } catch {
            return null;
        }
    }

    private async writeManifestData(data: SyncManifestData): Promise<void> {
        const folder = this.manifestPath.slice(
            0,
            this.manifestPath.lastIndexOf("/")
        );
        await this.ensureFolderExists(folder);
        await this.getAdapter().write(this.manifestPath, JSON.stringify(data));
    }

    private getAdapter() {
        const adapter = this.app.vault.adapter;
        if (!adapter) {
            throw new Error("SyncManifestStore: vault adapter is unavailable");
        }
        return adapter;
    }

    private async ensureManifestFileExists(): Promise<boolean> {
        const adapter = this.getAdapter();
        return adapter.exists(this.manifestPath);
    }

    private async ensureFolderExists(folder: string): Promise<void> {
        const adapter = this.getAdapter();
        if (!(await adapter.exists(folder))) {
            try {
                await adapter.mkdir(folder);
            } catch (error) {
                if (await adapter.exists(folder)) {
                    return;
                }
                throw error;
            }
        }
    }
}
