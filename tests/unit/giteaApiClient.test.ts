import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { GiteaApiClient } from "../../src/setting/infra/giteaApiClient";
import { GiteaForgeClient } from "../../src/syncProvider/apiClient";

function fakeResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
) {
    return { status, json: body, headers, text: JSON.stringify(body) };
}

function makeClient(baseUrl = "https://gitea.com", token = "gitea-token") {
    return new GiteaApiClient(
        () => baseUrl,
        () => token,
        vi.fn()
    );
}

describe("GiteaApiClient.fetchRepos", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("returns a placeholder when owner is empty", async () => {
        const result = await makeClient().fetchRepos("");
        expect(result).toEqual({ "": "Enter owner first" });
    });

    it("filters authenticated repositories by owner", async () => {
        vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(200, [
                { name: "vault-a", owner: { username: "redoracle" } },
                { name: "vault-b", owner: { username: "someone-else" } },
            ]) as never
        );

        const result = await makeClient(
            "https://gitea.com",
            "token-1"
        ).fetchRepos("redoracle");

        expect(result).toEqual({
            "": "Select repository",
            "vault-a": "vault-a",
        });
    });

    it("falls back to public owner repositories when token results are empty", async () => {
        vi.spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(fakeResponse(200, []) as never)
            .mockResolvedValueOnce(
                fakeResponse(200, [{ name: "public-vault" }]) as never
            );

        const result = await makeClient(
            "https://gitea.com",
            "token-1"
        ).fetchRepos("redoracle");

        expect(result).toEqual({
            "": "Select repository",
            "public-vault": "public-vault",
        });
    });
});

describe("GiteaApiClient.fetchBranches", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("returns a placeholder when owner or repo is missing", async () => {
        expect(await makeClient().fetchBranches("", "repo")).toEqual({
            "": "Select a repository first",
        });
        expect(await makeClient().fetchBranches("owner", "")).toEqual({
            "": "Select a repository first",
        });
    });

    it("maps API branch names into options", async () => {
        const spy = vi
            .spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(
                fakeResponse(200, [
                    { name: "main" },
                    { name: "feature/x" },
                ]) as never
            );

        const result = await makeClient(
            "https://gitea.com",
            "token-1"
        ).fetchBranches("redoracle", "vault");

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://gitea.com/api/v1/repos/redoracle/vault/branches?limit=100",
                headers: {
                    Authorization: "token token-1",
                    Accept: "application/json",
                },
            })
        );
        expect(result).toEqual({
            "": "Select branch",
            main: "main",
            "feature/x": "feature/x",
        });
    });
});

describe("GiteaForgeClient.listBranches", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("lists branches for the configured repository", async () => {
        const spy = vi
            .spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(
                fakeResponse(200, [
                    { name: "main" },
                    { name: "release" },
                ]) as never
            );
        const client = new GiteaForgeClient({
            token: "gitea-token",
            baseUrl: "https://gitea.com",
            owner: "redoracle",
            repo: "vault",
            branch: "main",
        });

        await expect(client.listBranches()).resolves.toEqual([
            "main",
            "release",
        ]);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://gitea.com/api/v1/repos/redoracle/vault/branches?limit=100&page=1",
            })
        );
    });
});

describe("GiteaForgeClient remote URLs", () => {
    it("builds file history URLs", () => {
        const client = new GiteaForgeClient({
            token: "gitea-token",
            baseUrl: "https://gitea.com",
            owner: "redoracle",
            repo: "vault",
            branch: "main",
        });

        expect(client.getRemoteHistoryUrl("notes/My Note.md")).toBe(
            "https://gitea.com/redoracle/vault/commits/branch/main/notes/My%20Note.md"
        );
    });
});
