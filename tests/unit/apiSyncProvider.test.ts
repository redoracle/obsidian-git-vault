import { describe, it, expect, vi } from "vitest";
import type ObsidianGit from "../../src/main";
import { ApiSyncProvider } from "../../src/syncProvider/apiSyncProvider";
import type {
    ApiForgeClient,
    ApiRemoteItem,
} from "../../src/syncProvider/apiClient";
import {
    computePassphraseFingerprint,
    decryptContent,
    encryptContent,
    isEncryptedEnvelope,
} from "../../src/syncProvider/apiEncryption";

function createEncryptionPassphraseGetter(passphrase: string | null = null) {
    return vi.fn((): string | null => passphrase);
}

function createPlugin(overrides: Record<string, unknown> = {}) {
    const manifestState = {
        manifest: [] as string[],
        sample: [] as string[],
    };
    const syncManifestStore = {
        data: manifestState,
        getSyncManifest: vi.fn(() =>
            Promise.resolve([...manifestState.manifest])
        ),
        loadSyncManifestSample: vi.fn(() =>
            Promise.resolve([...manifestState.sample])
        ),
        saveSyncManifest: vi.fn(
            (manifest: Iterable<string>, sample: Iterable<string> = []) => {
                manifestState.manifest = [...manifest];
                manifestState.sample = [...sample];
                return Promise.resolve();
            }
        ),
        clearSyncManifest: vi.fn(() => {
            manifestState.manifest = [];
            manifestState.sample = [];
            return Promise.resolve();
        }),
    };
    const settings = {
        githubOwner: "alice",
        githubRepo: "notes",
        githubBranch: "main",
        gitlabProjectId: "123",
        gitlabBranch: "main",
        giteaOwner: "o",
        giteaRepo: "r",
        giteaBranch: "main",
        trackedDirectory: "",
        syncExcludePaths: [],
        apiEncryptionEnabled: false,
        apiEncryptionPassphraseFingerprint: "",
        apiEncryptionPassphraseRepoFingerprint: "",
        lastSyncedRepoFingerprint: "",
        lastSyncManifestIsSummary: false,
        conflictResolutionStrategy: "manual",
        ...overrides,
    };

    return {
        settings,
        syncManifestStore,
        saveSettings: vi.fn(() => Promise.resolve()),
        makeSyncNotice: vi.fn(),
        showNotice: vi.fn(),
        providerSecrets: {
            getEncryptionPassphrase: createEncryptionPassphraseGetter(),
        },
        syncState: {
            getState: vi.fn(() => ({ lastSyncTime: null })),
        },
        app: {
            vault: {
                adapter: {
                    exists: vi.fn((_path?: string) => Promise.resolve(false)),
                    stat: vi.fn((_path?: string) =>
                        Promise.resolve(
                            null as null | { type: "file" | "folder" }
                        )
                    ),
                },
                getFiles: vi.fn(
                    () =>
                        [] as Array<{
                            path: string;
                            stat: { mtime: number };
                        }>
                ),
                getFileByPath: vi.fn(
                    (_path: string) =>
                        null as { path: string; stat: { mtime: number } } | null
                ),
                getFolderByPath: vi.fn(() => null),
                createFolder: vi.fn(() => Promise.resolve()),
                create: vi.fn(() => Promise.resolve()),
                createBinary: vi.fn(() => Promise.resolve()),
                delete: vi.fn(() => Promise.resolve()),
                modify: vi.fn(() => Promise.resolve()),
                modifyBinary: vi.fn(() => Promise.resolve()),
                read: vi.fn(() => Promise.resolve("")),
                readBinary: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
            },
        },
    };
}

function createClient(overrides: Record<string, unknown> = {}) {
    return {
        provider: "github",
        capabilities: {
            supportsAtomicBatchWrites: false,
            supportsRemoteCommitHistory: false,
            supportsPerFileMetadata: false,
            supportsEncryptedSync: false,
            supportsExcludePaths: false,
            supportsTrackedDirectoryScoping: false,
            supportsRemoteFileUrls: false,
            supportsDedicatedVaultImport: false,
            supportsDefaultBranchAutoDetection: false,
        },
        init: () => Promise.resolve(),
        getDefaultBranch: vi.fn(() => Promise.resolve("main")),
        listBranches: vi.fn(() => Promise.resolve(["main", "develop"])),
        listRemoteFiles: vi.fn(() =>
            Promise.resolve(new Map<string, ApiRemoteItem>())
        ),
        downloadFile: vi.fn((_path: string) => Promise.resolve("")),
        commitMutations: vi.fn((_mutations: unknown[], _message: string) =>
            Promise.resolve(0)
        ),
        getRemoteUrl: vi.fn((_path: string) => undefined),
        getRemoteHistoryUrl: vi.fn((_path: string) => undefined),
        ...overrides,
    };
}

