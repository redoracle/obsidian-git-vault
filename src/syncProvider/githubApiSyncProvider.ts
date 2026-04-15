import type ObsidianGit from "../main";
import { GitHubForgeClient } from "./apiClient";
import { ApiSyncProvider } from "./apiSyncProvider";

export class GitHubApiSyncProvider extends ApiSyncProvider {
    constructor(plugin: ObsidianGit) {
        const token: string = plugin.providerSecrets.getToken("github") ?? "";
        super(
            plugin,
            new GitHubForgeClient({
                token,
                owner: plugin.settings.githubOwner ?? "",
                repo: plugin.settings.githubRepo ?? "",
                branch: plugin.settings.githubBranch || "main",
            })
        );
    }
}
