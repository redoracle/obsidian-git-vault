import type ObsidianGit from "../main";
import { GitLabForgeClient } from "./apiClient";
import { ApiSyncProvider } from "./apiSyncProvider";

export class GitLabApiSyncProvider extends ApiSyncProvider {
    constructor(plugin: ObsidianGit) {
        super(
            plugin,
            new GitLabForgeClient({
                token: plugin.providerSecrets.getToken("gitlab") ?? "",
                baseUrl:
                    plugin.settings.gitlabBaseUrl ||
                    "https://gitlab.com/api/v4",
                projectId: plugin.settings.gitlabProjectId ?? "",
                branch: plugin.settings.gitlabBranch || "main",
            })
        );
    }
}
