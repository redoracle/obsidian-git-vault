import { describe, expect, it } from "vitest";
import { TargetChangeController } from "../../src/setting/controller/targetChangeController";
import type { TargetChangeDetection } from "../../src/setting/controller/targetChangeController";
import { SyncStateManager } from "../../src/syncProvider/syncState";

function makeController(isMobile = false): { ctrl: TargetChangeController; state: SyncStateManager } {
    const state = new SyncStateManager();
    const ctrl = new TargetChangeController(state, isMobile);
    return { ctrl, state };
}

function makeLinkedController(isMobile = false): { ctrl: TargetChangeController; state: SyncStateManager } {
    const { ctrl, state } = makeController(isMobile);
    ctrl.setLastSyncedFingerprint("github:org/repo@main");
    return { ctrl, state };
}

function makeDetection(overrides?: Partial<TargetChangeDetection>): TargetChangeDetection {
    return {
        provider: "github",
        currentTarget: { repo: "org/repo", branch: "main" },
        proposedTarget: { repo: "org/other-repo", branch: "main" },
        repoChanged: true,
        branchChanged: false,
        activeVaultAlreadyLinked: true,
        ...overrides,
    };
}

describe("TargetChangeController", () => {
    describe("detectChange", () => {
        it("detects repo change", () => {
            const { ctrl } = makeLinkedController();
            const result = ctrl.detectChange(
                "github",
                "org/new-repo",
                "main",
                "org/repo",
                "main"
            );
            expect(result.repoChanged).toBe(true);
            expect(result.branchChanged).toBe(false);
        });

        it("detects branch change", () => {
            const { ctrl } = makeLinkedController();
            const result = ctrl.detectChange(
                "github",
                "org/repo",
                "develop",
                "org/repo",
                "main"
            );
            expect(result.repoChanged).toBe(false);
            expect(result.branchChanged).toBe(true);
        });

        it("detects both changes", () => {
            const { ctrl } = makeLinkedController();
            const result = ctrl.detectChange(
                "github",
                "org/other",
                "develop",
                "org/repo",
                "main"
            );
            expect(result.repoChanged).toBe(true);
            expect(result.branchChanged).toBe(true);
        });

        it("detects no change", () => {
            const { ctrl } = makeLinkedController();
            const result = ctrl.detectChange(
                "github",
                "org/repo",
                "main",
                "org/repo",
                "main"
            );
            expect(result.repoChanged).toBe(false);
            expect(result.branchChanged).toBe(false);
        });

        it("reports vault as unlinked when fingerprint and current target are empty", () => {
            const { ctrl } = makeController();
            const result = ctrl.detectChange(
                "github",
                "",
                "",
                "",
                ""
            );
            expect(result.activeVaultAlreadyLinked).toBe(false);
        });

        it("reports vault as linked when current target is configured", () => {
            const { ctrl } = makeController();
            const result = ctrl.detectChange(
                "github",
                "org/new-repo",
                "main",
                "org/repo",
                "main"
            );
            expect(result.activeVaultAlreadyLinked).toBe(true);
        });

        it("reports vault as linked when fingerprint is set", () => {
            const { ctrl } = makeLinkedController();
            const result = ctrl.detectChange(
                "github",
                "org/repo",
                "main",
                "org/repo",
                "main"
            );
            expect(result.activeVaultAlreadyLinked).toBe(true);
        });
    });

    describe("validateTransition", () => {
        it("returns no confirmation needed when nothing changed", () => {
            const { ctrl } = makeLinkedController();
            const detection = makeDetection({
                repoChanged: false,
                branchChanged: false,
            });
            const result = ctrl.validateTransition(detection);
            expect(result.canProceed).toBe(true);
            expect(result.requiresConfirmation).toBe(false);
        });

        it("returns no confirmation needed when vault is not linked", () => {
            const { ctrl } = makeController();
            const detection = makeDetection({
                activeVaultAlreadyLinked: false,
            });
            const result = ctrl.validateTransition(detection);
            expect(result.canProceed).toBe(true);
            expect(result.requiresConfirmation).toBe(false);
        });

        it("requires confirmation when repo changes and vault is linked", () => {
            const { ctrl } = makeLinkedController();
            const detection = makeDetection({ repoChanged: true, branchChanged: false });
            const result = ctrl.validateTransition(detection);
            expect(result.canProceed).toBe(true);
            expect(result.requiresConfirmation).toBe(true);
            expect(result.warnings.length).toBeGreaterThan(0);
        });

        it("requires confirmation when branch changes and vault is linked", () => {
            const { ctrl } = makeLinkedController();
            const detection = makeDetection({
                repoChanged: false,
                branchChanged: true,
                proposedTarget: { repo: "org/repo", branch: "develop" },
            });
            const result = ctrl.validateTransition(detection);
            expect(result.canProceed).toBe(true);
            expect(result.requiresConfirmation).toBe(true);
            expect(result.warnings.some((w) => w.includes("Branch will change"))).toBe(true);
        });

        it("requires confirmation when uncommitted changes exist", () => {
            const { ctrl, state } = makeLinkedController();
            state.addPendingChange({ path: "test.md", type: "modified" });
            const detection = makeDetection();
            const result = ctrl.validateTransition(detection);
            expect(result.requiresConfirmation).toBe(true);
            expect(result.pendingChangeCount).toBe(1);
            expect(result.warnings.some((w) => w.includes("uncommitted"))).toBe(true);
        });

        it("requires confirmation when conflicts exist", () => {
            const { ctrl, state } = makeLinkedController();
            state.setConflicts([{ path: "test.md" }]);
            const detection = makeDetection();
            const result = ctrl.validateTransition(detection);
            expect(result.conflictCount).toBe(1);
            expect(result.warnings.some((w) => w.includes("conflict"))).toBe(true);
        });

        it("blocks when sync is in progress", () => {
            const { ctrl, state } = makeLinkedController();
            state.markSyncStart();
            const detection = makeDetection();
            const result = ctrl.validateTransition(detection);
            expect(result.canProceed).toBe(false);
            expect(result.blockers.length).toBeGreaterThan(0);
            expect(result.isSyncing).toBe(true);
        });

        it("adds mobile warning on mobile", () => {
            const { ctrl } = makeLinkedController(true);
            const detection = makeDetection();
            const result = ctrl.validateTransition(detection);
            expect(result.warnings.some((w) => w.includes("mobile"))).toBe(true);
        });

        it("does not add mobile warning on desktop", () => {
            const { ctrl } = makeLinkedController(false);
            const detection = makeDetection();
            const result = ctrl.validateTransition(detection);
            expect(result.warnings.some((w) => w.includes("mobile"))).toBe(false);
        });
    });

    describe("availableActions", () => {
        it("returns only cancel when blocked", () => {
            const { ctrl } = makeController();
            const result = ctrl.availableActions({
                canProceed: false,
                requiresConfirmation: false,
                warnings: [],
                blockers: ["sync in progress"],
                pendingChangeCount: 0,
                conflictCount: 0,
                isSyncing: true,
            });
            expect(result).toEqual(["cancel"]);
        });

        it("includes desktop-only actions on desktop", () => {
            const { ctrl } = makeController(false);
            const result = ctrl.availableActions({
                canProceed: true,
                requiresConfirmation: true,
                warnings: [],
                blockers: [],
                pendingChangeCount: 0,
                conflictCount: 0,
                isSyncing: false,
            });
            expect(result).toContain("clone-dedicated-vault");
            expect(result).toContain("switch-vault");
            expect(result).toContain("create-submodule");
            expect(result).toContain("cancel");
        });

        it("excludes desktop-only actions on mobile", () => {
            const { ctrl } = makeController(true);
            const result = ctrl.availableActions({
                canProceed: true,
                requiresConfirmation: true,
                warnings: [],
                blockers: [],
                pendingChangeCount: 0,
                conflictCount: 0,
                isSyncing: false,
            });
            expect(result).not.toContain("clone-dedicated-vault");
            expect(result).not.toContain("create-submodule");
            expect(result).toContain("switch-vault");
        });
    });

    describe("lastSyncTimestamp", () => {
        it("returns null initially", () => {
            const { ctrl } = makeController();
            expect(ctrl.lastSyncTimestamp()).toBeNull();
        });
    });
});
