import { describe, it, expect } from "vitest";
import {
    compileExcludePatterns,
    isPathExcludedByCompiledPatterns,
    isPathExcluded,
    normalizeExcludePatterns,
} from "../../src/syncProvider/excludeMatcher";

describe("normalizeExcludePatterns", () => {
    it("trims whitespace", () => {
        expect(normalizeExcludePatterns(["  .obsidian/**  "])).toEqual([".obsidian/**"]);
    });

    it("drops blank lines", () => {
        expect(normalizeExcludePatterns(["", "  ", "foo"])).toEqual(["foo"]);
    });

    it("drops comment lines", () => {
        expect(normalizeExcludePatterns(["# comment", "foo"])).toEqual(["foo"]);
    });

    it("drops negation lines", () => {
        expect(normalizeExcludePatterns(["!keep", "foo"])).toEqual(["foo"]);
    });

    it("handles mixed inputs (comments, blanks, spaced patterns, negations)", () => {
        const input = ["# this is a comment", "", "  ", "  .obsidian/**  ", "!negated"];
        expect(normalizeExcludePatterns(input)).toEqual([".obsidian/**"]);
    });
});

describe("compileExcludePatterns + isPathExcludedByCompiledPatterns", () => {
    it("excludes .obsidian/ subtree", () => {
        const re = compileExcludePatterns([".obsidian/**"]);
        expect(isPathExcludedByCompiledPatterns(".obsidian/app.json", re)).toBe(true);
        expect(isPathExcludedByCompiledPatterns(".obsidian/plugins/git-vault/main.js", re)).toBe(true);
    });

    it("does not exclude unrelated paths", () => {
        const re = compileExcludePatterns([".obsidian/**"]);
        expect(isPathExcludedByCompiledPatterns("Notes/daily.md", re)).toBe(false);
        expect(isPathExcludedByCompiledPatterns("README.md", re)).toBe(false);
    });

    it("returns false for empty compiled patterns", () => {
        const re = compileExcludePatterns([]);
        expect(isPathExcludedByCompiledPatterns("README.md", re)).toBe(false);
        expect(isPathExcludedByCompiledPatterns("dir/file", re)).toBe(false);
    });

    it("matches exact directory name pattern and its contents", () => {
        const re = compileExcludePatterns([".obsidian"]);
        expect(isPathExcludedByCompiledPatterns(".obsidian", re)).toBe(true);
        expect(isPathExcludedByCompiledPatterns(".obsidian/app.json", re)).toBe(true);
    });

    it("matches a wildcard file pattern", () => {
        const re = compileExcludePatterns(["**/*.tmp"]);
        expect(isPathExcludedByCompiledPatterns("foo/bar/scratch.tmp", re)).toBe(true);
        expect(isPathExcludedByCompiledPatterns("scratch.tmp", re)).toBe(true);
        expect(isPathExcludedByCompiledPatterns("scratch.md", re)).toBe(false);
    });

    it("matches a directory-root pattern without globstar", () => {
        const re = compileExcludePatterns(["node_modules"]);
        expect(isPathExcludedByCompiledPatterns("node_modules", re)).toBe(true);
        expect(isPathExcludedByCompiledPatterns("src/node_modules", re)).toBe(true);
    });

    it("single * does not cross directory boundaries", () => {
        const re = compileExcludePatterns(["docs/*"]);
        expect(isPathExcludedByCompiledPatterns("docs/readme.md", re)).toBe(true);
        expect(isPathExcludedByCompiledPatterns("docs/sub/deep.md", re)).toBe(false);
    });

    it("handles trailing slash as directory glob", () => {
        const re = compileExcludePatterns(["build/"]);
        expect(isPathExcludedByCompiledPatterns("build/output.js", re)).toBe(true);
        expect(isPathExcludedByCompiledPatterns("notbuild/output.js", re)).toBe(false);
    });
});

describe("isPathExcluded (convenience wrapper)", () => {
    it("returns false for empty pattern list", () => {
        expect(isPathExcluded("anything.md", [])).toBe(false);
    });

    it("returns true when pattern matches", () => {
        expect(isPathExcluded(".trash/deleted.md", [".trash/**"])).toBe(true);
    });

    it("returns false when no patterns match", () => {
        const path = "content/post.md";
        const patterns = [".trash/**", "temp/**"];
        expect(isPathExcluded(path, patterns)).toBe(false);
    });
});
