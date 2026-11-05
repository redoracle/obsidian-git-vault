import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "js-sha256";

/**
 * The line-author cache relies on incremental and byte-array SHA-256 hashing.
 * Pin down its digest semantics while upgrading the js-sha256 type/API surface.
 */
describe("js-sha256 version 1 compatibility", () => {
    it("matches the standard SHA-256 known-answer vector", () => {
        expect(sha256("abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    });

    it("preserves incremental hashing used by the line-author cache", () => {
        expect(sha256.create().update("a").update("bc").hex()).toBe(
            sha256("abc")
        );
    });

    it("hashes byte arrays identically to the Node reference implementation", () => {
        const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
        const expected = createHash("sha256").update(bytes).digest("hex");
        expect(sha256.create().update(bytes).hex()).toBe(expected);
    });
});
