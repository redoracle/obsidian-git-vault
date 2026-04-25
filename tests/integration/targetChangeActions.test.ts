/**
 * Integration tests for target change confirmation flow.
 *
 * These tests verify that the confirmation guard works end-to-end:
 * the controller detects changes, validates preconditions, and the
 * modal resolves to the correct action.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { TargetChangeController } from "../../src/setting/controller/targetChangeController";
import { SyncStateManager } from "../../src/syncProvider/syncState";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockController(isMobile = false): {
    controller: TargetChangeController;
    state: SyncStateManager;
} {
    const state = new SyncStateManager();
    const controller = new TargetChangeController(state, isMobile);
    return { controller, state };
}

function simulateLinkedVault(controller: TargetChangeController): void {
    controller.setLastSyncedFingerprint("github:owner/repo@main");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TargetChangeController — integration", () => {
    describe("full detection → validation → action pipeline", () => {
        let ctrl: TargetChangeController;
        let state: SyncStateManager;

        beforeEach(() => {
            const m = mockController();
            ctrl = m.controller;
            state = m.state;
        });

        it("allows unlinked vault to change target without confirmation", () => {
            const detection = ctrl.detectChange(
                "github",
                "new-org/new-repo",
                "develop",
                "",
                ""
            );
            expect(detection.activeVaultAlreadyLinked).toBe(false);

            const validation = ctrl.validateTransition(detection);
            expect(validation.requiresConfirmation).toBe(false);
            expect(validation.canProceed).toBe(true);
        });

        it("blocks when sync is in flight", () => {
            simulateLinkedVault(ctrl);
            state.markSyncStart();

            const detection = ctrl.detectChange(
                "github",
                "org/new-repo",
                "main",
                "org/repo",
                "main"
            );
            const validation = ctrl.validateTransition(detection);
            expect(validation.canProceed).toBe(false);
            expect(validation.isSyncing).toBe(true);
        });

        it("requires confirmation for linked vault with repo change", () => {
            simulateLinkedVault(ctrl);

            const detection = ctrl.detectChange(
                "github",
                "org/new-repo",
                "main",
                "org/old-repo",
                "main"
            );
            expect(detection.repoChanged).toBe(true);

            const validation = ctrl.validateTransition(detection);
            expect(validation.requiresConfirmation).toBe(true);
            expect(validation.warnings.length).toBeGreaterThan(0);
        });

        it("shows all relevant warnings when changes and pending files coexist", () => {
            simulateLinkedVault(ctrl);
            state.addPendingChange({ path: "notes.md", type: "modified" });
            state.setConflicts([{ path: "data.md" }]);

            const detection = ctrl.detectChange(
                "github",
                "org/new-repo",
                "develop",
                "org/old-repo",
                "main"
            );
            const validation = ctrl.validateTransition(detection);

            expect(validation.pendingChangeCount).toBe(1);
            expect(validation.conflictCount).toBe(1);
            expect(validation.warnings).toEqual(
                expect.arrayContaining([
                    expect.stringContaining("Repository will change"),
                    expect.stringContaining("Branch will change"),
                    expect.stringContaining("uncommitted"),
                    expect.stringContaining("conflict"),
                ])
            );
        });

        it("offers correct actions on desktop for linked vault change", () => {
            simulateLinkedVault(ctrl);

            const detection = ctrl.detectChange(
                "github",
                "org/new-repo",
                "main",
                "org/old-repo",
                "main"
            );
            const validation = ctrl.validateTransition(detection);
            const actions = ctrl.availableActions(validation);

            expect(actions).toContain("cancel");
            expect(actions).toContain("switch-vault");
            expect(actions).toContain("clone-dedicated-vault");
            expect(actions).toContain("create-submodule");
        });

        it("excludes clone-dedicated-vault on mobile", () => {
            const m = mockController(true);
            simulateLinkedVault(m.controller);

            const detection = m.controller.detectChange(
                "github",
                "org/new-repo",
                "main",
                "org/old-repo",
                "main"
            );
            const validation = m.controller.validateTransition(detection);
            const actions = m.controller.availableActions(validation);

            expect(actions).not.toContain("clone-dedicated-vault");
            expect(actions).toContain("switch-vault");
        });
    });

    describe("transition safeguard — no silent mutation", () => {
        it("returns no-change when repo and branch are identical", () => {
            const { controller } = mockController();
            controller.setLastSyncedFingerprint("github:org/repo@main");
            const detection = controller.detectChange(
                "github",
                "org/repo",
                "main",
                "org/repo",
                "main"
            );
            expect(detection.repoChanged).toBe(false);
            expect(detection.branchChanged).toBe(false);

            const validation = controller.validateTransition(detection);
            expect(validation.requiresConfirmation).toBe(false);
        });

        it("confirms branch-only change on linked vault when pending changes exist", () => {
            const { controller, state } = mockController();
            controller.setLastSyncedFingerprint("github:org/repo@main");
            state.addPendingChange({ path: "draft.md", type: "modified" });

            const detection = controller.detectChange(
                "github",
                "org/repo",
                "feature-x",
                "org/repo",
                "main"
            );
            expect(detection.repoChanged).toBe(false);
            expect(detection.branchChanged).toBe(true);

            const validation = controller.validateTransition(detection);
            expect(validation.requiresConfirmation).toBe(true);
            expect(validation.warnings.some((w) => w.includes("uncommitted"))).toBe(
                true
            );
        });
    });

    describe("GitLab target identity", () => {
        it("handles GitLab project ID changes", () => {
            const { controller } = mockController();
            controller.setLastSyncedFingerprint("gitlab:12345@main");

            const detection = controller.detectChange(
                "gitlab",
                "67890",
                "develop",
                "12345",
                "main"
            );
            expect(detection.repoChanged).toBe(true);
            expect(detection.branchChanged).toBe(true);
            expect(detection.activeVaultAlreadyLinked).toBe(true);
        });
    });

    describe("Gitea target identity", () => {
        it("handles Gitea repo changes", () => {
            const { controller } = mockController();
            controller.setLastSyncedFingerprint("gitea:user/vault@main");

            const detection = controller.detectChange(
                "gitea",
                "user/new-vault",
                "main",
                "user/vault",
                "main"
            );
            expect(detection.repoChanged).toBe(true);
            expect(detection.branchChanged).toBe(false);
        });
    });
});
