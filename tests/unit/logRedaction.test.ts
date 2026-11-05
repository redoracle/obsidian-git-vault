import { describe, expect, it } from "vitest";
import {
    isSensitiveAuditKey,
    redactSensitiveText,
    sanitizeUrl,
} from "../../src/security/logRedaction";

describe("logRedaction", () => {
    it("preserves URL hosts and paths while removing userinfo", () => {
        expect(sanitizeUrl("https://alice:password@example.com/repo")).toBe(
            "https://[REDACTED]@example.com/repo"
        );
    });

    it("redacts bearer credentials and token query values", () => {
        const text =
            "Authorization: Bearer ghp_secret https://api.example.com/?access_token=abc123";
        const safe = redactSensitiveText(text);
        expect(safe).not.toContain("ghp_secret");
        expect(safe).not.toContain("abc123");
        expect(safe).toContain("[REDACTED]");
    });

    it("identifies common secret key variants", () => {
        expect(isSensitiveAuditKey("githubToken")).toBe(true);
        expect(isSensitiveAuditKey("PRIVATE-TOKEN")).toBe(true);
        expect(isSensitiveAuditKey("encryptionPassphrase")).toBe(true);
        expect(isSensitiveAuditKey("branch")).toBe(false);
    });
});
