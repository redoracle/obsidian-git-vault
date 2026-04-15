import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from "vitest";
import * as auditModule from "../../src/syncProvider/syncAuditLog";
import { GitSyncProvider } from "../../src/syncProvider/gitSyncProvider";
import type ObsidianGit from "../../src/main";

type PluginMock = {
    settings: {
        lastSyncedRepoFingerprint: string;
    };
    saveSettings: ReturnType<typeof vi.fn>;
    gitManager: {
        pull: ReturnType<typeof vi.fn>;
        push: ReturnType<typeof vi.fn>;
        branchInfo: ReturnType<typeof vi.fn>;
        getRemotes: ReturnType<typeof vi.fn>;
        getRemoteUrl: ReturnType<typeof vi.fn>;
    };
};

function createPlugin() {
    const pull = vi.fn(() => Promise.resolve());
    const push = vi.fn(() => Promise.resolve());
    const branchInfo = vi.fn(() => Promise.resolve({ current: "main" }));
    const getRemotes = vi.fn(() => ({ first: () => null }));
    const getRemoteUrl = vi.fn(() => Promise.resolve(""));

    return {
        settings: {
            lastSyncedRepoFingerprint: "",
        },
        saveSettings: vi.fn(() => Promise.resolve()),
        gitManager: {
            pull,
            push,
            branchInfo,
            getRemotes,
            getRemoteUrl,
        },
    } satisfies PluginMock;
}

type AuditErrorPayload = {
    error: {
        message: string;
        stack?: string;
    };
};

function isAuditErrorPayload(value: unknown): value is AuditErrorPayload {
    if (!value || typeof value !== "object" || !("error" in value)) {
        return false;
    }

    const maybeError = value.error;
    return (
        !!maybeError &&
        typeof maybeError === "object" &&
        "message" in maybeError &&
        typeof maybeError.message === "string"
    );
}

describe("GitSyncProvider failure audits", () => {
    let auditSpy!: MockInstance<typeof auditModule.syncAuditLog>;

    beforeEach(() => {
        auditSpy = vi.spyOn(auditModule, "syncAuditLog");
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("serializes pull failures with message and stack", async () => {
        const plugin = createPlugin();
        const provider = new GitSyncProvider(plugin as unknown as ObsidianGit);
        const error = new Error("pull exploded");

        plugin.gitManager.pull.mockRejectedValueOnce(error);

        await expect(provider.pull()).rejects.toBe(error);

        expect(auditSpy).toHaveBeenCalled();
        const lastCall = auditSpy.mock.calls.at(-1);
        expect(lastCall).toBeDefined();

        const [, event, payload] = lastCall!;
        if (!isAuditErrorPayload(payload)) {
            throw new Error("Expected pull failure audit payload");
        }

        expect(event).toBe("pull:failure");
        expect(payload.error.message).toBe("pull exploded");
        expect(payload.error.stack).toEqual(expect.any(String));
    });

    it("serializes push failures with message and stack", async () => {
        const plugin = createPlugin();
        const provider = new GitSyncProvider(plugin as unknown as ObsidianGit);
        const error = new Error("push exploded");

        plugin.gitManager.push.mockRejectedValueOnce(error);

        await expect(provider.push()).rejects.toBe(error);

        expect(auditSpy).toHaveBeenCalled();
        const lastCall = auditSpy.mock.calls.at(-1);
        expect(lastCall).toBeDefined();

        const [, event, payload] = lastCall!;
        if (!isAuditErrorPayload(payload)) {
            throw new Error("Expected push failure audit payload");
        }

        expect(event).toBe("push:failure");
        expect(payload.error.message).toBe("push exploded");
        expect(payload.error.stack).toEqual(expect.any(String));
    });
});
