import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ApiRemoteTargetWorkflow } from "../../src/setting/policy/apiRemoteTargetWorkflow";
import type { IPluginContext } from "../../src/pluginContext";
import type ObsidianGit from "../../src/main";
import type { RepoBindingService } from "../../src/setting/policy/repoBindingService";

function makeWorkflow({
    fingerprint = "github:redoracle/test@main",
    shouldBootstrap = true,
    matchingVaultPath,
}: {
    fingerprint?: string | null;
    shouldBootstrap?: boolean;
    matchingVaultPath?: string | null;
} = {}) {
    const previousConfigDir = process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR;
    const createdPaths: string[] = [];
    const configDirPathPromise = mkdtemp(
        path.join(os.tmpdir(), "git-vault-workflow-config-")
    ).then((dirPath) => {
        createdPaths.push(dirPath);
        return dirPath;
    });
    const currentVaultPathPromise = mkdtemp(
        path.join(os.tmpdir(), "git-vault-workflow-current-")
    ).then((dirPath) => {
        createdPaths.push(dirPath);
        return dirPath;
    });
    const plugin = {
        makeSyncNotice: vi.fn(),
    };
    const repoBinding = {
        computeActiveApiRepoFingerprint: vi.fn().mockReturnValue(fingerprint),
        shouldBootstrapApiProvider: vi.fn().mockResolvedValue(shouldBootstrap),
    };
    const concretePlugin = {
        app: {},
        manifest: { id: "git-vault" },
    };

    const cleanup = async (): Promise<void> => {
        if (previousConfigDir === undefined) {
            delete process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR;
        } else {
            process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR = previousConfigDir;
        }
        await Promise.all(
            createdPaths.map((dirPath) =>
                rm(dirPath, { recursive: true, force: true })
            )
        );
    };

    const workflowPromise = Promise.all([
        configDirPathPromise,
        currentVaultPathPromise,
    ]).then(async ([configDirPath, currentVaultPath]) => {
        process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR = configDirPath;

        await writeFile(
            path.join(configDirPath, "obsidian.json"),
            JSON.stringify(
                matchingVaultPath
                    ? {
                          vaults: {
                              matched: {
                                  path: matchingVaultPath,
                                  open: false,
                              },
                          },
                      }
                    : { vaults: {} },
                null,
                2
            ),
            "utf8"
        );

        if (matchingVaultPath) {
            const pluginDataPath = path.join(
                matchingVaultPath,
                ".obsidian",
                "plugins",
                concretePlugin.manifest.id,
                "data.json"
            );
            await mkdir(path.dirname(pluginDataPath), { recursive: true });
            await writeFile(
                pluginDataPath,
                JSON.stringify(
                    {
                        lastSyncedRepoFingerprint: fingerprint,
                    },
                    null,
                    2
                ),
                "utf8"
            );
        }

        const pluginWithVault = {
            ...plugin,
            app: {
                vault: {
                    adapter: {
                        basePath: currentVaultPath,
                        getBasePath: () => currentVaultPath,
                    },
                },
            },
        };

        // Use named mocks for constructor dependencies to improve readability and maintenance
        const mockFetchTarget = vi.fn().mockResolvedValue(undefined);
        const mockValidateAuth = vi.fn().mockResolvedValue(undefined);
        const mockNotifyResult = vi.fn().mockResolvedValue(undefined);

        const workflow = new ApiRemoteTargetWorkflow(
            pluginWithVault as unknown as IPluginContext,
            (() => concretePlugin) as unknown as () => ObsidianGit,
            repoBinding as unknown as RepoBindingService,
            mockFetchTarget as () => Promise<void>,
            mockValidateAuth as () => Promise<void>,
            mockNotifyResult as () => Promise<void>
        );

        return {
            workflow,
            plugin: pluginWithVault,
            repoBinding,
            cleanup,
        };
    });

    return workflowPromise;
}

describe("ApiRemoteTargetWorkflow.describeCurrentTarget", () => {
    it("returns null when the active API target is incomplete", async () => {
        const { workflow, cleanup } = await makeWorkflow({ fingerprint: null });
        try {
            await expect(workflow.describeCurrentTarget()).resolves.toBeNull();
        } finally {
            await cleanup();
        }
    });

    it("returns current-vault-linked when bootstrap is not required", async () => {
        const { workflow, cleanup } = await makeWorkflow({
            shouldBootstrap: false,
        });
        try {
            await expect(
                workflow.describeCurrentTarget()
            ).resolves.toMatchObject({
                kind: "current-vault-linked",
                fingerprint: "github:redoracle/test@main",
            });
        } finally {
            await cleanup();
        }
    });

    it("returns new-target when bootstrap is required and no existing vault matches", async () => {
        const { workflow, cleanup } = await makeWorkflow({
            shouldBootstrap: true,
        });
        try {
            await expect(
                workflow.describeCurrentTarget()
            ).resolves.toMatchObject({
                kind: "new-target",
                fingerprint: "github:redoracle/test@main",
            });
        } finally {
            await cleanup();
        }
    });

    it("returns external-vault-linked when another registered vault matches the target", async () => {
        const registeredVaultPath = await mkdtemp(
            path.join(os.tmpdir(), "git-vault-workflow-registered-")
        );
        const { workflow, cleanup } = await makeWorkflow({
            shouldBootstrap: true,
            matchingVaultPath: registeredVaultPath,
        });
        try {
            await expect(
                workflow.describeCurrentTarget()
            ).resolves.toMatchObject({
                kind: "external-vault-linked",
                fingerprint: "github:redoracle/test@main",
                vaultPath: registeredVaultPath,
            });
        } finally {
            await cleanup();
            await rm(registeredVaultPath, { recursive: true, force: true });
        }
    });
});
