import { describe, it, expect, vi, beforeEach } from "vitest";
import * as obsidian from "obsidian";
import { GitHubApiClient } from "../../src/setting/infra/githubApiClient";
import { GitHubForgeClient } from "../../src/syncProvider/apiClient";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeClient(token = "test-token"): GitHubApiClient {
    return new GitHubApiClient(() => token, vi.fn());
}

function makeForgeClient(): GitHubForgeClient {
    return new GitHubForgeClient({
        token: "test-token",
        owner: "redoracle",
        repo: "obsidian-git-vault",
        branch: "main",
    });
}

/** Build a fake requestUrl response. */
function fakeResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
) {
    return { status, json: body, headers, text: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// request<T> — HTTP plumbing
// ---------------------------------------------------------------------------
describe("GitHubApiClient.request", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("sends Authorization header when token is provided", async () => {
        const spy = vi
            .spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(fakeResponse(200, { ok: true }) as never);
        const client = makeClient("thetok");
        await client.request("/some/path");
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://api.github.com/some/path",
                headers: { Authorization: "Bearer thetok" },
            })
        );
    });

    it("sends no Authorization header when token is empty", async () => {
        const spy = vi
            .spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(fakeResponse(200, {}) as never);
        const client = makeClient("");
        await client.request("/no-auth");
        const callHeaders = (
            spy.mock.calls[0][0] as { headers: Record<string, string> }
        ).headers;
        expect(callHeaders).not.toHaveProperty("Authorization");
    });

    it("returns parsed JSON on HTTP 200", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(200, [{ name: "repo1" }]) as never
        );
        const result = await makeClient().request<{ name: string }[]>("/x");
        expect(result).toEqual([{ name: "repo1" }]);
    });

    it("returns null and shows a notice on HTTP 401", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(401, {}) as never
        );
        const showNotice = vi.fn();
        const client = new GitHubApiClient(() => "test-token", showNotice);
        const result = await client.request("/x");
        expect(result).toBeNull();
        expect(showNotice).toHaveBeenCalled();
    });

    it("returns null and shows a notice on HTTP 403 (forbidden)", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(403, {}) as never
        );
        const showNotice = vi.fn();
        const result = await new GitHubApiClient(
            () => "test-token",
            showNotice
        ).request("/x");
        expect(result).toBeNull();
        expect(showNotice).toHaveBeenCalled();
    });

    it("returns null and shows a rate-limit notice on HTTP 403 with x-ratelimit-remaining=0", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(403, {}, { "x-ratelimit-remaining": "0" }) as never
        );
        const showNotice = vi.fn();
        const result = await new GitHubApiClient(
            () => "test-token",
            showNotice
        ).request("/y");
        expect(result).toBeNull();
        expect(showNotice).toHaveBeenCalled();
    });

    it("returns null and shows a notice on HTTP 404", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(404, {}) as never
        );
        const showNotice = vi.fn();
        const result = await new GitHubApiClient(
            () => "test-token",
            showNotice
        ).request("/missing");
        expect(result).toBeNull();
        expect(showNotice).toHaveBeenCalled();
    });

    it("returns null on generic >= 400 status", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(422, {}) as never
        );
        const showNotice = vi.fn();
        const result = await new GitHubApiClient(
            () => "test-token",
            showNotice
        ).request("/x");
        expect(result).toBeNull();
        expect(showNotice).toHaveBeenCalled();
    });

    it("returns null and shows a notice when requestUrl throws", async () => {
        vi.spyOn(obsidian, "requestUrl").mockRejectedValueOnce(
            new Error("network error")
        );
        const showNotice = vi.fn();
        const result = await new GitHubApiClient(
            () => "test-token",
            showNotice
        ).request("/x");
        expect(result).toBeNull();
        expect(showNotice).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// fetchRepos — repository listing logic
// ---------------------------------------------------------------------------
describe("GitHubApiClient.fetchRepos", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("returns placeholder when owner is empty", async () => {
        const result = await makeClient().fetchRepos("");
        expect(result).toEqual({ "": "Enter owner first" });
    });

    it("filters /user/repos by owner when token is present", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(200, [
                { name: "my-repo", owner: { login: "alice" } },
                { name: "other-repo", owner: { login: "bob" } },
            ]) as never
        );
        const result = await makeClient("tok").fetchRepos("alice");
        expect(Object.keys(result)).toContain("my-repo");
        expect(Object.keys(result)).not.toContain("other-repo");
    });

    it("falls back to /users/:owner/repos when token returns empty", async () => {
        // First call (authenticated) returns empty array
        vi.spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(fakeResponse(200, []) as never) // /user/repos empty
            .mockResolvedValueOnce(
                fakeResponse(200, [
                    { name: "public-repo", owner: { login: "bob" } },
                ]) as never
            );
        const result = await makeClient("tok").fetchRepos("bob");
        expect(Object.keys(result)).toContain("public-repo");
    });

    it("returns 'No repositories found' placeholder on all-empty results", async () => {
        vi.spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(fakeResponse(200, []) as never)
            .mockResolvedValueOnce(fakeResponse(200, []) as never)
            .mockResolvedValueOnce(fakeResponse(200, []) as never);
        const result = await makeClient("tok").fetchRepos("nobody");
        expect(result).toHaveProperty(
            "",
            "No repositories found (check owner/org name and token)"
        );
    });
});

