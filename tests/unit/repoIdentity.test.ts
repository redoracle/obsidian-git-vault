import { describe, expect, it } from "vitest";
import {
    encryptionFingerprintsMatch,
    fingerprintsMatch,
    getApiRepoFingerprint,
    getGitRepoFingerprint,
    normalizeRepoFingerprint,
} from "../../src/syncProvider/repoIdentity";

describe("repoIdentity", () => {
    it("normalizes legacy GitHub fingerprints to canonical repo fingerprints", () => {
        expect(normalizeRepoFingerprint("github:alice/notes@main")).toBe(
            "repo:github.com/alice/notes@main"
        );
    });

    it("preserves @ characters in legacy GitHub branch names", () => {
        expect(
            normalizeRepoFingerprint("github:alice/notes@feature@123")
        ).toBe("repo:github.com/alice/notes@feature@123");
    });

    it("builds canonical GitHub API fingerprints", () => {
        expect(
            getApiRepoFingerprint(
                {
                    githubOwner: "alice",
                    githubRepo: "notes",
                    githubBranch: "main",
                    gitlabBaseUrl: "",
                    gitlabProjectId: "",
                    gitlabBranch: "",
                    giteaBaseUrl: "",
                    giteaOwner: "",
                    giteaRepo: "",
                    giteaBranch: "",
                },
                "github"
            )
        ).toBe("repo:github.com/alice/notes@main");
    });

    it("builds canonical GitLab API fingerprints", () => {
        expect(
            getApiRepoFingerprint(
                {
                    githubOwner: "",
                    githubRepo: "",
                    githubBranch: "",
                    gitlabBaseUrl: "https://gitlab.example.com/api/v4",
                    gitlabProjectId: "group%2Fnotes",
                    gitlabBranch: "develop",
                    giteaBaseUrl: "",
                    giteaOwner: "",
                    giteaRepo: "",
                    giteaBranch: "",
                },
                "gitlab"
            )
        ).toBe("repo:gitlab.example.com/group/notes@develop");
    });

    it("builds canonical Gitea API fingerprints", () => {
        expect(
            getApiRepoFingerprint(
                {
                    githubOwner: "",
                    githubRepo: "",
                    githubBranch: "",
                    gitlabBaseUrl: "",
                    gitlabProjectId: "",
                    gitlabBranch: "",
                    giteaBaseUrl: "https://gitea.example.com/api/v1",
                    giteaOwner: "alice",
                    giteaRepo: "notes",
                    giteaBranch: "main",
                },
                "gitea"
            )
        ).toBe("repo:gitea.example.com/alice/notes@main");
    });

    it("matches HTTPS and SSH remotes for the same repository", () => {
        const httpsFingerprint = getGitRepoFingerprint(
            "https://github.com/alice/notes.git",
            "main"
        );
        const sshFingerprint = getGitRepoFingerprint(
            "git@github.com:alice/notes.git",
            "main"
        );

        expect(httpsFingerprint).toBe("repo:github.com/alice/notes@main");
        expect(sshFingerprint).toBe("repo:github.com/alice/notes@main");
        expect(fingerprintsMatch(httpsFingerprint, sshFingerprint)).toBe(true);
    });

    it("matches legacy and canonical GitHub fingerprints", () => {
        expect(
            fingerprintsMatch(
                "github:alice/notes@main",
                "repo:github.com/alice/notes@main"
            )
        ).toBe(true);
    });

    it("does not match fingerprints for different repositories", () => {
        expect(
            fingerprintsMatch(
                "repo:github.com/alice/notes@main",
                "repo:github.com/alice/other-repo@main"
            )
        ).toBe(false);
    });

    it("does not match fingerprints for different branches", () => {
        expect(
            fingerprintsMatch(
                "repo:github.com/alice/notes@main",
                "repo:github.com/alice/notes@develop"
            )
        ).toBe(false);
    });

    it("matches encryption bindings across API providers for the same repo path and branch", () => {
        expect(
            encryptionFingerprintsMatch(
                "repo:github.com/alice/notes@main",
                "repo:gitlab.com/alice/notes@main"
            )
        ).toBe(true);
        expect(
            encryptionFingerprintsMatch(
                "repo:github.com/alice/notes@main",
                "repo:forge.example.com/alice/notes@main"
            )
        ).toBe(true);
    });

    it("does not match encryption bindings when the branch differs", () => {
        expect(
            encryptionFingerprintsMatch(
                "repo:github.com/alice/notes@main",
                "repo:gitlab.com/alice/notes@develop"
            )
        ).toBe(false);
    });
});
