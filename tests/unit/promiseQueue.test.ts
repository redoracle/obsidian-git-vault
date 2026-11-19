import { describe, expect, it, vi } from "vitest";
import { PromiseQueue } from "../../src/promiseQueue";
import type ObsidianGit from "../../src/main";

function makeQueue() {
    const displayError = vi.fn();
    const queue = new PromiseQueue({ manifest: { id: "git-vault" }, displayError } as unknown as ObsidianGit);
    return { queue, displayError };
}

describe("PromiseQueue execution and shutdown", () => {
    it("preserves FIFO ordering without overlapping tasks", async () => {
        const { queue } = makeQueue();
        const order: string[] = [];
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const one = queue.addTask(async () => { order.push("first-start"); await barrier; order.push("first-end"); return 1; });
        const two = queue.addTask(async () => { order.push("second"); return 2; });
        expect(order).toEqual(["first-start"]);
        release();
        expect(await Promise.all([one, two])).toEqual([1, 2]);
        expect(order).toEqual(["first-start", "first-end", "second"]);
    });

    it("reports failures and continues", async () => {
        const { queue, displayError } = makeQueue();
        const error = new Error("failed");
        const one = queue.addTask(async (): Promise<number> => { throw error; });
        const two = queue.addTask(async () => 2);
        expect(await Promise.all([one, two])).toEqual([undefined, 2]);
        expect(displayError).toHaveBeenCalledExactlyOnceWith(error);
    });

    it("settles cancelled work and never starts another task after unload", async () => {
        const { queue, displayError } = makeQueue();
        const completed = vi.fn();
        const pendingFn = vi.fn(async () => 2);
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const active = queue.addTask(async () => { await barrier; throw new Error("late"); }, completed);
        const pending = queue.addTask(pendingFn, completed);
        queue.clear();
        expect(await Promise.all([active, pending])).toEqual([undefined, undefined]);
        expect(completed).not.toHaveBeenCalled();
        expect(pendingFn).not.toHaveBeenCalled();
        expect(await queue.addTask(async () => 3)).toBeUndefined();
        release();
        await Promise.resolve();
        await Promise.resolve();
        expect(displayError).not.toHaveBeenCalled();
    });

    it("isolates a callback error from following tasks", async () => {
        const { queue } = makeQueue();
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const one = queue.addTask(async () => 1, () => { throw new Error("callback"); });
            const two = queue.addTask(async () => 2);
            expect(await Promise.all([one, two])).toEqual([1, 2]);
            expect(spy).toHaveBeenCalledOnce();
        } finally {
            spy.mockRestore();
        }
    });
});
