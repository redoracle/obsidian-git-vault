import { describe, expect, it } from "vitest";
import {
    buildHostedHttpsRemoteUrl,
    fileIsBinary,
    parseHostedHttpsRemoteUrl,
} from "../../src/utils";

describe("fileIsBinary", () => {
    it("treats Obsidian note-bearing file types as text", () => {
        expect(fileIsBinary("Notes/daily.md")).toBe(false);
        expect(fileIsBinary("Boards/roadmap.canvas")).toBe(false);
        expect(fileIsBinary("Bases/projects.base")).toBe(false);
    });

    it("normalizes extension casing before binary detection", () => {
        expect(fileIsBinary("Boards/roadmap.CANVAS")).toBe(false);
        expect(fileIsBinary("Assets/photo.PNG")).toBe(true);
    });

    it("treats extensionless and hidden paths as non-binary", () => {
        expect(fileIsBinary("README")).toBe(false);
        expect(fileIsBinary(".gitignore")).toBe(false);
        expect(fileIsBinary("")).toBe(false);
        expect(fileIsBinary("   ")).toBe(false);
    });

    it("treats unusual path shapes as non-binary when no binary extension is present", () => {
        expect(fileIsBinary("file.")).toBe(false);
        expect(fileIsBinary("/")).toBe(false);
        expect(fileIsBinary("folder/")).toBe(false);
    });
});

describe("hosted HTTPS remote helpers", () => {
    it("builds a hosted HTTPS remote URL and normalizes the repository suffix", () => {
        expect(
            buildHostedHttpsRemoteUrl({
                baseUrl: "https://github.com",
                namespacePath: "redoracle",
                repository: "obsidian-git-vault",
            })
        ).toBe("https://github.com/redoracle/obsidian-git-vault.git");
    });

    it("normalizes repository suffix when repository already ends with .git to avoid .git.git", () => {
        expect(
            buildHostedHttpsRemoteUrl({
                baseUrl: "https://github.com",
                namespacePath: "redoracle",
                repository: "obsidian-git-vault.git",
            })
        ).toBe("https://github.com/redoracle/obsidian-git-vault.git");
    });

    it("preserves nested namespace paths when parsing hosted HTTPS remotes", () => {
        expect(
            parseHostedHttpsRemoteUrl(
                "https://gitlab.example.com/group/subgroup/repo.git"
            )
        ).toEqual({
            baseUrl: "https://gitlab.example.com",
            namespacePath: "group/subgroup",
            repository: "repo",
        });
    });

    it("rejects non-HTTP remote URLs for hosted HTTPS helper parsing", () => {
        expect(
            parseHostedHttpsRemoteUrl("git@github.com:redoracle/obsidian-git-vault.git")
        ).toBeNull();
    });

    it("parses a simple non-nested hosted HTTPS remote with .git suffix", () => {
        expect(
            parseHostedHttpsRemoteUrl("https://github.com/owner/repo.git")
        ).toEqual({
            baseUrl: "https://github.com",
            namespacePath: "owner",
            repository: "repo",
        });
    });

    it("parses hosted HTTPS remote URLs without .git suffix", () => {
        expect(
            parseHostedHttpsRemoteUrl("https://github.com/owner/repo")
        ).toEqual({
            baseUrl: "https://github.com",
            namespacePath: "owner",
            repository: "repo",
        });
    });

    it("builds hosted HTTPS remote URLs with a trailing slash in baseUrl", () => {
        expect(
            buildHostedHttpsRemoteUrl({
                baseUrl: "https://github.com/",
                namespacePath: "owner",
                repository: "repo",
            })
        ).toBe("https://github.com/owner/repo.git");
    });
});
