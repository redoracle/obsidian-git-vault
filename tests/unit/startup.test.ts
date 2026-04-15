import { describe, expect, it } from "vitest";
import {
    getPausedAutomaticsResumeDelay,
    requiresLocalGitRepo,
    shouldUseNativeGit,
} from "../../src/startup";

describe("requiresLocalGitRepo", () => {
    it("requires a local git repo only for the native git backend", () => {
        expect(requiresLocalGitRepo("git")).toBe(true);
        expect(requiresLocalGitRepo("github")).toBe(false);
        expect(requiresLocalGitRepo("gitlab")).toBe(false);
        expect(requiresLocalGitRepo("gitea")).toBe(false);
    });
});

describe("shouldUseNativeGit", () => {
    it("uses native git only on desktop git mode", () => {
        expect(shouldUseNativeGit("git", true)).toBe(true);
        expect(shouldUseNativeGit("github", true)).toBe(false);
        expect(shouldUseNativeGit("gitlab", true)).toBe(false);
        expect(shouldUseNativeGit("gitea", true)).toBe(false);
        expect(shouldUseNativeGit("git", false)).toBe(false);
    });
});

describe("getPausedAutomaticsResumeDelay", () => {
    it("returns null when there is no timed pause", () => {
        expect(getPausedAutomaticsResumeDelay(null, 1_000)).toBeNull();
    });

    it("returns the remaining delay for a future pause deadline", () => {
        expect(getPausedAutomaticsResumeDelay(5_000, 1_000)).toBe(4_000);
    });

    it("returns null for expired pause deadlines", () => {
        expect(getPausedAutomaticsResumeDelay(1_000, 5_000)).toBeNull();
    });
});
