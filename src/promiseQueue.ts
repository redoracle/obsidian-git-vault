import type ObsidianGit from "./main";

export type TaskErrorPolicy = "report" | "swallow";

interface QueuedTask {
    task: () => Promise<unknown>;
    finish: (result: unknown, cancelled?: boolean) => void;
    onError: TaskErrorPolicy;
}

/**
 * A single-owner FIFO execution queue.
 *
 * Only the queue advances the active task. Clearing settles all waiters,
 * prevents new work, and never starts a pending task. An already-running
 * asynchronous operation cannot be force-cancelled; owners must cooperate
 * with teardown where side effects are possible.
 */
export class PromiseQueue {
    private readonly tasks: QueuedTask[] = [];
    private activeTask: QueuedTask | undefined;
    private stopped = false;

    constructor(private readonly plugin: ObsidianGit) {}

    /**
     * Returns the result, or undefined on failure/cancellation.
     * onFinished runs only after execution, not on teardown cancellation;
     * cancellation must not re-arm automatic timers or invoke UI callbacks.
     */
    addTask<T>(
        task: () => Promise<T>,
        onFinished?: (res: T | undefined) => void,
        onError: TaskErrorPolicy = "report"
    ): Promise<T | undefined> {
        if (this.stopped) return Promise.resolve(undefined);

        return new Promise<T | undefined>((resolve) => {
            let settled = false;
            const item: QueuedTask = {
                task,
                onError,
                finish: (result: unknown, cancelled = false) => {
                    if (settled) return;
                    settled = true;
                    if (!cancelled) {
                        try {
                            onFinished?.(result as T | undefined);
                        } catch (error) {
                            console.error(
                                "%s: onFinished handler threw an error",
                                this.plugin.manifest.id,
                                error
                            );
                        }
                    }
                    resolve(result as T | undefined);
                },
            };
            this.tasks.push(item);
            this.startNext();
        });
    }

    private startNext(): void {
        if (this.stopped || this.activeTask) return;
        const item = this.tasks.shift();
        if (!item) return;
        this.activeTask = item;
        void this.execute(item);
    }

    private async execute(item: QueuedTask): Promise<void> {
        let result: unknown = undefined;
        try {
            result = await item.task();
        } catch (error) {
            if (!this.stopped) {
                try {
                    if (item.onError === "report") {
                        this.plugin.displayError(error);
                    } else {
                        console.debug(
                            "%s: swallowed queue task error",
                            this.plugin.manifest.id,
                            error
                        );
                    }
                } catch (reportError) {
                    // Error reporting must never strand the queue.
                    console.error(
                        "%s: queue error reporter threw",
                        this.plugin.manifest.id,
                        reportError
                    );
                }
            }
        } finally {
            item.finish(result);
            if (this.activeTask === item) this.activeTask = undefined;
            this.startNext();
        }
    }

    /** Terminal shutdown; cannot cancel the underlying active operation. */
    clear(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.activeTask?.finish(undefined, true);
        for (const item of this.tasks.splice(0)) {
            item.finish(undefined, true);
        }
    }
}
