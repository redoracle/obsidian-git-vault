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
