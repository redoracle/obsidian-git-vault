import { describe, it, expect, vi } from "vitest";
import { RuntimeOrchestrator } from "../../src/runtime/runtimeOrchestrator";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Boot the orchestrator to "ready" with git available. */
function bootGit(o: RuntimeOrchestrator): void {
    o.dispatch({ type: "boot-succeeded", gitAvailable: true, isSimpleGit: true });
}

/** Boot the orchestrator to "ready" without git (API provider). */
function bootApi(o: RuntimeOrchestrator): void {
    o.dispatch({ type: "boot-succeeded", gitAvailable: false, isSimpleGit: false });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RuntimeOrchestrator", () => {
    describe("initial state", () => {
        it('starts in "booting" phase', () => {
            const o = new RuntimeOrchestrator();
            expect(o.phase).toBe("booting");
        });

        it("isGitReady is false while booting", () => {
            const o = new RuntimeOrchestrator();
            expect(o.isGitReady).toBe(false);
        });

        it("useSimpleGit is false while booting", () => {
            const o = new RuntimeOrchestrator();
            expect(o.useSimpleGit).toBe(false);
        });
    });

    describe("boot sequence", () => {
        it('transitions booting → ready on boot-succeeded', () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            expect(o.phase).toBe("ready");
        });

        it('ignores boot-started while already booting', () => {
            const listener = vi.fn();
            const o = new RuntimeOrchestrator();
            o.onPhaseChange(listener);

            o.dispatch({ type: "boot-started" });

            expect(o.phase).toBe("booting");
            expect(listener).not.toHaveBeenCalled();
        });

        it("isGitReady is true after successful git boot", () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            expect(o.isGitReady).toBe(true);
        });

        it("isGitReady is false after API boot (gitAvailable: false)", () => {
            const o = new RuntimeOrchestrator();
            bootApi(o);
            expect(o.isGitReady).toBe(false);
        });

        it("useSimpleGit is true after git boot with isSimpleGit: true", () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            expect(o.useSimpleGit).toBe(true);
        });

        it('transitions booting → degraded on boot-failed', () => {
            const o = new RuntimeOrchestrator();
            o.dispatch({ type: "boot-failed", reason: "git not found" });
            expect(o.phase).toBe("degraded");
        });

        it('transitions ready → degraded on fatal-error', () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "fatal-error", reason: "unexpected failure" });
            expect(o.phase).toBe("degraded");
        });

        it("ignores fatal-error after unload", () => {
            const listener = vi.fn();
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "unload" });
            o.onPhaseChange(listener);
            o.dispatch({ type: "fatal-error", reason: "unexpected failure" });
            expect(o.phase).toBe("unloaded");
            expect(listener).not.toHaveBeenCalled();
        });

        it("isGitReady is false in degraded phase", () => {
            const o = new RuntimeOrchestrator();
            o.dispatch({ type: "boot-failed", reason: "oops" });
            expect(o.isGitReady).toBe(false);
        });
    });

    describe("sync lifecycle", () => {
        it("transitions ready → syncing → ready", () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "sync-started" });
            expect(o.phase).toBe("syncing");
            expect(o.isGitReady).toBe(true); // git still accessible during sync
            o.dispatch({ type: "sync-finished" });
            expect(o.phase).toBe("ready");
        });

        it("ignores sync-started when not in ready phase", () => {
            const o = new RuntimeOrchestrator();
            // Still booting — sync-started must be ignored.
            o.dispatch({ type: "sync-started" });
            expect(o.phase).toBe("booting");
        });

        it("ignores sync-finished when not in syncing phase", () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "sync-finished" });
            expect(o.phase).toBe("ready");
        });
    });

    describe("reload lifecycle", () => {
        it("transitions ready → reloading → ready", () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "reload-started" });
            expect(o.phase).toBe("reloading");
            o.dispatch({
                type: "reload-finished",
                gitAvailable: true,
                isSimpleGit: true,
            });
            expect(o.phase).toBe("ready");
        });

        it("transitions reloading → degraded on reload-failed", () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "reload-started" });
            o.dispatch({ type: "reload-failed", reason: "provider error" });
            expect(o.phase).toBe("degraded");
        });

        it("reload-failed clears isGitReady", () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "reload-started" });
            o.dispatch({ type: "reload-failed", reason: "fail" });
            expect(o.isGitReady).toBe(false);
        });
    });

    describe("unload", () => {
        it("transitions any phase to unloaded", () => {
            const phases: Array<() => RuntimeOrchestrator> = [
                () => {
                    const o = new RuntimeOrchestrator();
                    return o; // booting
                },
                () => {
                    const o = new RuntimeOrchestrator();
                    bootGit(o);
                    return o; // ready
                },
                () => {
                    const o = new RuntimeOrchestrator();
                    bootGit(o);
                    o.dispatch({ type: "sync-started" });
                    return o; // syncing
                },
                () => {
                    const o = new RuntimeOrchestrator();
                    bootGit(o);
                    o.dispatch({ type: "reload-started" });
                    return o; // reloading
                },
                () => {
                    const o = new RuntimeOrchestrator();
                    bootGit(o);
                    o.dispatch({ type: "reload-started" });
                    o.dispatch({ type: "reload-failed", reason: "boom" });
                    return o; // degraded
                },
            ];
            for (const make of phases) {
                const o = make();
                o.dispatch({ type: "unload" });
                expect(o.phase).toBe("unloaded");
            }
        });

        it("isGitReady is false after unload", () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "unload" });
            expect(o.isGitReady).toBe(false);
        });

        it("does not transition unloaded → unloaded on second unload", () => {
            const listener = vi.fn();
            const o = new RuntimeOrchestrator();
            bootGit(o);
            o.dispatch({ type: "unload" });
            o.onPhaseChange(listener);
            o.dispatch({ type: "unload" }); // second unload: no-op
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe("onPhaseChange()", () => {
        it("calls registered listeners with next and previous phase", () => {
            const listener = vi.fn();
            const o = new RuntimeOrchestrator();
            o.onPhaseChange(listener);
            bootGit(o);
            expect(listener).toHaveBeenCalledWith("ready", "booting");
        });

        it("returns an unsubscribe function that removes the listener", () => {
            const listener = vi.fn();
            const o = new RuntimeOrchestrator();
            const unsub = o.onPhaseChange(listener);
            unsub();
            bootGit(o); // listener should NOT be called
            expect(listener).not.toHaveBeenCalled();
        });

        it("does not call listener when transition is ignored (invalid event)", () => {
            const listener = vi.fn();
            const o = new RuntimeOrchestrator();
            o.onPhaseChange(listener);
            // sync-started is invalid from "booting" — listener should not be called
            o.dispatch({ type: "sync-started" });
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe("waitForPhase()", () => {
        it("resolves immediately if already in target phase", async () => {
            const o = new RuntimeOrchestrator();
            bootGit(o);
            await expect(o.waitForPhase("ready")).resolves.toBeUndefined();
        });

        it("resolves before the timeout when the target phase is reached", async () => {
            vi.useFakeTimers();
            try {
                const o = new RuntimeOrchestrator();
                const waiting = o.waitForPhase("ready", 1000);
                bootGit(o);
                await expect(waiting).resolves.toBeUndefined();
                await vi.runOnlyPendingTimersAsync();
            } finally {
                vi.useRealTimers();
            }
        });

        it("resolves when target phase is reached", async () => {
            const o = new RuntimeOrchestrator();
            // Boot asynchronously to prove waitForPhase returns a pending promise
            const waiting = o.waitForPhase("ready");
            bootGit(o);
            await expect(waiting).resolves.toBeUndefined();
        });

        it("rejects when the timeout elapses before the target phase is reached", async () => {
            vi.useFakeTimers();
            try {
                const o = new RuntimeOrchestrator();
                const waiting = o.waitForPhase("ready", 25);
                const rejection = expect(waiting).rejects.toThrow(
                    /timed out waiting for "ready"/
                );
                await vi.advanceTimersByTimeAsync(25);
                await rejection;
            } finally {
                vi.useRealTimers();
            }
        });

        it("rejects when degraded phase is reached before target", async () => {
            const o = new RuntimeOrchestrator();
            const waiting = o.waitForPhase("ready");
            o.dispatch({ type: "boot-failed", reason: "whoops" });
            await expect(waiting).rejects.toThrow(/degraded/);
        });

        it("rejects when unloaded before target phase is reached", async () => {
            const o = new RuntimeOrchestrator();
            const waiting = o.waitForPhase("ready");
            o.dispatch({ type: "unload" });
            await expect(waiting).rejects.toThrow(/unloaded/);
        });
    });
});
