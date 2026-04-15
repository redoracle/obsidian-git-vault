import type ObsidianGit from "./main";

/**
 * Controls how `PromiseQueue` handles a task error.
 *
 * - `"report"` (default) — the queue calls `plugin.displayError()` and then
 *   invokes `onFinished(undefined)`.  Use this for top-level commands that do
 *   not catch their own errors.
 * - `"swallow"` — the error is logged at debug level and then discarded after
 *   `onFinished(undefined)` is called. Use this for tasks that perform their
 *   own error reporting (e.g. `commit`, automatic tasks) to avoid showing two
 *   toast notifications for the same failure.
 */
export type TaskErrorPolicy = "report" | "swallow";

export class PromiseQueue {
    private tasks: {
        task: () => Promise<unknown>;
        onFinished: (res: unknown) => void;
        onError: TaskErrorPolicy;
    }[] = [];

    constructor(private readonly plugin: ObsidianGit) {}

    /**
     * Add a task to the queue.
     *
     * @param task The task to add.
     * @param onFinished A callback that is called when the task is finished. Both on success and on error.
     * @param onError Error reporting policy. Defaults to `"report"` (queue
     *   displays the error). Pass `"swallow"` when the task handles its own
     *   error display to prevent duplicate toast notifications.
     */
    addTask<T>(
        task: () => Promise<T>,
        onFinished?: (res: T | undefined) => void,
        onError: TaskErrorPolicy = "report"
    ): Promise<T | undefined> {
        return new Promise<T | undefined>((resolve) => {
            this.tasks.push({
                task: () => task(),
                onFinished: (res: unknown) => {
                    try {
                        onFinished?.(res as T | undefined);
                    } catch (e) {
                        console.error(
                            "%s: onFinished handler threw an error",
                            this.plugin.manifest.id,
                            e
                        );
                    } finally {
                        resolve(res as T | undefined);
                    }
                },
                onError,
            });
            if (this.tasks.length === 1) {
                this.handleTask();
            }
        });
    }

    private handleTask(): void {
        if (this.tasks.length > 0) {
            const item = this.tasks[0];
            // Ensure synchronous throws from the task are converted to a
            // rejected promise so they are handled uniformly.
            Promise.resolve()
                .then(() => item.task())
                .then(
                    (res) => {
                        item.onFinished(res);
                        this.tasks.shift();
                        this.handleTask();
                    },
                    (e) => {
                        if (item.onError === "report") {
                            this.plugin.displayError(e);
                        } else {
                            console.debug(
                                "%s: swallowed queue task error",
                                this.plugin.manifest.id,
                                e
                            );
                        }
                        item.onFinished(undefined);
                        this.tasks.shift();
                        this.handleTask();
                    }
                );
        }
    }

    clear(): void {
        this.tasks = [];
    }
}
