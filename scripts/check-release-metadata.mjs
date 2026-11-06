import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(tmpdir(), "git-vault-release-"));
const remote = path.join(temp, "origin.git");
const checkout = path.join(temp, "work");
const script = path.resolve("scripts/sync-release-metadata.sh");

function git(args, cwd = checkout) {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function runSync() {
    return execFileSync("bash", [script], {
        cwd: checkout,
        env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_REF: "refs/heads/main" },
        stdio: "pipe",
    });
}

try {
    git(["init", "--bare", "--initial-branch=main", remote], temp);
    git(["clone", remote, checkout], temp);
    git(["config", "user.name", "Release Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    for (const file of ["manifest.json", "versions.json", "package.json"]) {
        writeFileSync(path.join(checkout, file), '{"version":"1.0.0"}\n');
    }
    git(["add", "."]);
    git(["commit", "-m", "chore: initial metadata"]);
    git(["push", "-u", "origin", "main"]);

    writeFileSync(path.join(checkout, ".release-prepared"), "1.0.1\n");
    for (const file of ["manifest.json", "versions.json", "package.json"]) {
        writeFileSync(path.join(checkout, file), '{"version":"1.0.1"}\n');
    }

    runSync();
    const changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
        .split("\n").sort();
    assert.deepEqual(changed, ["manifest.json", "package.json", "versions.json"]);
    assert.equal(git(["rev-parse", "HEAD"]), git(["rev-parse", "origin/main"]));
    assert.equal(git(["rev-list", "--count", "HEAD"]), "2");

    // An already-synchronized metadata set must not create duplicate commits.
    runSync();
    assert.equal(git(["rev-list", "--count", "HEAD"]), "2");

    // A malformed version cannot mutate the repository.
    writeFileSync(path.join(checkout, ".release-prepared"), "../invalid\n");
    assert.throws(runSync);
    assert.equal(git(["rev-list", "--count", "HEAD"]), "2");
    console.log("Release metadata transaction and retry checks passed");
} finally {
    rmSync(temp, { recursive: true, force: true });
}