// ---------------------------------------------------------------------------
// fetchBranches — branch listing logic
// ---------------------------------------------------------------------------
describe("GitHubApiClient.fetchBranches", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("returns placeholder when owner is missing", async () => {
        const result = await makeClient().fetchBranches("", "repo");
        expect(result).toEqual({ "": "Select a repository first" });
    });

    it("returns placeholder when repo is missing", async () => {
        const result = await makeClient().fetchBranches("owner", "");
        expect(result).toEqual({ "": "Select a repository first" });
    });

    it("maps API branch names into options record", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(200, [{ name: "main" }, { name: "dev" }]) as never
        );
        const result = await makeClient().fetchBranches("owner", "repo");
        expect(Object.keys(result)).toContain("main");
        expect(Object.keys(result)).toContain("dev");
    });

    it("returns placeholder on HTTP 404", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(404, {}) as never
        );
        const result = await makeClient().fetchBranches("owner", "repo");
        expect(result).toEqual({ "": "No branches found" });
    });

    it("returns placeholder on empty 200 response", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(200, []) as never
        );
        const result = await makeClient().fetchBranches("owner", "repo");
        expect(result).toEqual({ "": "No branches found" });
    });
});

describe("GitHubForgeClient.listBranches", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("paginates branch names from the sync client API", async () => {
        const spy = vi
            .spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(
                fakeResponse(
                    200,
                    Array.from({ length: 100 }, (_, i) => ({
                        name: `branch-${i + 1}`,
                    }))
                ) as never
            )
            .mockResolvedValueOnce(
                fakeResponse(200, [{ name: "release" }]) as never
            );
        const client: { listBranches(): Promise<string[]> } = makeForgeClient();
        const branches = await client.listBranches();

        expect(branches).toEqual([
            ...Array.from({ length: 100 }, (_, i) => `branch-${i + 1}`),
            "release",
        ]);
        expect(spy).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                url: "https://api.github.com/repos/redoracle/obsidian-git-vault/branches?per_page=100&page=1",
            })
        );
        expect(spy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                url: "https://api.github.com/repos/redoracle/obsidian-git-vault/branches?per_page=100&page=2",
            })
        );
    });
});

describe("GitHubForgeClient remote URLs", () => {
    it("builds file history URLs", () => {
        const client = makeForgeClient();

        expect(client.getRemoteHistoryUrl("notes/My Note.md")).toBe(
            "https://github.com/redoracle/obsidian-git-vault/commits/main/notes/My%20Note.md"
        );
    });
});
