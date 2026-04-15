import { debounce, type Debouncer } from "obsidian";
import type ObsidianGit from "./main";

type AutoTaskResult = "completed" | "paused" | "scheduled" | "suppressed";

export default class AutomaticsManager {
    /**
     * Debouncer for auto-commit after a file change
     * (`autoBackupAfterFileChange` mode). Owned here so the lifecycle is
     * fully self-contained and main.ts needs no knowledge of it.
     */
    private autoCommitDebouncer: Debouncer<[], void> | undefined;

    /**
     * All recurring timeouts keyed by operation type.
     * Using a single Map makes it easy to clear any subset without
     * multiple nullable fields scattered through the class.
     */
    private readonly timers = new Map<"commit" | "push" | "pull", number>();

    constructor(private readonly plugin: ObsidianGit) {}

    /**
     * Called by the vault-change handlers in main.ts whenever a file is
     * modified/created/deleted/renamed.  Forwards to the debouncer when
     * `autoBackupAfterFileChange` mode is active; a no-op otherwise.
     */
    handleFileChange(): void {
        this.autoCommitDebouncer?.();
    }

    private saveLastAuto(date: Date, mode: "backup" | "pull" | "push") {
        if (mode === "backup") {
            this.plugin.localStorage.setLastAutoBackup(date.toString());
        } else if (mode === "pull") {
            this.plugin.localStorage.setLastAutoPull(date.toString());
        } else if (mode === "push") {
            this.plugin.localStorage.setLastAutoPush(date.toString());
        }
    }

    private areAutomaticRunsSuppressed(): boolean {
        return (
            this.plugin.areVaultChangeEffectsSuppressed() ||
            this.plugin.isBranchSwitchInProgress
        );
    }

    private loadLastAuto(): { backup: Date; pull: Date; push: Date } {
        return {
            backup: new Date(
                this.plugin.localStorage.getLastAutoBackup() ?? ""
            ),
            pull: new Date(this.plugin.localStorage.getLastAutoPull() ?? ""),
            push: new Date(this.plugin.localStorage.getLastAutoPush() ?? ""),
        };
    }

    async init() {
        await this.setUpAutoCommitAndSync();
        const lastAutos = this.loadLastAuto();

        if (
            this.plugin.settings.differentIntervalCommitAndPush &&
            this.plugin.settings.autoPushInterval > 0
        ) {
            const diff = this.diff(
                this.plugin.settings.autoPushInterval,
                lastAutos.push
            );
            this.startAutoPush(diff);
        }
        if (this.plugin.settings.autoPullInterval > 0) {
            const diff = this.diff(
                this.plugin.settings.autoPullInterval,
                lastAutos.pull
            );
            this.startAutoPull(diff);
        }
    }

    unload() {
        this.clearAutoPull();
        this.clearAutoPush();
        this.clearAutoCommitAndSync();
    }

    /**
     * Clears all timers and sets all timers to their current settings.
     *
     * This does not calculate any differences to last autos or commits.
     * Should only be used when settings are changed.
     */
    reload(...type: ("commit" | "push" | "pull")[]) {
        if (this.plugin.localStorage.getPausedAutomatics()) return;

        if (type.includes("commit")) {
            this.clearAutoCommitAndSync();
            if (this.plugin.settings.autoSaveInterval > 0) {
                this.startAutoCommitAndSync(
                    this.plugin.settings.autoSaveInterval
                );
            }
        }
        if (type.includes("push")) {
            this.clearAutoPush();
            if (
                this.plugin.settings.differentIntervalCommitAndPush &&
                this.plugin.settings.autoPushInterval > 0
            ) {
                this.startAutoPush(this.plugin.settings.autoPushInterval);
            }
        }
        if (type.includes("pull")) {
            this.clearAutoPull();
            if (this.plugin.settings.autoPullInterval > 0) {
                this.startAutoPull(this.plugin.settings.autoPullInterval);
            }
        }
    }

    /**
     * Starts the auto commit-and-sync with the correct remaining time.
     *
     * Additionally, if `setLastSaveToLastCommit` is enabled, the last auto commit-and-sync
     * is set to the last commit time.
     */
    private async setUpAutoCommitAndSync() {
        if (this.plugin.settings.setLastSaveToLastCommit) {
            this.clearAutoCommitAndSync();
            const lastCommitDate =
                await this.plugin.gitManager.getLastCommitTime();
            if (lastCommitDate) {
                this.saveLastAuto(lastCommitDate, "backup");
            }
        }

        if (!this.timers.has("commit") && !this.autoCommitDebouncer) {
            const lastAutos = this.loadLastAuto();

            if (this.plugin.settings.autoSaveInterval > 0) {
                const diff = this.diff(
                    this.plugin.settings.autoSaveInterval,
                    lastAutos.backup
                );
                this.startAutoCommitAndSync(diff);
            }
        }
    }

    private startAutoCommitAndSync(minutes?: number) {
        let time = (minutes ?? this.plugin.settings.autoSaveInterval) * 60000;
        if (this.plugin.settings.autoBackupAfterFileChange) {
            if (minutes === 0) {
                this.doAutoCommitAndSync();
            } else {
                this.autoCommitDebouncer = debounce(
                    () => this.doAutoCommitAndSync(),
                    time,
                    true
                );
            }
        } else {
            // max timeout in js
            if (time > 2147483647) time = 2147483647;
            this.timers.set(
                "commit",
                window.setTimeout(() => this.doAutoCommitAndSync(), time)
            );
        }
    }

