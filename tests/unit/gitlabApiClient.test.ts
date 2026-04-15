import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { GitLabApiClient } from "../../src/setting/infra/gitlabApiClient";
import { GitLabForgeClient } from "../../src/syncProvider/apiClient";

function fakeResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
) {
    return { status, json: body, headers, text: JSON.stringify(body) };
}

function makeClient(
    baseUrl = "https://gitlab.com/api/v4",
    token = "glpat-test"
) {
    return new GitLabApiClient(
        () => baseUrl,
        () => token,
        vi.fn()
    );
}

describe("GitLabApiClient.fetchProjects", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("returns a placeholder when token is empty", async () => {
        const result = await makeClient(
            "https://gitlab.com/api/v4",
            ""
        ).fetchProjects();
        expect(result).toEqual({ "": "Enter token first" });
    });

    it("lists projects using the configured base URL and token", async () => {
        const spy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce(
            fakeResponse(200, [
                {
                    id: 42,
                    path_with_namespace: "redoracle/obsidian-git-vault",
                    name_with_namespace: "redoracle / obsidian-git-vault",
                },
            ]) as never
        );

        const result = await makeClient(
            "https://gitlab.com/api/v4",
            "glpat-abc"
        ).fetchProjects();

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://gitlab.com/api/v4/projects?simple=true&membership=true&per_page=100&order_by=last_activity_at&sort=desc",
                headers: { "PRIVATE-TOKEN": "glpat-abc" },
            })
        );
        expect(result).toEqual({
            "": "Select project",
            "redoracle/obsidian-git-vault": "redoracle/obsidian-git-vault",
        });
    });
});

describe("GitLabApiClient.fetchBranches", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("returns a placeholder when project id is missing", async () => {
        const result = await makeClient().fetchBranches("");
        expect(result).toEqual({ "": "Select a project first" });
    });

    it("maps branches into dropdown options", async () => {
        const spy = vi
            .spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(
                fakeResponse(200, [
                    { name: "main" },
                    { name: "develop" },
                ]) as never
            );

        const result = await makeClient().fetchBranches("group%2Fvault");

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://gitlab.com/api/v4/projects/group%2Fvault/repository/branches?per_page=100",
                method: "GET",
                headers: { "PRIVATE-TOKEN": "glpat-test" },
            })
        );

        expect(result).toEqual({
            "": "Select branch",
            main: "main",
            develop: "develop",
        });
    });
});

describe("GitLabForgeClient.listBranches", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("lists branches using the normalized project path", async () => {
        const spy = vi
            .spyOn(obsidian, "requestUrl")
            .mockResolvedValueOnce(
                fakeResponse(200, [
                    { name: "main" },
                    { name: "release" },
                ]) as never
            );
        const client = new GitLabForgeClient({
            token: "glpat-test",
            baseUrl: "https://gitlab.com/api/v4",
            projectId: "redoracle/test",
            branch: "main",
        });

        const forgeClient: { listBranches(): Promise<string[]> } = client;
        await expect(forgeClient.listBranches()).resolves.toEqual([
            "main",
            "release",
        ]);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://gitlab.com/api/v4/projects/redoracle%2Ftest/repository/branches?per_page=100&page=1",
            })
        );
    });
});

describe("GitLabForgeClient remote URLs", () => {
    it("builds file history URLs from namespace project paths", () => {
        const client = new GitLabForgeClient({
            token: "glpat-test",
            baseUrl: "https://gitlab.com/api/v4",
            projectId: "redoracle/test",
            branch: "main",
        });

        expect(client.getRemoteHistoryUrl("notes/My Note.md")).toBe(
            "https://gitlab.com/redoracle/test/-/commits/main/notes/My%20Note.md"
        );
    });

    it("does not build history URLs for numeric project IDs", () => {
        const client = new GitLabForgeClient({
            token: "glpat-test",
            baseUrl: "https://gitlab.com/api/v4",
            projectId: "123",
            branch: "main",
        });

        expect(client.getRemoteHistoryUrl("notes/example.md")).toBeUndefined();
    });
});
