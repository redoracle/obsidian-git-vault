/**
 * Release-notes compatibility smoke test.
 *
 * Uses the same generator and Conventional Commits preset as semantic-release,
 * without pushing tags, creating releases, or requiring a GitHub token.
 */
import { createRequire } from "node:module";

const requireFromRoot = createRequire(import.meta.url);
const semanticReleaseEntry = requireFromRoot.resolve("semantic-release");
const requireFromSemanticRelease = createRequire(semanticReleaseEntry);
const generatorPath = requireFromSemanticRelease.resolve(
    "@semantic-release/release-notes-generator"
);
const { generateNotes } = await import(generatorPath);

const changes = [
    { hash: "a".repeat(40), message: "feat: demonstrate vault sync routing" },
    { hash: "b".repeat(40), message: "fix: protect forge API credentials" },
];

const notes = await generateNotes(
    { preset: "conventionalcommits" },
    {
        commits: changes,
        lastRelease: {
            version: "1.1.1",
            gitTag: "1.1.1",
            gitHead: "0".repeat(40),
        },
        nextRelease: {
            version: "1.1.2",
            gitTag: "1.1.2",
            gitHead: "1".repeat(40),
        },
        options: {
            repositoryUrl:
                "https://github.com/redoracle/obsidian-git-vault.git",
        },
        cwd: process.cwd(),
    }
);

for (const heading of ["### Features", "### Bug Fixes"]) {
    if (!notes.includes(heading)) {
        throw new Error(`Release notes omitted expected section: ${heading}`);
    }
}

if (
    !notes.includes("vault sync routing") ||
    !notes.includes("forge API credentials")
) {
    throw new Error("Release notes omitted expected commit messages");
}
console.log("Conventional Commits release notes rendered with both sections");
