/**
 * Parse Link pagination without accepting an untrusted foreign origin.
 * The caller appends the returned relative path to the fixed GitHub API host.
 */
export function nextGitHubPagePath(header: string): string | null {
    for (const entry of header.split(",")) {
        const match = entry.match(/<([^>]+)>;\s*rel="next"/i);
        if (!match) continue;
        const url = new URL(match[1]);
        if (
            url.protocol !== "https:" ||
            url.host !== "api.github.com" ||
            url.username ||
            url.password
        ) {
            throw new Error("Untrusted GitHub pagination origin");
        }
        return url.pathname + url.search;
    }
    return null;
}
