import { describe, expect, it, vi } from "vitest";
import { SyncStateManager } from "../../src/syncProvider/syncState";
import type { SyncState } from "../../src/syncProvider/syncState";

describe("SyncStateManager — branchSelection and providerReady", () => {
    it("initialises branchSelection as null", () => {
        const manager = new SyncStateManager();
        expect(manager.getState().branchSelection).toBeNull();
    });

    it("initialises branchSelectionStatus as idle", () => {
        const manager = new SyncStateManager();
        expect(manager.getState().branchSelectionStatus).toBe("idle");
    });

    it("initialises branchSelectionError as null", () => {
        const manager = new SyncStateManager();
        expect(manager.getState().branchSelectionError).toBeNull();
    });

    it("initialises providerReady as false", () => {
        const manager = new SyncStateManager();
        expect(manager.getState().providerReady).toBe(false);
    });

    it("setBranchSelection updates branchSelection and sets status to ready", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelection({ branches: ["main", "develop"], current: "main" });
        const state = manager.getState();
        expect(state.branchSelection).not.toBeNull();
        expect(state.branchSelection?.current).toBe("main");
        expect(state.branchSelection?.branches).toContain("develop");
        expect(state.branchSelectionStatus).toBe("ready");
        expect(state.branchSelectionError).toBeNull();
    });

    it("setBranchSelection(null) clears branchSelection and resets status to idle", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelection({ branches: ["main"], current: "main" });
        manager.setBranchSelection(null);
        const state = manager.getState();
        expect(state.branchSelection).toBeNull();
        expect(state.branchSelectionStatus).toBe("idle");
        expect(state.branchSelectionError).toBeNull();
    });

    it("setBranchSelection clears branchSelectionError even when setting a non-null selection", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelectionError("previous error");
        manager.setBranchSelection({ branches: ["main"], current: "main" });
        const state = manager.getState();
        expect(state.branchSelection?.current).toBe("main");
        expect(state.branchSelectionStatus).toBe("ready");
        expect(state.branchSelectionError).toBeNull();
    });

    it("setBranchSelection(null) clears branchSelectionError", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelectionError("previous error");
        manager.setBranchSelection(null);
        const state = manager.getState();
        expect(state.branchSelection).toBeNull();
        expect(state.branchSelectionStatus).toBe("idle");
        expect(state.branchSelectionError).toBeNull();
    });

    it("setProviderReady updates providerReady", () => {
        const manager = new SyncStateManager();
        manager.setProviderReady(true);
        expect(manager.getState().providerReady).toBe(true);
        manager.setProviderReady(false);
        expect(manager.getState().providerReady).toBe(false);
    });

    it("notifies subscribers on setBranchSelection", () => {
        const manager = new SyncStateManager();
        const listener = vi.fn<(state: Readonly<SyncState>) => void>();
        manager.subscribe(listener);
        manager.setBranchSelection({ branches: ["main"], current: "main" });
        expect(listener).toHaveBeenCalledTimes(1);
        const state: Readonly<SyncState> = listener.mock.calls[0][0];
        expect(state.branchSelection?.current).toBe("main");
    });

    it("notifies subscribers on setProviderReady", () => {
        const manager = new SyncStateManager();
        const listener = vi.fn<(state: Readonly<SyncState>) => void>();
        manager.subscribe(listener);
        manager.setProviderReady(true);
        expect(listener).toHaveBeenCalledTimes(1);
        const state: Readonly<SyncState> = listener.mock.calls[0][0];
        expect(state.providerReady).toBe(true);
    });

    it("freezes branchSelection in snapshots", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelection({ branches: ["main", "develop"], current: "main" });
        const state = manager.getState();
        expect(Object.isFrozen(state.branchSelection)).toBe(true);
        if (state.branchSelection) {
            expect(Object.isFrozen(state.branchSelection.branches)).toBe(true);
        }
    });

    it("returns independent snapshots (does not share mutable reference)", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelection({ branches: ["main"], current: "main" });
        const snap1 = manager.getState();
        manager.setBranchSelection({ branches: ["develop"], current: "develop" });
        const snap2 = manager.getState();
        expect(snap1.branchSelection?.current).toBe("main");
        expect(snap2.branchSelection?.current).toBe("develop");
    });
});

describe("SyncStateManager — branchSelectionStatus lifecycle", () => {
    it("setBranchSelectionLoading sets status to loading and clears error", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelectionError("previous error");
        manager.setBranchSelectionLoading();
        const state = manager.getState();
        expect(state.branchSelectionStatus).toBe("loading");
        expect(state.branchSelectionError).toBeNull();
    });

    it("setBranchSelectionReady stores selection and sets status to ready", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelectionReady({ branches: ["main"], current: "main" });
        const state = manager.getState();
        expect(state.branchSelection?.current).toBe("main");
        expect(state.branchSelectionStatus).toBe("ready");
        expect(state.branchSelectionError).toBeNull();
    });

    it("setBranchSelectionReady clears a previous error", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelectionError("fetch failed");
        manager.setBranchSelectionReady({ branches: ["develop"], current: "develop" });
        const state = manager.getState();
        expect(state.branchSelectionStatus).toBe("ready");
        expect(state.branchSelectionError).toBeNull();
        expect(state.branchSelection?.current).toBe("develop");
    });

    it("setBranchSelectionError sets status to error with message", () => {
        const manager = new SyncStateManager();
        manager.setBranchSelectionError("network timeout");
        const state = manager.getState();
        expect(state.branchSelectionStatus).toBe("error");
        expect(state.branchSelectionError).toBe("network timeout");
        // Existing branchSelection data is preserved so the UI can show
        // stale-but-useful data alongside the error.
    });

    it("notifies subscribers on setBranchSelectionLoading", () => {
        const manager = new SyncStateManager();
        const listener = vi.fn<(state: Readonly<SyncState>) => void>();
        manager.subscribe(listener);
        manager.setBranchSelectionLoading();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].branchSelectionStatus).toBe("loading");
    });

    it("notifies subscribers on setBranchSelectionError", () => {
        const manager = new SyncStateManager();
        const listener = vi.fn<(state: Readonly<SyncState>) => void>();
        manager.subscribe(listener);
        manager.setBranchSelectionError("boom");
        expect(listener).toHaveBeenCalledTimes(1);
        const state = listener.mock.calls[0][0];
        expect(state.branchSelectionStatus).toBe("error");
        expect(state.branchSelectionError).toBe("boom");
    });

    it("full lifecycle: idle → loading → ready", () => {
        const manager = new SyncStateManager();
        expect(manager.getState().branchSelectionStatus).toBe("idle");

        manager.setBranchSelectionLoading();
        expect(manager.getState().branchSelectionStatus).toBe("loading");

        manager.setBranchSelectionReady({ branches: ["main", "dev"], current: "main" });
        const state = manager.getState();
        expect(state.branchSelectionStatus).toBe("ready");
        expect(state.branchSelection?.branches).toEqual(["main", "dev"]);
    });

    it("full lifecycle: idle → loading → error", () => {
        const manager = new SyncStateManager();

        manager.setBranchSelectionLoading();
        expect(manager.getState().branchSelectionStatus).toBe("loading");

        manager.setBranchSelectionError("unauthorized");
        const state = manager.getState();
        expect(state.branchSelectionStatus).toBe("error");
        expect(state.branchSelectionError).toBe("unauthorized");
    });
});
