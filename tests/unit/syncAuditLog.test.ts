import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAuditLog } from "../../src/syncProvider/syncAuditLog";

describe("syncAuditLog", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("preserves Error details when writing JSON audit logs", () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const error = new Error("pull exploded");

        syncAuditLog("provider.git", "pull:failure", { error });

        expect(logSpy).toHaveBeenCalledTimes(1);
        const entry = JSON.parse(logSpy.mock.calls[0][0] as string) as {
            payload: {
                error: {
                    name: string;
                    message: string;
                    stack?: string;
                };
            };
        };
        expect(entry.payload.error).toMatchObject({
            name: "Error",
            message: "pull exploded",
        });
        expect(entry.payload.error.stack).toEqual(expect.any(String));
    });
});

describe("syncAuditLog credential redaction", () => {
    it("redacts nested secrets, bearer tokens, and URLs", () => {
        const logger = { log: vi.fn() };
        syncAuditLog("provider.github", "sync:failure", {
            _type: "options",
            logger,
            payload: {
                githubToken: "ghp_topsecret",
                headers: { Authorization: "Bearer abc123" },
                details: ["https://example.com?access_token=abc123"],
                error: new Error(
                    "fetch failed: https://user:password@example.com/repo"
                ),
            },
        });
        const serialized = JSON.stringify(logger.log.mock.calls[0][0]);
        expect(serialized).not.toContain("ghp_topsecret");
        expect(serialized).not.toContain("abc123");
        expect(serialized).not.toContain("user:password");
        expect(serialized).toContain("[REDACTED]");
    });

    it("preserves safe audit values", () => {
        const logger = { log: vi.fn() };
        syncAuditLog("provider.git", "sync:success", {
            _type: "options",
            logger,
            payload: { count: 3, branch: "main", filePath: "docs/notes.md" },
        });
        expect(logger.log.mock.calls[0][0]).toMatchObject({
            payload: { count: 3, branch: "main", filePath: "docs/notes.md" },
        });
    });
});
