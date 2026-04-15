import { describe, expect, it, vi } from "vitest";
import { ProviderSecrets } from "../../src/security/providerSecrets";

function createPlugin() {
    const secrets = new Map<string, string>();
    return {
        manifest: {
            id: "git-vault",
        },
        app: {
            secretStorage: {
                getSecret: vi.fn((id: string) => secrets.get(id) ?? null),
                setSecret: vi.fn((id: string, value: string) => {
                    secrets.set(id, value);
                }),
            },
            loadLocalStorage: vi.fn(() => ""),
            saveLocalStorage: vi.fn(),
        },
        __secrets: secrets,
    };
}

describe("ProviderSecrets", () => {
    it("reads the current encryption passphrase secret id", () => {
        const plugin = createPlugin();
        plugin.__secrets.set(
            "git-vault-api-encryption-passphrase",
            "correct horse battery staple"
        );

        const secrets = new ProviderSecrets(plugin as never);

        expect(secrets.getEncryptionPassphrase()).toBe(
            "correct horse battery staple"
        );
    });

    it("prefers the current encryption passphrase secret when both current and legacy values exist", () => {
        const plugin = createPlugin();
        plugin.__secrets.set(
            "git-vault-api-encryption-passphrase",
            "current passphrase"
        );
        plugin.__secrets.set(
            "obsidian-git-vault-api-encryption-passphrase",
            "legacy passphrase"
        );

        const secrets = new ProviderSecrets(plugin as never);

        expect(secrets.getEncryptionPassphrase()).toBe("current passphrase");
        expect(plugin.app.secretStorage.setSecret).not.toHaveBeenCalled();
        expect(plugin.__secrets.get("git-vault-api-encryption-passphrase")).toBe(
            "current passphrase"
        );
        expect(
            plugin.__secrets.get(
                "obsidian-git-vault-api-encryption-passphrase"
            )
        ).toBe("legacy passphrase");
    });

    it("migrates a legacy encryption passphrase secret id on read", () => {
        const plugin = createPlugin();
        plugin.__secrets.set(
            "obsidian-git-vault-api-encryption-passphrase",
            "legacy passphrase"
        );

        const secrets = new ProviderSecrets(plugin as never);

        expect(secrets.getEncryptionPassphrase()).toBe("legacy passphrase");
        expect(plugin.app.secretStorage.setSecret).toHaveBeenCalledWith(
            "git-vault-api-encryption-passphrase",
            "legacy passphrase"
        );
        expect(plugin.app.secretStorage.setSecret).toHaveBeenCalledWith(
            "obsidian-git-vault-api-encryption-passphrase",
            ""
        );
    });

    it("returns null when neither encryption passphrase secret exists", () => {
        const plugin = createPlugin();
        const secrets = new ProviderSecrets(plugin as never);

        expect(secrets.getEncryptionPassphrase()).toBeNull();
        expect(plugin.app.secretStorage.setSecret).not.toHaveBeenCalled();
        expect(plugin.__secrets.size).toBe(0);
    });
});