type PluginDouble = ReturnType<typeof createPlugin>;
type ClientDouble = ReturnType<typeof createClient>;

function createProvider(
    fakePlugin: PluginDouble,
    fakeClient: ClientDouble
): ApiSyncProvider {
    return new ApiSyncProvider(
        fakePlugin as unknown as ObsidianGit,
        fakeClient as unknown as ApiForgeClient
    );
}

function computeRepoFingerprintForTest(provider: ApiSyncProvider): string {
    return (
        provider as unknown as { computeRepoFingerprint(): string }
    ).computeRepoFingerprint();
}

describe("ApiSyncProvider.computeRepoFingerprint", () => {
    it("throws for unknown/unsupported client.provider values", () => {
        const fakePlugin = createPlugin();
        const fakeClient = createClient({ provider: "unknown" });

        const provider = createProvider(fakePlugin, fakeClient);

        expect(() => computeRepoFingerprintForTest(provider)).toThrow(
            /unknown API provider/i
        );
    });
});

describe("ApiSyncProvider repo-state persistence", () => {
    it("pulls Obsidian note, canvas, and base files as text", async () => {
        const fakePlugin = createPlugin();
        const remoteFiles = new Map([
            ["daily.md", { path: "daily.md", revision: "r1" }],
            [
                "boards/roadmap.canvas",
                { path: "boards/roadmap.canvas", revision: "r2" },
            ],
            [
                "bases/projects.base",
                { path: "bases/projects.base", revision: "r3" },
            ],
        ]);
        const downloadFile = vi.fn((filePath: string) =>
            Promise.resolve(`text:${filePath}`)
        );
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() => Promise.resolve(remoteFiles)),
            downloadFile,
        });
        const provider = createProvider(fakePlugin, fakeClient);

        await provider.pull();

        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "daily.md",
            "text:daily.md"
        );
        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "boards/roadmap.canvas",
            "text:boards/roadmap.canvas"
        );
        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "bases/projects.base",
            "text:bases/projects.base"
        );
        expect(fakePlugin.app.vault.createBinary).not.toHaveBeenCalled();
    });

    it("syncs Obsidian note, canvas, and base files from local text reads", async () => {
        const fakePlugin = createPlugin({
            lastSyncedRepoFingerprint: "repo:github.com/alice/notes@main",
        });
        const localFiles = [
            { path: "daily.md", stat: { mtime: 1 } },
            { path: "boards/roadmap.canvas", stat: { mtime: 2 } },
            { path: "bases/projects.base", stat: { mtime: 3 } },
        ];
        fakePlugin.app.vault.getFiles = vi.fn(() => localFiles);
        fakePlugin.app.vault.getFileByPath = vi.fn(
            (filePath: string) =>
                localFiles.find((file) => file.path === filePath) ?? null
        );
        fakePlugin.app.vault.read = vi.fn((...args: unknown[]) => {
            const file = args[0] as { path: string };
            return Promise.resolve(`local:${file.path}`);
        });

        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() => Promise.resolve(new Map())),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        const result = await provider.sync();

        expect(result).toMatchObject({ success: true, filesChanged: 3 });
        expect(fakePlugin.app.vault.readBinary).not.toHaveBeenCalled();
        expect(fakeClient.commitMutations).toHaveBeenCalledWith(
            [
                {
                    kind: "create",
                    path: "daily.md",
                    content: "local:daily.md",
                },
                {
                    kind: "create",
                    path: "boards/roadmap.canvas",
                    content: "local:boards/roadmap.canvas",
                },
                {
                    kind: "create",
                    path: "bases/projects.base",
                    content: "local:bases/projects.base",
                },
            ],
            expect.stringContaining("vault sync:")
        );
    });

    it("persists manifest and repo fingerprint after pull", async () => {
        const fakePlugin = createPlugin();
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        [
                            "folder/note.md",
                            { path: "folder/note.md", revision: "r1" },
                        ],
                    ])
                )
            ),
            downloadFile: vi.fn(() => Promise.resolve("pulled content")),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        await provider.pull();

        expect(fakePlugin.settings.lastSyncedRepoFingerprint).toBe(
            "repo:github.com/alice/notes@main"
        );
        expect(fakePlugin.syncManifestStore.data.manifest).toEqual([
            "folder/note.md",
        ]);
        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "folder/note.md",
            "pulled content"
        );
    });

    it("propagates local deletions to remote using manifest-backed sync", async () => {
        const fakePlugin = createPlugin({
            lastSyncedRepoFingerprint: "github:alice/notes@main",
        });
        fakePlugin.syncManifestStore.data.manifest = ["folder/note.md"];
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        [
                            "folder/note.md",
                            { path: "folder/note.md", revision: "r1" },
                        ],
                    ])
                )
            ),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        const result = await provider.sync();

        expect(result).toMatchObject({ success: true, filesChanged: 1 });
        expect(fakeClient.commitMutations).toHaveBeenCalledWith(
            [
                {
                    kind: "delete",
                    path: "folder/note.md",
                    previousRevision: "r1",
                },
            ],
            expect.stringContaining("vault sync:")
        );
    });

    it("records the current repo fingerprint after a successful push", async () => {
        const fakePlugin = createPlugin();
        const fakeClient = createClient();
        const provider = createProvider(fakePlugin, fakeClient);

        await provider.push();

        expect(fakePlugin.settings.lastSyncedRepoFingerprint).toBe(
            "repo:github.com/alice/notes@main"
        );
        expect(fakePlugin.syncManifestStore.data.manifest).toEqual([]);
        expect(fakePlugin.saveSettings).toHaveBeenCalledTimes(1);
    });

    it("auto-detects the remote default branch for a fresh API repo", async () => {
        const fakePlugin = createPlugin({
            lastSyncedRepoFingerprint: "",
            githubBranch: "main",
        });
        const fakeClient = createClient({
            getDefaultBranch: vi.fn(() => Promise.resolve("master")),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        await provider.init();

        expect(fakePlugin.settings.githubBranch).toBe("master");
        expect(fakePlugin.saveSettings).toHaveBeenCalledTimes(1);
        expect(fakeClient.getDefaultBranch).toHaveBeenCalledTimes(1);
    });

    it("auto-detects the remote default branch after switching to a new API repo", async () => {
        const fakePlugin = createPlugin({
            githubRepo: "new-notes",
            githubBranch: "main",
            lastSyncedRepoFingerprint: "repo:github.com/alice/old-notes@main",
        });
        const fakeClient = createClient({
            getDefaultBranch: vi.fn(() => Promise.resolve("master")),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        await provider.init();

        expect(fakePlugin.settings.githubBranch).toBe("master");
        expect(fakePlugin.saveSettings).toHaveBeenCalledTimes(1);
        expect(fakeClient.getDefaultBranch).toHaveBeenCalledTimes(1);
    });

    it("returns the configured branch plus discovered branches", async () => {
        const fakePlugin = createPlugin({
            githubBranch: "feature/sync",
        });
        const fakeClient = createClient({
            listBranches: vi.fn(() =>
                Promise.resolve(["main", "feature/sync", "release"])
            ),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        await expect(provider.getBranchSelection()).resolves.toEqual({
            current: "feature/sync",
            branches: ["main", "feature/sync", "release"],
        });
    });

    it("switches API branches by saving settings and reloading the provider", async () => {
        const fakePlugin = createPlugin({
            githubBranch: "main",
        }) as ReturnType<typeof createPlugin> & {
            syncManager: { reload: ReturnType<typeof vi.fn> };
        };
        fakePlugin.syncManager = {
            reload: vi.fn(() => Promise.resolve()),
        };
        const fakeClient = createClient();
        const provider = createProvider(fakePlugin, fakeClient);

        await provider.switchBranch("release");

        expect(fakePlugin.settings.githubBranch).toBe("release");
        expect(fakePlugin.saveSettings).toHaveBeenCalledTimes(1);
        expect(fakePlugin.syncManager.reload).toHaveBeenCalledTimes(1);
    });

    it("rejects push when the repo target changed and baseline was not re-established", async () => {
        const fakePlugin = createPlugin({
            lastSyncedRepoFingerprint: "repo:github.com/alice/other-repo@main",
        });
        const fakeClient = createClient();
        const provider = createProvider(fakePlugin, fakeClient);

        await expect(provider.push()).rejects.toThrow(/repo has changed/i);
        expect(fakeClient.commitMutations).not.toHaveBeenCalled();
    });

    it("binds encrypted sync to the passphrase used for the current repo", async () => {
        const fakePlugin = createPlugin({
            apiEncryptionEnabled: true,
        });
        fakePlugin.providerSecrets.getEncryptionPassphrase =
            createEncryptionPassphraseGetter("correct horse battery staple");
        const fakeClient = createClient();
        const provider = createProvider(fakePlugin, fakeClient);
        const expectedFingerprint = await computePassphraseFingerprint(
            "correct horse battery staple"
        );

        await provider.push();

        expect(fakePlugin.settings.apiEncryptionPassphraseRepoFingerprint).toBe(
            "repo:github.com/alice/notes@main"
        );
        expect(fakePlugin.settings.apiEncryptionPassphraseFingerprint).toBe(
            expectedFingerprint
        );
    });

    it("encrypts outbound and decrypts inbound vault data during API sync", async () => {
        vi.stubEnv("PBKDF2_ITERATIONS", "10000");
        try {
            const passphrase = "correct horse battery staple";
            const localFile = {
                path: "secret.md",
                stat: { mtime: 1 },
            };
            const pushPlugin = createPlugin({
                apiEncryptionEnabled: true,
                lastSyncedRepoFingerprint: "repo:github.com/alice/notes@main",
            });
            pushPlugin.providerSecrets.getEncryptionPassphrase =
                createEncryptionPassphraseGetter(passphrase);
            pushPlugin.app.vault.getFiles = vi.fn(() => [localFile]);
            pushPlugin.app.vault.getFileByPath = vi.fn((path: string) =>
                path === "secret.md" ? localFile : null
            );
            pushPlugin.app.vault.read = vi.fn(() =>
                Promise.resolve("local secret\n")
            );
            const commitMutations = vi.fn(() => Promise.resolve(1));
            const pushClient = createClient({
                commitMutations,
                listRemoteFiles: vi.fn(() => Promise.resolve(new Map())),
            });
            const pushProvider = createProvider(pushPlugin, pushClient);

            const pushResult = await pushProvider.sync();

            expect(pushResult).toMatchObject({
                success: true,
                filesChanged: 1,
            });
            expect(commitMutations).toHaveBeenCalledTimes(1);
            const mutationCalls = commitMutations.mock.calls as unknown as [
                Array<{
                    kind: string;
                    path: string;
                    content: string | Uint8Array;
                }>,
                string,
            ][];
            const mutations = mutationCalls[0][0];
            expect(mutations).toHaveLength(1);
            expect(mutations[0]).toMatchObject({
                kind: "create",
                path: "secret.md",
            });
            const encryptedContent = mutations[0].content as string;
            expect(typeof encryptedContent).toBe("string"); // runtime check
            expect(encryptedContent).not.toContain("local secret");
            expect(isEncryptedEnvelope(encryptedContent)).toBe(true);
            await expect(
                decryptContent(encryptedContent, passphrase)
            ).resolves.toMatchObject({
                content: "local secret\n",
                isBinary: false,
            });

            const encryptedRemote = await encryptContent(
                "remote secret\n",
                passphrase
            );
            const pullPlugin = createPlugin({
                apiEncryptionEnabled: true,
                lastSyncedRepoFingerprint: "repo:github.com/alice/notes@main",
            });
            pullPlugin.providerSecrets.getEncryptionPassphrase =
                createEncryptionPassphraseGetter(passphrase);
            const pullClient = createClient({
                listRemoteFiles: vi.fn(() =>
                    Promise.resolve(
                        new Map([
                            [
                                "remote-secret.md",
                                {
                                    path: "remote-secret.md",
                                    revision: "r1",
                                },
                            ],
                        ])
                    )
                ),
                downloadFile: vi.fn(() => Promise.resolve(encryptedRemote)),
            });
            const pullProvider = createProvider(pullPlugin, pullClient);

            await pullProvider.pull();

            expect(pullPlugin.app.vault.create).toHaveBeenCalledWith(
                "remote-secret.md",
                "remote secret\n"
            );
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("keeps the pulled manifest when establishing a baseline for a new repo", async () => {
        const fakePlugin = createPlugin({
            githubRepo: "new-notes",
            lastSyncedRepoFingerprint: "repo:github.com/alice/old-notes@main",
        });
        fakePlugin.syncManifestStore.data.manifest = ["stale.md"];
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        ["remote.md", { path: "remote.md", revision: "r1" }],
                    ])
                )
            ),
            downloadFile: vi.fn(() => Promise.resolve("hello from remote")),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        const result = await provider.sync();

        expect(result).toMatchObject({
            success: true,
            filesChanged: 1,
        });
        expect(fakePlugin.settings.lastSyncedRepoFingerprint).toBe(
            "repo:github.com/alice/new-notes@main"
        );
        expect(fakePlugin.syncManifestStore.data.manifest).toEqual([
            "remote.md",
        ]);
        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "remote.md",
            "hello from remote"
        );
    });

    it("surfaces stale local files as manual conflicts during repo-change baseline", async () => {
        const staleFile = {
            path: "stale.md",
            stat: { mtime: 1 },
        };
        const fakePlugin = createPlugin({
            githubRepo: "new-notes",
            lastSyncedRepoFingerprint: "repo:github.com/alice/old-notes@main",
        });
        fakePlugin.app.vault.getFiles = vi.fn(() => [staleFile]);
        fakePlugin.app.vault.getFileByPath = vi.fn((path: string) =>
            path === "stale.md" ? staleFile : null
        );
        fakePlugin.app.vault.read = vi.fn(() => Promise.resolve("stale local"));
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        ["remote.md", { path: "remote.md", revision: "r1" }],
                    ])
                )
            ),
            downloadFile: vi.fn((path: string) =>
                Promise.resolve(path === "remote.md" ? "hello from remote" : "")
            ),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        const result = await provider.sync();

        expect(result).toMatchObject({
            success: false,
            filesChanged: 1,
        });
        expect(result.conflicts).toEqual([
            expect.objectContaining({
                path: "stale.md",
                localContent: "stale local",
                deletedRemote: true,
                requiresManualResolution: true,
            }),
        ]);
        expect(fakePlugin.settings.lastSyncedRepoFingerprint).toBe(
            "repo:github.com/alice/new-notes@main"
        );
        expect(fakePlugin.syncManifestStore.data.manifest).toEqual([
            "remote.md",
        ]);
        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "remote.md",
            "hello from remote"
        );
    });

    it("continues baseline pull when a parent folder already exists on disk", async () => {
        const fakePlugin = createPlugin({
            githubRepo: "new-notes",
            lastSyncedRepoFingerprint: "repo:github.com/alice/old-notes@main",
        });
        fakePlugin.app.vault.createFolder = vi.fn(() =>
            Promise.reject(new Error("Folder already exists."))
        );
        fakePlugin.app.vault.adapter.exists = vi.fn((_path?: string) =>
            Promise.resolve(true)
        );
        fakePlugin.app.vault.adapter.stat = vi.fn((path?: string) =>
            Promise.resolve(
                path === "folder" ? { type: "folder" } : { type: "file" }
            )
        );
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        [
                            "folder/remote.md",
                            { path: "folder/remote.md", revision: "r1" },
                        ],
                    ])
                )
            ),
            downloadFile: vi.fn(() => Promise.resolve("hello from remote")),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        const result = await provider.sync();

        expect(result).toMatchObject({
            success: true,
            filesChanged: 1,
        });
        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "folder/remote.md",
            "hello from remote"
        );
    });

    it("surfaces a stale ancestor file that blocks a remote folder during baseline", async () => {
        const blockingFile = {
            path: "folder",
            stat: { mtime: 1 },
        };
        const fakePlugin = createPlugin({
            githubRepo: "new-notes",
            lastSyncedRepoFingerprint: "repo:github.com/alice/old-notes@main",
        });
        fakePlugin.app.vault.getFiles = vi.fn(() => [blockingFile]);
        fakePlugin.app.vault.getFileByPath = vi.fn((path: string) =>
            path === "folder" ? blockingFile : null
        );
        fakePlugin.app.vault.read = vi.fn(() =>
            Promise.resolve("stale blocker")
        );
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        [
                            "folder/remote.md",
                            { path: "folder/remote.md", revision: "r1" },
                        ],
                    ])
                )
            ),
            downloadFile: vi.fn(() => Promise.resolve("hello from remote")),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        const result = await provider.sync();

        expect(result).toMatchObject({
            success: false,
            filesChanged: 0,
        });
        expect(result.conflicts).toEqual([
            expect.objectContaining({
                path: "folder",
                localContent: "stale blocker",
                deletedRemote: true,
                requiresManualResolution: true,
            }),
        ]);
        expect(fakePlugin.app.vault.create).not.toHaveBeenCalled();
    });

    it("deletes a stale local-only file when resolving it as keep remote", async () => {
        const staleFile = {
            path: "stale.md",
            stat: { mtime: 1 },
        };
        const fakePlugin = createPlugin();
        fakePlugin.app.vault.getFileByPath = vi.fn((path: string) =>
            path === "stale.md" ? staleFile : null
        );
        const fakeClient = createClient();
        const provider = createProvider(fakePlugin, fakeClient);

        await provider.resolveConflicts([
            {
                path: "stale.md",
                strategy: "always-remote",
            },
        ]);

        expect(fakePlugin.app.vault.delete).toHaveBeenCalledWith(staleFile);
        expect(fakeClient.commitMutations).not.toHaveBeenCalled();
    });

    it("downloads all remote files in summary mode when sample is empty", async () => {
        const fakePlugin = createPlugin({
            lastSyncedRepoFingerprint: "repo:github.com/alice/notes@main",
            lastSyncManifestIsSummary: true,
        });
        fakePlugin.syncManifestStore.data.sample = [];
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        ["remote.md", { path: "remote.md", revision: "r1" }],
                    ])
                )
            ),
            downloadFile: vi.fn(() => Promise.resolve("hello from remote")),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        const result = await provider.sync();

        expect(result).toMatchObject({
            success: true,
            filesChanged: 1,
        });
        expect(fakeClient.commitMutations).not.toHaveBeenCalled();
        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "remote.md",
            "hello from remote"
        );
    });

    it("propagates local deletions in summary mode using the stored manifest", async () => {
        const fakePlugin = createPlugin({
            lastSyncedRepoFingerprint: "repo:github.com/alice/notes@main",
            lastSyncManifestIsSummary: true,
        });
        fakePlugin.syncManifestStore.data.manifest = ["folder/deleted.md"];
        fakePlugin.syncManifestStore.data.sample = [];
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        [
                            "folder/deleted.md",
                            { path: "folder/deleted.md", revision: "r1" },
                        ],
                    ])
                )
            ),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        const result = await provider.sync();

        expect(result).toMatchObject({ success: true, filesChanged: 1 });
        expect(fakeClient.commitMutations).toHaveBeenCalledWith(
            [
                {
                    kind: "delete",
                    path: "folder/deleted.md",
                    previousRevision: "r1",
                },
            ],
            expect.stringContaining("vault sync:")
        );
        expect(fakePlugin.app.vault.create).not.toHaveBeenCalled();
    });

    it("rejects encrypted sync when the stored passphrase does not match the repo binding", async () => {
        const fakePlugin = createPlugin({
            apiEncryptionEnabled: true,
            apiEncryptionPassphraseRepoFingerprint:
                "repo:github.com/alice/notes@main",
            apiEncryptionPassphraseFingerprint:
                await computePassphraseFingerprint("original passphrase"),
        });
        fakePlugin.providerSecrets.getEncryptionPassphrase =
            createEncryptionPassphraseGetter("different passphrase");
        const fakeClient = createClient();
        const provider = createProvider(fakePlugin, fakeClient);

        // Passphrase validation is lazy (not at init time) — it fires on the
        // first pull/sync/push that needs to encrypt or decrypt content.
        await provider.init(); // must not throw
        await expect(provider.pull()).rejects.toThrow(
            /automatic passphrase rotation is not supported/i
        );
    });

    it("keeps branch checkout moving when encrypted remote files cannot decrypt", async () => {
        const encryptedRemote = await encryptContent(
            "secret from remote",
            "original passphrase"
        );
        const staleFile = {
            path: "stale.md",
            stat: { mtime: 1 },
        };
        const fakePlugin = createPlugin({
            apiEncryptionEnabled: true,
            apiEncryptionPassphraseRepoFingerprint:
                "repo:github.com/alice/notes@main",
            apiEncryptionPassphraseFingerprint:
                await computePassphraseFingerprint("original passphrase"),
        });
        fakePlugin.providerSecrets.getEncryptionPassphrase =
            createEncryptionPassphraseGetter("different passphrase");
        fakePlugin.app.vault.getFiles = vi.fn(() => [staleFile]);
        fakePlugin.app.vault.getFileByPath = vi.fn((path: string) =>
            path === "stale.md" ? staleFile : null
        );
        fakePlugin.app.vault.read = vi.fn(() => Promise.resolve("stale local"));

        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        [
                            "plain.md",
                            { path: "plain.md", revision: "plain-revision" },
                        ],
                        [
                            "secret.md",
                            { path: "secret.md", revision: "secret-revision" },
                        ],
                        [
                            "malformed.md",
                            {
                                path: "malformed.md",
                                revision: "malformed-revision",
                            },
                        ],
                    ])
                )
            ),
            downloadFile: vi.fn((path: string) =>
                Promise.resolve(
                    path === "secret.md"
                        ? encryptedRemote
                        : path === "malformed.md"
                          ? "obsidian-git-vault:encrypted:v1\nzz## Getting started"
                          : "plain remote"
                )
            ),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        await expect(provider.checkoutBranchSnapshot()).resolves.toBe(2);

        expect(fakePlugin.app.vault.create).toHaveBeenCalledWith(
            "plain.md",
            "plain remote"
        );
        expect(fakePlugin.app.vault.create).not.toHaveBeenCalledWith(
            "secret.md",
            expect.anything()
        );
        expect(fakePlugin.app.vault.create).not.toHaveBeenCalledWith(
            "malformed.md",
            expect.anything()
        );
        expect(fakePlugin.app.vault.delete).toHaveBeenCalledWith(staleFile);
        expect(fakePlugin.syncManifestStore.data.manifest).toEqual([
            "plain.md",
        ]);
        expect(fakePlugin.showNotice).toHaveBeenCalledWith(
            expect.stringContaining("could not be decrypted"),
            9000
        );
        expect(fakePlugin.settings.apiEncryptionPassphraseFingerprint).toBe(
            await computePassphraseFingerprint("original passphrase")
        );
    });

    it("fails export before writing files when encrypted sync has no passphrase", async () => {
        const fakePlugin = createPlugin({
            apiEncryptionEnabled: true,
        });
        fakePlugin.providerSecrets.getEncryptionPassphrase =
            createEncryptionPassphraseGetter(null);
        const fakeClient = createClient({
            listRemoteFiles: vi.fn(() =>
                Promise.resolve(
                    new Map([
                        ["plain.md", { path: "plain.md", revision: "r1" }],
                    ])
                )
            ),
        });
        const provider = createProvider(fakePlugin, fakeClient);

        await expect(
            provider.exportRemoteToDirectory("/tmp/git-vault-export-test")
        ).rejects.toThrow(/no passphrase is stored on this device/i);
        expect(fakeClient.listRemoteFiles).not.toHaveBeenCalled();
        expect(fakePlugin.app.vault.create).not.toHaveBeenCalled();
    });

    it("rejects encrypted sync when a legacy repo fingerprint matches the same repo", async () => {
        const fakePlugin = createPlugin({
            apiEncryptionEnabled: true,
            apiEncryptionPassphraseRepoFingerprint: "github:alice/notes@main",
            apiEncryptionPassphraseFingerprint:
                await computePassphraseFingerprint("original passphrase"),
        });
        fakePlugin.providerSecrets.getEncryptionPassphrase =
            createEncryptionPassphraseGetter("different passphrase");
        const fakeClient = createClient();
        const provider = createProvider(fakePlugin, fakeClient);

        await provider.init();
        await expect(provider.pull()).rejects.toThrow(
            /automatic passphrase rotation is not supported/i
        );
    });
});
