/**
 * VaultEncryptionService
 *
 * Responsible for: encrypting and decrypting individual vault files in-place
 * using the passphrase stored in ProviderSecrets.
 *
 * Extracted from: ObsidianGit.encryptSingleFile / decryptSingleFile /
 * readSingleFileContent / writeSingleFileContent (src/main.ts).
 *
 * Does NOT own: passphrase storage (ProviderSecrets), sync-level encryption
 * (apiEncryption.ts), or provider-level envelope handling (apiSyncProvider).
 */

import type { TFile, Vault } from "obsidian";
import type { ProviderSecrets } from "src/security/providerSecrets";
import {
    DECRYPTION_FAILED_ERROR_CODE,
    decryptContent,
    encryptContent,
    isEncryptedEnvelope,
} from "src/syncProvider/apiEncryption";
import { fileIsBinary } from "src/utils";

export class VaultEncryptionService {
    constructor(
        private readonly vault: Vault,
        private readonly secrets: ProviderSecrets,
        private readonly showNotice: (
            message: string,
            duration?: number
        ) => void
    ) {}

    /**
     * Encrypt a single vault file in-place using the stored passphrase.
     */
    async encryptFile(file: TFile): Promise<boolean> {
        try {
            const passphrase = this.secrets.getEncryptionPassphrase();
            if (!passphrase) {
                this.showNotice(
                    "Set an encryption passphrase in Git Vault settings first."
                );
                return false;
            }
            const raw = await this.readContent(file);
            if (isEncryptedEnvelope(raw)) {
                this.showNotice("File is already encrypted.");
                return false;
            }
            const encrypted = await encryptContent(raw, passphrase);
            await this.writeContent(file, encrypted, fileIsBinary(file.path));
            this.showNotice(`Encrypted "${file.path}"`);
            return true;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            // Use a safe format string to avoid unsafe-formatstring lint warnings
            console.error(
                "Encryption failed for file: %s: %s",
                file.path,
                message,
                error
            );
            this.showNotice(`Encryption failed for "${file.path}": ${message}`);
            return false;
        }
    }

    /**
     * Decrypt a single vault file in-place using the stored passphrase.
     */
    async decryptFile(file: TFile): Promise<boolean> {
        try {
            const passphrase = this.secrets.getEncryptionPassphrase();
            if (!passphrase) {
                this.showNotice(
                    "Set an encryption passphrase in Git Vault settings first."
                );
                return false;
            }
            const raw = await this.readContent(file);
            if (!isEncryptedEnvelope(raw)) {
                this.showNotice("File is not encrypted.");
                return false;
            }
            const result = await decryptContent(raw, passphrase);
            await this.writeContent(file, result.content, result.isBinary);
            this.showNotice(`Decrypted "${file.path}"`);
            return true;
        } catch (error) {
            if (this.isIncorrectPassphraseError(error)) {
                this.showNotice(
                    `Incorrect encryption passphrase for "${file.path}".`
                );
                return false;
            }
            console.error("Decryption failed for file:", file.path, error);
            const message =
                error instanceof Error ? error.message : String(error);
            this.showNotice(`Decryption failed for "${file.path}": ${message}`);
            return false;
        }
    }

    private isIncorrectPassphraseError(error: unknown): boolean {
        return (
            error instanceof Error &&
            (error as { code?: unknown }).code === DECRYPTION_FAILED_ERROR_CODE
        );
    }

    private async readContent(file: TFile): Promise<string | Uint8Array> {
        if (fileIsBinary(file.path)) {
            return new Uint8Array(await this.vault.readBinary(file));
        }
        return this.vault.read(file);
    }

    private async writeContent(
        file: TFile,
        content: string | Uint8Array,
        binary: boolean
    ): Promise<void> {
        if (!binary && typeof content === "string") {
            await this.vault.modify(file, content);
            return;
        }
        const bytes =
            typeof content === "string"
                ? Buffer.from(content, "utf8")
                : Buffer.from(content);
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        await this.vault.modifyBinary(file, buffer);
    }
}
