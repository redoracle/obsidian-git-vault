/**
 * SettingsValidator (pure function module)
 *
 * Logs developer-facing warnings for setting combinations that are
 * likely to produce confusing or redundant behaviour.  These are
 * non-fatal and intentionally surfaced only to the console so as not
 * to spam end-users with notices on every reload.
 *
 * Extracted from: ObsidianGit.warnOnSettingsInconsistency (src/main.ts)
 */

import type { ObsidianGitSettings } from "src/types";

export function warnOnSettingsInconsistency(
    settings: ObsidianGitSettings,
    log: (...args: unknown[]) => void
): void {
    const s = settings;

    if (s.autoPullInterval === 0 && s.syncOnFileChange) {
        log(
            "Settings warning: syncOnFileChange is enabled but autoPullInterval is 0. " +
                "Remote changes will only arrive when a file-change sync is triggered, " +
                "which may miss inbound updates between file saves."
        );
    }

    if (
        s.autoBackupAfterFileChange &&
        s.autoSaveInterval > 0 &&
        s.syncOnFileChange
    ) {
        log(
            "Settings warning: both autoBackupAfterFileChange (git automatics) and " +
                "syncOnFileChange (SyncManager) are enabled. Each file change will " +
                "trigger two independent sync paths; consider disabling one."
        );
    }

    if (
        s.differentIntervalCommitAndPush &&
        s.autoPushInterval === 0 &&
        s.autoSaveInterval > 0
    ) {
        log(
            "Settings warning: differentIntervalCommitAndPush is enabled but " +
                "autoPushInterval is 0 — commits will accumulate locally and never be pushed automatically."
        );
    }

    if (
        s.autoPullInterval > 0 &&
        s.autoPushInterval > 0 &&
        s.autoPullInterval < s.autoPushInterval
    ) {
        log(
            "Settings warning: autoPullInterval (" +
                s.autoPullInterval +
                " min) is shorter than autoPushInterval (" +
                s.autoPushInterval +
                " min). This can cause repeated pull/push cycles with no net change."
        );
    }
}
