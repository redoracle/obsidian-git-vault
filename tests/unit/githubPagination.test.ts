import { describe, expect, it } from "vitest";
import { nextGitHubPagePath } from "../../src/setting/infra/githubPagination";

describe("GitHub Link pagination", () => {
    it("extracts a next page path and query", () => {
        expect(
            nextGitHubPagePath(
                '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"'
            )
        ).toBe("/user/repos?page=2");
    });

    it("returns null for absent next-page links", () => {
        expect(
            nextGitHubPagePath('<https://api.github.com/x>; rel="last"')
        ).toBeNull();
    });

    it("rejects foreign origins and URL credentials", () => {
        for (const link of [
            '<https://evil.example/repos>; rel="next"',
            '<https://user:pass@api.github.com/repos>; rel="next"',
            '<http://api.github.com/repos>; rel="next"',
        ]) {
            expect(() => nextGitHubPagePath(link)).toThrow(/Untrusted/);
        }
    });
});
