import { describe, expect, it } from "vitest";
import { zeroCommit } from "src/gitManager/blameConstants";
import type { RenderableLineAuthoring } from "src/editor/lineAuthor/model";
import { chooseNewestCommit } from "src/editor/lineAuthor/view/gutter/commitChoice";

describe("chooseNewestCommit", () => {
    it("returns the newest available commit and skips missing hashes", () => {
        const lineAuthoring = {
            hashPerLine: [undefined, "missing", "older", "newer"],
            commits: new Map([
                ["older", { hash: "older", author: { epochSeconds: 10 } }],
                ["newer", { hash: "newer", author: { epochSeconds: 20 } }],
            ]),
        } as RenderableLineAuthoring;

        expect(chooseNewestCommit(lineAuthoring, 1, 3)).toEqual({
            hash: "newer",
            author: { epochSeconds: 20 },
        });
    });

    it("returns zeroCommit when all hashes in range are missing from commits", () => {
        const lineAuthoring = {
            hashPerLine: [undefined, "missing-a", "missing-b"],
            commits: new Map(),
        } as RenderableLineAuthoring;

        expect(chooseNewestCommit(lineAuthoring, 1, 2)).toBe(zeroCommit);
    });

    it("returns the expected commit for a single-line range", () => {
        const lineAuthoring = {
            hashPerLine: [undefined, "single"],
            commits: new Map([
                ["single", { hash: "single", author: { epochSeconds: 42 } }],
            ]),
        } as RenderableLineAuthoring;

        expect(chooseNewestCommit(lineAuthoring, 1, 1)).toEqual({
            hash: "single",
            author: { epochSeconds: 42 },
        });
    });

    it("returns zeroCommit for empty commits maps across multiple ranges", () => {
        const lineAuthoring = {
            hashPerLine: [undefined, "missing-a", "missing-b", "missing-c"],
            commits: new Map(),
        } as RenderableLineAuthoring;

        expect(chooseNewestCommit(lineAuthoring, 1, 1)).toBe(zeroCommit);
        expect(chooseNewestCommit(lineAuthoring, 1, 3)).toBe(zeroCommit);
        expect(chooseNewestCommit(lineAuthoring, 2, 3)).toBe(zeroCommit);
    });

    it("falls back to the shared zero commit for invalid ranges", () => {
        const lineAuthoring = {
            hashPerLine: [undefined, "older"],
            commits: new Map([
                ["older", { hash: "older", author: { epochSeconds: 10 } }],
            ]),
        } as RenderableLineAuthoring;

        expect(chooseNewestCommit(lineAuthoring, 2, 1)).toBe(zeroCommit);
    });
});
