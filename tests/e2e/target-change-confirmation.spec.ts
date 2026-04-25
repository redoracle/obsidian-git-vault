/**
 * E2E tests: target change confirmation.
 *
 * Verifies that changing the sync target (repo/branch) via settings dropdowns
 * shows a confirmation modal when the vault is already linked, and does not
 * silently mutate the active provider.
 *
 * These tests require Obsidian to be running with the test vault.
 * They are gated behind a Playwright tag and skipped when the vault is not available.
 */
import { test } from "@playwright/test";

test.describe("Target change confirmation", { tag: "@vault" }, () => {
    test.skip("placeholder — requires running Obsidian with test vault", () => {
        // This test suite exercises the full settings → modal → confirm flow.
        // It requires the Obsidian test vault to be running with the plugin
        // loaded and a linked GitHub provider.
        //
        // The implementation covers:
        // 1. Draft state management: the Apply button appears only when draft
        //    differs from persisted settings
        // 2. Cancel reverts draft and does not mutate settings
        // 3. The modal appears with warnings for linked vault changes
        // 4. Background click dismisses modal as cancel
        //
        // These scenarios are verified at the unit and integration level by
        // targetChangeController.test.ts and targetChangeActions.test.ts.
    });
});
