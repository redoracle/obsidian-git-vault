import { mkdtemp, readFile, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultBootstrapService } from "../../src/runtime/vaultBootstrapService";

const previousConfigDir = process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR;

type RegisterVaultMethod = (vaultPath: string) => Promise<boolean>;

function makeService(): VaultBootstrapService {
    return new VaultBootstrapService({
        app: {},
        manifest: { id: "git-vault" },
    } as never);
}

function getRegisterVault(
    service: VaultBootstrapService
): RegisterVaultMethod {
    const serviceWithRegisterVault = service as unknown as {
        registerVault: RegisterVaultMethod;
    };

    return (vaultPath: string) =>
        serviceWithRegisterVault.registerVault(vaultPath);
}

afterEach(() => {
    if (previousConfigDir == null) {
        delete process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR;
        return;
    }

    process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR = previousConfigDir;
});

describe("VaultBootstrapService registerVault", () => {
    it("preserves unrelated obsidian.json keys while adding a vault", async () => {
        const configDir = await mkdtemp(
            path.join(os.tmpdir(), "git-vault-bootstrap-registry-")
        );
        process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR = configDir;

        const registryPath = path.join(configDir, "obsidian.json");
        await writeFile(
            registryPath,
            JSON.stringify(
                {
                    appTheme: "moonstone",
                    recentFiles: ["Daily.md"],
                    vaults: {
                        existing: {
                            path: "/tmp/existing-vault",
                            ts: 1,
                            open: true,
                        },
                    },
                },
                null,
                2
            ),
            "utf8"
        );

        const service = makeService();
        const registerVault = getRegisterVault(service);

        await expect(registerVault("/tmp/new-vault")).resolves.toBe(true);

        const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
            appTheme?: string;
            recentFiles?: string[];
            vaults?: Record<string, { path: string }>;
        };
        expect(registry.appTheme).toBe("moonstone");
        expect(registry.recentFiles).toEqual(["Daily.md"]);
        expect(Object.values(registry.vaults ?? {})).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: "/tmp/existing-vault" }),
                expect.objectContaining({ path: path.resolve("/tmp/new-vault") }),
            ])
        );
    });

    it("refuses to overwrite a malformed obsidian.json registry", async () => {
        const configDir = await mkdtemp(
            path.join(os.tmpdir(), "git-vault-bootstrap-registry-bad-")
        );
        process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR = configDir;

        const registryPath = path.join(configDir, "obsidian.json");
        const malformedRegistry = "{ this is not valid json";
        await writeFile(registryPath, malformedRegistry, "utf8");

        const service = makeService();
        const registerVault = getRegisterVault(service);

        await expect(registerVault("/tmp/new-vault")).resolves.toBe(false);
        await expect(readFile(registryPath, "utf8")).resolves.toBe(
            malformedRegistry
        );
    });

    it("refuses to overwrite a registry with malformed vault entries", async () => {
        const configDir = await mkdtemp(
            path.join(os.tmpdir(), "git-vault-bootstrap-registry-bad-vaults-")
        );
        process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR = configDir;

        const registryPath = path.join(configDir, "obsidian.json");
        const malformedRegistry = JSON.stringify({
            appTheme: "moonstone",
            vaults: [],
        });
        await writeFile(registryPath, malformedRegistry, "utf8");

        const service = makeService();
        const registerVault = getRegisterVault(service);

        await expect(registerVault("/tmp/new-vault")).resolves.toBe(false);
        await expect(readFile(registryPath, "utf8")).resolves.toBe(
            malformedRegistry
        );
    });

    it("returns false when registry key generation exhausts retries", async () => {
        const configDir = await mkdtemp(
            path.join(os.tmpdir(), "git-vault-bootstrap-registry-collisions-")
        );
        process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR = configDir;

        const registryPath = path.join(configDir, "obsidian.json");
        await writeFile(
            registryPath,
            JSON.stringify(
                {
                    vaults: {
                        collision: {
                            path: "/tmp/existing-vault",
                            ts: 1,
                            open: true,
                        },
                    },
                },
                null,
                2
            ),
            "utf8"
        );

        const service = makeService();
        const registerVault = getRegisterVault(service);
        const serviceWithKeyGenerator = service as unknown as {
            generateVaultKey: () => string;
        };
        serviceWithKeyGenerator.generateVaultKey = () => "collision";

        await expect(registerVault("/tmp/new-vault")).resolves.toBe(false);
        await expect(readFile(registryPath, "utf8")).resolves.toContain(
            "existing-vault"
        );
        await expect(readFile(registryPath, "utf8")).resolves.not.toContain(
            "/tmp/new-vault"
        );
    });
});
