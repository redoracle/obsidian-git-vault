import { describe, it, expect } from "vitest";
import {
    normalizeTrackedDirectory,
    isPathInTrackedDirectory,
    toRemoteScopedPath,
    toVaultScopedPath,
} from "../../src/syncProvider/pathScope";

describe("normalizeTrackedDirectory", () => {
    it("returns empty string for vault root inputs", () => {
        expect(normalizeTrackedDirectory("")).toBe("");
        expect(normalizeTrackedDirectory("   ")).toBe("");
        expect(normalizeTrackedDirectory(".")).toBe("");
        expect(normalizeTrackedDirectory("/")).toBe("");
    });

    it("strips leading and trailing slashes", () => {
        expect(normalizeTrackedDirectory("/notes/")).toBe("notes");
    });

    it("normalizes a nested path", () => {
        expect(normalizeTrackedDirectory("docs/journal")).toBe("docs/journal");
    });
});

describe("isPathInTrackedDirectory", () => {
    it("vault root (empty) includes everything", () => {
        expect(isPathInTrackedDirectory("any/file.md", "")).toBe(true);
    });

    it("includes exact directory path", () => {
        expect(isPathInTrackedDirectory("notes", "notes")).toBe(true);
    });

    it("includes files under the tracked directory", () => {
        expect(isPathInTrackedDirectory("notes/daily.md", "notes")).toBe(true);
    });

    it("excludes files outside the tracked directory", () => {
        expect(isPathInTrackedDirectory("archive/old.md", "notes")).toBe(false);
    });

    it("does not match prefix-only paths", () => {
        expect(isPathInTrackedDirectory("notesExtra/file.md", "notes")).toBe(false);
    });
});

describe("toRemoteScopedPath", () => {
    it("vault root: returns the vault path unchanged", () => {
        expect(toRemoteScopedPath("notes/daily.md", "")).toBe("notes/daily.md");
    });

    it("strips the tracked directory prefix", () => {
        expect(toRemoteScopedPath("notes/daily.md", "notes")).toBe("daily.md");
    });

    it("returns empty string for the directory itself", () => {
        expect(toRemoteScopedPath("notes", "notes")).toBe("");
    });

    it("throws for paths outside the tracked directory", () => {
        expect(() => toRemoteScopedPath("archive/old.md", "notes")).toThrow(
            /outside the tracked directory/
        );
    });
});

describe("toVaultScopedPath", () => {
    it("vault root: returns remote path", () => {
        expect(toVaultScopedPath("notes/daily.md", "")).toBe("notes/daily.md");
    });

    it("prepends the tracked directory", () => {
        expect(toVaultScopedPath("daily.md", "notes")).toBe("notes/daily.md");
    });

    it("handles empty remote path as the tracked directory itself", () => {
        expect(toVaultScopedPath("", "notes")).toBe("notes");
    });
});

describe("path safety at the API sync boundary", () => {
    it("rejects traversal in configured tracked directories", () => {
        expect(() => normalizeTrackedDirectory("notes/../private")).toThrow(
            /parent traversal/
        );
        expect(() => normalizeTrackedDirectory("notes\\..\\private")).toThrow(
            /parent traversal/
        );
    });

    it("rejects traversal in locally supplied vault paths", () => {
        expect(() => toRemoteScopedPath("notes/../secret.md", "notes")).toThrow(
            /parent traversal/
        );
    });

    it("rejects parent traversal from remote names at any scope", () => {
        for (const remotePath of [
            "../secret.md",
            "notes/../../secret.md",
            "folder\\..\\secret.md",
        ]) {
            expect(() => toVaultScopedPath(remotePath, "notes")).toThrow(
                /Invalid remote path/
            );
            expect(() => toVaultScopedPath(remotePath, "")).toThrow(
                /Invalid remote path/
            );
        }
    });

    it("rejects rooted, Windows and NUL-containing remote paths", () => {
        for (const remotePath of [
            "/etc/passwd",
            "C:/Windows/file.md",
            "\\\\server\\share",
            "notes/unsafe\0.md",
        ]) {
            expect(() => toVaultScopedPath(remotePath, "notes")).toThrow(
                /Invalid remote path/
            );
        }
    });

    it("preserves valid relative paths and hidden files", () => {
        expect(toVaultScopedPath(".obsidian/config.json", "notes")).toBe(
            "notes/.obsidian/config.json"
        );
        expect(toVaultScopedPath("folder/note.md", "")).toBe("folder/note.md");
    });
});
