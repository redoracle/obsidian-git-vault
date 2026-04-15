import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";

function makeProviderHarness() {
    const gitManager = {
        submoduleAwareHeadRevisonInContainingDirectory: vi
            .fn()
            .mockResolvedValue("deadbeef"),
        hashObject: vi.fn().mockResolvedValue("abc123"),
        blame: vi.fn(),
    };

    const plugin = {
        settings: {
            lineAuthor: {
                followMovement: "inactive",
                ignoreWhitespace: false,
            },
        },
        editorIntegration: {
            lineAuthoringFeature: {
                isAvailableOnCurrentPlatform: () => ({ gitManager }),
            },
        },
        log: vi.fn(),
    };

    return {
        gitManager,
        plugin,
    };
}

describe("LineAuthorProvider", () => {
    it("publishes a failed state instead of leaving subscribers stuck in loading when blame rejects", async () => {
        Object.defineProperty(globalThis, "window", {
            value: globalThis,
            configurable: true,
        });

        const { eventsPerFilePathSingleton } = await import(
            "../../src/editor/eventsPerFilepath"
        );
        const { LineAuthorProvider } = await import(
            "../../src/editor/lineAuthor/lineAuthorProvider"
        );
        const { lineAuthoringFailureId } = await import(
            "../../src/editor/lineAuthor/model"
        );

        const { gitManager, plugin } = makeProviderHarness();
        const provider = new LineAuthorProvider(plugin as never);
        const filePath = "docs/Architecture.md";
        const notifications: Array<{ id: string; la: unknown }> = [];
        const subscriber = {
            notifyLineAuthoring(id: string, la: unknown) {
                notifications.push({ id, la });
            },
        };

        eventsPerFilePathSingleton.ifFilepathDefinedTransformSubscribers(
            filePath,
            (subs) => subs.add(subscriber as never)
        );

        gitManager.blame.mockRejectedValueOnce(new Error("git blame exploded"));

        const file = new TFile();
        file.path = filePath;
        await expect(provider.trackChanged(file)).rejects.toThrow("git blame exploded");

        expect(notifications).toContainEqual({
            id: lineAuthoringFailureId(filePath),
            la: "failed",
        });

        eventsPerFilePathSingleton.ifFilepathDefinedTransformSubscribers(
            filePath,
            (subs) => subs.delete(subscriber as never)
        );
    });
});
