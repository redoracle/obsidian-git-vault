import type ObsidianGit from "../main";
import { GiteaForgeClient } from "./apiClient";
import { ApiSyncProvider } from "./apiSyncProvider";

export class GiteaApiSyncProvider extends ApiSyncProvider {
    constructor(plugin: ObsidianGit) {
        super(
            plugin,
            new GiteaForgeClient({
                token: plugin.providerSecrets.getToken("gitea") ?? "",
                baseUrl: plugin.settings.giteaBaseUrl ?? "",
                owner: plugin.settings.giteaOwner ?? "",
                repo: plugin.settings.giteaRepo ?? "",
                branch: plugin.settings.giteaBranch || "main",
            })
        );
    }
}