    // This is used for both auto commit-and-sync and commit only
    private doAutoCommitAndSync(): void {
        void this.plugin.promiseQueue.addTask(
            async (): Promise<AutoTaskResult> => {
                // Guard: check pause or runtime suppression at execution time,
                // not just at enqueue time.  Suppression is used during
                // branch switches / bulk vault updates to avoid automatic
                // routines operating on the wrong branch.
                if (this.plugin.localStorage.getPausedAutomatics()) {
                    return "paused";
                }
                if (this.areAutomaticRunsSuppressed()) {
                    return "suppressed";
                }

                // Re-check if the auto commit should run now or be postponed,
                // because the last commit time has changed
                if (this.plugin.settings.setLastSaveToLastCommit) {
                    const lastCommitDate =
                        await this.plugin.gitManager.getLastCommitTime();
                    if (lastCommitDate) {
                        this.saveLastAuto(lastCommitDate, "backup");
                        const diff = this.diff(
                            this.plugin.settings.autoSaveInterval,
                            lastCommitDate
                        );
                        if (diff > 0) {
                            this.startAutoCommitAndSync(diff);
                            // Return "scheduled" to mark the next iteration
                            // as already being scheduled by the manager.
                            return "scheduled";
                        }
                    }
                }
                const onlyStaged = this.plugin.settings.autoCommitOnlyStaged;
                if (this.plugin.settings.differentIntervalCommitAndPush) {
                    await this.plugin.commit({
                        fromAutoBackup: true,
                        onlyStaged,
                    });
                } else {
                    await this.plugin.commitAndSync({
                        fromAutoBackup: true,
                        onlyStaged,
                    });
                }
                return "completed";
            },
            (result) => {
                // Don't schedule if the next iteration is already scheduled,
                // or if automatics are paused. Temporary suppression still
                // re-arms the next interval because no automatic work ran.
                if (
                    result !== "scheduled" &&
                    result !== "paused" &&
                    !this.plugin.localStorage.getPausedAutomatics()
                ) {
                    if (result === "completed") {
                        this.saveLastAuto(new Date(), "backup");
                    }
                    this.startAutoCommitAndSync();
                }
            }
        );
    }

    private startAutoPull(minutes?: number) {
        let time = (minutes ?? this.plugin.settings.autoPullInterval) * 60000;
        // max timeout in js
        if (time > 2147483647) time = 2147483647;

        this.timers.set(
            "pull",
            window.setTimeout(() => this.doAutoPull(), time)
        );
    }

    private doAutoPull(): void {
        void this.plugin.promiseQueue.addTask(
            async (): Promise<AutoTaskResult> => {
                // Guard: check pause or runtime suppression at execution time.
                if (this.plugin.localStorage.getPausedAutomatics()) {
                    return "paused";
                }
                if (this.areAutomaticRunsSuppressed()) {
                    return "suppressed";
                }
                await this.plugin.pullChangesFromRemote();
                return "completed";
            },
            (result) => {
                if (
                    result !== "paused" &&
                    !this.plugin.localStorage.getPausedAutomatics()
                ) {
                    if (result === "completed") {
                        this.saveLastAuto(new Date(), "pull");
                    }
                    this.startAutoPull();
                }
            }
        );
    }

    private startAutoPush(minutes?: number) {
        let time = (minutes ?? this.plugin.settings.autoPushInterval) * 60000;
        // max timeout in js
        if (time > 2147483647) time = 2147483647;

        this.timers.set(
            "push",
            window.setTimeout(() => this.doAutoPush(), time)
        );
    }

    private doAutoPush(): void {
        void this.plugin.promiseQueue.addTask(
            async (): Promise<AutoTaskResult> => {
                // Guard: check pause or runtime suppression at execution time.
                if (this.plugin.localStorage.getPausedAutomatics()) {
                    return "paused";
                }
                if (this.areAutomaticRunsSuppressed()) {
                    return "suppressed";
                }
                await this.plugin.push();
                return "completed";
            },
            (result) => {
                if (
                    result !== "paused" &&
                    !this.plugin.localStorage.getPausedAutomatics()
                ) {
                    if (result === "completed") {
                        this.saveLastAuto(new Date(), "push");
                    }
                    this.startAutoPush();
                }
            }
        );
    }

    private clearAutoCommitAndSync(): boolean {
        let wasActive = false;
        const id = this.timers.get("commit");
        if (id !== undefined) {
            window.clearTimeout(id);
            this.timers.delete("commit");
            wasActive = true;
        }
        if (this.autoCommitDebouncer) {
            this.autoCommitDebouncer.cancel();
            this.autoCommitDebouncer = undefined;
            wasActive = true;
        }
        return wasActive;
    }

    private clearAutoPull(): boolean {
        const id = this.timers.get("pull");
        if (id !== undefined) {
            window.clearTimeout(id);
            this.timers.delete("pull");
            return true;
        }
        return false;
    }

    private clearAutoPush(): boolean {
        const id = this.timers.get("push");
        if (id !== undefined) {
            window.clearTimeout(id);
            this.timers.delete("push");
            return true;
        }
        return false;
    }

    /**
     * Calculates the minutes until the next auto action. >= 0
     *
     * This is done by the difference between the setting and the time since the last auto action, but at least 0.
     */
    private diff(setting: number, lastAuto: Date) {
        if (Number.isNaN(lastAuto.getTime())) {
            return 0;
        }
        const now = new Date();
        const diff =
            setting -
            Math.round((now.getTime() - lastAuto.getTime()) / 1000 / 60);
        return Math.max(0, diff);
    }
}
