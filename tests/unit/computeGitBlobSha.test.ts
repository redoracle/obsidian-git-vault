import { describe, it, expect } from "vitest";
import { computeGitBlobSha } from "../../src/syncProvider/apiClient";

// Expected values pre-computed with: git hash-object --stdin
describe("computeGitBlobSha", () => {
    it("matches the known SHA for an empty blob", async () => {
        // `echo -n "" | git hash-object --stdin` → e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
        const sha = await computeGitBlobSha("");
        expect(sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    });

    it("matches the known SHA for 'hello world\\n'", async () => {
        // `printf 'hello world\n' | git hash-object --stdin` → 3b18e512dba79e4c8300dd08aeb37f8e728b8dad
        const sha = await computeGitBlobSha("hello world\n");
        expect(sha).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
    });

    it("accepts Uint8Array input and produces the same SHA", async () => {
        const text = "hello world\n";
        const bytes = new TextEncoder().encode(text);
        const shaStr = await computeGitBlobSha(text);
        const shaBytes = await computeGitBlobSha(bytes);
        expect(shaStr).toBe(shaBytes);
    });

    it("produces different SHAs for different content", async () => {
        const a = await computeGitBlobSha("foo");
        const b = await computeGitBlobSha("bar");
        expect(a).not.toBe(b);
    });

    it("SHA is a 40-character lowercase hex string", async () => {
        const sha = await computeGitBlobSha("test content");
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });
});
