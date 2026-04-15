import { describe, expect, it } from "vitest";
import {
    computePassphraseFingerprint,
    decryptContent,
    encryptContent,
    isEncryptedEnvelope,
} from "../../src/syncProvider/apiEncryption";

describe("apiEncryption", () => {
    it("round-trips text content", async () => {
        const encrypted = await encryptContent("hello world", "passphrase");

        expect(isEncryptedEnvelope(encrypted)).toBe(true);

        const decrypted = await decryptContent(encrypted, "passphrase");
        expect(decrypted).toEqual({
            content: "hello world",
            isBinary: false,
        });
    });

    it("round-trips empty text content", async () => {
        const encrypted = await encryptContent("", "passphrase");

        expect(isEncryptedEnvelope(encrypted)).toBe(true);

        const decrypted = await decryptContent(encrypted, "passphrase");
        expect(decrypted).toEqual({
            content: "",
            isBinary: false,
        });
    });

    it("round-trips binary content", async () => {
        const binary = new Uint8Array([0, 255, 1, 2, 3, 254]);
        const encrypted = await encryptContent(binary, "passphrase");
        expect(isEncryptedEnvelope(encrypted)).toBe(true);
        const decrypted = await decryptContent(encrypted, "passphrase");

        expect(decrypted.isBinary).toBe(true);
        expect(Array.from(decrypted.content as Uint8Array)).toEqual(
            Array.from(binary)
        );
    });

    it("round-trips empty binary content", async () => {
        const encrypted = await encryptContent(
            new Uint8Array([]),
            "passphrase"
        );

        expect(isEncryptedEnvelope(encrypted)).toBe(true);

        const decrypted = await decryptContent(encrypted, "passphrase");
        expect(decrypted.isBinary).toBe(true);
        expect(decrypted.content).toBeInstanceOf(Uint8Array);
        expect(Array.from(decrypted.content as Uint8Array)).toHaveLength(0);
    });

    it("round-trips unicode text content", async () => {
        const text = "emoji 😀 multibyte é 漢字";
        const encrypted = await encryptContent(text, "passphrase");

        expect(isEncryptedEnvelope(encrypted)).toBe(true);

        const decrypted = await decryptContent(encrypted, "passphrase");
        expect(decrypted).toEqual({
            content: text,
            isBinary: false,
        });
    });

    it("passes through plaintext content unchanged", async () => {
        const decrypted = await decryptContent("plain text", "passphrase");
        expect(decrypted).toEqual({
            content: "plain text",
            isBinary: false,
        });
        expect(isEncryptedEnvelope("plain text")).toBe(false);
    });

    it("does not classify plaintext with the encryption prefix as a valid envelope", async () => {
        const malformed = "obsidian-git-vault:encrypted:v1\nnot json";

        expect(isEncryptedEnvelope(malformed)).toBe(false);

        await expect(decryptContent(malformed, "passphrase")).rejects.toThrow(
            /Invalid encrypted sync envelope/
        );
    });

    it("rejects envelopes missing required crypto metadata", async () => {
        const prefix = "obsidian-git-vault:encrypted:v1\n";
        const malformed = `${prefix}${JSON.stringify({
            version: 1,
            iterations: 10_000,
            salt: "",
            iv: "",
            ciphertext: "",
            isBinary: false,
        })}`;

        expect(isEncryptedEnvelope(malformed)).toBe(false);

        await expect(decryptContent(malformed, "passphrase")).rejects.toThrow(
            /Invalid encrypted sync envelope/
        );
    });

    it("rejects corrupted ciphertext envelopes", async () => {
        const encrypted = await encryptContent("hello world", "correct");
        const prefix = "obsidian-git-vault:encrypted:v1\n";
        const envelope = JSON.parse(encrypted.slice(prefix.length)) as {
            ciphertext: string;
        };
        const lastChar = envelope.ciphertext.slice(-1);
        const replacement = lastChar === "A" ? "B" : "A";
        envelope.ciphertext = envelope.ciphertext.slice(0, -1) + replacement;
        const corrupted = `${prefix}${JSON.stringify(envelope)}`;

        expect(isEncryptedEnvelope(corrupted)).toBe(true);

        await expect(decryptContent(corrupted, "correct")).rejects.toThrow(
            /Decryption failed/
        );
    });

    it("throws when decrypting with the wrong passphrase", async () => {
        const encrypted = await encryptContent("hello world", "correct");

        await expect(decryptContent(encrypted, "wrong")).rejects.toThrow(
            /Decryption failed/
        );
    });

    it("computes a stable passphrase fingerprint", async () => {
        const first = await computePassphraseFingerprint("same");
        const second = await computePassphraseFingerprint("same");
        const different = await computePassphraseFingerprint("different");

        expect(first).toBe(second);
        expect(first).not.toBe(different);
    });
});
