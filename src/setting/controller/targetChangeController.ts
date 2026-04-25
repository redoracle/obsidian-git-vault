import type { SyncProviderSetting } from "../../types";
import type { SyncStateManager } from "../../syncProvider/syncState";

// ─── Public types ──────────────────────────────────────────────────────────────

export interface TargetIdentity {
    repo: string;
    branch: string;
}

export interface TargetChangeDetection {
    provider: SyncProviderSetting;
    currentTarget: TargetIdentity;
    proposedTarget: TargetIdentity;
    repoChanged: boolean;
    branchChanged: boolean;
    /** The vault has already completed at least one sync against the current target. */
    activeVaultAlreadyLinked: boolean;
}

export interface TargetChangeValidation {
    /** false when a blocker prevents the transition entirely. */
    canProceed: boolean;
    /** true when uncommitted changes, conflicts, a repository change, or a branch change on a linked vault require explicit confirmation. */
    requiresConfirmation: boolean;
    /** Human-readable warnings to show in the confirmation modal. */
    warnings: string[];
    /** Blockers that prevent the transition. */
    blockers: string[];
    pendingChangeCount: number;
    conflictCount: number;
    isSyncing: boolean;
}

export type TargetChangeAction =
    | "cancel"
    | "switch-vault"
    | "clone-dedicated-vault"
    | "create-submodule";

export interface TargetChangeResolution {
    action: TargetChangeAction;
}

// ─── Controller ────────────────────────────────────────────────────────────────

/**
 * TargetChangeController
 *
 * Validates repo/branch target changes before they are persisted, ensuring that
 * the user cannot silently overwrite a linked vault's sync target without
 * explicit confirmation.
 *
 * Design principles:
 *  - Read-only query of current state — no side effects.
 *  - Blockers are enforced; warnings are advisory.
 *  - Mobile restrictions are surfaced per-platform.
 */
export class TargetChangeController {
    private lastSyncedFingerprint: string;

    constructor(
        private readonly state: SyncStateManager,
        private readonly isMobile: boolean
    ) {
        this.lastSyncedFingerprint = "";
    }

    /**
     * Update the cached fingerprint so the controller can evaluate whether a
     * vault is already linked.  Call this once during construction or whenever
     * the settings are reloaded.
     */
    setLastSyncedFingerprint(fingerprint: string): void {
        this.lastSyncedFingerprint = fingerprint;
    }

    /**
     * Compare the currently persisted target with a proposed new target and
     * classify the difference.
     */
    detectChange(
        provider: SyncProviderSetting,
        proposedRepo: string,
        proposedBranch: string,
        currentRepo: string,
        currentBranch: string
    ): TargetChangeDetection {
        const repoChanged = currentRepo !== proposedRepo;
        const branchChanged = currentBranch !== proposedBranch;
        const hasConfiguredCurrentTarget =
            currentRepo.trim().length > 0 && currentBranch.trim().length > 0;

        return {
            provider,
            currentTarget: { repo: currentRepo, branch: currentBranch },
            proposedTarget: { repo: proposedRepo, branch: proposedBranch },
            repoChanged,
            branchChanged,
            // Consider the vault linked if:
            // 1) we have a persisted sync fingerprint, OR
            // 2) a non-empty target is already configured in settings.
            // The second condition preserves confirmation prompts for users with
            // legacy/migrated settings where fingerprint persistence may be empty
            // even though the vault was previously connected to an API target.
            activeVaultAlreadyLinked:
                !!this.lastSyncedFingerprint || hasConfiguredCurrentTarget,
        };
    }

    /**
     * Validate whether a detected target change can safely proceed.
     *
     * Rules:
     *  1. If nothing changed, no confirmation needed.
     *  2. If the vault has never synced (not linked), allow without confirmation.
     *  3. If repo changed on mobile, warn about bandwidth.
     *  4. If uncommitted changes or conflicts exist, require confirmation.
     *  5. If a sync is in flight, block the transition.
     */
    validateTransition(
        detection: TargetChangeDetection
    ): TargetChangeValidation {
        const warnings: string[] = [];
        const blockers: string[] = [];

        if (!detection.repoChanged && !detection.branchChanged) {
            const syncState = this.state.getState();
            return {
                canProceed: true,
                requiresConfirmation: false,
                warnings: [],
                blockers: [],
                pendingChangeCount: syncState.pendingChanges.length,
                conflictCount: syncState.conflicts.length,
                isSyncing: syncState.isSyncing,
            };
        }

        const syncState = this.state.getState();
        const isSyncing = syncState.isSyncing;
        const pendingChangeCount = syncState.pendingChanges.length;
        const conflictCount = syncState.conflicts.length;

        // Blocker: sync in progress
        if (isSyncing) {
            blockers.push(
                "A sync operation is currently in progress. Wait for it to complete before changing the target."
            );
        }

        if (blockers.length > 0) {
            return {
                canProceed: false,
                requiresConfirmation: false,
                warnings,
                blockers,
                pendingChangeCount,
                conflictCount,
                isSyncing,
            };
        }

        // Not linked yet — no confirmation needed (first-time setup)
        if (!detection.activeVaultAlreadyLinked) {
            return {
                canProceed: true,
                requiresConfirmation: false,
                warnings,
                blockers,
                pendingChangeCount,
                conflictCount,
                isSyncing,
            };
        }

        // Vault is linked — changes need confirmation
        if (detection.repoChanged) {
            warnings.push(
                `Repository will change from "${detection.currentTarget.repo}" to "${detection.proposedTarget.repo}".`
            );
            warnings.push(
                "Existing local files may be replaced by the new repository contents on the next sync."
            );
        }

        if (detection.branchChanged) {
            warnings.push(
                `Branch will change from "${detection.currentTarget.branch}" to "${detection.proposedTarget.branch}".`
            );
        }

        if (pendingChangeCount > 0) {
            warnings.push(
                `${pendingChangeCount} uncommitted local change(s) are present. These changes may be lost if you switch without pushing first.`
            );
        }

        if (conflictCount > 0) {
            warnings.push(
                `${conflictCount} unresolved conflict(s) are present. Resolve them before switching or they will be discarded.`
            );
        }

        if (this.isMobile && detection.repoChanged) {
            warnings.push(
                "You are on a mobile device. Switching to a new repository requires a full re-download, which may consume significant data."
            );
        }

        const requiresConfirmation =
            detection.repoChanged ||
            detection.branchChanged ||
            pendingChangeCount > 0 ||
            conflictCount > 0;

        return {
            canProceed: true,
            requiresConfirmation,
            warnings,
            blockers,
            pendingChangeCount,
            conflictCount,
            isSyncing,
        };
    }

    /**
     * Compute available actions based on the validation result.
     * Desktop-only actions are excluded on mobile.
     */
    availableActions(validation: TargetChangeValidation): TargetChangeAction[] {
        if (!validation.canProceed) {
            return ["cancel"];
        }
        const actions: TargetChangeAction[] = ["cancel", "switch-vault"];
        if (!this.isMobile) {
            actions.push("clone-dedicated-vault");
            actions.push("create-submodule");
        }
        return actions;
    }

    /**
     * Timestamp of the last successful sync, used to qualify whether the vault
     * is already linked to a provider target.
     */
    lastSyncTimestamp(): number | null {
        return this.state.getState().lastSyncTime;
    }
}
